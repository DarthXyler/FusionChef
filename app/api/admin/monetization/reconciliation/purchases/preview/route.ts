/**
 * Read-only preview for one controlled purchase reconciliation action.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  enforceRateLimit,
  isRequestBodyTooLarge,
} from "@/lib/api-security";
import {
  previewPurchaseReconciliationResolution,
  PurchaseReconciliationActionError,
} from "@/lib/monetization-purchase-reconciliation-actions";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 24_000;

function noStoreJson(payload: unknown, status = 200) {
  const response = NextResponse.json(payload, { status });
  withNoStore(response);
  return response;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(value: unknown) {
  if (!isObjectRecord(value)) {
    throw new PurchaseReconciliationActionError(
      "invalid_request",
      "Invalid request body.",
      400,
    );
  }
  const issueId = typeof value.issueId === "string" ? value.issueId.trim() : "";
  const googlePurchaseToken =
    typeof value.googlePurchaseToken === "string"
      ? value.googlePurchaseToken.trim()
      : "";
  if (!issueId || issueId.length > 128 || googlePurchaseToken.length > 20_000) {
    throw new PurchaseReconciliationActionError(
      "invalid_request",
      "The purchase resolution preview request is invalid.",
      400,
    );
  }
  return { issueId, googlePurchaseToken };
}

export async function POST(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    withNoStore(admin.response);
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-purchase-reconciliation-preview",
    limit: 12,
    windowMs: 60_000,
    // A preview must perform no operational database writes.
    strategy: "memory",
  });
  if (limited) {
    withNoStore(limited);
    return limited;
  }

  try {
    if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
      return noStoreJson(
        { error: "Request is too large.", code: "request_too_large" },
        413,
      );
    }
    const body = parseBody((await request.json()) as unknown);
    const preview = await previewPurchaseReconciliationResolution(body);
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reconciliation_previewed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      issueId: body.issueId,
      issueType: preview.issueType,
      automaticResolutionSupported: preview.automaticResolutionSupported,
    });
    return noStoreJson(preview);
  } catch (error) {
    const actionError =
      error instanceof PurchaseReconciliationActionError ? error : null;
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reconciliation_preview_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      errorCode: actionError?.code ?? "internal_error",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return noStoreJson(
      {
        error:
          actionError?.message ??
          "Could not preview the purchase reconciliation action.",
        code: actionError?.code ?? "internal_error",
      },
      actionError?.statusCode ?? 500,
    );
  }
}
