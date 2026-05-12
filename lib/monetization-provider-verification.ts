/**
 * Server-side purchase verification adapters.
 * Supports Apple App Store and Google Play product purchase verification.
 */
import { createPrivateKey, createSign } from "crypto";
import type { PurchaseProvider } from "@/lib/monetization-credit-packs";

type PurchaseVerificationState = "purchased" | "revoked" | "pending" | "canceled";

export type VerificationResult = {
  provider: PurchaseProvider;
  providerTransactionId: string;
  providerOriginalTransactionId: string | null;
  productId: string;
  state: PurchaseVerificationState;
  purchasedAt: string | null;
  revokedAt: string | null;
  riskFlags: string[];
  payload: Record<string, unknown>;
};

export type AppleVerificationInput = {
  transactionId: string;
  expectedProductId: string;
};

export type GoogleVerificationInput = {
  purchaseToken: string;
  expectedProductId: string;
  packageName?: string | null;
};

class ProviderVerificationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertNonEmpty(value: string | undefined, fieldName: string) {
  if (!value || value.trim().length === 0) {
    throw new ProviderVerificationError(`${fieldName} is not configured.`, 500);
  }
  return value.trim();
}

function toIsoFromMillis(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return new Date(numeric).toISOString();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payloadJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as unknown;
    return { response, payload };
  } catch {
    throw new ProviderVerificationError("Apple verification request could not reach App Store.", 502);
  }
}

function getApplePrivateKeyDiagnostics(privateKeyRaw: string, privateKey: string) {
  let parseableAsPrivateKey = false;
  let parseError = "";

  try {
    createPrivateKey(privateKey);
    parseableAsPrivateKey = true;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return {
    rawLength: privateKeyRaw.length,
    normalizedLength: privateKey.length,
    hasEscapedNewlines: privateKeyRaw.includes("\\n"),
    hasLiteralNewlines: privateKeyRaw.includes("\n"),
    startsWithBeginPrivateKey: privateKey.startsWith("-----BEGIN PRIVATE KEY-----"),
    endsWithEndPrivateKey: privateKey.endsWith("-----END PRIVATE KEY-----"),
    wrappedInDoubleQuotes: privateKeyRaw.startsWith('"') && privateKeyRaw.endsWith('"'),
    wrappedInSingleQuotes: privateKeyRaw.startsWith("'") && privateKeyRaw.endsWith("'"),
    parseableAsPrivateKey,
    parseError: parseError.slice(0, 160),
  };
}

function logApplePrivateKeyDiagnostics(privateKeyRaw: string, privateKey: string, error: unknown) {
  console.warn(
    "[monetization/apple-iap-key]",
    JSON.stringify({
      event: "private_key_sign_failed",
      diagnostics: getApplePrivateKeyDiagnostics(privateKeyRaw, privateKey),
      signError: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    }),
  );
}

function summarizeAppleVerificationPayload(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { payloadType: typeof payload };
  }

  const candidate = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["errorCode", "errorMessage", "status", "reason"]) {
    const value = candidate[key];
    if (typeof value === "string" || typeof value === "number") {
      summary[key] = value;
    }
  }
  return summary;
}

function logAppleVerificationFailure(params: {
  transactionId: string;
  productionStatus: number;
  sandboxStatus?: number;
  selectedEnvironment: "production" | "sandbox";
  selectedPayload: unknown;
}) {
  console.warn(
    "[monetization/apple-iap-verify]",
    JSON.stringify({
      event: "transaction_lookup_failed",
      transactionIdLength: params.transactionId.length,
      transactionIdPrefix: params.transactionId.slice(0, 4),
      productionStatus: params.productionStatus,
      sandboxStatus: params.sandboxStatus ?? null,
      selectedEnvironment: params.selectedEnvironment,
      appleResponse: summarizeAppleVerificationPayload(params.selectedPayload),
    }),
  );
}

