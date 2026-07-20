import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { getApiBaseUrl } from "../config/api";
import {
  captureMobileSessionIdentity,
  transitionMobileSessionIdentity,
} from "./authSession";
import { resetMobileIdentityForSignOut } from "./mobileIdentity";

const MOBILE_AUTH_TOKEN_KEY = "flavor_fusion_mobile_auth_token";
const ANDROID_CHROME_PACKAGE = "com.android.chrome";
let volatileAuthToken: string | null = null;

export type MobileAuthSession = {
  userId: string;
  email: string;
  name: string;
  avatarUrl?: string;
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
  const avatarUrl = typeof candidate.avatarUrl === "string" ? candidate.avatarUrl.trim() : "";
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
  return { userId, email, name, avatarUrl, role, channel, iat, exp };
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
  if (volatileAuthToken !== null) {
    return volatileAuthToken;
  }

  try {
    const token = (await SecureStore.getItemAsync(MOBILE_AUTH_TOKEN_KEY))?.trim() ?? "";
    return volatileAuthToken ?? token;
  } catch {
    return volatileAuthToken ?? "";
  }
}

export async function clearMobileAuthToken() {
  volatileAuthToken = "";
  transitionMobileSessionIdentity(null, { forceRevision: true });
  try {
    await SecureStore.deleteItemAsync(MOBILE_AUTH_TOKEN_KEY);
  } catch {
    // Ignore secure store cleanup failures.
  }
}

export async function isMobileAuthenticated() {
  return (await getMobileAuthSession()) !== null;
}

export async function getMobileAuthRequestContext() {
  const token = await getMobileAuthToken();
  if (!token) {
    transitionMobileSessionIdentity(null);
    return {
      token: "",
      session: null,
      identity: captureMobileSessionIdentity(),
    };
  }

  const session = parseMobileAuthSessionToken(token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!session || session.exp <= nowSeconds) {
    await clearMobileAuthToken();
    try {
      await resetMobileIdentityForSignOut();
    } catch {
      // The authenticated state is already cleared; identity rotation is best effort.
    }
    return {
      token: "",
      session: null,
      identity: captureMobileSessionIdentity(),
    };
  }

  transitionMobileSessionIdentity(session.userId);
  return {
    token,
    session,
    identity: captureMobileSessionIdentity(),
  };
}

export async function getMobileAuthSession() {
  return (await getMobileAuthRequestContext()).session;
}

async function storeMobileAuthToken(token: string) {
  const normalizedToken = token.trim();
  const session = parseMobileAuthSessionToken(normalizedToken);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!session || session.exp <= nowSeconds) {
    throw new Error("Login response did not include a valid mobile session.");
  }

  await SecureStore.setItemAsync(MOBILE_AUTH_TOKEN_KEY, normalizedToken);
  volatileAuthToken = normalizedToken;
  transitionMobileSessionIdentity(session.userId, { forceRevision: true });
}

export async function loginWithGoogleForMobile() {
  const redirectUri = Linking.createURL("auth/callback");
  const startUrl = `${getApiBaseUrl()}/api/auth/google/start?platform=mobile&redirectUri=${encodeURIComponent(
    redirectUri,
  )}`;

  const result =
    Platform.OS === "android"
      ? await openGoogleAuthSessionWithChromeForAndroid(startUrl, redirectUri)
      : await WebBrowser.openAuthSessionAsync(startUrl, redirectUri);
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

  await storeMobileAuthToken(token);
  return true;
}

async function openGoogleAuthSessionWithChromeForAndroid(startUrl: string, redirectUri: string) {
  const customTabs = await WebBrowser.getCustomTabsSupportingBrowsersAsync();
  const browserPackages = customTabs.browserPackages;
  const servicePackages = customTabs.servicePackages;
  const configuredPackages = [
    ...browserPackages,
    ...servicePackages,
    customTabs.preferredBrowserPackage,
    customTabs.defaultBrowserPackage,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const chromePackage = configuredPackages.find((value) => value === ANDROID_CHROME_PACKAGE);
  const sharedCustomTabsPackage =
    browserPackages.find((value) => servicePackages.includes(value)) ?? null;
  const browserPackage =
    chromePackage ??
    customTabs.preferredBrowserPackage ??
    sharedCustomTabsPackage ??
    browserPackages[0] ??
    null;

  if (!browserPackage) {
    return WebBrowser.openAuthSessionAsync(startUrl, redirectUri);
  }
  return WebBrowser.openAuthSessionAsync(startUrl, redirectUri, {
    browserPackage,
  });
}

function normalizeAppleName(fullName: AppleAuthentication.AppleAuthenticationFullName | null) {
  if (!fullName) {
    return {};
  }
  return {
    givenName: fullName.givenName ?? "",
    middleName: fullName.middleName ?? "",
    familyName: fullName.familyName ?? "",
  };
}

function isAppleAuthCancelled(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_REQUEST_CANCELED"
  );
}

export async function loginWithAppleForMobile() {
  if (Platform.OS !== "ios") {
    throw new Error("Apple Sign in is only available on iOS.");
  }

  const isAvailable = await AppleAuthentication.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Apple Sign in is only available on supported Apple devices.");
  }

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (error) {
    if (isAppleAuthCancelled(error)) {
      return false;
    }
    throw error;
  }

  const identityToken = credential.identityToken?.trim() ?? "";
  if (!identityToken) {
    throw new Error("Apple did not return a sign-in token. Please try again.");
  }

  const response = await fetch(`${getApiBaseUrl()}/api/auth/apple/mobile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      identityToken,
      fullName: normalizeAppleName(credential.fullName),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.error === "string" && payload.error.trim().length > 0
        ? payload.error
        : "Could not complete Apple login right now.";
    throw new Error(message);
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Apple login response did not include a session token.");
  }

  await storeMobileAuthToken(token);
  return true;
}
