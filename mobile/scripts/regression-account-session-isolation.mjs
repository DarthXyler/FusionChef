import assert from "node:assert/strict";
import {
  assertSameMobileSessionIdentity,
  createMobileSessionIdentitySignal,
  getWorkspaceSessionDisposition,
} from "../src/services/authSession.ts";
import {
  buildAccountStorageKey,
  selectAccountOwnedValue,
  shouldInvalidateMobileSession,
} from "../src/services/accountOwnership.ts";
import { createAuthenticatedRerollContinuation } from "../src/services/rerollContinuation.ts";

function verifyTransitionsPublishSynchronously() {
  const signal = createMobileSessionIdentitySignal();
  const observed = [];
  signal.subscribe(() => {
    observed.push(signal.getSnapshot());
  });

  const accountA = signal.transition("account-a");
  assert.equal(accountA.userId, "account-a");
  assert.deepEqual(observed, [accountA]);

  const accountB = signal.transition("account-b");
  assert.equal(accountB.userId, "account-b");
  assert.deepEqual(observed, [accountA, accountB]);
  assert.equal(signal.isCurrent(accountA), false);
  assert.equal(signal.isCurrent(accountB), true);
}

function verifySameAccountLoginGetsFreshRevision() {
  const signal = createMobileSessionIdentitySignal();
  const firstLogin = signal.transition("account-a");
  const unchangedRead = signal.transition("account-a");
  const secondLogin = signal.transition("account-a", { forceRevision: true });

  assert.equal(unchangedRead.revision, firstLogin.revision);
  assert.equal(secondLogin.userId, firstLogin.userId);
  assert.equal(secondLogin.revision, firstLogin.revision + 1);
  assert.equal(signal.isCurrent(firstLogin), false);
}

function verifyLogoutInvalidatesAuthenticatedWork() {
  const signal = createMobileSessionIdentitySignal();
  const accountARequest = signal.transition("account-a");
  const signedOut = signal.transition(null, { forceRevision: true });

  assert.equal(signedOut.userId, null);
  assert.equal(signal.isCurrent(accountARequest), false);

  const accountB = signal.transition("account-b", { forceRevision: true });
  assert.equal(signal.isCurrent(signedOut), false);
  assert.equal(signal.isCurrent(accountB), true);
}

async function verifyStaleAsyncResultCannotCommit() {
  const signal = createMobileSessionIdentitySignal();
  const accountARequest = signal.transition("account-a");
  let resolveAccountA;
  const accountAResponse = new Promise((resolve) => {
    resolveAccountA = resolve;
  });
  const visibleState = [];

  const pendingCommit = accountAResponse.then((value) => {
    if (signal.isCurrent(accountARequest)) {
      visibleState.push(value);
    }
  });

  signal.transition("account-b");
  resolveAccountA("account-a-cookbook");
  await pendingCommit;

  assert.deepEqual(visibleState, []);
}

function verifyAuthenticatedWorkspaceResetsAcrossAccounts() {
  const signal = createMobileSessionIdentitySignal();
  const accountAOwner = signal.transition("account-a");
  const accountB = signal.transition("account-b");

  assert.equal(
    getWorkspaceSessionDisposition(accountAOwner, accountB, false),
    "reset_to_root",
  );
}

function verifyPreservedStackCannotRevealPriorAccountWorkspace() {
  const signal = createMobileSessionIdentitySignal();
  const accountAOwner = signal.transition("account-a");
  const preservedAndroidStack = ["DashboardHome", "RecentFusions", "RecipeWorkspace"];
  const accountB = signal.transition("account-b");
  const disposition = getWorkspaceSessionDisposition(accountAOwner, accountB, false);
  const resetStack =
    disposition === "reset_to_root" ? preservedAndroidStack.slice(0, 1) : preservedAndroidStack;

  assert.deepEqual(resetStack, ["DashboardHome"]);
  assert.equal(resetStack.includes("RecipeWorkspace"), false);
}

