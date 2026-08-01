import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createClient } from "@libsql/client";
import { settleVerifiedPurchase } from "./monetization-purchase-settlement.ts";

const settlementMigrationSql = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const verificationRouteSource = readFileSync(
  new URL("../app/api/monetization/purchases/verify/route.ts", import.meta.url),
  "utf8",
);

function baseSchemaSql(enforceCandidateUniqueness) {
  return `
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

    ${
      enforceCandidateUniqueness
        ? `CREATE UNIQUE INDEX idx_credit_ledger_idempotency
             ON credit_ledger_entries (idempotency_scope, idempotency_key)
             WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL;`
        : ""
    }

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
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ${enforceCandidateUniqueness ? ", UNIQUE(provider, provider_transaction_id)" : ""}
    );
  `;
}

async function createFixture(options = {}) {
  const databasePath = path.join(
    tmpdir(),
    `ff-purchase-settlement-${randomUUID()}.db`,
  );
  const url = `file:${databasePath.replace(/\\/g, "/")}`;
  const client = createClient({ url });
  await client.executeMultiple(
    baseSchemaSql(options.enforceCandidateUniqueness !== false),
  );
  await client.executeMultiple(settlementMigrationSql);

  return {
    client,
    url,
    async close(additionalClients = []) {
      for (const additionalClient of additionalClients) {
        additionalClient.close();
      }
      client.close();
    },
  };
}

function purchaseInput(overrides = {}) {
  const provider = overrides.provider ?? "apple_app_store";
  const providerTransactionId =
    overrides.providerTransactionId ?? "provider-transaction-1";
  return {
    provider,
    providerTransactionId,
    providerOriginalTransactionId:
      overrides.providerOriginalTransactionId ?? "original-transaction-1",
    canonicalAnonUserId: overrides.canonicalAnonUserId ?? "user-1",
    productId:
      overrides.productId ?? "com.flavorfusion.credits.20",
    verifiedCredits: overrides.verifiedCredits ?? 20,
    verifiedAt: overrides.verifiedAt ?? "2026-07-31T08:00:00.000Z",
    settlementIdempotencyKey:
      overrides.settlementIdempotencyKey ??
      `${provider}:${providerTransactionId}`,
    providerVerificationPayload:
      overrides.providerVerificationPayload ?? {
        transactionId: providerTransactionId,
        productId:
          overrides.productId ?? "com.flavorfusion.credits.20",
        receipt: "fixture-provider-receipt",
      },
    providerMetadata: overrides.providerMetadata ?? {
      verificationState: "purchased",
    },
    currency: overrides.currency ?? "USD",
    price: overrides.price ?? "1.99",
    riskFlags: overrides.riskFlags ?? [],
  };
}

function settlementOptions(client, overrides = {}) {
  return {
    client,
    ensureSchemas: async () => {},
    now: () => new Date("2026-07-31T09:00:00.000Z"),
    createId: overrides.createId ?? randomUUID,
    faultInjector: overrides.faultInjector,
    afterCommit: overrides.afterCommit,
  };
}

