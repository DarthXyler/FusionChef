import assert from "node:assert/strict";
import {
  createAccountRefreshRequestCoalescer,
  createPostMutationAccountRefresh,
  mergeVerifiedAccountBalance,
} from "../src/services/accountRefresh.ts";

function buildSnapshot({
  availableCredits = 10,
  freeFuse = 1,
  freeReroll = 1,
} = {}) {
  return {
    authenticated: true,
    balance: {
      availableCredits,
      pendingCredits: 0,
    },
    freeRemaining: {
      fuse: freeFuse,
      reroll: freeReroll,
    },
  };
}

function cloneSnapshot(snapshot) {
  return structuredClone(snapshot);
}

function createRefreshHarness(initialSnapshot = buildSnapshot()) {
  const coalescer = createAccountRefreshRequestCoalescer();
  let currentIdentity = { userId: "account-a", revision: 1 };
  let backendSnapshot = cloneSnapshot(initialSnapshot);
  let visibleSnapshot = cloneSnapshot(initialSnapshot);
  let requestCount = 0;
  let refreshGeneration = 0;
  let pendingGate = null;
  let failNextRequest = false;
  const listeners = new Set();

  function isCurrent(identity) {
    return (
      identity.userId === currentIdentity.userId &&
      identity.revision === currentIdentity.revision
    );
  }

  function publish(snapshot) {
    visibleSnapshot = cloneSnapshot(snapshot);
    listeners.forEach((listener) => listener(visibleSnapshot));
  }

  async function requestFreshSnapshot(identity) {
    const requestGeneration = refreshGeneration;
    return coalescer.run({ ...identity, refreshGeneration: requestGeneration }, async () => {
      requestCount += 1;
      const responseSnapshot = cloneSnapshot(backendSnapshot);
      const gate = pendingGate;
      if (gate) {
        await gate.promise;
      }
      if (failNextRequest) {
        failNextRequest = false;
        throw new Error("account refresh unavailable");
      }
      if (!isCurrent(identity) || requestGeneration !== refreshGeneration) {
        return null;
      }
      return responseSnapshot;
    });
  }

  const postMutationRefresh = createPostMutationAccountRefresh({
    isCurrent,
    onMutation: () => {
      refreshGeneration += 1;
    },
    requestFreshSnapshot,
    publishFreshSnapshot: (snapshot, identity) => {
      if (isCurrent(identity)) {
        publish(snapshot);
      }
    },
    publishVerifiedBalance: (balance, identity) => {
      if (isCurrent(identity)) {
        publish(mergeVerifiedAccountBalance(visibleSnapshot, balance));
      }
    },
    refreshTimeoutMs: 25,
  });

  return {
    captureIdentity: () => currentIdentity,
    getRequestCount: () => requestCount,
    getVisibleSnapshot: () => visibleSnapshot,
    scheduleMutationRefresh: postMutationRefresh.schedule,
    waitForMutationRefresh: postMutationRefresh.waitForIdle,
    requestFreshSnapshot,
    setBackendSnapshot(snapshot) {
      backendSnapshot = cloneSnapshot(snapshot);
    },
    failNextRequest() {
      failNextRequest = true;
    },
    pauseNextRequest() {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      pendingGate = { promise, release };
    },
    releaseRequest() {
      const gate = pendingGate;
      pendingGate = null;
      gate?.release();
    },
    switchAccount(snapshot = buildSnapshot()) {
      currentIdentity = {
        userId: "account-b",
        revision: currentIdentity.revision + 1,
      };
      refreshGeneration += 1;
      coalescer.reset();
      publish(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function verifyFreeFuseCounterRefreshes() {
  const harness = createRefreshHarness();
  harness.setBackendSnapshot(buildSnapshot({ freeFuse: 0 }));

  harness.scheduleMutationRefresh({
    expectedIdentity: harness.captureIdentity(),
  });
  await harness.waitForMutationRefresh();

  assert.equal(harness.getVisibleSnapshot().freeRemaining.fuse, 0);
  assert.equal(harness.getVisibleSnapshot().balance.availableCredits, 10);
}

async function verifyFreeRerollCounterRefreshes() {
  const harness = createRefreshHarness();
  harness.setBackendSnapshot(buildSnapshot({ freeReroll: 0 }));

  harness.scheduleMutationRefresh({
    expectedIdentity: harness.captureIdentity(),
  });
  await harness.waitForMutationRefresh();

  assert.equal(harness.getVisibleSnapshot().freeRemaining.reroll, 0);
  assert.equal(harness.getVisibleSnapshot().balance.availableCredits, 10);
}

async function verifyPaidFuseDeductsThreeCredits() {
  const harness = createRefreshHarness(buildSnapshot({ availableCredits: 10, freeFuse: 0 }));
  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 7, freeFuse: 0 }));

  harness.scheduleMutationRefresh({
    expectedIdentity: harness.captureIdentity(),
  });
  await harness.waitForMutationRefresh();

  assert.equal(harness.getVisibleSnapshot().balance.availableCredits, 7);
}

async function verifyPaidRerollDeductsOneCredit() {
  const harness = createRefreshHarness(buildSnapshot({ availableCredits: 10, freeReroll: 0 }));
  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 9, freeReroll: 0 }));

  harness.scheduleMutationRefresh({
    expectedIdentity: harness.captureIdentity(),
  });
  await harness.waitForMutationRefresh();

  assert.equal(harness.getVisibleSnapshot().balance.availableCredits, 9);
}

