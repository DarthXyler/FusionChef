import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import { buildAccountDeletionGraphCleanupStatements } from "./account-deletion-execution.ts";
import { planAccountDeletion as planAccountDeletionWithSecret } from "./account-deletion-planner.ts";
import { scanPurchaseReconciliation } from "./monetization-purchase-reconciliation.ts";
import {
  ACCOUNT_DELETION_RECONCILIATION_METADATA,
  createAccountDeletionPseudonym,
  isAccountDeletionPseudonym,
} from "./purchase-settlement-retention.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const ALIAS = "22222222-2222-4222-8222-222222222222";
const OUTSIDE = "99999999-9999-4999-8999-999999999999";
const SECRET = "purchase-retention-fixture-secret-at-least-32-bytes";
const pur01Migration = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

function planAccountDeletion(options) {
  return planAccountDeletionWithSecret({
    ...options,
    secret: SECRET,
    publicBaseUrl: "https://r2.example.test",
  });
}

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE auth_identity_links (
    auth_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL
  );
  CREATE TABLE mobile_identity_aliases (
    anon_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL
  );
  CREATE TABLE mobile_identity_links (
    device_key TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL
  );
  CREATE TABLE cookbook_recipes (
    row_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL, image_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY,
    available_credits INTEGER NOT NULL,
    pending_credits INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    expires_at TEXT
  );
  CREATE TABLE credit_daily_usage (
    anon_user_id TEXT NOT NULL, day_key TEXT NOT NULL
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_available_after INTEGER NOT NULL,
    balance_pending_after INTEGER NOT NULL DEFAULT 0,
    reservation_id TEXT,
    idempotency_scope TEXT,
    idempotency_key TEXT,
    actor TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_transaction_id TEXT NOT NULL,
    provider_original_transaction_id TEXT,
    anon_user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL,
    granted_credits INTEGER NOT NULL,
    reversed_credits INTEGER NOT NULL DEFAULT 0,
    outstanding_reversal_credits INTEGER NOT NULL DEFAULT 0,
    risk_flags_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    verified_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_transaction_id)
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY, auth_user_id TEXT, canonical_anon_user_id TEXT
  );
