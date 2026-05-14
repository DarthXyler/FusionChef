/**
 * Apple Sign in token verification.
 * Mobile sends Apple's identity token; the backend validates the signature and claims.
 */
import { createPublicKey, verify as verifyCryptoSignature, type JsonWebKey } from "crypto";
import { getAppleSignInAudiences } from "@/lib/auth-config";

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_CACHE_MS = 6 * 60 * 60 * 1000;

type AppleJwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  kty?: string;
  use?: string;
};

type AppleJwksPayload = {
  keys?: AppleJwk[];
};

type AppleIdTokenHeader = {
  alg: string;
  kid: string;
};

type AppleIdTokenClaims = {
  sub: string;
  email: string;
  emailVerified: boolean;
  aud: string | string[];
  iss: string;
  exp: number;
  iat: number;
};

let appleKeysCache: { keys: AppleJwk[]; expiresAt: number } | null = null;

function decodeBase64UrlBuffer(input: string) {
  return Buffer.from(input, "base64url");
}

function decodeBase64UrlJson<T>(input: string) {
  return JSON.parse(decodeBase64UrlBuffer(input).toString("utf8")) as T;
}

async function getAppleSigningKeys() {
  if (appleKeysCache && appleKeysCache.expiresAt > Date.now()) {
    return appleKeysCache.keys;
  }

  const response = await fetch(APPLE_JWKS_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Could not fetch Apple sign-in keys.");
  }

  const payload = (await response.json()) as AppleJwksPayload;
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  if (keys.length === 0) {
    throw new Error("Apple sign-in keys response was empty.");
  }

  appleKeysCache = {
    keys,
    expiresAt: Date.now() + APPLE_KEYS_CACHE_MS,
  };
  return keys;
}

function readStringClaim(candidate: Record<string, unknown>, key: string) {
  return typeof candidate[key] === "string" ? candidate[key].trim() : "";
}

function readNumberClaim(candidate: Record<string, unknown>, key: string) {
  const value = candidate[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function isEmailVerified(value: unknown) {
  return value === true || value === "true";
}

function audienceMatches(audience: string | string[], allowedAudiences: string[]) {
  const audiences = Array.isArray(audience) ? audience : [audience];
  return audiences.some((value) => allowedAudiences.includes(value));
}

function parseAppleIdTokenClaims(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid Apple id_token payload.");
  }

  const candidate = payload as Record<string, unknown>;
  const audValue = candidate.aud;
  const aud =
    typeof audValue === "string"
      ? audValue.trim()
      : Array.isArray(audValue)
        ? audValue.filter((value): value is string => typeof value === "string")
        : "";
  const claims: AppleIdTokenClaims = {
    sub: readStringClaim(candidate, "sub"),
    email: readStringClaim(candidate, "email"),
    emailVerified: isEmailVerified(candidate.email_verified),
    aud,
    iss: readStringClaim(candidate, "iss"),
    exp: readNumberClaim(candidate, "exp"),
    iat: readNumberClaim(candidate, "iat"),
  };

  if (!claims.sub || !claims.iss || !claims.aud || claims.exp <= 0 || claims.iat <= 0) {
    throw new Error("Apple id_token is missing required claims.");
  }
  if (claims.iss !== APPLE_ISSUER) {
    throw new Error("Apple id_token issuer mismatch.");
  }

  const allowedAudiences = getAppleSignInAudiences();
  if (allowedAudiences.length === 0) {
    throw new Error("Apple Sign in audience is not configured.");
  }
  if (!audienceMatches(claims.aud, allowedAudiences)) {
    throw new Error("Apple id_token audience mismatch.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error("Apple id_token has expired.");
  }
  return claims;
}

export async function verifyAppleIdentityToken(identityToken: string) {
  const token = identityToken.trim();
  const [headerBase64, payloadBase64, signatureBase64] = token.split(".");
  if (!headerBase64 || !payloadBase64 || !signatureBase64) {
    throw new Error("Invalid Apple id_token format.");
  }

  const header = decodeBase64UrlJson<AppleIdTokenHeader>(headerBase64);
  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported Apple id_token signature.");
  }

  const keys = await getAppleSigningKeys();
  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key) {
    appleKeysCache = null;
    throw new Error("Apple signing key was not found.");
  }

  const publicKey = createPublicKey({ key: key as JsonWebKey, format: "jwk" });
  const isSignatureValid = verifyCryptoSignature(
    "RSA-SHA256",
    Buffer.from(`${headerBase64}.${payloadBase64}`),
    publicKey,
    decodeBase64UrlBuffer(signatureBase64),
  );
  if (!isSignatureValid) {
    throw new Error("Apple id_token signature is invalid.");
  }

  const claims = parseAppleIdTokenClaims(decodeBase64UrlJson<unknown>(payloadBase64));
  return {
    subject: claims.sub,
    email: claims.email,
    emailVerified: claims.emailVerified,
  };
}
