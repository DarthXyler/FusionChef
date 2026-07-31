import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  ACCOUNT_DELETION_RECONCILIATION_METADATA,
  buildPurchaseReconciliationAccountDeletionStatement,
} from "./purchase-settlement-retention.ts";

const migrationSql = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

const baseSchemaSql = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_transaction_id TEXT NOT NULL,
    anon_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'verified',
    granted_credits INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT '2026-07-31T00:00:00.000Z'
  );

  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'purchase_grant',
    amount INTEGER NOT NULL DEFAULT 0,
    balance_available_after INTEGER NOT NULL DEFAULT 0,
    balance_pending_after INTEGER NOT NULL DEFAULT 0,
    idempotency_scope TEXT,
    idempotency_key TEXT
  );

  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY,
    available_credits INTEGER NOT NULL,
    pending_credits INTEGER NOT NULL
  );
`;

async function createFixture(seedSql = "") {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(baseSchemaSql);
  if (seedSql.trim()) {
    await client.executeMultiple(seedSql);
  }
  return client;
}

async function getReport(client) {
  const result = await client.execute(
    "SELECT * FROM purchase_ledger_backfill_report",
  );
  const row = result.rows[0] ?? {};
  return {
    expectedLinked: Number(row.expected_linked_count ?? 0),
    linked: Number(row.linked_count ?? 0),
    skipped: Number(row.skipped_count ?? 0),
    ambiguous: Number(row.ambiguous_count ?? 0),
  };
}

async function expectConstraintFailure(operation, pattern) {
  await assert.rejects(operation, pattern);
}

test("clean one-to-one backfill is idempotent and does not mutate financial rows", async () => {
  const client = await createFixture(`
    INSERT INTO credit_balances VALUES ('user-1', 17, 2);
    INSERT INTO credit_purchase_transactions (
      row_id, provider, provider_transaction_id, anon_user_id, granted_credits
    ) VALUES ('purchase-1', 'google_play', 'txn-1', 'user-1', 25);
    INSERT INTO credit_ledger_entries (
      entry_id, anon_user_id, amount, balance_available_after,
      balance_pending_after, idempotency_scope, idempotency_key
    ) VALUES (
      'ledger-1', 'user-1', 25, 17, 2,
      'purchase-credit-grant', 'google_play:txn-1'
    );
  `);

  try {
    const balancesBefore = await client.execute(
      "SELECT * FROM credit_balances ORDER BY anon_user_id",
    );
    const purchasesBefore = await client.execute(
      `SELECT row_id, granted_credits, status
       FROM credit_purchase_transactions ORDER BY row_id`,
    );
    const ledgerBefore = await client.execute(
      `SELECT entry_id, amount, balance_available_after, balance_pending_after
       FROM credit_ledger_entries ORDER BY entry_id`,
    );

    await client.executeMultiple(migrationSql);

    assert.deepEqual(await getReport(client), {
      expectedLinked: 1,
      linked: 1,
      skipped: 0,
      ambiguous: 0,
    });
    const links = await client.execute(
      `SELECT purchase_transaction_id, ledger_entry_id, link_kind
       FROM credit_purchase_ledger_links`,
    );
    assert.deepEqual(
      links.rows.map((row) => ({ ...row })),
      [
        {
          purchase_transaction_id: "purchase-1",
          ledger_entry_id: "ledger-1",
          link_kind: "base_grant",
        },
      ],
    );

    await client.executeMultiple(migrationSql);
    assert.equal(
      Number(
        (
          await client.execute(
            "SELECT COUNT(*) AS count FROM credit_purchase_ledger_links",
          )
        ).rows[0]?.count ?? 0,
      ),
      1,
    );
    assert.deepEqual(await getReport(client), {
      expectedLinked: 1,
      linked: 1,
      skipped: 0,
      ambiguous: 0,
    });

    const balancesAfter = await client.execute(
      "SELECT * FROM credit_balances ORDER BY anon_user_id",
    );
    const purchasesAfter = await client.execute(
      `SELECT row_id, granted_credits, status
       FROM credit_purchase_transactions ORDER BY row_id`,
    );
    const ledgerAfter = await client.execute(
      `SELECT entry_id, amount, balance_available_after, balance_pending_after
       FROM credit_ledger_entries ORDER BY entry_id`,
    );
    assert.deepEqual(balancesAfter.rows, balancesBefore.rows);
    assert.deepEqual(purchasesAfter.rows, purchasesBefore.rows);
    assert.deepEqual(ledgerAfter.rows, ledgerBefore.rows);
  } finally {
    client.close();
  }
});

test("backfill skips missing counterparts and reports ambiguous candidates", async () => {
  const client = await createFixture(`
    INSERT INTO credit_purchase_transactions (
      row_id, provider, provider_transaction_id, anon_user_id
    ) VALUES
      ('purchase-exact', 'google_play', 'exact', 'user-1'),
      ('purchase-no-ledger', 'apple_app_store', 'purchase-only', 'user-2'),
      ('purchase-ledger-ambiguous', 'google_play', 'duplicate-ledger', 'user-3'),
      ('purchase-duplicate-a', 'apple_app_store', 'duplicate-purchase', 'user-4'),
      ('purchase-duplicate-b', 'apple_app_store', 'duplicate-purchase', 'user-5');

    INSERT INTO credit_ledger_entries (
      entry_id, anon_user_id, idempotency_scope, idempotency_key
    ) VALUES
      ('ledger-exact', 'user-1', 'purchase-credit-grant', 'google_play:exact'),
      ('ledger-orphan', 'user-6', 'purchase-credit-grant', 'google_play:ledger-only'),
      ('ledger-duplicate-a', 'user-3', 'purchase-credit-grant', 'google_play:duplicate-ledger'),
      ('ledger-duplicate-b', 'user-3', 'purchase-credit-grant', 'google_play:duplicate-ledger'),
      ('ledger-duplicate-purchase', 'user-4', 'purchase-credit-grant', 'apple_app_store:duplicate-purchase'),
      ('ledger-other-scope', 'user-7', 'reservation', 'google_play:ignored');
  `);

  try {
    await client.executeMultiple(migrationSql);
    assert.deepEqual(await getReport(client), {
      expectedLinked: 1,
      linked: 1,
      skipped: 2,
      ambiguous: 2,
    });

    const result = await client.execute(
      `SELECT purchase_transaction_id, ledger_entry_id
       FROM credit_purchase_ledger_links`,
    );
    assert.deepEqual(
      result.rows.map((row) => ({ ...row })),
      [
        {
          purchase_transaction_id: "purchase-exact",
          ledger_entry_id: "ledger-exact",
        },
      ],
    );
  } finally {
    client.close();
  }
});

test("link constraints enforce one base grant, one link per ledger, and foreign keys", async () => {
  const client = await createFixture(`
    INSERT INTO credit_purchase_transactions (
      row_id, provider, provider_transaction_id, anon_user_id
    ) VALUES
      ('purchase-1', 'google_play', 'one', 'user-1'),
      ('purchase-2', 'google_play', 'two', 'user-2');
    INSERT INTO credit_ledger_entries (
      entry_id, anon_user_id, idempotency_scope, idempotency_key
    ) VALUES
      ('ledger-1', 'user-1', 'manual', 'one'),
      ('ledger-2', 'user-1', 'manual', 'two'),
      ('ledger-3', 'user-2', 'manual', 'three');
  `);

  try {
    await client.executeMultiple(migrationSql);
    await client.execute(
      `INSERT INTO credit_purchase_ledger_links
       (id, purchase_transaction_id, ledger_entry_id, link_kind)
       VALUES ('link-1', 'purchase-1', 'ledger-1', 'base_grant')`,
    );

    await expectConstraintFailure(
      () =>
        client.execute(
          `INSERT INTO credit_purchase_ledger_links
           (id, purchase_transaction_id, ledger_entry_id, link_kind)
           VALUES ('link-2', 'purchase-1', 'ledger-2', 'base_grant')`,
        ),
      /UNIQUE constraint failed/,
    );
    await expectConstraintFailure(
      () =>
        client.execute(
          `INSERT INTO credit_purchase_ledger_links
           (id, purchase_transaction_id, ledger_entry_id, link_kind)
           VALUES ('link-3', 'purchase-2', 'ledger-1', 'repair_adjustment')`,
        ),
      /UNIQUE constraint failed/,
    );
    await expectConstraintFailure(
      () =>
        client.execute(
          `INSERT INTO credit_purchase_ledger_links
           (id, purchase_transaction_id, ledger_entry_id, link_kind)
           VALUES ('bad-purchase', 'missing', 'ledger-3', 'reversal')`,
        ),
      /FOREIGN KEY constraint failed/,
    );
    await expectConstraintFailure(
      () =>
        client.execute(
          `INSERT INTO credit_purchase_ledger_links
           (id, purchase_transaction_id, ledger_entry_id, link_kind)
           VALUES ('bad-ledger', 'purchase-2', 'missing', 'reversal')`,
        ),
      /FOREIGN KEY constraint failed/,
    );

    await client.execute("DELETE FROM credit_ledger_entries WHERE entry_id = 'ledger-1'");
    assert.equal(
      Number(
        (
          await client.execute(
            "SELECT COUNT(*) AS count FROM credit_purchase_ledger_links",
          )
        ).rows[0]?.count ?? 0,
      ),
      0,
    );
  } finally {
    client.close();
  }
});

test("completed reconciliation facts are immutable and retained across FK deletion", async () => {
  const client = await createFixture(`
    INSERT INTO credit_purchase_transactions (
      row_id, provider, provider_transaction_id, anon_user_id
    ) VALUES ('purchase-1', 'google_play', 'one', 'user-1');
    INSERT INTO credit_ledger_entries (
      entry_id, anon_user_id, idempotency_scope, idempotency_key
    ) VALUES ('ledger-1', 'user-1', 'manual', 'one');
  `);

  try {
    await client.executeMultiple(migrationSql);
    await client.execute(
      `INSERT INTO purchase_reconciliation_actions (
        id, issue_type, purchase_transaction_id, ledger_entry_id,
        admin_actor, reason, preview_fingerprint, idempotency_key,
        balance_before, balance_after, credit_delta,
        provider_verification_hash, status, completed_at, metadata_json
      ) VALUES (
        'action-1', 'missing_grant', 'purchase-1', 'ledger-1',
        'admin-1', 'fixture', 'preview-1', 'idem-1',
        5, 10, 5, 'verification-hash', 'completed',
        '2026-07-31T01:00:00.000Z', '{"evidence":"safe"}'
      )`,
    );

    await expectConstraintFailure(
      () =>
        client.execute(
          `INSERT INTO purchase_reconciliation_actions (
            id, issue_type, admin_actor, reason, preview_fingerprint,
            idempotency_key, balance_before, balance_after, credit_delta,
            provider_verification_hash, status
          ) VALUES (
            'action-duplicate', 'missing_grant', 'admin-1', 'fixture',
            'preview-2', 'idem-1', 5, 5, 0, 'hash', 'pending'
          )`,
        ),
      /UNIQUE constraint failed/,
    );
    await expectConstraintFailure(
      () =>
        client.execute(
          `UPDATE purchase_reconciliation_actions
           SET balance_after = 11 WHERE id = 'action-1'`,
        ),
      /completed reconciliation actions are immutable/,
    );
    await expectConstraintFailure(
      () =>
        client.execute(
          "DELETE FROM purchase_reconciliation_actions WHERE id = 'action-1'",
        ),
      /completed reconciliation actions are immutable/,
    );
    await expectConstraintFailure(
      () =>
        client.execute(
          `INSERT INTO purchase_reconciliation_actions (
            id, issue_type, purchase_transaction_id, admin_actor, reason,
            preview_fingerprint, idempotency_key, balance_before,
            balance_after, credit_delta, provider_verification_hash, status
          ) VALUES (
            'bad-fk', 'missing_grant', 'missing', 'admin-1', 'fixture',
            'preview-3', 'idem-3', 5, 5, 0, 'hash', 'pending'
          )`,
        ),
      /FOREIGN KEY constraint failed/,
    );

    await client.execute("DELETE FROM credit_ledger_entries WHERE entry_id = 'ledger-1'");
    await client.execute(
      "DELETE FROM credit_purchase_transactions WHERE row_id = 'purchase-1'",
    );
    const retained = (
      await client.execute(
        `SELECT purchase_transaction_id, ledger_entry_id, balance_before,
                balance_after, credit_delta, status
         FROM purchase_reconciliation_actions WHERE id = 'action-1'`,
      )
    ).rows[0];
    assert.deepEqual(
      { ...retained },
      {
        purchase_transaction_id: null,
        ledger_entry_id: null,
        balance_before: 5,
        balance_after: 10,
        credit_delta: 5,
        status: "completed",
      },
    );
  } finally {
    client.close();
  }
});

test("account deletion redacts reconciliation metadata and preserves financial audit history", async () => {
  const client = await createFixture(`
    INSERT INTO credit_purchase_transactions (
      row_id, provider, provider_transaction_id, anon_user_id,
      granted_credits, payload_json
    ) VALUES
      ('purchase-delete', 'google_play', 'delete-me', 'user-delete', 30,
       '{"email":"person@example.com","receipt":"secret"}'),
      ('purchase-keep', 'google_play', 'keep-me', 'user-keep', 15,
       '{"receipt":"keep"}');
    INSERT INTO credit_ledger_entries (
      entry_id, anon_user_id, amount, balance_available_after,
      idempotency_scope, idempotency_key
    ) VALUES
      ('ledger-delete', 'user-delete', 30, 30,
       'purchase-credit-grant', 'google_play:delete-me'),
      ('ledger-keep', 'user-keep', 15, 15,
       'purchase-credit-grant', 'google_play:keep-me');
  `);

  try {
    await client.executeMultiple(migrationSql);
    await client.executeMultiple(`
      INSERT INTO purchase_reconciliation_actions (
        id, issue_type, purchase_transaction_id, ledger_entry_id,
        admin_actor, reason, preview_fingerprint, idempotency_key,
        balance_before, balance_after, credit_delta,
        provider_verification_hash, status, completed_at, metadata_json
      ) VALUES
        (
          'action-delete', 'missing_link', 'purchase-delete', 'ledger-delete',
          'admin-1', 'fixture', 'preview-delete', 'idem-delete',
          0, 30, 30, 'verification-delete', 'completed',
          '2026-07-31T01:00:00.000Z',
          '{"email":"person@example.com","provider_transaction_id":"delete-me"}'
        ),
        (
          'action-keep', 'missing_link', 'purchase-keep', 'ledger-keep',
          'admin-1', 'fixture', 'preview-keep', 'idem-keep',
          0, 15, 15, 'verification-keep', 'completed',
          '2026-07-31T01:00:00.000Z', '{"safe":"keep"}'
        );
    `);

    await client.batch(
      [
        buildPurchaseReconciliationAccountDeletionStatement("user-delete"),
        {
          sql: `UPDATE credit_purchase_transactions
                SET anon_user_id = ?, payload_json = '{}'
                WHERE anon_user_id = ?`,
          args: ["deleted:auth-user", "user-delete"],
        },
        {
          sql: "DELETE FROM credit_ledger_entries WHERE anon_user_id = ?",
          args: ["user-delete"],
        },
      ],
      "write",
    );

    const purchase = (
      await client.execute(
        `SELECT anon_user_id, granted_credits, payload_json
         FROM credit_purchase_transactions WHERE row_id = 'purchase-delete'`,
      )
    ).rows[0];
    assert.deepEqual(
      { ...purchase },
      {
        anon_user_id: "deleted:auth-user",
        granted_credits: 30,
        payload_json: "{}",
      },
    );

    const action = (
      await client.execute(
        `SELECT purchase_transaction_id, ledger_entry_id, metadata_json,
                balance_before, balance_after, credit_delta, status
         FROM purchase_reconciliation_actions WHERE id = 'action-delete'`,
      )
    ).rows[0];
    assert.deepEqual(
      { ...action },
      {
        purchase_transaction_id: "purchase-delete",
        ledger_entry_id: null,
        metadata_json: ACCOUNT_DELETION_RECONCILIATION_METADATA,
        balance_before: 0,
        balance_after: 30,
        credit_delta: 30,
        status: "completed",
      },
    );

    assert.equal(
      Number(
        (
          await client.execute(
            `SELECT COUNT(*) AS count
             FROM credit_purchase_ledger_links
             WHERE purchase_transaction_id = 'purchase-delete'`,
          )
        ).rows[0]?.count ?? 0,
      ),
      0,
    );
    const untouched = (
      await client.execute(
        `SELECT metadata_json FROM purchase_reconciliation_actions
         WHERE id = 'action-keep'`,
      )
    ).rows[0];
    assert.equal(untouched?.metadata_json, '{"safe":"keep"}');
  } finally {
    client.close();
  }
});
