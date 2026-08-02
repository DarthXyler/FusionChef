import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AccountDeletionAuthorizationError,
  assertAccountDeletionDoesNotIncludeActor,
  evaluateAccountDeletionAuthorization,
} from "./account-deletion-authorization-core.ts";

const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);

const now = 1_800_000_000;
const session = {
  userId: "admin-1",
  email: "stale@example.com",
  name: "Stale claim",
  role: "user",
  channel: "web",
  iat: now - 300,
  exp: now + 3600,
};
const currentAdmin = {
  id: "admin-1",
  email: "admin@example.com",
  name: "Current Admin",
  avatarUrl: "",
  provider: "google",
  providerSubject: "provider-admin-1",
  role: "admin",
};

function authorize(overrides = {}) {
  return evaluateAccountDeletionAuthorization({
    session,
    currentUser: currentAdmin,
    allowedAdminEmails: ["admin@example.com"],
    nowEpochSeconds: now,
    recentAuthMaxAgeSeconds: 900,
    bearerPresented: false,
    ...overrides,
  });
}

function assertCode(fn, code) {
  assert.throws(
    fn,
    (error) =>
      error instanceof AccountDeletionAuthorizationError &&
      error.code === code,
  );
}

test("valid active web admin uses current database identity, not JWT actor claims", () => {
  const principal = authorize();
  assert.deepEqual(principal, {
    actor: "auth_user:admin-1",
    actorAuthUserId: "admin-1",
    actorEmail: "admin@example.com",
  });
});

test("removed allowlist member is rejected", () => {
  assertCode(
    () => authorize({ allowedAdminEmails: ["another@example.com"] }),
    "account_deletion_forbidden",
  );
});

test("demoted, deleted, and expired admins are rejected", async (t) => {
  await t.test("demoted", () => {
    assertCode(
      () => authorize({ currentUser: { ...currentAdmin, role: "user" } }),
      "account_deletion_forbidden",
    );
  });
  await t.test("deleted", () => {
    assertCode(
      () => authorize({ currentUser: null }),
      "admin_account_unavailable",
    );
  });
  await t.test("expired", () => {
    assertCode(
      () => authorize({ session: { ...session, exp: now } }),
      "admin_session_invalid",
    );
  });
});

test("mobile bearer and static-token-only attempts cannot authorize deletion", () => {
  assertCode(
    () =>
      authorize({
        bearerPresented: true,
        session: { ...session, channel: "mobile" },
      }),
    "web_admin_session_required",
  );
  assertCode(
    () => authorize({ session: null, currentUser: null }),
    "web_admin_session_required",
  );
});

test("recent-auth boundary accepts exact threshold and rejects one second later", () => {
  assert.doesNotThrow(() =>
    authorize({ session: { ...session, iat: now - 900 } }),
  );
  assertCode(
    () => authorize({ session: { ...session, iat: now - 901 } }),
    "recent_authentication_required",
  );
});

test("self deletion is rejected", () => {
  assertCode(
    () =>
      assertAccountDeletionDoesNotIncludeActor("admin-1", [
        "user-1",
        "admin-1",
      ]),
    "self_deletion_forbidden",
  );
});

test("route ignores x-admin-actor and uses deletion-specific server context", () => {
  assert.match(routeSource, /await requireAccountDeletionAdmin\(request\)/);
  const deletionBranch = routeSource.slice(
    routeSource.indexOf('if (operation === "account_delete")'),
    routeSource.indexOf("const payload = parseBatchPayload"),
  );
  assert.match(deletionBranch, /deletionAdmin\.context\.actor/);
  assert.match(deletionBranch, /assertAccountDeletionDoesNotIncludeActor/);
  assert.doesNotMatch(deletionBranch, /x-admin-actor/i);
});