async function queryCount(client, table) {
  const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function financialSnapshot(client, anonUserId = "user-1") {
  const balance = await client.execute({
    sql: `SELECT available_credits, pending_credits
          FROM credit_balances WHERE anon_user_id = ?`,
    args: [anonUserId],
  });
  return {
    purchases: await queryCount(client, "credit_purchase_transactions"),
    ledgers: await queryCount(client, "credit_ledger_entries"),
    links: await queryCount(client, "credit_purchase_ledger_links"),
    balanceRows: await queryCount(client, "credit_balances"),
    availableCredits: Number(balance.rows[0]?.available_credits ?? 0),
    pendingCredits: Number(balance.rows[0]?.pending_credits ?? 0),
  };
}

async function seedBalance(client, anonUserId, availableCredits) {
  await client.execute({
    sql: `INSERT INTO credit_balances (
            anon_user_id, available_credits, pending_credits
          ) VALUES (?, ?, 0)`,
    args: [anonUserId, availableCredits],
  });
}

async function seedPurchase(client, overrides = {}) {
  const input = purchaseInput(overrides);
  await client.execute({
    sql: `INSERT INTO credit_purchase_transactions (
            row_id,
            provider,
            provider_transaction_id,
            provider_original_transaction_id,
            anon_user_id,
            product_id,
            status,
            granted_credits,
            reversed_credits,
            outstanding_reversal_credits,
            risk_flags_json,
            payload_json,
            verified_at,
            revoked_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', '{}', ?, NULL)`,
    args: [
      overrides.rowId ?? "purchase-1",
      input.provider,
      input.providerTransactionId,
      input.providerOriginalTransactionId,
      input.canonicalAnonUserId,
      input.productId,
      overrides.status ?? "verified",
      overrides.grantedCredits ?? input.verifiedCredits,
      overrides.verifiedAt === null ? null : input.verifiedAt,
    ],
  });
  return overrides.rowId ?? "purchase-1";
}

async function seedLedger(client, overrides = {}) {
  const input = purchaseInput(overrides);
  const metadata =
    overrides.metadata ??
    {
      provider: input.provider,
      productId: input.productId,
      providerTransactionId: input.providerTransactionId,
    };
  await client.execute({
    sql: `INSERT INTO credit_ledger_entries (
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'purchase_verification', ?)`,
    args: [
      overrides.entryId ?? "ledger-1",
      overrides.ledgerOwner ?? input.canonicalAnonUserId,
      overrides.eventType ?? "purchase_grant",
      overrides.ledgerAmount ?? input.verifiedCredits,
      overrides.balanceAvailableAfter ?? input.verifiedCredits,
      "purchase-credit-grant",
      input.settlementIdempotencyKey,
      JSON.stringify(metadata),
    ],
  });
  return overrides.entryId ?? "ledger-1";
}

test("successful new settlement atomically creates every financial record", async () => {
  const fixture = await createFixture();
  try {
    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(result.status, "settled");
    assert.equal(result.purchase.status, "verified");
    assert.equal(result.purchase.grantedCredits, 20);
    assert.equal(result.balance.availableCredits, 20);
    assert.deepEqual(await financialSnapshot(fixture.client), {
      purchases: 1,
      ledgers: 1,
      links: 1,
      balanceRows: 1,
      availableCredits: 20,
      pendingCredits: 0,
    });

    const ledger = (
      await fixture.client.execute(
        `SELECT event_type, amount, idempotency_scope, idempotency_key,
                metadata_json
         FROM credit_ledger_entries`,
      )
    ).rows[0];
    assert.equal(ledger?.event_type, "purchase_grant");
    assert.equal(ledger?.amount, 20);
    assert.equal(ledger?.idempotency_scope, "purchase-credit-grant");
    assert.equal(
      ledger?.idempotency_key,
      "apple_app_store:provider-transaction-1",
    );
    const metadata = JSON.parse(String(ledger?.metadata_json));
    assert.match(metadata.providerVerificationHash, /^[a-f0-9]{64}$/);
    assert.equal(metadata.productId, "com.flavorfusion.credits.20");
  } finally {
    await fixture.close();
  }
});

test("fault injection rolls back every write at each settlement stage", async (t) => {
  for (const stage of [
    "after_purchase_insert",
    "after_ledger_insert",
    "after_balance_update",
    "after_link_insert",
  ]) {
    await t.test(stage, async () => {
      const fixture = await createFixture();
      try {
        await assert.rejects(
          settleVerifiedPurchase(
            purchaseInput(),
            settlementOptions(fixture.client, {
              faultInjector: (currentStage) => {
                if (currentStage === stage) {
                  throw new Error(`fault:${stage}`);
                }
              },
            }),
          ),
          new RegExp(`fault:${stage}`),
        );
        assert.deepEqual(await financialSnapshot(fixture.client), {
          purchases: 0,
          ledgers: 0,
          links: 0,
          balanceRows: 0,
          availableCredits: 0,
          pendingCredits: 0,
        });
      } finally {
        await fixture.close();
      }
    });
  }
});

test("same provider transaction replays without balance or ledger duplication", async () => {
  const fixture = await createFixture();
  try {
    const first = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    const replay = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(first.status, "settled");
    assert.equal(replay.status, "replay");
    assert.deepEqual(await financialSnapshot(fixture.client), {
      purchases: 1,
      ledgers: 1,
      links: 1,
      balanceRows: 1,
      availableCredits: 20,
      pendingCredits: 0,
    });
  } finally {
    await fixture.close();
  }
});

test("different API idempotency requests converge on the provider settlement key", async () => {
  const fixture = await createFixture();
  try {
    const first = await settleVerifiedPurchase(
      purchaseInput({
        providerMetadata: { apiIdempotencyKey: "api-request-a" },
      }),
      settlementOptions(fixture.client),
    );
    const second = await settleVerifiedPurchase(
      purchaseInput({
        providerMetadata: { apiIdempotencyKey: "api-request-b" },
      }),
      settlementOptions(fixture.client),
    );
    assert.equal(first.status, "settled");
    assert.equal(second.status, "replay");
    assert.equal((await financialSnapshot(fixture.client)).availableCredits, 20);
    assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 1);
  } finally {
    await fixture.close();
  }
});

