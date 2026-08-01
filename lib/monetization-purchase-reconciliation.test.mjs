import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  PURCHASE_RECONCILIATION_ISSUE_TYPES,
  maskProviderTransactionIdentifier,
  scanPurchaseReconciliation,
} from "./monetization-purchase-reconciliation.ts";

const migrationSql = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const routeSource = readFileSync(
  new URL(
    "../app/api/admin/monetization/reconciliation/purchases/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const adminSource = readFileSync(
  new URL("../components/AdminMonetizationConfigPanel.tsx", import.meta.url),
  "utf8",
);
const purchaseUiSource = readFileSync(
  new URL("../components/AdminPurchaseReconciliationSection.tsx", import.meta.url),
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
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(baseSchemaSql);
  await client.executeMultiple(migrationSql);
  return client;
}

function transactionKey(provider, transactionId) {
  return `${provider}:${transactionId}`;
}

async function seedPurchase(client, overrides = {}) {
  const provider = overrides.provider ?? "google_play";
  const transactionId = overrides.transactionId ?? `GPA.${randomUUID()}`;
  const rowId = overrides.rowId ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO credit_purchase_transactions (
            row_id, provider, provider_transaction_id,
            provider_original_transaction_id, anon_user_id, product_id,
            status, granted_credits, reversed_credits,
            outstanding_reversal_credits, payload_json, verified_at,
            revoked_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      rowId,
      provider,
      transactionId,
      overrides.originalTransactionId ?? transactionId,
      overrides.owner ?? "user-1",
      overrides.productId ?? "credits_20_android",
      overrides.status ?? "verified",
      overrides.grantedCredits ?? 20,
      overrides.reversedCredits ?? 0,
      overrides.outstandingReversalCredits ?? 0,
      JSON.stringify(overrides.payload ?? {}),
      overrides.verifiedAt === null
        ? null
        : (overrides.verifiedAt ?? "2026-08-01T08:00:00.000Z"),
      overrides.revokedAt ?? null,
      overrides.createdAt ?? "2026-08-01T08:00:00.000Z",
      overrides.updatedAt ?? "2026-08-01T08:00:00.000Z",
    ],
  });
  return { provider, transactionId, rowId };
}

async function seedLedger(client, purchase, overrides = {}) {
  const entryId = overrides.entryId ?? randomUUID();
  const owner = overrides.owner ?? "user-1";
  const amount = overrides.amount ?? 20;
  const metadata =
    overrides.metadata ??
    {
      provider: purchase?.provider ?? "google_play",
      providerTransactionId: purchase?.transactionId ?? "GPA.missing",
      productId: overrides.productId ?? "credits_20_android",
      providerPayload: { purchaseToken: "must-never-be-returned" },
    };
  await client.execute({
    sql: `INSERT INTO credit_ledger_entries (
            entry_id, anon_user_id, event_type, amount,
            balance_available_after, balance_pending_after,
            idempotency_scope, idempotency_key, actor,
            metadata_json, created_at
          ) VALUES (?, ?, 'purchase_grant', ?, ?, 0, ?, ?,
            'purchase_verification', ?, ?)`,
    args: [
      entryId,
      owner,
      amount,
      overrides.balanceAfter ?? amount,
      overrides.idempotencyScope === undefined
        ? "purchase-credit-grant"
        : overrides.idempotencyScope,
      overrides.idempotencyKey === undefined
        ? transactionKey(
            purchase?.provider ?? "google_play",
            purchase?.transactionId ?? "GPA.missing",
          )
        : overrides.idempotencyKey,
      JSON.stringify(metadata),
      overrides.createdAt ?? "2026-08-01T08:01:00.000Z",
    ],
  });
  return entryId;
}

async function seedLink(client, purchaseRowId, ledgerEntryId) {
  await client.execute({
    sql: `INSERT INTO credit_purchase_ledger_links (
            id, purchase_transaction_id, ledger_entry_id, link_kind
          ) VALUES (?, ?, ?, 'base_grant')`,
    args: [randomUUID(), purchaseRowId, ledgerEntryId],
  });
}

async function seedBalance(client, owner = "user-1", amount = 20) {
  await client.execute({
    sql: `INSERT INTO credit_balances (
            anon_user_id, available_credits, pending_credits
          ) VALUES (?, ?, 0)`,
    args: [owner, amount],
  });
}

async function scan(client) {
  return scanPurchaseReconciliation({
    client,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
  });
}

function assertSingleIssue(report, issueType) {
  assert.equal(report.status, "needs_attention");
  assert.equal(report.totalIssues, 1);
  assert.equal(report.counts[issueType], 1);
  assert.equal(report.issues[0]?.issueType, issueType);
}

