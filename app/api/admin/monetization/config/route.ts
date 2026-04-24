/**
 * /api/admin/monetization/config
 * Admin-only endpoint for monetization runtime config.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import {
  getMonetizationRuntimeConfig,
  MonetizationConfigValidationError,
  type MonetizationPackageKey,
  type MonetizationPricingPackage,
  updateMonetizationRuntimeConfig,
  type MonetizationRuntimeConfigPatch,
} from "@/lib/monetization-config";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";
import {
  beginIdempotentRequest,
  clearIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKeyFromHeaders,
  type IdempotencyContext,
} from "@/lib/idempotency";

const MAX_CONFIG_BODY_BYTES = 20_000;
const PACKAGE_KEYS = ["pack_1", "pack_2", "pack_3"] as const;

class RequestValidationError extends Error {}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePricingPackages(value: unknown) {
  if (!Array.isArray(value)) {
    throw new RequestValidationError("pricingPackages must be an array.");
  }
  const parsed: MonetizationPricingPackage[] = value.map((entry) => {
    if (!isObjectRecord(entry)) {
      throw new RequestValidationError("Each pricing package must be an object.");
    }
    const rawPackageKey = entry.packageKey;
    if (
      rawPackageKey !== "pack_1" &&
      rawPackageKey !== "pack_2" &&
      rawPackageKey !== "pack_3"
    ) {
      throw new RequestValidationError("pricing packageKey must be pack_1, pack_2, or pack_3.");
    }
    const packageKey: MonetizationPackageKey = rawPackageKey;
    if (typeof entry.label !== "string" || !entry.label.trim()) {
      throw new RequestValidationError("pricing package label is required.");
    }
    if (typeof entry.credits !== "number" || !Number.isFinite(entry.credits)) {
      throw new RequestValidationError("pricing package credits must be a number.");
    }
    if (typeof entry.displayPriceUsd !== "number" || !Number.isFinite(entry.displayPriceUsd)) {
      throw new RequestValidationError("pricing package displayPriceUsd must be a number.");
    }
    if (typeof entry.appleProductId !== "string" || !entry.appleProductId.trim()) {
      throw new RequestValidationError("pricing package appleProductId is required.");
    }
    if (typeof entry.googleProductId !== "string") {
      throw new RequestValidationError("pricing package googleProductId must be a string.");
    }
    if (typeof entry.active !== "boolean") {
      throw new RequestValidationError("pricing package active must be boolean.");
    }
    return {
      packageKey,
      label: entry.label.trim(),
      credits: Math.trunc(entry.credits),
      displayPriceUsd: Math.round(entry.displayPriceUsd * 100) / 100,
      appleProductId: entry.appleProductId.trim(),
      googleProductId: entry.googleProductId.trim(),
      active: entry.active,
    };
  });

  const seenKeys = new Set<string>();
  for (const entry of parsed) {
    if (seenKeys.has(entry.packageKey)) {
      throw new RequestValidationError("pricingPackages packageKey must be unique.");
    }
    seenKeys.add(entry.packageKey);
  }
  for (const requiredKey of PACKAGE_KEYS) {
    if (!seenKeys.has(requiredKey)) {
      throw new RequestValidationError("pricingPackages must include pack_1, pack_2, and pack_3.");
    }
  }
  return parsed;
}

function parseSeasonalOffers(value: unknown) {
  if (!Array.isArray(value)) {
    throw new RequestValidationError("seasonalOffers must be an array.");
  }
  return value.map((entry) => {
    if (!isObjectRecord(entry)) {
      throw new RequestValidationError("Each seasonal offer must be an object.");
    }
    if (typeof entry.offerId !== "string" || !entry.offerId.trim()) {
      throw new RequestValidationError("seasonal offer offerId is required.");
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new RequestValidationError("seasonal offer name is required.");
    }
    if (typeof entry.startDate !== "string" || !entry.startDate.trim()) {
      throw new RequestValidationError("seasonal offer startDate is required.");
    }
    if (typeof entry.endDate !== "string" || !entry.endDate.trim()) {
      throw new RequestValidationError("seasonal offer endDate is required.");
    }
    if (!isObjectRecord(entry.discountPercentByPackage)) {
      throw new RequestValidationError("seasonal offer discountPercentByPackage is required.");
    }
    const discount = entry.discountPercentByPackage;
    const pack1 = typeof discount.pack_1 === "number" ? Math.trunc(discount.pack_1) : NaN;
    const pack2 = typeof discount.pack_2 === "number" ? Math.trunc(discount.pack_2) : NaN;
    const pack3 = typeof discount.pack_3 === "number" ? Math.trunc(discount.pack_3) : NaN;
    if (
      !Number.isFinite(pack1) ||
      !Number.isFinite(pack2) ||
      !Number.isFinite(pack3)
    ) {
      throw new RequestValidationError("seasonal offer package discounts must be numbers.");
    }
    if (typeof entry.active !== "boolean") {
      throw new RequestValidationError("seasonal offer active must be boolean.");
    }
    return {
      offerId: entry.offerId.trim(),
      name: entry.name.trim(),
      startDate: entry.startDate.trim(),
      endDate: entry.endDate.trim(),
      discountPercentByPackage: {
        pack_1: pack1,
        pack_2: pack2,
        pack_3: pack3,
      },
      active: entry.active,
    };
  });
}

function parseConfigPatch(body: unknown): MonetizationRuntimeConfigPatch {
  if (!isObjectRecord(body)) {
    throw new RequestValidationError("Invalid request body.");
  }

  const patch: MonetizationRuntimeConfigPatch = {};

  if (typeof body.enabled !== "undefined") {
    if (typeof body.enabled !== "boolean") {
      throw new RequestValidationError("enabled must be boolean.");
    }
    patch.enabled = body.enabled;
  }

  if (typeof body.enforcementMode !== "undefined") {
    const mode = body.enforcementMode;
    if (mode !== "off" && mode !== "observe" && mode !== "enforce") {
      throw new RequestValidationError("enforcementMode must be off, observe, or enforce.");
    }
    patch.enforcementMode = mode;
  }

  if (typeof body.freeDailyFuseActions !== "undefined") {
    if (typeof body.freeDailyFuseActions !== "number" || !Number.isFinite(body.freeDailyFuseActions)) {
      throw new RequestValidationError("freeDailyFuseActions must be a number.");
    }
    patch.freeDailyFuseActions = Math.trunc(body.freeDailyFuseActions);
  }

  if (typeof body.freeDailyRerollActions !== "undefined") {
    if (
      typeof body.freeDailyRerollActions !== "number" ||
      !Number.isFinite(body.freeDailyRerollActions)
    ) {
      throw new RequestValidationError("freeDailyRerollActions must be a number.");
    }
    patch.freeDailyRerollActions = Math.trunc(body.freeDailyRerollActions);
  }

  if (typeof body.allowCompActions !== "undefined") {
    if (typeof body.allowCompActions !== "boolean") {
      throw new RequestValidationError("allowCompActions must be boolean.");
    }
    patch.allowCompActions = body.allowCompActions;
  }

  if (typeof body.pricingPackages !== "undefined") {
    patch.pricingPackages = parsePricingPackages(body.pricingPackages);
  }

  if (typeof body.seasonalOffers !== "undefined") {
    patch.seasonalOffers = parseSeasonalOffers(body.seasonalOffers);
  }

  if (Object.keys(patch).length === 0) {
    throw new RequestValidationError("At least one config field is required.");
  }

  return patch;
}

export async function GET(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-config-read",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  try {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "config_read_started",
      actor: admin.context.actor,
      ip: admin.context.ip,
    });

    const config = await getMonetizationRuntimeConfig();
    const response = NextResponse.json({ config });
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "config_read_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
    });

    return response;
  } catch {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "config_read_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
    });
    return NextResponse.json({ error: "Could not load monetization config." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const admin = requireMonetizationAdmin(request, { requireActor: true });
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-config-write",
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let idempotencyContext: IdempotencyContext | null = null;
  try {
    if (isRequestBodyTooLarge(request, MAX_CONFIG_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
    }

    const body = (await request.json()) as unknown;
    const patch = parseConfigPatch(body);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "config_update_started",
      actor: admin.context.actor,
      ip: admin.context.ip,
      patchKeys: Object.keys(patch),
    });

    const idempotency = await beginIdempotentRequest({
      key: idempotencyKey,
      scope: "admin-monetization-config:update",
      requestPayload: {
        actor: admin.context.actor,
        patch,
      },
    });

    if (idempotency.state === "in_progress") {
      return NextResponse.json(
        { error: "This request is already being processed. Please retry shortly." },
        { status: 409, headers: { "Idempotency-Status": "in-progress" } },
      );
    }

    if (idempotency.state === "conflict") {
      return NextResponse.json(
        { error: "Idempotency key was reused with a different payload." },
        { status: 409, headers: { "Idempotency-Status": "conflict" } },
      );
    }

    if (idempotency.state === "replay") {
      const response = NextResponse.json(
        idempotency.responseBody,
        { status: idempotency.responseStatus },
      );
      response.headers.set("Idempotency-Status", "replayed");
      withNoStore(response);
      return response;
    }

    if (idempotency.state === "started") {
      idempotencyContext = idempotency.context;
    }

    const config = await updateMonetizationRuntimeConfig(patch, admin.context.actor);
    const responseBody = { config };

    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }

    const response = NextResponse.json(responseBody);
    if (idempotencyContext) {
      response.headers.set("Idempotency-Status", "stored");
    }
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "config_update_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
      patchKeys: Object.keys(patch),
    });

    return response;
  } catch (error) {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    const isValidationError =
      error instanceof RequestValidationError ||
      error instanceof MonetizationConfigValidationError;
    const message =
      error instanceof Error ? error.message : "Could not update monetization config.";
    const statusCode = isValidationError ? 400 : 500;

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "config_update_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      reason: message,
    });

    return NextResponse.json(
      { error: isValidationError ? message : "Could not update monetization config." },
      { status: statusCode },
    );
  }
}
