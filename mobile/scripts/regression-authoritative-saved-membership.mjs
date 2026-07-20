import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createCookbookMembershipLookupCoordinator,
  createCookbookMembershipRevisionTracker,
  getCookbookSavedMembershipStatus,
  isCookbookSavedMembershipBlocking,
  mergeSavedCookbookRecipeIds,
  setCookbookSavedMembership,
} from "../src/services/cookbookSavedMembership.ts";
import { createMobileSessionIdentitySignal } from "../src/services/authSession.ts";

const contextSource = readFileSync(
  new URL("../src/context/mobileCookbook.tsx", import.meta.url),
  "utf8",
);
const cookbookSource = readFileSync(
  new URL("../src/services/cookbook.ts", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/screens/RecipeWorkspaceScreen.tsx", import.meta.url),
  "utf8",
);

function verifySavedRecipeOutsideFirstPage() {
  const firstPageIds = Array.from({ length: 15 }, (_, index) => `recipe-${index + 1}`);
  let membership = mergeSavedCookbookRecipeIds({}, firstPageIds);

  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-16"),
    "unknown",
  );
  membership = setCookbookSavedMembership(membership, "recipe-16", true);
  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-16"),
    "saved",
  );
}

function verifyUnsavedSaveAndDeleteTransitions() {
  let membership = setCookbookSavedMembership({}, "recipe-a", false);
  assert.equal(getCookbookSavedMembershipStatus(membership, "recipe-a"), "unsaved");

  membership = setCookbookSavedMembership(membership, "recipe-a", true);
  assert.equal(getCookbookSavedMembershipStatus(membership, "recipe-a"), "saved");

  membership = setCookbookSavedMembership(membership, "recipe-a", false);
  assert.equal(getCookbookSavedMembershipStatus(membership, "recipe-a"), "unsaved");
}

function verifyOnlyConfirmedUnsavedEnablesSave() {
  assert.equal(isCookbookSavedMembershipBlocking("unknown", true), true);
  assert.equal(isCookbookSavedMembershipBlocking("checking", true), true);
  assert.equal(isCookbookSavedMembershipBlocking("unavailable", true), true);
  assert.equal(isCookbookSavedMembershipBlocking("unsaved", true), false);
  assert.equal(isCookbookSavedMembershipBlocking("saved", true), false);
  assert.equal(isCookbookSavedMembershipBlocking("unknown", false), false);
}

function verifyLookupFailuresKeepSaveDisabled() {
  for (const failure of [
    "network",
    "server",
    "malformed",
    "auth_invalid",
    "account_deleted",
  ]) {
    const status = getCookbookSavedMembershipStatus({}, `recipe-${failure}`, {
      isUnavailable: true,
    });
    assert.equal(status, "unavailable");
    assert.equal(isCookbookSavedMembershipBlocking(status, true), true);
  }
}

async function verifyStaleLookupCannotAffectNextAccount() {
  const signal = createMobileSessionIdentitySignal();
  const accountA = signal.transition("account-a");
  let releaseLookup;
  const lookupPending = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  let membership = {};

  const lookup = (async () => {
    const isSaved = await lookupPending;
    if (signal.isCurrent(accountA)) {
      membership = setCookbookSavedMembership(membership, "recipe-a", isSaved);
    }
  })();

  signal.transition("account-b");
  membership = {};
  releaseLookup(true);
  await lookup;

  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-a"),
    "unknown",
  );
}

async function verifyDuplicateLookupsCoalesce() {
  const coordinator = createCookbookMembershipLookupCoordinator();
  let requests = 0;
  let releaseLookup;
  const pending = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const operation = async () => {
    requests += 1;
    return pending;
  };

  const first = coordinator.run(4, "recipe-a", operation);
  const duplicate = coordinator.run(4, "recipe-a", operation);
  assert.equal(first.started, true);
  assert.equal(duplicate.started, false);
  assert.equal(first.promise, duplicate.promise);
  releaseLookup(true);
  assert.equal(await first.promise, true);
  assert.equal(requests, 1);
}

async function verifyDeleteSupersedesOlderLookup() {
  const tracker = createCookbookMembershipRevisionTracker();
  let membership = {};
  let releaseLookup;
  const pendingLookup = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const lookupRevision = tracker.capture("recipe-a");

  const lookup = (async () => {
    const isSaved = await pendingLookup;
    if (tracker.isCurrent("recipe-a", lookupRevision)) {
      membership = setCookbookSavedMembership(membership, "recipe-a", isSaved);
    }
  })();

  tracker.advance("recipe-a");
  membership = setCookbookSavedMembership(membership, "recipe-a", false);
  releaseLookup(true);
  await lookup;

  assert.equal(getCookbookSavedMembershipStatus(membership, "recipe-a"), "unsaved");
}

async function verifySuccessfulControlledRetry() {
  const coordinator = createCookbookMembershipLookupCoordinator();
  let membership = {};
  let unavailable = true;

  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-a", {
      isUnavailable: unavailable,
    }),
    "unavailable",
  );
  const retry = coordinator.run(12, "recipe-a", async () => true);
  const isSaved = await retry.promise;
  membership = setCookbookSavedMembership(membership, "recipe-a", isSaved);
  unavailable = false;

  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-a", {
      isUnavailable: unavailable,
    }),
    "saved",
  );

  const notFoundRetry = coordinator.run(12, "recipe-b", async () => false);
  membership = setCookbookSavedMembership(
    membership,
    "recipe-b",
    await notFoundRetry.promise,
  );
  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-b"),
    "unsaved",
  );
}

