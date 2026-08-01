/**
 * Server-side purchase verification adapters.
 * Supports Apple App Store and Google Play product purchase verification.
 */
import { createHash, createSign } from "crypto";
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
  requestId?: string | null;
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

const ANDROID_PACKAGE_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const GOOGLE_PURCHASE_TOKEN_HASH_FIELD =
  "_googlePurchaseTokenSha256";

export function resolveGooglePlayPackageName(
  clientPackageName?: string | null,
) {
  const configuredPackageName = assertNonEmpty(
    process.env.GOOGLE_PLAY_PACKAGE_NAME,
    "GOOGLE_PLAY_PACKAGE_NAME",
  );
  if (!ANDROID_PACKAGE_NAME_PATTERN.test(configuredPackageName)) {
    throw new ProviderVerificationError(
      "GOOGLE_PLAY_PACKAGE_NAME is invalid.",
      500,
    );
  }

  const suppliedPackageName = clientPackageName?.trim() || "";
  if (suppliedPackageName && suppliedPackageName !== configuredPackageName) {
    throw new ProviderVerificationError(
      "packageName does not match the configured Android application.",
      400,
    );
  }
  return configuredPackageName;
}

export function buildGooglePurchaseTransactionId(
  orderId: string | null | undefined,
  purchaseToken: string,
) {
  const normalizedOrderId = orderId?.trim() || "";
  if (normalizedOrderId) {
    return normalizedOrderId;
  }
  const tokenHash = hashGooglePurchaseToken(purchaseToken);
  return `token_sha256:${tokenHash}`;
}

export function hashGooglePurchaseToken(purchaseToken: string) {
  return createHash("sha256").update(purchaseToken).digest("hex");
}

export function resolveGooglePurchaseState(
  purchaseState: unknown,
): PurchaseVerificationState {
  if (purchaseState === 0) {
    return "purchased";
  }
  if (purchaseState === 1) {
    return "canceled";
  }
  if (purchaseState === 2) {
    return "pending";
  }
  throw new ProviderVerificationError(
    "Google purchase response has an unrecognized purchase state.",
    502,
  );
}

/** Historical lookup only. New purchase tokens are represented by a SHA-256 digest. */
export function buildLegacyGooglePurchaseTransactionIdForLookup(
  purchaseToken: string,
) {
  return `token:${purchaseToken}`;
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

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function extractGoogleErrorDiagnostics(payload: unknown) {
  const root = asObjectRecord(payload);
  const error = asObjectRecord(root?.error) ?? root;
  const details = Array.isArray(error?.details) ? error.details : [];
  const firstDetail = details.map(asObjectRecord).find(Boolean) ?? null;

  return {
    googleErrorCode: typeof error?.code === "number" ? error.code : undefined,
    googleErrorStatus: asTrimmedString(error?.status) || undefined,
    googleErrorReason:
      asTrimmedString(firstDetail?.reason) ||
      asTrimmedString(error?.reason) ||
      asTrimmedString(root?.error) ||
      undefined,
    googleErrorMessage:
      asTrimmedString(error?.message) ||
      asTrimmedString(root?.error_description) ||
      undefined,
  };
}

function logGooglePlayVerificationDiagnostic(event: Record<string, unknown>) {
  console.info("[google-play-purchase-verification]", JSON.stringify(event));
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

function buildAppleJwt() {
  const issuerId = assertNonEmpty(process.env.APPLE_IAP_ISSUER_ID, "APPLE_IAP_ISSUER_ID");
  const keyId = assertNonEmpty(process.env.APPLE_IAP_KEY_ID, "APPLE_IAP_KEY_ID");
  const privateKeyRaw = assertNonEmpty(process.env.APPLE_IAP_PRIVATE_KEY, "APPLE_IAP_PRIVATE_KEY");
  const bundleId = assertNonEmpty(
    process.env.APPLE_BUNDLE_ID ?? "com.flavorfusionchef.mobile",
    "APPLE_BUNDLE_ID",
  );
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 10 * 60;
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: issuedAt,
    exp: expiresAt,
    aud: "appstoreconnect-v1",
    bid: bundleId,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  let signature: Buffer;
  try {
    signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  } catch {
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
    (production.response.status === 404 ||
      production.response.status === 401 ||
      production.response.status === 400);
  const sandbox = shouldFallbackToSandbox
    ? await fetchJson(sandboxUrl, { method: "GET", headers })
    : null;
  const selected = sandbox ?? production;

  if (!selected.response.ok) {
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

async function getGoogleAccessToken(requestId?: string | null) {
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
    const payload = (await response.json().catch(() => null)) as unknown;
    logGooglePlayVerificationDiagnostic({
      requestId: requestId || undefined,
      event: "google_play_oauth_response_failed",
      httpStatus: response.status,
      ...extractGoogleErrorDiagnostics(payload),
    });
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

  const packageName = resolveGooglePlayPackageName(input.packageName);
  const accessToken = await getGoogleAccessToken(input.requestId);
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
    logGooglePlayVerificationDiagnostic({
      requestId: input.requestId || undefined,
      event: "google_play_verification_response_failed",
      httpStatus: response.status,
      packageName,
      productId: expectedProductId,
      ...extractGoogleErrorDiagnostics(payload),
    });
    throw new ProviderVerificationError("Google purchase verification failed.", 502);
  }

  const orderId = typeof payload.orderId === "string" ? payload.orderId.trim() : "";
  const providerTransactionId = buildGooglePurchaseTransactionId(
    orderId,
    purchaseToken,
  );
  const state = resolveGooglePurchaseState(payload.purchaseState);
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
    payload: {
      ...payload,
      [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: hashGooglePurchaseToken(purchaseToken),
    },
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
