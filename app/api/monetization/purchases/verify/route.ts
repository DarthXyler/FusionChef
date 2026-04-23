/**
 * /api/monetization/purchases/verify
 * Verifies mobile IAP purchases server-side and grants credits once.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { applyAnonymousIdentityCookie } from "@/lib/anon-user";
import { resolveCookbookIdentity } from "@/lib/cookbook-identity";
import {
  beginIdempotentRequest,
  clearIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKeyFromHeaders,
  type IdempotencyContext,
} from "@/lib/idempotency";
import { getCreditsForProduct, type PurchaseProvider } from "@/lib/monetization-credit-packs";
import { applyPurchaseReversalDeduction, grantCredits } from "@/lib/monetization-ledger";
import {
  createPurchaseRecord,
  getPurchaseByProviderTransaction,
  updatePurchaseRecord,
} from "@/lib/monetization-purchases";
import {
  ProviderVerificationError,
  verifyProviderPurchase,
} from "@/lib/monetization-provider-verification";

const MAX_VERIFY_BODY_BYTES = 30_000;

type VerifyPurchaseBody = {
  provider: PurchaseProvider;
  productId: string;
  appleTransactionId?: string;
  googlePurchaseToken?: string;
  packageName?: string;
};

class RequestValidationError extends Error {}

function logPurchaseVerify(event: Record<string, unknown>) {
  console.info("[api/monetization/purchases/verify]", JSON.stringify(event));
}

function withIdentityHeaders(response: NextResponse, anonUserId: string) {
  response.headers.set("x-flavor-fusion-anon-id", anonUserId);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProvider(value: unknown) {
  if (value === "apple_app_store" || value === "google_play") {
    return value;
  }
  throw new RequestValidationError("provider must be apple_app_store or google_play.");
}

function parseVerifyBody(value: unknown): VerifyPurchaseBody {
  if (!isObjectRecord(value)) {
    throw new RequestValidationError("Invalid request body.");
  }

  const provider = normalizeProvider(value.provider);
  const productId = typeof value.productId === "string" ? value.productId.trim() : "";
  if (!productId) {
    throw new RequestValidationError("productId is required.");
  }

  const body: VerifyPurchaseBody = {
    provider,
    productId,
  };

  if (provider === "apple_app_store") {
    const transactionId =
      typeof value.appleTransactionId === "string" ? value.appleTransactionId.trim() : "";
    if (!transactionId) {
      throw new RequestValidationError("appleTransactionId is required for apple_app_store.");
    }
    body.appleTransactionId = transactionId;
  } else {
    const purchaseToken =
      typeof value.googlePurchaseToken === "string" ? value.googlePurchaseToken.trim() : "";
    if (!purchaseToken) {
      throw new RequestValidationError("googlePurchaseToken is required for google_play.");
    }
    body.googlePurchaseToken = purchaseToken;
    body.packageName = typeof value.packageName === "string" ? value.packageName.trim() : "";
  }

  return body;
}

export async function POST(request: NextRequest) {
  let idempotencyContext: IdempotencyContext | null = null;
  const requestId = crypto.randomUUID();
  try {
    const limited = await enforceRateLimit(request, {
      bucket: "api-monetization-purchase-verify",
      limit: 30,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_VERIFY_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
    }

    const identity = await resolveCookbookIdentity(request);
    const body = parseVerifyBody((await request.json()) as unknown);
    const responseWithIdentity = (payload: unknown, status = 200) => {
      const response = NextResponse.json(payload, { status });
      withIdentityHeaders(response, identity.anonUserId);
      applyAnonymousIdentityCookie(response, identity);
      return response;
    };

    const idempotency = await beginIdempotentRequest({
      key: idempotencyKey,
      scope: `purchase-verify:${identity.anonUserId}:${body.provider}`,
      requestPayload: body,
    });

    if (idempotency.state === "in_progress") {
      return responseWithIdentity(
        { error: "This request is already being processed. Please retry shortly." },
        409,
      );
    }
    if (idempotency.state === "conflict") {
      return responseWithIdentity(
        { error: "Idempotency key was reused with a different payload." },
        409,
      );
    }
    if (idempotency.state === "replay") {
      const replayed = responseWithIdentity(idempotency.responseBody, idempotency.responseStatus);
      replayed.headers.set("Idempotency-Status", "replayed");
      return replayed;
    }
    if (idempotency.state === "started") {
      idempotencyContext = idempotency.context;
    }

    const verification =
      body.provider === "apple_app_store"
        ? await verifyProviderPurchase(body.provider, {
            transactionId: body.appleTransactionId!,
            expectedProductId: body.productId,
          })
        : await verifyProviderPurchase(body.provider, {
            purchaseToken: body.googlePurchaseToken!,
            expectedProductId: body.productId,
            packageName: body.packageName,
          });

    const credits = getCreditsForProduct(body.provider, verification.productId);
    if (!credits) {
      logPurchaseVerify({
        requestId,
        event: "verification_risk",
        reason: "unknown_product",
        provider: body.provider,
        productId: verification.productId,
        anonUserId: identity.anonUserId,
      });
      return responseWithIdentity(
        { error: "This product is not recognized for credits." },
        400,
      );
    }

    const existing = await getPurchaseByProviderTransaction(
      body.provider,
      verification.providerTransactionId,
    );

    if (existing && existing.anonUserId !== identity.anonUserId) {
      logPurchaseVerify({
        requestId,
        event: "verification_risk",
        reason: "replay_different_identity",
        provider: body.provider,
        providerTransactionId: verification.providerTransactionId,
        existingAnonUserId: existing.anonUserId,
        incomingAnonUserId: identity.anonUserId,
      });
      return responseWithIdentity(
        { error: "This purchase token has already been used." },
        409,
      );
    }

    if (existing && verification.state === "revoked" && existing.status !== "revoked") {
      const remainingToReverse = Math.max(0, existing.grantedCredits - existing.reversedCredits);
      if (remainingToReverse > 0) {
        const reversal = await applyPurchaseReversalDeduction({
          anonUserId: existing.anonUserId,
          amount: remainingToReverse,
          actor: "provider_reversal",
          reason: "Provider reported purchase revocation/refund.",
          idempotencyScope: "provider-reversal",
          idempotencyKey: `${body.provider}:${verification.providerTransactionId}`,
          metadata: {
            provider: body.provider,
            providerTransactionId: verification.providerTransactionId,
          },
        });
        const updated = await updatePurchaseRecord({
          provider: body.provider,
          providerTransactionId: verification.providerTransactionId,
          status: reversal.ok ? "revoked" : "reversal_pending",
          reversedCredits: existing.reversedCredits + (reversal.ok ? remainingToReverse : 0),
          outstandingReversalCredits: reversal.ok ? 0 : remainingToReverse,
          revokedAt: verification.revokedAt ?? new Date().toISOString(),
          payload: verification.payload,
          addRiskFlags: reversal.ok
            ? verification.riskFlags
            : [...verification.riskFlags, "provider_reversal_insufficient_credits"],
        });
        const responseBody = {
          purchase: updated,
          reversalApplied: reversal.ok,
          outstandingReversalCredits: reversal.ok ? 0 : remainingToReverse,
          balance: reversal.balance,
        };
        if (idempotencyContext) {
          await completeIdempotentRequest(idempotencyContext, 200, responseBody);
        }
        const response = responseWithIdentity(responseBody, 200);
        response.headers.set("Idempotency-Status", "stored");
        return response;
      }
    }

    if (existing) {
      const responseBody = {
        purchase: existing,
        replay: true,
      };
      if (idempotencyContext) {
        await completeIdempotentRequest(idempotencyContext, 200, responseBody);
      }
      const response = responseWithIdentity(responseBody, 200);
      response.headers.set("Idempotency-Status", "stored");
      return response;
    }

    if (verification.state !== "purchased") {
      const record = await createPurchaseRecord({
        provider: body.provider,
        providerTransactionId: verification.providerTransactionId,
        providerOriginalTransactionId: verification.providerOriginalTransactionId,
        anonUserId: identity.anonUserId,
        productId: verification.productId,
        status: verification.state === "revoked" ? "revoked" : "rejected",
        grantedCredits: 0,
        reversedCredits: 0,
        outstandingReversalCredits: 0,
        verifiedAt: null,
        revokedAt: verification.revokedAt,
        payload: verification.payload,
        riskFlags: verification.riskFlags,
      });
      const responseBody = {
        purchase: record,
        grantedCredits: 0,
      };
      if (idempotencyContext) {
        await completeIdempotentRequest(idempotencyContext, 200, responseBody);
      }
      const response = responseWithIdentity(responseBody, 200);
      response.headers.set("Idempotency-Status", "stored");
      return response;
    }

    const grantResult = await grantCredits({
      anonUserId: identity.anonUserId,
      amount: credits,
      actor: "purchase_verification",
      eventType: "purchase_grant",
      idempotencyScope: "purchase-credit-grant",
      idempotencyKey: `${body.provider}:${verification.providerTransactionId}`,
      metadata: {
        provider: body.provider,
        productId: verification.productId,
        providerTransactionId: verification.providerTransactionId,
      },
    });

    const record = await createPurchaseRecord({
      provider: body.provider,
      providerTransactionId: verification.providerTransactionId,
      providerOriginalTransactionId: verification.providerOriginalTransactionId,
      anonUserId: identity.anonUserId,
      productId: verification.productId,
      status: "verified",
      grantedCredits: credits,
      reversedCredits: 0,
      outstandingReversalCredits: 0,
      verifiedAt: verification.purchasedAt ?? new Date().toISOString(),
      revokedAt: null,
      payload: verification.payload,
      riskFlags: verification.riskFlags,
    });

    if (verification.riskFlags.length > 0) {
      logPurchaseVerify({
        requestId,
        event: "verification_risk",
        reason: "provider_risk_flags_present",
        provider: body.provider,
        providerTransactionId: verification.providerTransactionId,
        riskFlags: verification.riskFlags,
        anonUserId: identity.anonUserId,
      });
    }

    const responseBody = {
      purchase: record,
      grantedCredits: credits,
      balance: grantResult.balance,
    };
    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }
    const response = responseWithIdentity(responseBody, 200);
    response.headers.set("Idempotency-Status", "stored");
    return response;
  } catch (error) {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ProviderVerificationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    return NextResponse.json({ error: "Could not verify purchase." }, { status: 500 });
  }
}