test("concurrent duplicate settlement requests serialize to settled plus replay", async () => {
  const fixture = await createFixture();
  const secondClient = createClient({ url: fixture.url });
  try {
    const [first, second] = await Promise.all([
      settleVerifiedPurchase(
        purchaseInput(),
        settlementOptions(secondClient),
      ),
      settleVerifiedPurchase(
        purchaseInput(),
        settlementOptions(fixture.client),
      ),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort(),
      ["replay", "settled"],
    );
    assert.deepEqual(await financialSnapshot(fixture.client), {
      purchases: 1,
      ledgers: 1,
      links: 1,
      balanceRows: 1,
      availableCredits: 20,
      pendingCredits: 0,
    });
  } finally {
    await fixture.close([secondClient]);
  }
});

test("cross-account replay is rejected without creating another balance", async () => {
  const fixture = await createFixture();
  try {
    await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    const conflict = await settleVerifiedPurchase(
      purchaseInput({ canonicalAnonUserId: "user-2" }),
      settlementOptions(fixture.client),
    );
    assert.deepEqual(conflict, {
      status: "owner_conflict",
      reason: "purchase_owner_mismatch",
    });
    assert.equal(await queryCount(fixture.client, "credit_balances"), 1);
    assert.equal((await financialSnapshot(fixture.client)).availableCredits, 20);
  } finally {
    await fixture.close();
  }
});

test("purchase present with missing grant and link is recovered exactly once", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, "user-1", 5);
    await seedPurchase(fixture.client);
    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(result.status, "recovered");
    assert.equal(result.balance.availableCredits, 25);
    assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 1);
    assert.equal(
      await queryCount(fixture.client, "credit_purchase_ledger_links"),
      1,
    );

    const replay = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(replay.status, "replay");
    assert.equal(replay.balance.availableCredits, 25);
  } finally {
    await fixture.close();
  }
});

test("grant present with missing purchase and link is recovered without another grant", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, "user-1", 20);
    await seedLedger(fixture.client);
    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(result.status, "recovered");
    assert.equal(result.balance.availableCredits, 20);
    assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 1);
    assert.equal(
      await queryCount(fixture.client, "credit_purchase_transactions"),
      1,
    );
    assert.equal(
      await queryCount(fixture.client, "credit_purchase_ledger_links"),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("matching purchase and ledger with missing link creates only the link", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, "user-1", 20);
    await seedPurchase(fixture.client);
    await seedLedger(fixture.client);
    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(result.status, "recovered");
    assert.deepEqual(await financialSnapshot(fixture.client), {
      purchases: 1,
      ledgers: 1,
      links: 1,
      balanceRows: 1,
      availableCredits: 20,
      pendingCredits: 0,
    });
  } finally {
    await fixture.close();
  }
});

