/**
 * Google OAuth helpers.
 */
import { getGoogleOauthConfig } from "@/lib/auth-config";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

type GoogleIdTokenClaims = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  aud: string;
  exp: number;
};

function decodeBase64UrlJson(raw: string) {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
}

function parseGoogleIdTokenClaims(rawIdToken: string, expectedAudience: string) {
  const parts = rawIdToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid Google id_token format.");
  }
  const payload = decodeBase64UrlJson(parts[1]);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid Google id_token payload.");
  }
  const candidate = payload as Record<string, unknown>;
  const sub = typeof candidate.sub === "string" ? candidate.sub.trim() : "";
  const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
  const aud = typeof candidate.aud === "string" ? candidate.aud.trim() : "";
  const exp = typeof candidate.exp === "number" && Number.isFinite(candidate.exp) ? Math.trunc(candidate.exp) : 0;
  const emailVerified = candidate.email_verified === true;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const picture = typeof candidate.picture === "string" ? candidate.picture.trim() : "";
  if (!sub || !email || !aud || exp <= 0) {
    throw new Error("Google id_token is missing required claims.");
  }
  if (aud !== expectedAudience) {
    throw new Error("Google id_token audience mismatch.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) {
    throw new Error("Google id_token has expired.");
  }
  return {
    sub,
    email,
    email_verified: emailVerified,
    name,
    picture,
    aud,
    exp,
  } satisfies GoogleIdTokenClaims;
}

export function buildGoogleOauthUrl(params: {
  redirectUri: string;
  state: string;
}) {
  const config = getGoogleOauthConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google OAuth is not configured.");
  }
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(params: {
  code: string;
  redirectUri: string;
}) {
  const config = getGoogleOauthConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google OAuth is not configured.");
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: params.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
    }),
    cache: "no-store",
  });

  const payload = (await tokenResponse.json()) as Record<string, unknown>;
  if (!tokenResponse.ok) {
    const message = typeof payload.error_description === "string" ? payload.error_description : "Google token exchange failed.";
    throw new Error(message);
  }

  const idToken = typeof payload.id_token === "string" ? payload.id_token.trim() : "";
  if (!idToken) {
    throw new Error("Google token response did not include id_token.");
  }

  const claims = parseGoogleIdTokenClaims(idToken, config.clientId);
  if (!claims.email_verified) {
    throw new Error("Google account email is not verified.");
  }

  return {
    subject: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
    avatarUrl: claims.picture ?? "",
  };
}