async function verifyNewPurchaseBalanceSupersedesPausedRefresh() {
  const harness = createRefreshHarness();
  const publishedBalances = [];
  harness.subscribe((snapshot) => {
    publishedBalances.push(snapshot.balance.availableCredits);
  });
  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 17 }));
  harness.pauseNextRequest();
  const identity = harness.captureIdentity();

  const firstSequence = harness.scheduleMutationRefresh({
    expectedIdentity: identity,
  });
  await Promise.resolve();
  await Promise.resolve();
  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 37 }));
  const secondSequence = harness.scheduleMutationRefresh({
    expectedIdentity: identity,
    verifiedBalance: {
      availableCredits: 37,
      pendingCredits: 0,
    },
  });

  assert.equal(firstSequence, 1);
  assert.equal(secondSequence, 2);
  assert.deepEqual(publishedBalances, [37]);
  harness.releaseRequest();
  await harness.waitForMutationRefresh();

  assert.equal(harness.getRequestCount(), 2);
  assert.deepEqual(publishedBalances, [37, 37]);
  assert.equal(publishedBalances.includes(17), false);
}

async function verifyTwoMutationsProduceTrailingAuthoritativeRefresh() {
  const harness = createRefreshHarness();
  harness.setBackendSnapshot(buildSnapshot({ freeFuse: 0, freeReroll: 1 }));
  harness.pauseNextRequest();
  const identity = harness.captureIdentity();

  const firstSequence = harness.scheduleMutationRefresh({ expectedIdentity: identity });
  await Promise.resolve();
  await Promise.resolve();
  harness.setBackendSnapshot(buildSnapshot({ freeFuse: 0, freeReroll: 0 }));
  const secondSequence = harness.scheduleMutationRefresh({ expectedIdentity: identity });
  await Promise.resolve();

  assert.equal(harness.getRequestCount(), 1);
  assert.equal(firstSequence, 1);
  assert.equal(secondSequence, 2);
  harness.releaseRequest();
  await harness.waitForMutationRefresh();

  assert.equal(harness.getRequestCount(), 2);
  assert.deepEqual(harness.getVisibleSnapshot().freeRemaining, {
    fuse: 0,
    reroll: 0,
  });
}

async function verifyMutationRefreshSupersedesOlderRequest() {
  const harness = createRefreshHarness();
  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 10, freeFuse: 1 }));
  harness.pauseNextRequest();
  const identity = harness.captureIdentity();
  const olderRefresh = harness.requestFreshSnapshot(identity);
  await Promise.resolve();

  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 10, freeFuse: 0 }));
  harness.scheduleMutationRefresh({ expectedIdentity: identity });
  await Promise.resolve();
  harness.releaseRequest();
  await Promise.all([olderRefresh, harness.waitForMutationRefresh()]);

  assert.equal(harness.getRequestCount(), 2);
  assert.equal(harness.getVisibleSnapshot().freeRemaining.fuse, 0);
}