test("a conflicting base-grant link fails closed without correction", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, "user-1", 20);
    await seedPurchase(fixture.client);
    await seedLedger(fixture.client);
    await fixture.client.execute(
      `INSERT INTO credit_ledger_entries (
        entry_id, anon_user_id, event_type, amount,
        balance_available_after, balance_pending_after,
        idempotency_scope, idempotency_key, actor, metadata_json
      ) VALUES (
        'wrong-ledger', 'user-1', 'purchase_grant', 20,
        20, 0, 'legacy', 'wrong-key', 'fixture', '{}'
      )`,
    );
    await fixture.client.execute(
      `INSERT INTO credit_purchase_ledger_links (
        id, purchase_transaction_id, ledger_entry_id, link_kind
      ) VALUES ('wrong-link', 'purchase-1', 'wrong-ledger', 'base_grant')`,
    );

    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.deepEqual(result, {
      status: "inconsistent_state",
      reason: "base_grant_link_conflict",
    });
    assert.equal((await financialSnapshot(fixture.client)).availableCredits, 20);
    assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 2);
    assert.equal(
      await queryCount(fixture.client, "credit_purchase_ledger_links"),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("ledger owner mismatch fails closed", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, "other-user", 20);
    await seedLedger(fixture.client, { ledgerOwner: "other-user" });
    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.deepEqual(result, {
      status: "owner_conflict",
      reason: "ledger_owner_mismatch",
    });
    assert.equal(await queryCount(fixture.client, "credit_purchase_transactions"), 0);
    assert.equal(await queryCount(fixture.client, "credit_purchase_ledger_links"), 0);
  } finally {
    await fixture.close();
  }
});

test("amount and product mismatches fail closed without financial correction", async (t) => {
  await t.test("amount mismatch", async () => {
    const fixture = await createFixture();
    try {
      await seedBalance(fixture.client, "user-1", 50);
      await seedPurchase(fixture.client);
      await seedLedger(fixture.client, {
        ledgerAmount: 50,
        balanceAvailableAfter: 50,
      });
      const result = await settleVerifiedPurchase(
        purchaseInput(),
        settlementOptions(fixture.client),
      );
      assert.deepEqual(result, {
        status: "inconsistent_state",
        reason: "ledger_amount_mismatch",
      });
      assert.equal((await financialSnapshot(fixture.client)).availableCredits, 50);
      assert.equal(await queryCount(fixture.client, "credit_purchase_ledger_links"), 0);
    } finally {
      await fixture.close();
    }
  });

  await t.test("product mismatch", async () => {
    const fixture = await createFixture();
    try {
      await seedBalance(fixture.client, "user-1", 20);
      await seedLedger(fixture.client, {
        metadata: {
          provider: "apple_app_store",
          productId: "different-product",
          providerTransactionId: "provider-transaction-1",
        },
      });
      const result = await settleVerifiedPurchase(
        purchaseInput(),
        settlementOptions(fixture.client),
      );
      assert.deepEqual(result, {
        status: "inconsistent_state",
        reason: "ledger_product_mismatch",
      });
    } finally {
      await fixture.close();
    }
  });
});

test("ambiguous duplicate purchase or ledger candidates fail closed", async (t) => {
  await t.test("duplicate ledgers", async () => {
    const fixture = await createFixture({
      enforceCandidateUniqueness: false,
    });
    try {
      await seedBalance(fixture.client, "user-1", 40);
      await seedLedger(fixture.client, { entryId: "ledger-a" });
      await seedLedger(fixture.client, { entryId: "ledger-b" });
      const result = await settleVerifiedPurchase(
        purchaseInput(),
        settlementOptions(fixture.client),
      );
      assert.deepEqual(result, {
        status: "inconsistent_state",
        reason: "multiple_ledger_candidates",
      });
      assert.equal(await queryCount(fixture.client, "credit_purchase_transactions"), 0);
      assert.equal((await financialSnapshot(fixture.client)).availableCredits, 40);
    } finally {
      await fixture.close();
    }
  });

  await t.test("duplicate purchases", async () => {
    const fixture = await createFixture({
      enforceCandidateUniqueness: false,
    });
    try {
      await seedBalance(fixture.client, "user-1", 0);
      await seedPurchase(fixture.client, { rowId: "purchase-a" });
      await seedPurchase(fixture.client, { rowId: "purchase-b" });
      const result = await settleVerifiedPurchase(
        purchaseInput(),
        settlementOptions(fixture.client),
      );
      assert.deepEqual(result, {
        status: "inconsistent_state",
        reason: "multiple_purchase_candidates",
      });
      assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 0);
    } finally {
      await fixture.close();
    }
  });
});

