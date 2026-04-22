/**
 * /api/admin/monetization/config
 * Admin-only endpoint for monetization runtime config.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import {
  getMonetizationRuntimeConfig,
  MonetizationConfigValidationError,
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

class RequestValidationError extends Error {}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
