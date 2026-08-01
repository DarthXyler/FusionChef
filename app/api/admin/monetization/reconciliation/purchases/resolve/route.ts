/**
 * Commits one previewed, explicitly confirmed purchase reconciliation action.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  enforceRateLimit,
  isRequestBodyTooLarge,
} from "@/lib/api-security";
import { getIdempotencyKeyFromHeaders } from "@/lib/idempotency";
import {
  PurchaseReconciliationActionError,
  resolvePurchaseReconciliationIssue,
} from "@/lib/monetization-purchase-reconciliation-actions";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_000;

function noStoreJson(payload: unknown, status = 200) {
  const response = NextResponse.json(payload, { status });
  withNoStore(response);
  return response;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" ? value[key].trim() : "";
}

function parseBody(value: unknown) {
  if (!isObjectRecord(value)) {
    throw new PurchaseReconciliationActionError(
      "invalid_request",
      "Invalid request body.",
      400,
    );
  }
  const issueId = bodyString(value, "issueId");
  const previewFingerprint = bodyString(value, "previewFingerprint");
  const confirmation = bodyString(value, "confirmation");
  const reason = bodyString(value, "reason");
  const googlePurchaseToken = bodyString(value, "googlePurchaseToken");
  if (
    !issueId ||
    issueId.length > 128 ||
    !previewFingerprint ||
    previewFingerprint.length > 8_000 ||
    confirmation.length > 256 ||
    reason.length > 500 ||
    googlePurchaseToken.length > 20_000
  ) {
    throw new PurchaseReconciliationActionError(
      "invalid_request",
      "The purchase resolution request is invalid.",
      400,
    );
  }
  return {
    issueId,
    previewFingerprint,
    confirmation,
    reason,
    googlePurchaseToken,
  };
}

export async function POST(request: NextRequest) {
  const admin = requireMonetizationAdmin(request, { requireActor: true });
  if (!admin.ok) {
    withNoStore(admin.response);
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-purchase-reconciliation-resolve",
    limit: 8,
    windowMs: 60_000,
    strategy: "memory",
  });
  if (limited) {
    withNoStore(limited);
    return limited;
  }

  const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
  if (!idempotencyKey) {
    return noStoreJson(
      {
        error: "idempotency-key header is required.",
        code: "idempotency_key_required",
      },
      400,
    );
  }

  try {
    if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
      return noStoreJson(
        { error: "Request is too large.", code: "request_too_large" },
        413,
      );
    }
    const body = parseBody((await request.json()) as unknown);
    const result = await resolvePurchaseReconciliationIssue({
      ...body,
      idempotencyKey,
      adminActor: admin.context.actor,
    });
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reconciliation_resolved",
      actor: admin.context.actor,
      ip: admin.context.ip,
      issueId: body.issueId,
      issueType: result.issueType,
      actionId: result.actionId,
      status: result.status,
      creditDelta: result.creditDelta,
    });
    const response = noStoreJson(result);
    response.headers.set(
      "Idempotency-Status",
      result.status === "replayed" ? "replayed" : "stored",
    );
    return response;
  } catch (error) {
    const actionError =
      error instanceof PurchaseReconciliationActionError ? error : null;
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reconciliation_resolution_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      errorCode: actionError?.code ?? "internal_error",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return noStoreJson(
      {
        error:
          actionError?.message ??
          "Could not complete the purchase reconciliation action.",
        code: actionError?.code ?? "internal_error",
      },
      actionError?.statusCode ?? 500,
    );
  }
}
