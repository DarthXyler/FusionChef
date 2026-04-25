import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { getApiBaseUrl } from "../config/api";

const MOBILE_AUTH_TOKEN_KEY = "flavor_fusion_mobile_auth_token";

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
