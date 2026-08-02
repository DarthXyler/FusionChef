/**
 * Authentication configuration helpers.
 * Keeps provider/client/session values in one place.
 */

const DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;
const DEFAULT_MOBILE_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS = 15 * 60;

function parseSessionMaxAgeSeconds(rawValue: string | undefined, fallback: number) {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 60 * 60 || parsed > 60 * 60 * 24 * 90) {
    return fallback;
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
  return parseSessionMaxAgeSeconds(
    process.env.AUTH_SESSION_MAX_AGE_SECONDS,
    DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS,
  );
}

export function getAdminWebSessionMaxAgeSeconds() {
  return parseSessionMaxAgeSeconds(
    process.env.AUTH_SESSION_MAX_AGE_SECONDS_ADMIN,
    DEFAULT_ADMIN_SESSION_MAX_AGE_SECONDS,
  );
}

export function getMobileSessionMaxAgeSeconds() {
  return parseSessionMaxAgeSeconds(
    process.env.AUTH_SESSION_MAX_AGE_SECONDS_MOBILE,
    DEFAULT_MOBILE_SESSION_MAX_AGE_SECONDS,
  );
}

export function getAccountDeletionRecentAuthMaxAgeSeconds() {
  const parsed = Number.parseInt(
    process.env.ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS ?? "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 60 || parsed > 60 * 60) {
    return DEFAULT_ACCOUNT_DELETION_RECENT_AUTH_MAX_AGE_SECONDS;
  }
  return parsed;
}

export function getGoogleOauthConfig() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "",
  };
}

export function getAppleSignInAudiences() {
  const explicitAudiences = splitCsv(process.env.APPLE_SIGN_IN_AUDIENCES);
  const singleAudience = process.env.APPLE_SIGN_IN_AUDIENCE?.trim() ?? "";
  const bundleId = process.env.APPLE_BUNDLE_ID?.trim() ?? "";
  const audiences = [...explicitAudiences, singleAudience, bundleId].filter(Boolean);
  return [...new Set(audiences)];
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