async function verifySignedOutRerollContinuationRetainsWorkspaceOnce() {
  const signal = createMobileSessionIdentitySignal();
  const signedOutOwner = signal.transition(null, { forceRevision: true });
  const continuation = createAuthenticatedRerollContinuation();
  const counters = { authenticate: 0, fuse: 0, reroll: 0 };
  let releaseAuthentication;
  const authenticationPending = new Promise((resolve) => {
    releaseAuthentication = resolve;
  });
  const input = {
    isAuthenticated: async () => false,
    authenticate: async () => {
      counters.authenticate += 1;
      await authenticationPending;
      signal.transition("account-a", { forceRevision: true });
      return true;
    },
    requestReroll: async (action) => {
      assert.equal(action, "reroll");
      counters.reroll += 1;
      return "rerolled-recipe";
    },
  };

  const firstRun = continuation.run(input);
  const duplicateRun = await continuation.run(input);
  assert.equal(duplicateRun.status, "duplicate");
  releaseAuthentication();
  const outcome = await firstRun;
  const authenticatedIdentity = signal.getSnapshot();

  assert.equal(outcome.status, "completed");
  assert.deepEqual(counters, { authenticate: 1, fuse: 0, reroll: 1 });
  assert.equal(
    getWorkspaceSessionDisposition(signedOutOwner, authenticatedIdentity, true),
    "retain",
  );
}

async function verifyProfileUploadCannotWriteAfterAccountSwitch() {
  const signal = createMobileSessionIdentitySignal();
  const expectedIdentity = signal.transition("account-a");
  let releaseUpload;
  const uploadPending = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  let accountBWrites = 0;

  const saveAfterUpload = (async () => {
    await uploadPending;
    assertSameMobileSessionIdentity(expectedIdentity, signal.getSnapshot());
    accountBWrites += 1;
  })();

  signal.transition("account-b");
  releaseUpload();
  await assert.rejects(saveAfterUpload, { name: "MobileSessionChangedError" });
  assert.equal(accountBWrites, 0);
}

function verifyLegacyUnscopedProfileIsDiscarded() {
  const unscopedLegacyProfile = {
    displayName: "Account A",
    photoUri: "https://example.invalid/account-a.jpg",
  };
  const emptyProfile = { displayName: "", photoUri: "" };
  const selectedProfile = selectAccountOwnedValue(null, emptyProfile);

  assert.deepEqual(selectedProfile, emptyProfile);
  assert.notDeepEqual(selectedProfile, unscopedLegacyProfile);
}

function verifyFuseImageInvalidAuthInvalidatesCurrentSession() {
  for (const reason of ["auth_invalid", "account_deleted"]) {
    const signal = createMobileSessionIdentitySignal();
    const accountA = signal.transition("account-a");
    assert.equal(shouldInvalidateMobileSession(401, { reason }), true);
    signal.transition(null, { forceRevision: true });
    assert.equal(signal.isCurrent(accountA), false);
  }

  assert.equal(shouldInvalidateMobileSession(401, { reason: "login_required" }), false);
  assert.equal(shouldInvalidateMobileSession(500, { reason: "auth_invalid" }), false);
}

function verifyCookbookPersistenceKeysAreAccountOwned() {
  const accountASummaries = buildAccountStorageKey("cookbook-summaries-v1", "account-a");
  const accountBSummaries = buildAccountStorageKey("cookbook-summaries-v1", "account-b");
  const accountADetail = buildAccountStorageKey(
    "cookbook-detail-v1",
    "account-a",
    "recipe-1",
  );
  const accountBDetail = buildAccountStorageKey(
    "cookbook-detail-v1",
    "account-b",
    "recipe-1",
  );

  assert.notEqual(accountASummaries, accountBSummaries);
  assert.notEqual(accountADetail, accountBDetail);
  assert.match(accountASummaries, /account-a/);
  assert.match(accountBDetail, /account-b/);
}

verifyTransitionsPublishSynchronously();
verifySameAccountLoginGetsFreshRevision();
verifyLogoutInvalidatesAuthenticatedWork();
await verifyStaleAsyncResultCannotCommit();
verifyAuthenticatedWorkspaceResetsAcrossAccounts();
verifyPreservedStackCannotRevealPriorAccountWorkspace();
await verifySignedOutRerollContinuationRetainsWorkspaceOnce();
await verifyProfileUploadCannotWriteAfterAccountSwitch();
verifyLegacyUnscopedProfileIsDiscarded();
verifyFuseImageInvalidAuthInvalidatesCurrentSession();
verifyCookbookPersistenceKeysAreAccountOwned();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "synchronous_account_transition",
      "same_account_reauthentication",
      "logout_invalidates_authenticated_work",
      "stale_async_result_ignored",
      "authenticated_workspace_cleared_on_account_switch",
      "preserved_stack_cannot_reveal_prior_account_workspace",
      "signed_out_reroll_continues_once",
      "profile_upload_cannot_write_after_account_switch",
      "legacy_unscoped_profile_discarded",
      "fuse_image_invalid_auth_invalidates_session",
      "account_keyed_cookbook_persistence",
    ],
  }),
);
