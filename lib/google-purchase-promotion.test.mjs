import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  buildGooglePurchaseTransactionId,
  GOOGLE_PURCHASE_TOKEN_HASH_FIELD,
  hashGooglePurchaseToken,
  resolveGooglePurchaseState,
  resolveGooglePlayPackageName,
  verifyGooglePurchase,
} from "./monetization-provider-verification.ts";
import { settleVerifiedPurchase } from "./monetization-purchase-settlement.ts";

const migrationSql = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/monetization/purchases/verify/route.ts", import.meta.url),
  "utf8",
);

const baseSchemaSql = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY,
    available_credits INTEGER NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
    pending_credits INTEGER NOT NULL DEFAULT 0 CHECK(pending_credits >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_available_after INTEGER NOT NULL CHECK(balance_available_after >= 0),
    balance_pending_after INTEGER NOT NULL CHECK(balance_pending_after >= 0),
    reservation_id TEXT,
    idempotency_scope TEXT,
    idempotency_key TEXT,
    actor TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX idx_credit_ledger_idempotency
    ON credit_ledger_entries (idempotency_scope, idempotency_key)
    WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL;
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('apple_app_store','google_play')),
    provider_transaction_id TEXT NOT NULL,
    provider_original_transaction_id TEXT,
    anon_user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('verified','rejected','revoked','reversal_pending')),
    granted_credits INTEGER NOT NULL DEFAULT 0 CHECK(granted_credits >= 0),
    reversed_credits INTEGER NOT NULL DEFAULT 0 CHECK(reversed_credits >= 0),
    outstanding_reversal_credits INTEGER NOT NULL DEFAULT 0 CHECK(outstanding_reversal_credits >= 0),
    risk_flags_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    verified_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(provider, provider_transaction_id)
  );
`;

async function createFixture() {
  const databasePath = path.join(tmpdir(), `ff-pur03-${randomUUID()}.db`);
  const url = `file:${databasePath.replace(/\\/g, "/")}`;
  const client = createClient({ url });
  await client.executeMultiple(baseSchemaSql);
  await client.executeMultiple(migrationSql);
  return { client, url, close: () => client.close() };
}

function googleInput(overrides = {}) {
  const providerTransactionId = overrides.providerTransactionId ?? "GPA.1234-5678";
  return {
    provider: "google_play",
    providerTransactionId,
    providerOriginalTransactionId:
      overrides.providerOriginalTransactionId ?? providerTransactionId,
    canonicalAnonUserId: overrides.canonicalAnonUserId ?? "user-1",
    productId: overrides.productId ?? "credits_20_android",
    verifiedCredits: overrides.verifiedCredits ?? 20,
    verifiedAt: "2026-08-01T08:00:00.000Z",
    settlementIdempotencyKey:
      overrides.settlementIdempotencyKey ??
      `google_play:${providerTransactionId}`,
    providerVerificationPayload:
      overrides.providerVerificationPayload ?? {
        orderId: providerTransactionId,
        purchaseState: 0,
        [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: "a".repeat(64),
      },
    providerMetadata: { verificationState: "purchased" },
    riskFlags: overrides.riskFlags ?? [],
    allowGooglePendingPromotion:
      overrides.allowGooglePendingPromotion ?? true,
    existingProviderTransactionIdHint:
      overrides.existingProviderTransactionIdHint ?? null,
  };
}

function options(client) {
  return {
    client,
    ensureSchemas: async () => {},
    now: () => new Date("2026-08-01T09:00:00.000Z"),
    createId: randomUUID,
  };
}

async function seedPending(client, overrides = {}) {
  const input = googleInput(overrides);
  await client.execute({
    sql: `INSERT INTO credit_purchase_transactions (
            row_id, provider, provider_transaction_id,
            provider_original_transaction_id, anon_user_id, product_id,
            status, granted_credits, reversed_credits,
            outstanding_reversal_credits, risk_flags_json, payload_json,
            verified_at, revoked_at
          ) VALUES (?, 'google_play', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      overrides.rowId ?? randomUUID(),
      overrides.storedProviderTransactionId ?? input.providerTransactionId,
      overrides.storedOriginalTransactionId ?? input.providerOriginalTransactionId,
      overrides.storedOwner ?? input.canonicalAnonUserId,
      overrides.storedProductId ?? input.productId,
      overrides.status ?? "rejected",
      overrides.grantedCredits ?? 0,
      overrides.reversedCredits ?? 0,
      overrides.outstandingReversalCredits ?? 0,
      JSON.stringify(overrides.storedRiskFlags ?? []),
      JSON.stringify(
        overrides.previousPayload ?? {
          orderId: input.providerTransactionId,
          purchaseState: 2,
          [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: "a".repeat(64),
        },
      ),
      overrides.previousVerifiedAt ?? null,
      overrides.revokedAt ?? null,
    ],
  });
}

