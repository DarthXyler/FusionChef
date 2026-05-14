/**
 * /api/monetization/account
 * Public mobile account snapshot for credits + free daily allowance.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { applyAnonymousIdentityCookie } from "@/lib/anon-user";
import { buildInactiveAuthResponse } from "@/lib/auth-api";
import { getActiveAuthSessionFromRequest } from "@/lib/auth-session";
import { resolveCookbookIdentity } from "@/lib/cookbook-identity";
import { getMonetizationRuntimeConfig } from "@/lib/monetization-config";
import { getMonetizationCreditCatalog } from "@/lib/monetization-credit-packs";
import { getCreditBalance } from "@/lib/monetization-ledger";
import { getTodayDailyMonetizationUsage } from "@/lib/monetization-operations";

function withIdentity(response: NextResponse, anonUserId: string) {
  response.headers.set("x-flavor-fusion-anon-id", anonUserId);
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
}

function getTodayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, {
    bucket: "api-monetization-account",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  try {
    const authValidation = await getActiveAuthSessionFromRequest(request);
    const inactiveAuthResponse = buildInactiveAuthResponse(authValidation);
    if (inactiveAuthResponse) {
      noStore(inactiveAuthResponse);
      return inactiveAuthResponse;
    }
    const authSession = authValidation.session;
    const identity = await resolveCookbookIdentity(request);
    const [runtimeConfig, balance, todayUsage] = await Promise.all([
      getMonetizationRuntimeConfig(),
      getCreditBalance(identity.anonUserId),
      getTodayDailyMonetizationUsage(identity.anonUserId),
    ]);
    const freeFuseRemaining = Math.max(
      0,
      runtimeConfig.freeDailyFuseActions - todayUsage.fuseCount,
    );
    const freeRerollRemaining = Math.max(
      0,
      runtimeConfig.freeDailyRerollActions - todayUsage.rerollCount,
    );
    const catalog = getMonetizationCreditCatalog();
    const products = [
      ...Object.entries(catalog.apple_app_store).map(([productId, credits]) => ({
        provider: "apple_app_store" as const,
        productId,
        credits,
      })),
      ...Object.entries(catalog.google_play).map(([productId, credits]) => ({
        provider: "google_play" as const,
        productId,
        credits,
      })),
    ].sort((left, right) => left.credits - right.credits);
    const today = getTodayDateOnly();
    const activeSeasonalOffers = runtimeConfig.seasonalOffers.filter(
      (offer) => offer.active && offer.startDate <= today && offer.endDate >= today,
    );

    const response = NextResponse.json({
      authenticated: Boolean(authSession),
      login: authSession
        ? {
            role: authSession.role,
            email: authSession.email,
            name: authSession.name,
            expiresAt: new Date(authSession.exp * 1000).toISOString(),
          }
        : null,
      enabled: runtimeConfig.enabled,
      enforcementMode: runtimeConfig.enforcementMode,
      actionCosts: {
        fuse: runtimeConfig.fuseCreditCost,
        reroll: runtimeConfig.rerollCreditCost,
      },
      freeDaily: {
        fuse: runtimeConfig.freeDailyFuseActions,
        reroll: runtimeConfig.freeDailyRerollActions,
      },
      todayUsage: {
        fuse: todayUsage.fuseCount,
        reroll: todayUsage.rerollCount,
      },
      freeRemaining: {
        fuse: freeFuseRemaining,
        reroll: freeRerollRemaining,
      },
      balance,
      products,
      pricingPackages: runtimeConfig.pricingPackages,
      seasonalOffers: runtimeConfig.seasonalOffers,
      activeSeasonalOffers,
    });
    withIdentity(response, identity.anonUserId);
    applyAnonymousIdentityCookie(response, identity);
    noStore(response);
    return response;
  } catch {
    return NextResponse.json(
      { error: "Could not load monetization account snapshot." },
      { status: 500 },
    );
  }
}