`;

async function createFixture() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(schema);
  await client.executeMultiple(pur01Migration);
  return client;
}

async function seedPayingUser(client) {
  await client.executeMultiple(`
    INSERT INTO auth_users (id, email) VALUES ('auth-paying', 'paying@example.test');
    INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id)
      VALUES ('auth-paying', '${ROOT}');
    INSERT INTO mobile_identity_aliases (anon_user_id, canonical_anon_user_id)
      VALUES ('${ALIAS}', '${ROOT}');
    INSERT INTO credit_balances (
      anon_user_id, available_credits, pending_credits, updated_at
    ) VALUES ('${ALIAS}', 35, 0, '2026-08-02T00:00:00.000Z');
    INSERT INTO credit_purchase_transactions (
      row_id, provider, provider_transaction_id, anon_user_id, product_id,
      status, granted_credits, reversed_credits,
      outstanding_reversal_credits, risk_flags_json, payload_json,
      verified_at, revoked_at, created_at, updated_at
    ) VALUES
      (
        'purchase-active', 'google_play', 'txn-active', '${ALIAS}',
        'credits.medium', 'verified', 35, 0, 0, '[]',
        '{"email":"paying@example.test","token":"secret-token"}',
        '2026-08-01T00:00:00.000Z', NULL,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      ),
      (
        'purchase-refund', 'apple_app_store', 'txn-refund', '${ALIAS}',
        'credits.small', 'revoked', 20, 20, 0,
        '["provider_refunded"]', '{"receipt":"secret-receipt"}',
        '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
      );
    INSERT INTO credit_ledger_entries (
      entry_id, anon_user_id, event_type, amount,
      balance_available_after, idempotency_scope, idempotency_key,
      actor, metadata_json, created_at
    ) VALUES
      (
        'ledger-base', '${ALIAS}', 'purchase_grant', 30, 30,
        'purchase-credit-grant', 'google_play:txn-active',
        'purchase:paying@example.test',
        '{"provider":"google_play","providerTransactionId":"txn-active","productId":"credits.medium","email":"paying@example.test"}',
        '2026-08-01T00:00:00.000Z'
      ),
      (
        'ledger-adjustment', '${ALIAS}', 'purchase_adjustment', 5, 35,
        'purchase-reconciliation-adjustment', 'adjustment-1',
        'admin:person@example.test', '{"reason":"private"}',
        '2026-08-01T01:00:00.000Z'
      ),
      (
        'ledger-refund-base', '${ALIAS}', 'purchase_grant', 20, 55,
        'purchase-credit-grant', 'apple_app_store:txn-refund',
        'purchase',
        '{"provider":"apple_app_store","providerTransactionId":"txn-refund","productId":"credits.small"}',
        '2026-07-01T00:00:00.000Z'
      ),
      (
        'ledger-reversal', '${ALIAS}', 'purchase_reversal', -20, 35,
        'purchase-reversal-deduction', 'reversal-1',
        'admin:person@example.test', '{"refund":"provider"}',
        '2026-07-10T00:00:00.000Z'
      ),
      (
        'ledger-operational', '${ALIAS}', 'grant', 1, 36,
        'admin-grant', 'grant-1', 'admin:person@example.test',
        '{"email":"paying@example.test"}', '2026-08-02T00:00:00.000Z'
      );
    INSERT INTO credit_purchase_ledger_links (
      id, purchase_transaction_id, ledger_entry_id, link_kind
    ) VALUES
      ('link-base', 'purchase-active', 'ledger-base', 'base_grant'),
      ('link-adjustment', 'purchase-active', 'ledger-adjustment', 'repair_adjustment'),
      ('link-refund-base', 'purchase-refund', 'ledger-refund-base', 'base_grant'),
      ('link-reversal', 'purchase-refund', 'ledger-reversal', 'reversal');
    INSERT INTO purchase_reconciliation_actions (
      id, issue_type, purchase_transaction_id, ledger_entry_id,
      admin_actor, reason, preview_fingerprint, idempotency_key,
      balance_before, balance_after, credit_delta,
      provider_verification_hash, status, completed_at, metadata_json
    ) VALUES (
      'action-adjustment', 'credit_amount_mismatch', 'purchase-active',
      'ledger-adjustment', 'auth_user:admin-id', 'Audited correction',
      'preview-hash', 'action-idempotency', 30, 35, 5,
      'provider-verification-hash', 'completed',
      '2026-08-01T01:00:00.000Z',
      '{"email":"paying@example.test","token":"must-remove"}'
    );
  `);
}

test("paying deletion retains linked grants, adjustments, reversals, refunds, and healthy reconciliation", async () => {
  const client = await createFixture();
  try {
    await seedPayingUser(client);
    const before = await scanPurchaseReconciliation({ client });
    assert.equal(before.status, "healthy");

    const plan = await planAccountDeletion({
      authUserIds: ["auth-paying"],
      client,
    });
    const [graph] = plan.graphs;
    assert.equal(graph.status, "ready");
    assert.equal(graph.inventory.financialLedgerEntriesRetained, 4);
    assert.equal(graph.inventory.operationalLedgerEntriesDeleted, 1);
    const pseudonym = createAccountDeletionPseudonym({
      authUserIds: graph.ownerAuthUserIds,
      identityNodes: graph.identityNodes,
      secret: SECRET,
    });
    assert.ok(isAccountDeletionPseudonym(pseudonym));
    assert.doesNotMatch(pseudonym, /auth-paying|11111111|22222222/);

    await client.batch(
      buildAccountDeletionGraphCleanupStatements({
        graph,
        deletedPurchaseOwner: pseudonym,
      }),
      "write",
    );

    const purchases = await client.execute(
      `SELECT anon_user_id, status, granted_credits, reversed_credits,
              risk_flags_json, payload_json
       FROM credit_purchase_transactions ORDER BY row_id`,
    );
    assert.equal(purchases.rows.length, 2);
    assert.ok(purchases.rows.every((row) => row.anon_user_id === pseudonym));
    assert.ok(purchases.rows.every((row) => row.payload_json === "{}"));
    assert.deepEqual(
      purchases.rows.map((row) => ({
        status: row.status,
        granted: Number(row.granted_credits),
        reversed: Number(row.reversed_credits),
        risk: row.risk_flags_json,
      })),
      [
        { status: "verified", granted: 35, reversed: 0, risk: "[]" },
        {
          status: "revoked",
          granted: 20,
          reversed: 20,
          risk: '["provider_refunded"]',
        },
      ],
    );

    const ledgers = await client.execute(
      `SELECT anon_user_id, event_type, actor, metadata_json
       FROM credit_ledger_entries ORDER BY entry_id`,
    );
    assert.equal(ledgers.rows.length, 4);
    assert.deepEqual(
      ledgers.rows.map((row) => row.event_type).sort(),
      [
        "purchase_adjustment",
        "purchase_grant",
        "purchase_grant",
        "purchase_reversal",
      ],
    );
    assert.ok(ledgers.rows.every((row) => row.anon_user_id === pseudonym));
    assert.ok(
      ledgers.rows.every(
        (row) => row.actor === "account_deletion_retained_financial",
      ),
    );
    assert.ok(
      ledgers.rows.every((row) =>
        String(row.metadata_json).includes("redacted_for_account_deletion"),
      ),
    );
    assert.equal(
      Number(
        (
          await client.execute(
            "SELECT COUNT(*) AS count FROM credit_purchase_ledger_links",
          )
        ).rows[0].count,
      ),
      4,
    );
    const action = (
      await client.execute(
        `SELECT purchase_transaction_id, ledger_entry_id, metadata_json
         FROM purchase_reconciliation_actions`,
      )
    ).rows[0];
    assert.deepEqual(
      { ...action },
      {
        purchase_transaction_id: "purchase-active",
        ledger_entry_id: "ledger-adjustment",
        metadata_json: ACCOUNT_DELETION_RECONCILIATION_METADATA,
      },
    );
    const after = await scanPurchaseReconciliation({ client });
    assert.equal(after.status, "healthy");
    assert.equal(after.totalIssues, 0);

    const retainedText = JSON.stringify({
      purchases: purchases.rows.map((row) => ({ ...row })),
      ledgers: ledgers.rows.map((row) => ({ ...row })),
    });
    assert.doesNotMatch(retainedText, /auth-paying|paying@example\.test|secret-token|secret-receipt/);
  } finally {
    client.close();
  }
});

test("no-purchase user retains no operational ledger evidence", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES ('auth-free', 'free@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id)
        VALUES ('auth-free', '${ROOT}');
      INSERT INTO credit_ledger_entries (
        entry_id, anon_user_id, event_type, amount,
        balance_available_after, actor, created_at
      ) VALUES ('free-grant', '${ROOT}', 'grant', 5, 5, 'admin', '2026-08-02T00:00:00.000Z');
    `);
    const [graph] = (
      await planAccountDeletion({ authUserIds: ["auth-free"], client })
    ).graphs;
    assert.equal(graph.inventory.financialLedgerEntriesRetained, 0);
    assert.equal(graph.inventory.operationalLedgerEntriesDeleted, 1);
    const pseudonym = createAccountDeletionPseudonym({
      authUserIds: graph.ownerAuthUserIds,
      identityNodes: graph.identityNodes,
      secret: SECRET,
    });
    await client.batch(
      buildAccountDeletionGraphCleanupStatements({
        graph,
        deletedPurchaseOwner: pseudonym,
      }),
      "write",
    );
    const ledgerCount = await client.execute(
      "SELECT COUNT(*) AS count FROM credit_ledger_entries",
    );
    assert.equal(Number(ledgerCount.rows[0].count), 0);
  } finally {
    client.close();
  }
});