async function counts(client) {
  const result = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM credit_purchase_transactions) AS purchases,
      (SELECT COUNT(*) FROM credit_ledger_entries) AS ledgers,
      (SELECT COUNT(*) FROM credit_purchase_ledger_links) AS links,
      (SELECT COALESCE(SUM(available_credits), 0) FROM credit_balances) AS credits
  `);
  const row = result.rows[0];
  return {
    purchases: Number(row?.purchases ?? 0),
    ledgers: Number(row?.ledgers ?? 0),
    links: Number(row?.links ?? 0),
    credits: Number(row?.credits ?? 0),
  };
}

test("pending then purchased promotes atomically and later requests replay", async () => {
  const fixture = await createFixture();
  try {
    await seedPending(fixture.client);
    assert.deepEqual(await counts(fixture.client), {
      purchases: 1,
      ledgers: 0,
      links: 0,
      credits: 0,
    });

    const promoted = await settleVerifiedPurchase(
      googleInput(),
      options(fixture.client),
    );
    assert.equal(promoted.status, "recovered");
    assert.equal(promoted.purchase.status, "verified");
    assert.equal(promoted.purchase.grantedCredits, 20);
    assert.equal(promoted.balance.availableCredits, 20);

    const replay = await settleVerifiedPurchase(
      googleInput(),
      options(fixture.client),
    );
    assert.equal(replay.status, "replay");
    assert.deepEqual(await counts(fixture.client), {
      purchases: 1,
      ledgers: 1,
      links: 1,
      credits: 20,
    });
  } finally {
    fixture.close();
  }
});

test("concurrent pending promotions grant exactly once", async () => {
  const fixture = await createFixture();
  const secondClient = createClient({ url: fixture.url });
  try {
    await seedPending(fixture.client);
    const results = await Promise.all([
      settleVerifiedPurchase(googleInput(), options(fixture.client)),
      settleVerifiedPurchase(googleInput(), options(secondClient)),
    ]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["recovered", "replay"],
    );
    assert.deepEqual(await counts(fixture.client), {
      purchases: 1,
      ledgers: 1,
      links: 1,
      credits: 20,
    });
  } finally {
    secondClient.close();
    fixture.close();
  }
});

test("pending promotion fails closed for unsafe prior records", async (t) => {
  const cases = [
    {
      name: "another account",
      seed: { storedOwner: "user-2" },
      expectedStatus: "owner_conflict",
      expectedReason: "purchase_owner_mismatch",
    },
    {
      name: "product mismatch",
      seed: { storedProductId: "credits_50_android" },
      expectedReason: "purchase_product_mismatch",
    },
    {
      name: "conflicting credited amount",
      seed: { grantedCredits: 5 },
      expectedReason: "purchase_amount_mismatch",
    },
    {
      name: "previous canceled state",
      seed: { previousPayload: { purchaseState: 1 } },
      expectedReason: "pending_state_unproven",
    },
    {
      name: "previous revoked row",
      seed: {
        status: "revoked",
        revokedAt: "2026-07-31T00:00:00.000Z",
        previousPayload: { purchaseState: 1 },
      },
      expectedReason: "pending_state_unproven",
    },
    {
      name: "previous refund marker",
      seed: { storedRiskFlags: ["provider_refund_confirmed"] },
      expectedReason: "pending_state_unproven",
    },
    {
      name: "previous fraud marker",
      seed: { storedRiskFlags: ["provider_fraud_suspected"] },
      expectedReason: "pending_state_unproven",
    },
    {
      name: "missing previous state",
      seed: { previousPayload: {} },
      expectedReason: "pending_state_unproven",
    },
    {
      name: "malformed previous state",
      seed: { previousPayload: { purchaseState: "2" } },
      expectedReason: "pending_state_unproven",
    },
    {
      name: "conflicting provider transaction data",
      seed: {
        previousPayload: {
          orderId: "GPA.different",
          purchaseState: 2,
          [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: "a".repeat(64),
        },
      },
      expectedReason: "pending_state_unproven",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = await createFixture();
      try {
        await seedPending(fixture.client, entry.seed);
        const result = await settleVerifiedPurchase(
          googleInput(),
          options(fixture.client),
        );
        assert.equal(result.status, entry.expectedStatus ?? "inconsistent_state");
        assert.equal(result.reason, entry.expectedReason);
        assert.deepEqual(await counts(fixture.client), {
          purchases: 1,
          ledgers: 0,
          links: 0,
          credits: 0,
        });
      } finally {
        fixture.close();
      }
    });
  }
});

test("pending without orderId can be promoted when Google later supplies it", async () => {
  const fixture = await createFixture();
  try {
    const tokenHash = "b".repeat(64);
    const pendingTransactionId = `token_sha256:${tokenHash}`;
    await seedPending(fixture.client, {
      providerTransactionId: "GPA.later-order",
      providerOriginalTransactionId: "GPA.later-order",
      storedProviderTransactionId: pendingTransactionId,
      storedOriginalTransactionId: null,
      previousPayload: {
        purchaseState: 2,
        [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: tokenHash,
      },
    });
    const result = await settleVerifiedPurchase(
      googleInput({
        providerTransactionId: "GPA.later-order",
        providerOriginalTransactionId: "GPA.later-order",
        providerVerificationPayload: {
          orderId: "GPA.later-order",
          purchaseState: 0,
          [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: tokenHash,
        },
        existingProviderTransactionIdHint: pendingTransactionId,
      }),
      options(fixture.client),
    );
    assert.equal(result.status, "recovered");
    assert.equal(result.balance.availableCredits, 20);
  } finally {
    fixture.close();
  }
});

test("pending row with an existing financial grant is not promoted", async () => {
  const fixture = await createFixture();
  try {
    await seedPending(fixture.client);
    await fixture.client.execute(
      "INSERT INTO credit_balances (anon_user_id, available_credits) VALUES ('user-1', 20)",
    );
    await fixture.client.execute({
      sql: `INSERT INTO credit_ledger_entries (
              entry_id, anon_user_id, event_type, amount,
              balance_available_after, balance_pending_after,
              idempotency_scope, idempotency_key, actor, metadata_json
            ) VALUES (?, 'user-1', 'purchase_grant', 20, 20, 0,
              'purchase-credit-grant', ?, 'purchase_verification', ?)`,
      args: [
        randomUUID(),
        "google_play:GPA.1234-5678",
        JSON.stringify({
          provider: "google_play",
          productId: "credits_20_android",
          providerTransactionId: "GPA.1234-5678",
        }),
      ],
    });
    const before = await counts(fixture.client);
    const result = await settleVerifiedPurchase(
      googleInput(),
      options(fixture.client),
    );
    assert.equal(result.status, "inconsistent_state");
    assert.equal(result.reason, "pending_purchase_has_financial_records");
    assert.deepEqual(await counts(fixture.client), before);
  } finally {
    fixture.close();
  }
});

test("legacy token identifier can be promoted without persisting it again", async () => {
  const fixture = await createFixture();
  try {
    const token = "legacy-plaintext-token";
    const freshId = buildGooglePurchaseTransactionId(null, token);
    const legacyId = `token:${token}`;
    await seedPending(fixture.client, {
      providerTransactionId: freshId,
      providerOriginalTransactionId: null,
      storedProviderTransactionId: legacyId,
      storedOriginalTransactionId: null,
      previousPayload: { purchaseState: 2 },
    });
    const result = await settleVerifiedPurchase(
      googleInput({
        providerTransactionId: freshId,
        providerOriginalTransactionId: null,
        settlementIdempotencyKey: `google_play:${freshId}`,
        providerVerificationPayload: {
          purchaseState: 0,
          [GOOGLE_PURCHASE_TOKEN_HASH_FIELD]: hashGooglePurchaseToken(token),
        },
        existingProviderTransactionIdHint: legacyId,
      }),
      options(fixture.client),
    );
    assert.equal(result.status, "recovered");
    const ledger = await fixture.client.execute(
      "SELECT idempotency_key, metadata_json FROM credit_ledger_entries",
    );
    assert.equal(ledger.rows[0]?.idempotency_key, `google_play:${freshId}`);
    assert.doesNotMatch(String(ledger.rows[0]?.metadata_json), /legacy-plaintext-token/);
  } finally {
    fixture.close();
  }
});

test("existing purchased Google flow and Apple settlement remain unchanged", async () => {
  const fixture = await createFixture();
  try {
    const google = await settleVerifiedPurchase(
      googleInput({ providerTransactionId: "GPA.new" }),
      options(fixture.client),
    );
    const apple = await settleVerifiedPurchase(
      {
        ...googleInput({ providerTransactionId: "apple-tx" }),
        provider: "apple_app_store",
        providerOriginalTransactionId: "apple-original",
        productId: "com.flavorfusion.credits.20",
        settlementIdempotencyKey: "apple_app_store:apple-tx",
        providerVerificationPayload: { transactionId: "apple-tx" },
        allowGooglePendingPromotion: false,
      },
      options(fixture.client),
    );
    assert.equal(google.status, "settled");
    assert.equal(apple.status, "settled");
    assert.equal((await counts(fixture.client)).credits, 40);
  } finally {
    fixture.close();
  }
});

test("configured Google package is authoritative", () => {
  const previous = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  try {
    process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.flavorfusionchef.mobile";
    assert.equal(
      resolveGooglePlayPackageName("com.flavorfusionchef.mobile"),
      "com.flavorfusionchef.mobile",
    );
    assert.equal(
      resolveGooglePlayPackageName(),
      "com.flavorfusionchef.mobile",
    );
    assert.throws(
      () => resolveGooglePlayPackageName("com.attacker.application"),
      (error) =>
        error.statusCode === 400 &&
        /does not match the configured Android application/.test(error.message),
    );
    assert.throws(
      () => resolveGooglePlayPackageName("malformed"),
      (error) => error.statusCode === 400,
    );

    delete process.env.GOOGLE_PLAY_PACKAGE_NAME;
    assert.throws(
      () => resolveGooglePlayPackageName(),
      (error) => error.statusCode === 500,
    );
    process.env.GOOGLE_PLAY_PACKAGE_NAME = "not-a-package";
    assert.throws(
      () => resolveGooglePlayPackageName(),
      (error) => error.statusCode === 500,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.GOOGLE_PLAY_PACKAGE_NAME;
    } else {
      process.env.GOOGLE_PLAY_PACKAGE_NAME = previous;
    }
  }
});

test("mismatched client package is rejected before credentials or network", async () => {
  const previousPackage = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  const previousEmail = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL;
  const previousKey = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY;
  try {
    process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.flavorfusionchef.mobile";
    delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY;
    await assert.rejects(
      verifyGooglePurchase({
        purchaseToken: "must-not-be-sent",
        expectedProductId: "credits_20_android",
        packageName: "com.attacker.application",
      }),
      (error) =>
        error.statusCode === 400 &&
        /does not match the configured Android application/.test(error.message),
    );
  } finally {
    for (const [name, value] of [
      ["GOOGLE_PLAY_PACKAGE_NAME", previousPackage],
      ["GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL", previousEmail],
      ["GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY", previousKey],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("Google provider states distinguish pending, purchased, and canceled", () => {
  assert.equal(resolveGooglePurchaseState(2), "pending");
  assert.equal(resolveGooglePurchaseState(0), "purchased");
  assert.equal(resolveGooglePurchaseState(1), "canceled");
  assert.throws(
    () => resolveGooglePurchaseState("2"),
    (error) => error.statusCode === 502,
  );
  assert.match(routeSource, /grantedCredits: 0/);
  assert.match(routeSource, /status: verification\.state === "revoked" \? "revoked" : "rejected"/);
});

test("Google token fallback is hashed and route preserves mobile response shape", () => {
  const token = "sensitive-google-purchase-token";
  const transactionId = buildGooglePurchaseTransactionId(null, token);
  assert.match(transactionId, /^token_sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(transactionId, /sensitive-google-purchase-token/);
  assert.match(routeSource, /packageName: body\.packageName/);
  assert.match(routeSource, /allowGooglePendingPromotion/);
  assert.match(routeSource, /purchase: purchaseForResponse\(settlement\.purchase\)/);
  assert.match(routeSource, /grantedCredits: credits/);
  assert.match(routeSource, /replay: true/);
  assert.doesNotMatch(routeSource, /grantCredits\s*\(/);
});