async function verifyAccountSwitchDuringRetryCannotPublish() {
  const signal = createMobileSessionIdentitySignal();
  const accountA = signal.transition("account-a");
  let releaseRetry;
  const retryPending = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  let membership = {};

  const retry = (async () => {
    const isSaved = await retryPending;
    if (signal.isCurrent(accountA)) {
      membership = setCookbookSavedMembership(membership, "recipe-a", isSaved);
    }
  })();

  signal.transition("account-b");
  releaseRetry(true);
  await retry;

  assert.equal(
    getCookbookSavedMembershipStatus(membership, "recipe-a"),
    "unknown",
  );
}

function verifyProductionWiring() {
  assert.match(
    cookbookSource,
    /export async function checkCookbookRecipeSaved\([\s\S]*buildCookbookRequestContext\(undefined, expectedIdentity\)/,
  );
  assert.match(cookbookSource, /if \(response\.status === 404\)[\s\S]*return false/);
  assert.match(cookbookSource, /if \(!response\.ok\) \{[\s\S]*throw new Error/);
  const membershipLookupSource = cookbookSource.slice(
    cookbookSource.indexOf("export async function checkCookbookRecipeSaved"),
    cookbookSource.indexOf("export async function deleteCookbookRecipe"),
  );
  assert.ok(
    membershipLookupSource.indexOf("if (response.status === 404)") <
      membershipLookupSource.indexOf("if (!response.ok)"),
  );
  assert.match(
    membershipLookupSource,
    /readErrorMessage\([\s\S]*requestContext\.identity/,
  );
  assert.match(
    cookbookSource,
    /!isCookbookRecipeRecord\(payload\.record\)[\s\S]*throw new Error/,
  );
  assert.match(
    contextSource,
    /createCookbookMembershipLookupCoordinator\(\)/,
  );
  assert.match(
    contextSource,
    /createCookbookMembershipRevisionTracker\(\)/,
  );
  assert.match(
    contextSource,
    /checkCookbookRecipeSaved\(normalizedRecipeId, requestIdentity\)/,
  );
  assert.match(
    contextSource,
    /if \(!canCommitForIdentity\(requestIdentity\)\) \{\s*throw new Error\(/,
  );
  assert.match(
    contextSource,
    /markSavedMembership\(record\.recipe\.id, true\)/,
  );
  assert.match(contextSource, /markSavedMembership\(recipeId, false\)/);
  assert.match(
    contextSource,
    /membershipRevisionTracker\.isCurrent\(\s*normalizedRecipeId,\s*expectedMembershipRevision/,
  );
  assert.match(
    contextSource,
    /catch \(error\) \{[\s\S]*setUnavailableSavedRecipeIds/,
  );
  assert.match(
    contextSource,
    /setSavedRecipeMembership\(\{\}\)[\s\S]*membershipLookupCoordinator\.reset\(\)/,
  );
  assert.match(
    workspaceSource,
    /savedMembershipStatus === "saved"/,
  );
  assert.match(
    workspaceSource,
    /savedMembershipStatus !== "unknown"[\s\S]*ensureSavedRecipeMembership\(activeRecipe\.id\)/,
  );
  assert.match(
    workspaceSource,
    /isCookbookSavedMembershipBlocking\([\s\S]*savedMembershipStatus[\s\S]*sessionIdentity\.userId !== null/,
  );
  assert.match(
    workspaceSource,
    /isBlocked: isPurchasingCredits \|\| isSavedMembershipBlocked/,
  );
  assert.match(
    workspaceSource,
    /addListener\("focus",[\s\S]*savedMembershipStatus !== "unavailable"[\s\S]*ensureSavedRecipeMembership\(activeRecipe\.id\)/,
  );
  assert.match(
    workspaceSource,
    /if \(isActiveRecipeSaved \|\| isSavedMembershipBlocked\) \{\s*return/,
  );
}

verifySavedRecipeOutsideFirstPage();
verifyUnsavedSaveAndDeleteTransitions();
verifyOnlyConfirmedUnsavedEnablesSave();
verifyLookupFailuresKeepSaveDisabled();
await verifyStaleLookupCannotAffectNextAccount();
await verifyDuplicateLookupsCoalesce();
await verifyDeleteSupersedesOlderLookup();
await verifySuccessfulControlledRetry();
await verifyAccountSwitchDuringRetryCannotPublish();
verifyProductionWiring();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "saved_recipe_outside_first_page",
      "unsaved_recipe_shows_save",
      "successful_save_updates_membership",
      "deletion_resets_membership",
      "stale_account_lookup_ignored",
      "account_switch_clears_membership",
      "duplicate_lookup_and_save_blocking",
      "delete_supersedes_older_lookup",
      "membership_failures_keep_save_disabled",
      "confirmed_404_enables_save",
      "successful_controlled_retry",
      "account_switch_during_retry_ignored",
      "production_membership_wiring",
    ],
  }),
);
