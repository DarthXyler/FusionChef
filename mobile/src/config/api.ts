const DEFAULT_API_BASE_URL = "https://flavor-fusion-chef.vercel.app";

export function getApiBaseUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, "");
  }

  return DEFAULT_API_BASE_URL;
}