test("cross-owner purchase link is manual review and causes no mutation", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES ('auth-a', 'a@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id)
        VALUES ('auth-a', '${ROOT}');
      INSERT INTO credit_purchase_transactions (
        row_id, provider, provider_transaction_id, anon_user_id, product_id,
        status, granted_credits, created_at, updated_at
      ) VALUES (
        'cross-purchase', 'google_play', 'cross', '${ROOT}', 'credits.small',
        'verified', 10, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO credit_ledger_entries (
        entry_id, anon_user_id, event_type, amount,
        balance_available_after, idempotency_scope, idempotency_key,
        actor, created_at
      ) VALUES (
        'cross-ledger', '${OUTSIDE}', 'purchase_grant', 10, 10,
        'purchase-credit-grant', 'google_play:cross', 'purchase',
        '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO credit_purchase_ledger_links (
        id, purchase_transaction_id, ledger_entry_id, link_kind
      ) VALUES ('cross-link', 'cross-purchase', 'cross-ledger', 'base_grant');
    `);
    const [graph] = (
      await planAccountDeletion({ authUserIds: ["auth-a"], client })
    ).graphs;
    assert.equal(graph.status, "manual_review");
    assert.ok(graph.blockers.includes("conflicting_financial_ownership"));
    const purchase = await client.execute(
      "SELECT anon_user_id FROM credit_purchase_transactions",
    );
    assert.equal(purchase.rows[0].anon_user_id, ROOT);
  } finally {
    client.close();
  }
});