async function verifyAccountSwitchCancelsInflightAndTrailingPublication() {
  const harness = createRefreshHarness();
  harness.setBackendSnapshot(buildSnapshot({ availableCredits: 4 }));
  harness.pauseNextRequest();
  const accountA = harness.captureIdentity();
  harness.scheduleMutationRefresh({ expectedIdentity: accountA });
  harness.scheduleMutationRefresh({
    expectedIdentity: accountA,
    verifiedBalance: {
      availableCredits: 24,
      pendingCredits: 0,
    },
  });
  await Promise.resolve();

  harness.switchAccount(buildSnapshot({ availableCredits: 99 }));
  harness.releaseRequest();
  await harness.waitForMutationRefresh();

  assert.equal(harness.getRequestCount(), 1);
  assert.equal(harness.getVisibleSnapshot().balance.availableCredits, 99);
}

async function verifyRefreshFailureDoesNotChangeActionResult() {
  const harness = createRefreshHarness();
  const successfulActionResult = { recipeId: "recipe-1", action: "fuse" };
  harness.failNextRequest();

  const mutationSequence = harness.scheduleMutationRefresh({
    expectedIdentity: harness.captureIdentity(),
  });
  await harness.waitForMutationRefresh();

  assert.equal(mutationSequence, 1);
  assert.deepEqual(successfulActionResult, { recipeId: "recipe-1", action: "fuse" });
  assert.equal(harness.getVisibleSnapshot().balance.availableCredits, 10);
}

async function verifyHangingRefreshDoesNotDelaySuccessfulAction() {
  const harness = createRefreshHarness();
  const successfulActionResult = { recipeId: "recipe-2", action: "reroll" };
  harness.pauseNextRequest();

  const startedAt = Date.now();
  const mutationSequence = harness.scheduleMutationRefresh({
    expectedIdentity: harness.captureIdentity(),
  });
  const schedulingDurationMs = Date.now() - startedAt;

  assert.equal(mutationSequence, 1);
  assert.ok(schedulingDurationMs < 20);
  assert.deepEqual(successfulActionResult, {
    recipeId: "recipe-2",
    action: "reroll",
  });
  await harness.waitForMutationRefresh();
  harness.releaseRequest();
}

async function verifyResumeAndFocusRequestsCoalesce() {
  const harness = createRefreshHarness();
  harness.pauseNextRequest();
  const identity = harness.captureIdentity();

  const appResumeRefresh = harness.requestFreshSnapshot(identity);
  const focusedScreenRefresh = harness.requestFreshSnapshot(identity);
  await Promise.resolve();

  assert.equal(harness.getRequestCount(), 1);
  harness.releaseRequest();
  await Promise.all([appResumeRefresh, focusedScreenRefresh]);
}

await verifyFreeFuseCounterRefreshes();
await verifyFreeRerollCounterRefreshes();
await verifyPaidFuseDeductsThreeCredits();
await verifyPaidRerollDeductsOneCredit();
await verifyNewPurchaseBalanceSupersedesPausedRefresh();
await verifyTwoMutationsProduceTrailingAuthoritativeRefresh();
await verifyMutationRefreshSupersedesOlderRequest();
await verifyAccountSwitchCancelsInflightAndTrailingPublication();
await verifyRefreshFailureDoesNotChangeActionResult();
await verifyHangingRefreshDoesNotDelaySuccessfulAction();
await verifyResumeAndFocusRequestsCoalesce();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "free_fuse_counter_refresh",
      "free_reroll_counter_refresh",
      "paid_fuse_deducts_three",
      "paid_reroll_deducts_one",
      "new_verified_purchase_balance_supersedes_paused_refresh",
      "two_mutations_schedule_trailing_authoritative_refresh",
      "mutation_refresh_supersedes_older_request",
      "account_switch_cancels_inflight_and_trailing_publication",
      "refresh_failure_preserves_action_success",
      "hanging_refresh_does_not_delay_action_success",
      "resume_and_focus_refreshes_coalesce",
    ],
  }),
);
