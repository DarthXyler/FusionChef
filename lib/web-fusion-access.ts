/**
 * Web fusion feature switch.
 *
 * The mobile app still uses the backend APIs, but the browser-based fusion UI can
 * be retired without deleting its code. Set WEB_FUSION_ENABLED=true to bring the
 * legacy web interface back.
 */
export function isWebFusionEnabled() {
  return process.env.WEB_FUSION_ENABLED === "true";
}

export function isLikelyMobileAppRequest(request: Request) {
  const deviceKey = request.headers.get("x-flavor-fusion-device-key")?.trim() ?? "";
  return deviceKey.length >= 16;
}

export function shouldBlockRetiredWebFusionRequest(request: Request) {
  return !isWebFusionEnabled() && !isLikelyMobileAppRequest(request);
}
