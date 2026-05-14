import { clearMobileAuthToken } from "./auth";
import { clearDashboardFusionHistory } from "./dashboardHistory";
import { resetMobileIdentityForSignOut } from "./mobileIdentity";
import { resetMonetizationAccountSnapshotForSignedOutSession } from "./monetization";
import { clearMobileProfileOverrides } from "./profile";

export async function signOutAndResetMobileSession() {
  await clearMobileAuthToken();
  resetMonetizationAccountSnapshotForSignedOutSession();
  await Promise.all([
    resetMobileIdentityForSignOut(),
    clearMobileProfileOverrides(),
    clearDashboardFusionHistory(),
  ]);
}
