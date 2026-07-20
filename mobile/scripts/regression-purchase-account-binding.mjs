import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPurchaseVerificationHeaders,
  createPurchaseAccountBinding,
  isPurchaseAccountBindingCurrent,
} from "../src/services/purchaseAccountBinding.ts";

const monetizationSource = readFileSync(
  new URL("../src/services/monetization.ts", import.meta.url),
  "utf8",
);

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function buildBinding(provider, identity, suffix = provider) {
  return createPurchaseAccountBinding({
    provider,
    userId: identity.userId,
    identity,
    authToken: `token-${identity.userId}`,
    anonymousId: `anon-${identity.userId}`,
    deviceKey: `device-${identity.userId}`,
    idempotencyKey: `purchase-${suffix}`,
  });
}

async function verifyStoreCallbackAccountSwitchIsBoundToAccountA() {
  const accountA = { userId: "account-a", revision: 1, initialized: true };
  const accountB = { userId: "account-b", revision: 2, initialized: true };
  const binding = buildBinding("apple_app_store", accountA);
  const storeCallback = createDeferred();
  let currentIdentity = accountA;
  let verifiedHeaders = null;
  let publishedBalance = null;

  const purchase = (async () => {
    await storeCallback.promise;
    verifiedHeaders = buildPurchaseVerificationHeaders(binding);
    if (isPurchaseAccountBindingCurrent(binding, currentIdentity)) {
      publishedBalance = 30;
    }
  })();

  currentIdentity = accountB;
  storeCallback.resolve();
  await purchase;

  assert.equal(verifiedHeaders.authorization, "Bearer token-account-a");
  assert.equal(verifiedHeaders["x-flavor-fusion-anon-id"], "anon-account-a");
  assert.equal(verifiedHeaders["x-flavor-fusion-device-key"], "device-account-a");
  assert.equal(publishedBalance, null);
}

async function verifyBackendPauseCannotPublishIntoAccountB() {
  const accountA = { userId: "account-a", revision: 4, initialized: true };
  const accountB = { userId: "account-b", revision: 5, initialized: true };
  const binding = buildBinding("google_play", accountA);
  const backendVerification = createDeferred();
  let currentIdentity = accountA;
  let publishedBalance = null;
  let refreshedIdentity = null;

  const purchase = (async () => {
    const balance = await backendVerification.promise;
    if (isPurchaseAccountBindingCurrent(binding, currentIdentity)) {
      publishedBalance = balance;
      refreshedIdentity = binding.identity;
    }
  })();

  currentIdentity = accountB;
  backendVerification.resolve(50);
  await purchase;

  assert.equal(publishedBalance, null);
  assert.equal(refreshedIdentity, null);
}

function verifyStaleAuthFailureCannotInvalidateAccountB() {
  const accountA = { userId: "account-a", revision: 7, initialized: true };
  const accountB = { userId: "account-b", revision: 8, initialized: true };
  const binding = buildBinding("google_play", accountA);

  assert.equal(isPurchaseAccountBindingCurrent(binding, accountB), false);
}

function verifySameAccountStoreFlowsRemainCurrent() {
  const identity = { userId: "account-a", revision: 10, initialized: true };
  const appleBinding = buildBinding("apple_app_store", identity, "apple");
  const googleBinding = buildBinding("google_play", identity, "google");

  assert.equal(isPurchaseAccountBindingCurrent(appleBinding, identity), true);
  assert.equal(isPurchaseAccountBindingCurrent(googleBinding, identity), true);
  assert.equal(appleBinding.provider, "apple_app_store");
  assert.equal(googleBinding.provider, "google_play");
}

function verifyDuplicateCallbacksReuseOneIdempotencyKey() {
  const identity = { userId: "account-a", revision: 12, initialized: true };
  const binding = buildBinding("apple_app_store", identity, "duplicate");
  const callbackKeys = [binding.idempotencyKey, binding.idempotencyKey];

  assert.deepEqual(callbackKeys, ["purchase-duplicate", "purchase-duplicate"]);
  assert.match(
    monetizationSource,
    /if\s*\(settled\)\s*\{\s*return;\s*\}\s*settled\s*=\s*true/,
  );
}

function verifyProductionBindingWiring() {
  const appleCaptureIndex = monetizationSource.indexOf(
    'capturePurchaseAccountContext("apple_app_store")',
  );
  const appleStoreIndex = monetizationSource.indexOf('onStatus?.("Opening App Store...")');
  const googleCaptureIndex = monetizationSource.indexOf(
    'capturePurchaseAccountContext("google_play")',
  );
  const googleStoreIndex = monetizationSource.indexOf("await iap.requestPurchase");

  assert.ok(appleCaptureIndex >= 0 && appleCaptureIndex < appleStoreIndex);
  assert.ok(googleCaptureIndex >= 0 && googleCaptureIndex < googleStoreIndex);
  assert.match(
    monetizationSource,
    /buildPurchaseVerificationHeaders\(params\.purchaseContext\)/,
  );
  assert.match(
    monetizationSource,
    /"idempotency-key":\s*params\.purchaseContext\.idempotencyKey/,
  );
  assert.match(
    monetizationSource,
    /handleInvalidAuthResponse\(\s*response,\s*payload,\s*params\.purchaseContext\.identity\s*\)/,
  );
  assert.match(
    monetizationSource,
    /expectedIdentity:\s*purchaseContext\.identity/,
  );
  assert.match(
    monetizationSource,
    /const didClearSession = await clearInvalidMobileSession\(identity\);\s*if \(didClearSession\)/,
  );
  assert.doesNotMatch(
    monetizationSource,
    /const verificationIdentity = captureMobileSessionIdentity\(\)/,
  );
  assert.match(monetizationSource, /await iap\.finishTransactionAsync\(purchase,\s*true\)/);
  assert.match(
    monetizationSource,
    /await iap\.finishTransaction\(\{\s*purchase,\s*isConsumable:\s*true\s*\}\)/,
  );
}

await verifyStoreCallbackAccountSwitchIsBoundToAccountA();
await verifyBackendPauseCannotPublishIntoAccountB();
verifyStaleAuthFailureCannotInvalidateAccountB();
verifySameAccountStoreFlowsRemainCurrent();
verifyDuplicateCallbacksReuseOneIdempotencyKey();
verifyProductionBindingWiring();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "account_switch_during_store_callback",
      "account_switch_during_backend_verification",
      "purchase_not_published_to_new_account",
      "stale_auth_failure_cannot_invalidate_new_account",
      "same_account_apple_purchase",
      "same_account_google_purchase",
      "duplicate_callback_idempotency",
      "production_purchase_binding_wiring",
    ],
  }),
);
