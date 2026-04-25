/**
 * OAuth state payload helpers.
 */
import { randomUUID } from "crypto";

export const AUTH_OAUTH_STATE_COOKIE = "ffc_auth_oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

export type OAuthStatePayload = {
  state: string;
  provider: "google";
  returnTo: string;
  platform: "web" | "mobile";
  redirectUri: string;
};

function toBase64Url(input: string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function isAllowedRelativeReturnPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
}

export function normalizeReturnToPath(value: string | null, fallback = "/admin/monetization") {
  const candidate = (value ?? "").trim();
  if (!candidate || !isAllowedRelativeReturnPath(candidate)) {
    return fallback;
  }
  return candidate;
}

export function normalizeMobileRedirectUri(value: string | null) {
  const candidate = (value ?? "").trim();
  if (!candidate) {
    return "";
  }
  if (!candidate.startsWith("flavorfusionchef://")) {
    return "";
  }
  return candidate;
}

export function createOAuthStatePayload(input: {
  returnTo: string;
  platform: "web" | "mobile";
  redirectUri: string;
}) {
  return {
    state: randomUUID(),
    provider: "google",
    returnTo: input.returnTo,
    platform: input.platform,
    redirectUri: input.redirectUri,
  } satisfies OAuthStatePayload;
}

export function encodeOAuthStatePayload(payload: OAuthStatePayload) {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeOAuthStatePayload(raw: string) {
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    const state = typeof candidate.state === "string" ? candidate.state.trim() : "";
    const provider = candidate.provider === "google" ? "google" : null;
    const returnTo = typeof candidate.returnTo === "string" ? candidate.returnTo.trim() : "";
    const platform = candidate.platform === "mobile" ? "mobile" : candidate.platform === "web" ? "web" : null;
    const redirectUri = typeof candidate.redirectUri === "string" ? candidate.redirectUri.trim() : "";
    if (!state || !provider || !returnTo || !platform) {
      return null;
    }
    return {
      state,
      provider,
      returnTo,
      platform,
      redirectUri,
    } satisfies OAuthStatePayload;
  } catch {
    return null;
  }
}

export function getOauthStateMaxAgeSeconds() {
  return OAUTH_STATE_MAX_AGE_SECONDS;
}

