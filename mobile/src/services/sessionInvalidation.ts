import { clearMobileAuthToken } from "./auth";
import { resetMobileIdentityForSignOut } from "./mobileIdentity";

export function isInvalidAuthPayload(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const reason = (payload as Record<string, unknown>).reason;
  return reason === "account_deleted" || reason === "auth_invalid";
}

export async function clearInvalidMobileSession() {
  await clearMobileAuthToken();
  await resetMobileIdentityForSignOut();
}
