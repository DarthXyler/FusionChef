/**
 * Authentication configuration helpers.
 * Keeps provider/client/session values in one place.
 */

const DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;

function parseSessionMaxAgeSeconds() {
  const parsed = Number.parseInt(process.env.AUTH_SESSION_MAX_AGE_SECONDS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 60 * 60 || parsed > 60 * 60 * 24 * 30) {
    return DEFAULT_SESSION_MAX_AGE_SECONDS;
  }
  return parsed;
}

function splitCsv(raw: string | undefined) {
  if (!raw) {
    return [] as string[];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function getSessionSecret() {
  const secret = process.env.AUTH_SESSION_SECRET?.trim();
  return secret ?? "";
}

export function getSessionMaxAgeSeconds() {
  return parseSessionMaxAgeSeconds();
}

export function getGoogleOauthConfig() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "",
  };
}

export function getAllowedAdminEmails() {
  return splitCsv(process.env.ADMIN_AUTH_EMAIL_ALLOWLIST).map((email) =>
    email.toLowerCase(),
  );
}

export function isAdminEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return getAllowedAdminEmails().includes(normalized);
}

export function isGoogleOauthConfigured() {
  const config = getGoogleOauthConfig();
  return Boolean(config.clientId && config.clientSecret);
}

