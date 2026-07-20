import { clearMobileAuthToken } from "./auth";
import { hasInvalidMobileAuthReason } from "./accountOwnership";
import {
  isMobileSessionIdentityCurrent,
  type MobileSessionIdentity,
} from "./authSession";
import { resetMobileIdentityForSignOut } from "./mobileIdentity";

export function isInvalidAuthPayload(payload: unknown) {
  return hasInvalidMobileAuthReason(payload);
}

export async function clearInvalidMobileSession(expectedIdentity?: MobileSessionIdentity) {
  if (expectedIdentity && !isMobileSessionIdentityCurrent(expectedIdentity)) {
    return false;
  }
  await clearMobileAuthToken();
  await resetMobileIdentityForSignOut();
  return true;
}