function buildAppleJwt() {
  const issuerId = assertNonEmpty(process.env.APPLE_IAP_ISSUER_ID, "APPLE_IAP_ISSUER_ID");
  const keyId = assertNonEmpty(process.env.APPLE_IAP_KEY_ID, "APPLE_IAP_KEY_ID");
  const privateKeyRaw = assertNonEmpty(process.env.APPLE_IAP_PRIVATE_KEY, "APPLE_IAP_PRIVATE_KEY");
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10 * 60;
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: issuedAt,
    exp: expiresAt,
    aud: "appstoreconnect-v1",
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  let signature: Buffer;
  try {
    signature = signer.sign(privateKey);
  } catch (error) {
    logApplePrivateKeyDiagnostics(privateKeyRaw, privateKey, error);
    throw new ProviderVerificationError(
      "Apple verification credentials could not sign the request.",
      500,
    );
  }
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function parseAppleSignedTransaction(
  signedTransactionInfo: string,
  expectedProductId: string,
) {
  const payload = decodeJwtPayload(signedTransactionInfo);
  if (!payload) {
    throw new ProviderVerificationError("Could not parse Apple transaction payload.", 502);
  }

  const transactionId =
    typeof payload.transactionId === "string" ? payload.transactionId.trim() : "";
  const originalTransactionId =
    typeof payload.originalTransactionId === "string"
      ? payload.originalTransactionId.trim()
      : "";
  const productId = typeof payload.productId === "string" ? payload.productId.trim() : "";
  const revocationDateIso = toIsoFromMillis(payload.revocationDate);
  const purchaseDateIso = toIsoFromMillis(payload.purchaseDate);

  if (!transactionId || !productId) {
    throw new ProviderVerificationError("Apple transaction payload missing identifiers.", 502);
  }

  const riskFlags: string[] = [];
  if (productId !== expectedProductId) {
    riskFlags.push("apple_product_id_mismatch");
  }

  return {
    providerTransactionId: transactionId,
    providerOriginalTransactionId: originalTransactionId || null,
    productId,
    state: revocationDateIso ? ("revoked" as const) : ("purchased" as const),
    purchasedAt: purchaseDateIso,
    revokedAt: revocationDateIso,
    riskFlags,
    payload,
  };
}

export async function verifyApplePurchase(
  input: AppleVerificationInput,
): Promise<VerificationResult> {
  const transactionId = input.transactionId.trim();
  if (!transactionId) {
    throw new ProviderVerificationError("transactionId is required.", 400);
  }
  if (!input.expectedProductId?.trim()) {
    throw new ProviderVerificationError("expectedProductId is required.", 400);
  }

  const jwt = buildAppleJwt();
  const productionUrl = `https://api.storekit.itunes.apple.com/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  const sandboxUrl = `https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };

  const production = await fetchJson(productionUrl, { method: "GET", headers });
  const shouldFallbackToSandbox =
    !production.response.ok &&
    (production.response.status === 404 || production.response.status === 400);
  const sandbox = shouldFallbackToSandbox
    ? await fetchJson(sandboxUrl, { method: "GET", headers })
    : null;
  const selected = sandbox ?? production;
  const selectedEnvironment = sandbox ? "sandbox" : "production";

  if (!selected.response.ok) {
    logAppleVerificationFailure({
      transactionId,
      productionStatus: production.response.status,
      sandboxStatus: sandbox?.response.status,
      selectedEnvironment,
      selectedPayload: selected.payload,
    });
    throw new ProviderVerificationError("Apple verification failed.", 502);
  }

  const signedTransactionInfo =
    typeof (selected.payload as { signedTransactionInfo?: unknown })?.signedTransactionInfo ===
    "string"
      ? ((selected.payload as { signedTransactionInfo: string }).signedTransactionInfo)
      : "";
  if (!signedTransactionInfo) {
    throw new ProviderVerificationError("Apple response missing signedTransactionInfo.", 502);
  }

  const parsed = parseAppleSignedTransaction(signedTransactionInfo, input.expectedProductId);
  return {
    provider: "apple_app_store",
    ...parsed,
  };
}

function buildGoogleServiceJwt() {
  const clientEmail = assertNonEmpty(
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL,
    "GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL",
  );
  const privateKeyRaw = assertNonEmpty(
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
    "GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY",
  );
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getGoogleAccessToken() {
  const assertion = buildGoogleServiceJwt();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new ProviderVerificationError("Google OAuth token request failed.", 502);
  }

  const payload = (await response.json()) as { access_token?: unknown };
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) {
    throw new ProviderVerificationError("Google OAuth response missing access token.", 502);
  }
  return accessToken;
}

export async function verifyGooglePurchase(
  input: GoogleVerificationInput,
): Promise<VerificationResult> {
  const purchaseToken = input.purchaseToken.trim();
  const expectedProductId = input.expectedProductId.trim();
  if (!purchaseToken) {
    throw new ProviderVerificationError("purchaseToken is required.", 400);
  }
  if (!expectedProductId) {
    throw new ProviderVerificationError("expectedProductId is required.", 400);
  }

  const configuredPackageName = assertNonEmpty(
    process.env.GOOGLE_PLAY_PACKAGE_NAME,
    "GOOGLE_PLAY_PACKAGE_NAME",
  );
  const packageName = (input.packageName?.trim() || configuredPackageName).trim();
  const accessToken = await getGoogleAccessToken();
  const verificationUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(expectedProductId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  const response = await fetch(verificationUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !payload) {
    throw new ProviderVerificationError("Google purchase verification failed.", 502);
  }

  const orderId = typeof payload.orderId === "string" ? payload.orderId.trim() : "";
  const providerTransactionId = orderId || `token:${purchaseToken}`;
  const purchaseState = Number(payload.purchaseState);
  const state: PurchaseVerificationState =
    purchaseState === 0 ? "purchased" : purchaseState === 1 ? "canceled" : "pending";
  const productId = expectedProductId;
  const riskFlags: string[] = [];
  if (typeof payload.purchaseType === "number" && payload.purchaseType !== 0) {
    riskFlags.push("google_purchase_type_non_standard");
  }

  return {
    provider: "google_play",
    providerTransactionId,
    providerOriginalTransactionId: orderId || null,
    productId,
    state,
    purchasedAt: toIsoFromMillis(payload.purchaseTimeMillis),
    revokedAt: state === "canceled" ? toIsoFromMillis(payload.purchaseTimeMillis) : null,
    riskFlags,
    payload,
  };
}

export async function verifyProviderPurchase(
  provider: PurchaseProvider,
  input: AppleVerificationInput | GoogleVerificationInput,
) {
  if (provider === "apple_app_store") {
    return verifyApplePurchase(input as AppleVerificationInput);
  }
  return verifyGooglePurchase(input as GoogleVerificationInput);
}

export { ProviderVerificationError };