test("fully matched purchase is healthy and reports its database snapshot time", async () => {
  const client = await createFixture();
  try {
    const purchase = await seedPurchase(client);
    const ledger = await seedLedger(client, purchase);
    await seedLink(client, purchase.rowId, ledger);
    await seedBalance(client);
    const report = await scan(client);
    assert.equal(report.status, "healthy");
    assert.equal(report.totalIssues, 0);
    assert.equal(report.checkedAt, "2026-08-01T12:00:00.000Z");
    assert.deepEqual(report.issues, []);
    assert.deepEqual(Object.values(report.counts), [0, 0, 0, 0, 0, 0, 0]);
  } finally {
    client.close();
  }
});

test("healthy deterministic legacy grant without product metadata is not flagged", async () => {
  const client = await createFixture();
  try {
    const purchase = await seedPurchase(client);
    const ledger = await seedLedger(client, purchase, { metadata: {} });
    await seedLink(client, purchase.rowId, ledger);
    const report = await scan(client);
    assert.equal(report.status, "healthy");
    assert.equal(report.totalIssues, 0);
  } finally {
    client.close();
  }
});

test("scanner detects each evidence-backed purchase inconsistency", async (t) => {
  const cases = [
    {
      name: "verified purchase missing grant",
      issueType: "purchase_missing_grant",
      arrange: async (client) => {
        await seedPurchase(client);
      },
    },
    {
      name: "grant missing purchase",
      issueType: "grant_missing_purchase",
      arrange: async (client) => {
        await seedLedger(client, null);
      },
    },
    {
      name: "matching records missing link",
      issueType: "missing_purchase_ledger_link",
      arrange: async (client) => {
        const purchase = await seedPurchase(client);
        await seedLedger(client, purchase);
      },
    },
    {
      name: "linked credit amount mismatch",
      issueType: "credit_amount_mismatch",
      arrange: async (client) => {
        const purchase = await seedPurchase(client);
        const ledger = await seedLedger(client, purchase, { amount: 50 });
        await seedLink(client, purchase.rowId, ledger);
      },
    },
    {
      name: "linked owner mismatch",
      issueType: "owner_mismatch",
      arrange: async (client) => {
        const purchase = await seedPurchase(client);
        const ledger = await seedLedger(client, purchase, { owner: "user-2" });
        await seedLink(client, purchase.rowId, ledger);
      },
    },
    {
      name: "duplicate grant association",
      issueType: "duplicate_grant",
      arrange: async (client) => {
        const purchase = await seedPurchase(client);
        const ledger = await seedLedger(client, purchase);
        await seedLink(client, purchase.rowId, ledger);
        await seedLedger(client, purchase, {
          idempotencyScope: null,
          idempotencyKey: null,
        });
      },
    },
    {
      name: "linked product conflict",
      issueType: "product_or_transaction_conflict",
      arrange: async (client) => {
        const purchase = await seedPurchase(client);
        const ledger = await seedLedger(client, purchase, {
          metadata: {
            provider: purchase.provider,
            providerTransactionId: purchase.transactionId,
            productId: "credits_50_android",
          },
        });
        await seedLink(client, purchase.rowId, ledger);
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = await createFixture();
      try {
        await scenario.arrange(client);
        const report = await scan(client);
        assertSingleIssue(report, scenario.issueType);
      } finally {
        client.close();
      }
    });
  }
});

test("pending, canceled, rejected, and properly reversed purchases are excluded", async () => {
  const client = await createFixture();
  try {
    await seedPurchase(client, {
      transactionId: "GPA.pending",
      status: "rejected",
      grantedCredits: 0,
      verifiedAt: null,
      payload: { purchaseState: 2 },
    });
    await seedPurchase(client, {
      transactionId: "GPA.canceled",
      status: "rejected",
      grantedCredits: 0,
      verifiedAt: null,
      revokedAt: "2026-08-01T08:00:00.000Z",
      payload: { purchaseState: 1 },
    });
    await seedPurchase(client, {
      transactionId: "GPA.rejected",
      status: "rejected",
      grantedCredits: 0,
      verifiedAt: null,
    });
    const reversed = await seedPurchase(client, {
      transactionId: "GPA.reversed",
      status: "revoked",
      grantedCredits: 20,
      reversedCredits: 20,
      revokedAt: "2026-08-01T10:00:00.000Z",
    });
    const reversalLedger = await seedLedger(client, reversed);
    await seedLink(client, reversed.rowId, reversalLedger);

    const report = await scan(client);
    assert.equal(report.status, "healthy");
    assert.equal(report.totalIssues, 0);
  } finally {
    client.close();
  }
});

