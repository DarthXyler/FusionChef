/**
 * /api/admin/monetization/purchases/reversal
 * Admin-triggered purchase reversal path (refund/chargeback handling).
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { applyPurchaseReversalDeduction } from "@/lib/monetization-ledger";
import {
  getPurchaseByProviderTransaction,
  updatePurchaseRecord,
  type PurchaseRecordStatus,
} from "@/lib/monetization-purchases";
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
import type { PurchaseProvider } from "@/lib/monetization-credit-packs";

const MAX_BODY_BYTES = 20_000;

class RequestValidationError extends Error {}

type ReversalBody = {
  provider: PurchaseProvider;
  providerTransactionId: string;
  reason: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(value: unknown): ReversalBody {
  if (!isObjectRecord(value)) {
    throw new RequestValidationError("Invalid request body.");
  }
  const provider =
    value.provider === "apple_app_store" || value.provider === "google_play"
      ? value.provider
      : "";
  if (!provider) {
    throw new RequestValidationError("provider must be apple_app_store or google_play.");
  }
  const providerTransactionId =
    typeof value.providerTransactionId === "string" ? value.providerTransactionId.trim() : "";
  if (!providerTransactionId) {
    throw new RequestValidationError("providerTransactionId is required.");
  }
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason) {
    throw new RequestValidationError("reason is required.");
  }
  return { provider, providerTransactionId, reason };
}

function statusFromOutstanding(outstanding: number): PurchaseRecordStatus {
  return outstanding > 0 ? "reversal_pending" : "revoked";
}

export async function POST(request: NextRequest) {
  const admin = requireMonetizationAdmin(request, { requireActor: true });
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-purchase-reversal",
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
  }

  let idempotencyContext: IdempotencyContext | null = null;
  try {
    if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const body = parseBody((await request.json()) as unknown);
    const idempotency = await beginIdempotentRequest({
      key: idempotencyKey,
      scope: `admin-purchase-reversal:${body.provider}:${body.providerTransactionId}`,
      requestPayload: {
        actor: admin.context.actor,
        reason: body.reason,
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

    const purchase = await getPurchaseByProviderTransaction(
      body.provider,
      body.providerTransactionId,
    );
    if (!purchase) {
      return NextResponse.json({ error: "Purchase record not found." }, { status: 404 });
    }

    const remainingToReverse = Math.max(
      0,
      purchase.grantedCredits - purchase.reversedCredits,
    );
    if (remainingToReverse === 0) {
      const alreadyReversed = await updatePurchaseRecord({
        provider: body.provider,
        providerTransactionId: body.providerTransactionId,
        status: "revoked",
        outstandingReversalCredits: 0,
        revokedAt: new Date().toISOString(),
        addRiskFlags: [],
      });
      const responseBody = {
        purchase: alreadyReversed,
        reversedCredits: 0,
        outstandingReversalCredits: 0,
      };
      if (idempotencyContext) {
        await completeIdempotentRequest(idempotencyContext, 200, responseBody);
      }
      const response = NextResponse.json(responseBody);
      response.headers.set("Idempotency-Status", "stored");
      withNoStore(response);
      return response;
    }

    const reversal = await applyPurchaseReversalDeduction({
      anonUserId: purchase.anonUserId,
      amount: remainingToReverse,
      actor: `admin_reversal:${admin.context.actor}`,
      reason: body.reason,
      idempotencyScope: "purchase-reversal-deduction",
      idempotencyKey: `${body.provider}:${body.providerTransactionId}`,
      metadata: {
        provider: body.provider,
        providerTransactionId: body.providerTransactionId,
      },
    });

    const reversedNow = reversal.ok ? remainingToReverse : 0;
    const outstanding = reversal.ok ? 0 : remainingToReverse;
    const updated = await updatePurchaseRecord({
      provider: body.provider,
      providerTransactionId: body.providerTransactionId,
      status: statusFromOutstanding(outstanding),
      reversedCredits: purchase.reversedCredits + reversedNow,
      outstandingReversalCredits: outstanding,
      revokedAt: new Date().toISOString(),
      addRiskFlags: reversal.ok ? [] : ["reversal_insufficient_credits"],
    });

    const responseBody = {
      purchase: updated,
      reversedCredits: reversedNow,
      outstandingReversalCredits: outstanding,
      balance: reversal.balance,
      reversalApplied: reversal.ok,
    };
    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }

    const response = NextResponse.json(responseBody);
    response.headers.set("Idempotency-Status", "stored");
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reversal_processed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      provider: body.provider,
      providerTransactionId: body.providerTransactionId,
      reversedNow,
      outstanding,
      reversalApplied: reversal.ok,
    });

    return response;
  } catch (error) {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    const message = error instanceof Error ? error.message : "Could not process reversal.";
    const isValidation = error instanceof RequestValidationError;
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reversal_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      reason: message,
    });
    return NextResponse.json(
      { error: isValidation ? message : "Could not process reversal." },
      { status: isValidation ? 400 : 500 },
    );
  }
}
