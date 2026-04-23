/**
 * /api/monetization/account
 * Public mobile account snapshot for credits + free daily allowance.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { applyAnonymousIdentityCookie } from "@/lib/anon-user";
import { resolveCookbookIdentity } from "@/lib/cookbook-identity";
import { getMonetizationRuntimeConfig } from "@/lib/monetization-config";
import { getMonetizationCreditCatalog } from "@/lib/monetization-credit-packs";
import { getCreditBalance } from "@/lib/monetization-ledger";
import { getTodayDailyMonetizationUsage } from "@/lib/monetization-operations";

const CREDIT_COST_PER_ACTION = 1;

function withIdentity(response: NextResponse, anonUserId: string) {
  response.headers.set("x-flavor-fusion-anon-id", anonUserId);
}

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
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

    const response = NextResponse.json({
      enabled: runtimeConfig.enabled,
      enforcementMode: runtimeConfig.enforcementMode,
      actionCosts: {
        fuse: CREDIT_COST_PER_ACTION,
        reroll: CREDIT_COST_PER_ACTION,
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