test("empty database returns healthy with every count set to zero", async () => {
  const client = await createFixture();
  try {
    const report = await scan(client);
    assert.equal(report.status, "healthy");
    assert.equal(report.totalIssues, 0);
    assert.deepEqual(
      Object.keys(report.counts),
      [...PURCHASE_RECONCILIATION_ISSUE_TYPES],
    );
    assert.ok(Object.values(report.counts).every((count) => count === 0));
  } finally {
    client.close();
  }
});

test("provider identifiers are masked and provider tokens are never returned", async () => {
  const client = await createFixture();
  try {
    const secretToken = "plaintext-google-purchase-token";
    await seedPurchase(client, {
      transactionId: `token:${secretToken}`,
    });
    const report = await scan(client);
    assertSingleIssue(report, "purchase_missing_grant");
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /plaintext-google-purchase-token/);
    assert.match(
      report.issues[0].maskedProviderTransactionId,
      /^Google token ••••[a-f0-9]{10}$/,
    );
    assert.doesNotMatch(
      maskProviderTransactionIdentifier("google_play", `token:${secretToken}`),
      /plaintext-google-purchase-token/,
    );
  } finally {
    client.close();
  }
});

test("scanner executes one SELECT and performs zero database writes", async () => {
  const client = await createFixture();
  try {
    const purchase = await seedPurchase(client);
    const ledger = await seedLedger(client, purchase);
    await seedLink(client, purchase.rowId, ledger);
    const before = await client.execute(
      "SELECT COUNT(*) AS purchases FROM credit_purchase_transactions",
    );
    const statements = [];
    const readOnlyClient = {
      execute(statement) {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);
        assert.match(sql, /^\s*SELECT\b/i);
        assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i);
        return client.execute(statement);
      },
    };
    const report = await scanPurchaseReconciliation({ client: readOnlyClient });
    const after = await client.execute(
      "SELECT COUNT(*) AS purchases FROM credit_purchase_transactions",
    );
    assert.equal(report.status, "healthy");
    assert.equal(statements.length, 1);
    assert.equal(after.rows[0]?.purchases, before.rows[0]?.purchases);
  } finally {
    client.close();
  }
});

test("purchase monitoring endpoint is authenticated, rate-limited, no-store, and GET-only", () => {
  const getHandler = routeSource.slice(routeSource.indexOf("export async function GET"));
  assert.match(getHandler, /requireMonetizationAdmin\(request\)/);
  assert.match(getHandler, /enforceRateLimit\(request/);
  assert.match(getHandler, /scanPurchaseReconciliation\(\)/);
  assert.match(routeSource, /withNoStore/);
  assert.match(routeSource, /api-admin-purchase-reconciliation-read/);
  assert.match(routeSource, /strategy: "memory"/);
  assert.doesNotMatch(routeSource, /export async function POST/);
  assert.doesNotMatch(routeSource, /reconcileExpiredReservations/);
  assert.doesNotMatch(routeSource, /product_activity_events/);
});

test("admin reconciliation UI preserves reservations and renders purchase monitoring states", () => {
  assert.match(adminSource, />\s*Expired Reservation Reconciliation\s*</);
  assert.match(
    adminSource,
    /Use this when credits remain temporarily locked after a recipe generation or other\s+credit-consuming action did not finish\./,
  );
  assert.match(adminSource, /Preview Expired Reservations/);
  assert.match(adminSource, /Run Reconciliation Now/);
  assert.match(adminSource, /loadReconciliationPreview/);
  assert.match(adminSource, /runReconciliationNow/);
  assert.match(adminSource, /AdminPurchaseReconciliationSection/);

  assert.match(purchaseUiSource, />\s*Purchase Reconciliation\s*</);
  assert.match(
    purchaseUiSource,
    /Use this when a user reports being charged without receiving the correct credits/,
  );
  assert.match(purchaseUiSource, /"Healthy"/);
  assert.match(purchaseUiSource, /"Needs attention"/);
  assert.match(purchaseUiSource, /No purchase or credit mismatches were detected\./);
  assert.match(purchaseUiSource, /onClick=\{\(\) => void loadPurchaseReconciliation\(\)\}/);
  assert.match(
    purchaseUiSource,
    /\/api\/admin\/monetization\/reconciliation\/purchases/,
  );
  assert.match(purchaseUiSource, /Review resolution/);
  assert.match(purchaseUiSource, /Manual investigation required/);
  assert.doesNotMatch(purchaseUiSource, /Repair all|multi-select/i);
});