test("response loss after commit is safely resumable as a replay", async () => {
  const fixture = await createFixture();
  try {
    await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    const resumed = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(resumed.status, "replay");
    assert.equal(resumed.purchase.providerTransactionId, "provider-transaction-1");
    assert.equal(resumed.balance.availableCredits, 20);
    assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 1);
  } finally {
    await fixture.close();
  }
});

test("after-commit activity failure cannot roll back settlement and replay retries it", async () => {
  const fixture = await createFixture();
  const originalWarn = console.warn;
  let attempts = 0;
  let backfilled = false;
  console.warn = () => {};
  try {
    const first = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client, {
        afterCommit: async () => {
          attempts += 1;
          throw new Error("activity unavailable");
        },
      }),
    );
    assert.equal(first.status, "settled");
    assert.equal((await financialSnapshot(fixture.client)).availableCredits, 20);

    const replay = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client, {
        afterCommit: async () => {
          attempts += 1;
          backfilled = true;
        },
      }),
    );
    assert.equal(replay.status, "replay");
    assert.equal(attempts, 2);
    assert.equal(backfilled, true);
    assert.equal(await queryCount(fixture.client, "credit_ledger_entries"), 1);
  } finally {
    console.warn = originalWarn;
    await fixture.close();
  }
});

test("purchase response fields remain compatible and route uses atomic settlement", async () => {
  const fixture = await createFixture();
  try {
    const result = await settleVerifiedPurchase(
      purchaseInput(),
      settlementOptions(fixture.client),
    );
    assert.equal(result.status, "settled");
    assert.deepEqual(Object.keys(result.purchase).sort(), [
      "anonUserId",
      "createdAt",
      "grantedCredits",
      "outstandingReversalCredits",
      "payload",
      "productId",
      "provider",
      "providerOriginalTransactionId",
      "providerTransactionId",
      "reversedCredits",
      "revokedAt",
      "riskFlags",
      "rowId",
      "status",
      "updatedAt",
      "verifiedAt",
    ]);
    assert.doesNotMatch(
      verificationRouteSource,
      /const grantResult = await grantCredits\(/,
    );
    assert.match(
      verificationRouteSource,
      /settlement\.status === "replay"[\s\S]*replay: true/,
    );
    assert.match(
      verificationRouteSource,
      /grantedCredits: credits,[\s\S]*balance: settlement\.balance/,
    );
    assert.match(
      verificationRouteSource,
      /afterCommit:[\s\S]*recordVerifiedPurchaseActivitySafely/,
    );
    assert.match(
      verificationRouteSource,
      /verification\.state !== "purchased" \|\| existing\.status !== "verified"/,
    );
  } finally {
    await fixture.close();
  }
});

test("monetization regression refuses remote databases without the isolated-test flag", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/regression-monetization-turso.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TURSO_DATABASE_URL: "libsql://production-like.example.invalid",
        TURSO_AUTH_TOKEN: "fixture-token-that-must-not-be-logged",
        ALLOW_ISOLATED_MONETIZATION_TEST_DATABASE: "",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Remote monetization regression is disabled/,
  );
  assert.doesNotMatch(result.stderr, /fixture-token-that-must-not-be-logged/);
  assert.doesNotMatch(
    result.stderr,
    /libsql:\/\/production-like\.example\.invalid/,
  );
});
