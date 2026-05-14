import { clearMobileAuthToken } from "./auth";
import { resetMobileIdentityForSignOut } from "./mobileIdentity";
import { resetMonetizationAccountSnapshotForSignedOutSession } from "./monetization";
import { migrateLegacyProfileOverridesToCurrentAccount } from "./profile";

export async function signOutAndResetMobileSession() {
  await migrateLegacyProfileOverridesToCurrentAccount();
  await clearMobileAuthToken();
  resetMonetizationAccountSnapshotForSignedOutSession();
  await Promise.all([
    resetMobileIdentityForSignOut(),
  ]);
}
