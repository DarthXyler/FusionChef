import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { getApiBaseUrl } from "../config/api";

const MOBILE_AUTH_TOKEN_KEY = "flavor_fusion_mobile_auth_token";

export type MobileAuthSession = {
  userId: string;
  email: string;
  name: string;
  role: "user" | "admin";
  channel: "web" | "mobile";
  iat: number;
  exp: number;
};

function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  if (typeof globalThis.atob === "function") {
    return globalThis.atob(padded);
  }
  return "";
}

function parseMobileAuthSessionPayload(payload: unknown): MobileAuthSession | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  const userId = typeof candidate.userId === "string" ? candidate.userId.trim() : "";
  const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const role = candidate.role === "admin" ? "admin" : candidate.role === "user" ? "user" : null;
  const channel =
    candidate.channel === "mobile" ? "mobile" : candidate.channel === "web" ? "web" : null;
  const iat =
    typeof candidate.iat === "number" && Number.isFinite(candidate.iat)
      ? Math.trunc(candidate.iat)
      : 0;
  const exp =
    typeof candidate.exp === "number" && Number.isFinite(candidate.exp)
      ? Math.trunc(candidate.exp)
      : 0;
  if (!userId || !email || !name || !role || !channel || iat <= 0 || exp <= 0) {
    return null;
  }
  return { userId, email, name, role, channel, iat, exp };
}

export function parseMobileAuthSessionToken(token: string) {
  const [, payloadBase64] = token.trim().split(".");
  if (!payloadBase64) {
    return null;
  }
  try {
    return parseMobileAuthSessionPayload(JSON.parse(decodeBase64Url(payloadBase64)));
  } catch {
    return null;
  }
}

export async function getMobileAuthToken() {
  try {
    const token = (await SecureStore.getItemAsync(MOBILE_AUTH_TOKEN_KEY))?.trim() ?? "";
    if (!token) {
      return "";
    }
    return token;
  } catch {
    return "";
  }
}

export async function clearMobileAuthToken() {
  try {
    await SecureStore.deleteItemAsync(MOBILE_AUTH_TOKEN_KEY);
  } catch {
    // Ignore secure store cleanup failures.
  }
}

export async function isMobileAuthenticated() {
  const token = await getMobileAuthToken();
  return token.length > 0;
}

export async function getMobileAuthSession() {
  const token = await getMobileAuthToken();
  if (!token) {
    return null;
  }
  return parseMobileAuthSessionToken(token);
}

export async function loginWithGoogleForMobile() {
  const redirectUri = Linking.createURL("auth/callback");
  const startUrl = `${getApiBaseUrl()}/api/auth/google/start?platform=mobile&redirectUri=${encodeURIComponent(
    redirectUri,
  )}`;

  const result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUri);
  if (result.type !== "success") {
    return false;
  }

  const callbackUrl = result.url?.trim() ?? "";
  if (!callbackUrl) {
    return false;
  }
  const parsed = Linking.parse(callbackUrl);
  const token = typeof parsed.queryParams?.token === "string" ? parsed.queryParams.token.trim() : "";
  if (!token) {
    return false;
  }

  await SecureStore.setItemAsync(MOBILE_AUTH_TOKEN_KEY, token);
  return true;
}
