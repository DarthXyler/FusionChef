import assert from "node:assert/strict";
import { createAuthenticatedRerollContinuation } from "../mobile/src/services/rerollContinuation.ts";

function createCounters() {
  return { authenticate: 0, fuse: 0, reroll: 0 };
}

async function verifySuccessfulLoginResumesOneReroll() {
  const counters = createCounters();
  const currentRecipe = { id: "existing-recipe" };
  const continuation = createAuthenticatedRerollContinuation();
  const outcome = await continuation.run({
    isAuthenticated: async () => false,
    authenticate: async () => {
      counters.authenticate += 1;
      return true;
    },
    requestReroll: async (action) => {
      assert.equal(action, "reroll");
      counters.reroll += 1;
      return { id: "rerolled-recipe" };
    },
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(counters, { authenticate: 1, fuse: 0, reroll: 1 });
  assert.deepEqual(currentRecipe, { id: "existing-recipe" });
}

async function verifyCancellationStartsNoGeneration() {
  const counters = createCounters();
  const continuation = createAuthenticatedRerollContinuation();
  const outcome = await continuation.run({
    isAuthenticated: async () => false,
    authenticate: async () => {
      counters.authenticate += 1;
      return false;
    },
    requestReroll: async () => {
      counters.reroll += 1;
    },
  });

  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(counters, { authenticate: 1, fuse: 0, reroll: 0 });
}

async function verifyLoginFailureStartsNoGeneration() {
  const counters = createCounters();
  const continuation = createAuthenticatedRerollContinuation();
  const outcome = await continuation.run({
    isAuthenticated: async () => false,
    authenticate: async () => {
      counters.authenticate += 1;
      throw new Error("login failed");
    },
    requestReroll: async () => {
      counters.reroll += 1;
    },
  });

  assert.equal(outcome.status, "authentication_failed");
  assert.deepEqual(counters, { authenticate: 1, fuse: 0, reroll: 0 });
}

async function verifyDuplicateContinuationIsIgnored() {
  const counters = createCounters();
  const continuation = createAuthenticatedRerollContinuation();
  let releaseAuthentication;
  const authenticationPending = new Promise((resolve) => {
    releaseAuthentication = resolve;
  });
  const input = {
    isAuthenticated: async () => false,
    authenticate: async () => {
      counters.authenticate += 1;
      await authenticationPending;
      return true;
    },
    requestReroll: async (action) => {
      assert.equal(action, "reroll");
      counters.reroll += 1;
    },
  };

  const firstRun = continuation.run(input);
  const duplicateRun = await continuation.run(input);
  assert.equal(duplicateRun.status, "duplicate");
  releaseAuthentication();
  const firstOutcome = await firstRun;

  assert.equal(firstOutcome.status, "completed");
  assert.deepEqual(counters, { authenticate: 1, fuse: 0, reroll: 1 });
}

async function verifySignedInRerollSkipsAuthentication() {
  const counters = createCounters();
  const continuation = createAuthenticatedRerollContinuation();
  const outcome = await continuation.run({
    isAuthenticated: async () => true,
    authenticate: async () => {
      counters.authenticate += 1;
      return true;
    },
    requestReroll: async (action) => {
      assert.equal(action, "reroll");
      counters.reroll += 1;
    },
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(counters, { authenticate: 0, fuse: 0, reroll: 1 });
}

await verifySuccessfulLoginResumesOneReroll();
await verifyCancellationStartsNoGeneration();
await verifyLoginFailureStartsNoGeneration();
await verifyDuplicateContinuationIsIgnored();
await verifySignedInRerollSkipsAuthentication();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "signed_out_login_success",
      "signed_out_login_cancelled",
      "signed_out_login_failed",
      "duplicate_continuation",
      "signed_in_reroll",
    ],
  }),
);
