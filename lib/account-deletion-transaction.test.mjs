import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import { buildAccountDeletionGraphCleanupStatements } from "./account-deletion-execution.ts";
import {
  AccountDeletionJobError,
  createAccountDeletionPreview,
  executeAccountDeletionJob,
} from "./account-deletion-jobs.ts";
import { planAccountDeletion } from "./account-deletion-planner.ts";
import {
  buildDeletedIdentityTombstoneStatements,
  createDeletedIdentityReference,
  DeletedIdentityTombstoneConfigurationError,
  ensureDeletedIdentityTombstoneKey,
} from "./deleted-identity-tombstones.ts";
import { createAccountDeletionPseudonym } from "./purchase-settlement-retention.ts";

const AUTH_A = "auth-transaction-a";
const AUTH_B = "auth-transaction-b";
const ROOT_A = "11111111-1111-4111-8111-111111111111";
const ROOT_B = "22222222-2222-4222-8222-222222222222";
const SECRET = "transactional-deletion-test-secret-at-least-32-bytes";
const REASON = "Verified transactional deletion request.";
const PREVIEW_NOW = new Date("2026-08-02T00:00:00.000Z");
const EXECUTE_NOW = new Date("2026-08-02T00:01:00.000Z");

const purMigration = readFileSync(
  new URL("../migrations/20260731_001_create_purchase_settlement_foundation.sql", import.meta.url),
  "utf8",
);
const jobMigration = readFileSync(
  new URL("../migrations/20260802_001_create_account_deletion_jobs.sql", import.meta.url),
  "utf8",
);
const outboxMigration = readFileSync(
  new URL("../migrations/20260802_002_create_account_deletion_storage_outbox.sql", import.meta.url),
  "utf8",
);
const tombstoneMigration = readFileSync(
  new URL("../migrations/20260802_003_create_deleted_identity_tombstones.sql", import.meta.url),
  "utf8",
);

const domainSchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, normalized_email TEXT NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'google',
    role TEXT NOT NULL DEFAULT 'user', updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE auth_identity_links (
    auth_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE mobile_identity_aliases (
    anon_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE mobile_identity_links (
    device_key TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE cookbook_recipes (
    row_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL, recipe_id TEXT NOT NULL,
    recipe_json TEXT NOT NULL DEFAULT '{}', source_input_json TEXT NOT NULL DEFAULT '{}',
    image_url TEXT, saved_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '', is_favorite INTEGER NOT NULL DEFAULT 0,
    is_to_try INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL,
    activity_type TEXT NOT NULL, source_reference_id TEXT, occurred_at TEXT NOT NULL
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY, available_credits INTEGER NOT NULL,
    pending_credits INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    action_kind TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
    reason TEXT NOT NULL, metadata_json TEXT NOT NULL, expires_at TEXT,
    idempotency_scope TEXT, idempotency_key TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE credit_daily_usage (
    anon_user_id TEXT NOT NULL, day_key TEXT NOT NULL, timezone TEXT NOT NULL,
    fuse_count INTEGER NOT NULL, reroll_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (anon_user_id, day_key)
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL, action_kind TEXT, amount INTEGER NOT NULL,
    balance_available_after INTEGER NOT NULL, balance_pending_after INTEGER NOT NULL,
    reservation_id TEXT, idempotency_scope TEXT, idempotency_key TEXT,
    actor TEXT NOT NULL, reason TEXT NOT NULL, metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
    provider_transaction_id TEXT NOT NULL, provider_original_transaction_id TEXT,
    anon_user_id TEXT NOT NULL, product_id TEXT NOT NULL, status TEXT NOT NULL,
    granted_credits INTEGER NOT NULL, reversed_credits INTEGER NOT NULL DEFAULT 0,
    outstanding_reversal_credits INTEGER NOT NULL DEFAULT 0,
    risk_flags_json TEXT NOT NULL DEFAULT '[]', payload_json TEXT NOT NULL DEFAULT '{}',
    verified_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_transaction_id)
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY, auth_user_id TEXT,
    canonical_anon_user_id TEXT, email_hash TEXT, provider TEXT, role TEXT,
    requested_by TEXT, reason TEXT, counts_json TEXT,
    purchase_transactions_preserved INTEGER, idempotency_key TEXT, deleted_at TEXT
  );
`;

function deferred() {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });
  return { promise, resolve };
}

async function createFixture(authUsers = [{ authId: AUTH_A, root: ROOT_A }]) {
  const databasePath = path.join(
    tmpdir(),
    `ffc-account-deletion-transaction-${randomUUID()}.db`,
  );
  const url = `file:${databasePath.replace(/\\/g, "/")}`;
  const client = createClient({ url });
  const concurrentClient = createClient({ url });
  await client.executeMultiple(domainSchema);
  await client.executeMultiple(purMigration);
  await client.executeMultiple(jobMigration);
  await client.executeMultiple(outboxMigration);
  await client.executeMultiple(tombstoneMigration);
  for (const { authId, root } of authUsers) {
    await client.batch(
      [
        {
          sql: `INSERT INTO auth_users (
                  id, email, normalized_email, avatar_url, provider, role, updated_at
                ) VALUES (?, ?, ?, '', 'google', 'user', ?)`,
          args: [authId, `${authId}@example.test`, `${authId}@example.test`, PREVIEW_NOW.toISOString()],
        },
        {
          sql: `INSERT INTO auth_identity_links (
                  auth_user_id, canonical_anon_user_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?)`,
          args: [authId, root, PREVIEW_NOW.toISOString(), PREVIEW_NOW.toISOString()],
        },
        {
          sql: `INSERT INTO credit_balances (
                  anon_user_id, available_credits, pending_credits, created_at, updated_at
                ) VALUES (?, 10, 0, ?, ?)`,
          args: [root, PREVIEW_NOW.toISOString(), PREVIEW_NOW.toISOString()],
        },
        {
          sql: `INSERT INTO credit_reservations (
                  reservation_id, anon_user_id, action_kind, amount, status,
                  reason, metadata_json, expires_at, created_at, updated_at
                ) VALUES (?, ?, 'fuse', 1, 'reserved', 'test', '{}',
                  '2999-01-01T00:00:00.000Z', ?, ?)`,
          args: [`reservation-${authId}`, root, PREVIEW_NOW.toISOString(), PREVIEW_NOW.toISOString()],
        },
      ],
      "write",
    );
  }
  return {
    client,
    concurrentClient,
    url,
    close(additionalClients = []) {
      for (const additionalClient of additionalClients) additionalClient.close();
      concurrentClient.close();
      client.close();
      try {
        unlinkSync(databasePath);
      } catch {
        // libSQL may retain the ephemeral file briefly on Windows.
      }
    },
  };
}

function plan(client, authUserIds = [AUTH_A]) {
  return planAccountDeletion({
    authUserIds,
    client,
    secret: SECRET,
    snapshot: EXECUTE_NOW,
  });
}

async function preview(client, currentPlan) {
  return createAccountDeletionPreview({
    plan: currentPlan,
    reason: REASON,
    actingAdminAuthUserId: "admin-transaction-test",
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    now: () => PREVIEW_NOW,
    previewTtlSeconds: 900,
    client,
    secret: SECRET,
    executionEnabled: true,
  });
}

function deletionStatements({ graph, jobId, targetId }) {
  return [
    ...graph.ownerAuthUserIds.map((authUserId) => ({
      sql: `INSERT INTO account_deletion_events (
              deletion_id, auth_user_id, canonical_anon_user_id, idempotency_key
            ) VALUES (?, ?, ?, ?)`,
      args: [`event:${targetId}:${authUserId}`, authUserId, graph.identityNodes[0] ?? null, jobId],
    })),
    ...buildDeletedIdentityTombstoneStatements({
      identityNodes: graph.identityNodes,
      deletionJobId: jobId,
      secret: SECRET,
    }),
    ...buildAccountDeletionGraphCleanupStatements({
      graph,
      deletedPurchaseOwner: createAccountDeletionPseudonym({
        authUserIds: graph.ownerAuthUserIds,
        identityNodes: graph.identityNodes,
        secret: SECRET,
      }),
    }),
  ];
}

function execute(client, created, authUserIds = [AUTH_A], overrides = {}) {
  return executeAccountDeletionJob({
    jobId: created.jobId,
    fingerprint: created.fingerprint,
    authUserIds,
    reason: REASON,
    actingAdminAuthUserId: "admin-transaction-test",
    buildGraphStatements: deletionStatements,
    now: () => EXECUTE_NOW,
    client,
    secret: SECRET,
    tombstoneSecret: SECRET,
    executionEnabled: true,
    ...overrides,
  });
}

async function assertStale(operation) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AccountDeletionJobError);
    assert.equal(error.code, "stale_preview");
    assert.equal(error.statusCode, 409);
    return true;
  });
}

async function assertNoGraphDeletion(client, mutationCountSql) {
  const state = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM auth_users WHERE id = '${AUTH_A}') AS auth_users,
      (SELECT COUNT(*) FROM account_deletion_events) AS events,
      (SELECT COUNT(*) FROM deleted_identity_tombstones) AS tombstones,
      (SELECT COUNT(*) FROM account_deletion_storage_outbox) AS outbox,
      (SELECT COUNT(*) FROM account_deletion_job_targets WHERE status = 'completed') AS completed,
      (${mutationCountSql}) AS mutation_count
  `);
  assert.deepEqual(
    Object.fromEntries(Object.entries(state.rows[0]).map(([key, value]) => [key, Number(value)])),
    { auth_users: 1, events: 0, tombstones: 0, outbox: 0, completed: 0, mutation_count: 1 },
  );
}

const beforeLockMutations = [
  {
    name: "cookbook insert",
    statements: [{
      sql: `INSERT INTO cookbook_recipes (
              row_id, anon_user_id, recipe_id, recipe_json, source_input_json,
              saved_at, created_at, updated_at
            ) VALUES ('concurrent-recipe', ?, 'recipe', '{}', '{}', ?, ?, ?)`,
      args: [ROOT_A, EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString()],
    }],
    countSql: "SELECT COUNT(*) FROM cookbook_recipes WHERE row_id = 'concurrent-recipe'",
  },
  {
    name: "product activity insert",
    statements: [{
      sql: `INSERT INTO product_activity_events (
              event_id, auth_user_id, activity_type, occurred_at
            ) VALUES ('concurrent-activity', ?, 'fusion_generation', ?)`,
      args: [AUTH_A, EXECUTE_NOW.toISOString()],
    }],
    countSql: "SELECT COUNT(*) FROM product_activity_events WHERE event_id = 'concurrent-activity'",
  },
  {
    name: "balance mutation",
    statements: [{
      sql: "UPDATE credit_balances SET available_credits = 11, updated_at = ? WHERE anon_user_id = ?",
      args: [EXECUTE_NOW.toISOString(), ROOT_A],
    }],
    countSql: `SELECT COUNT(*) FROM credit_balances
               WHERE anon_user_id = '${ROOT_A}' AND available_credits = 11`,
  },
  {
    name: "reservation transition",
    statements: [{
      sql: `UPDATE credit_reservations
            SET status = 'released', updated_at = ?
            WHERE reservation_id = 'reservation-auth-transaction-a'`,
      args: [EXECUTE_NOW.toISOString()],
    }],
    countSql: `SELECT COUNT(*) FROM credit_reservations
               WHERE reservation_id = 'reservation-auth-transaction-a'
                 AND status = 'released'`,
  },
  {
    name: "purchase and ledger mutation",
    statements: [
      {
        sql: `INSERT INTO credit_purchase_transactions (
                row_id, provider, provider_transaction_id, anon_user_id,
                product_id, status, granted_credits, created_at, updated_at
              ) VALUES ('concurrent-purchase', 'google_play', 'concurrent-txn', ?,
                'credits.small', 'verified', 10, ?, ?)`,
        args: [ROOT_A, EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString()],
      },
      {
        sql: `INSERT INTO credit_ledger_entries (
                entry_id, anon_user_id, event_type, amount,
                balance_available_after, balance_pending_after,
                idempotency_scope, idempotency_key, actor, reason,
                metadata_json, created_at
              ) VALUES ('concurrent-ledger', ?, 'purchase_grant', 10, 20, 0,
                'purchase-credit-grant', 'google_play:concurrent-txn',
                'purchase', 'test', '{}', ?)`,
        args: [ROOT_A, EXECUTE_NOW.toISOString()],
      },
    ],
    countSql: `SELECT COUNT(*)
               FROM credit_purchase_transactions purchase
               JOIN credit_ledger_entries ledger
                 ON purchase.row_id = 'concurrent-purchase'
                AND ledger.entry_id = 'concurrent-ledger'
               WHERE purchase.granted_credits = 10 AND ledger.amount = 10`,
  },
  {
    name: "alias and device mapping mutation",
    statements: [
      {
        sql: `INSERT INTO mobile_identity_aliases (
                anon_user_id, canonical_anon_user_id, created_at, updated_at
              ) VALUES ('33333333-3333-4333-8333-333333333333', ?, ?, ?)`,
        args: [ROOT_A, EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString()],
      },
      {
        sql: `INSERT INTO mobile_identity_links (
                device_key, canonical_anon_user_id, created_at, updated_at
              ) VALUES ('concurrent-device', ?, ?, ?)`,
        args: [ROOT_A, EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString()],
      },
    ],
    countSql: "SELECT COUNT(*) FROM mobile_identity_links WHERE device_key = 'concurrent-device'",
  },
];

test("writes committed before the deletion lock are observed and cause stale_preview", async (t) => {
  for (const mutation of beforeLockMutations) {
    await t.test(mutation.name, async () => {
      const fixture = await createFixture();
      const transactionRequested = deferred();
      const releaseTransaction = deferred();
      try {
        const approvedPlan = await plan(fixture.client);
        const created = await preview(fixture.client, approvedPlan);
        const gatedClient = {
          execute: fixture.client.execute.bind(fixture.client),
          batch: fixture.client.batch.bind(fixture.client),
          async transaction(mode) {
            transactionRequested.resolve();
            await releaseTransaction.promise;
            return fixture.client.transaction(mode);
          },
        };
        const deletion = execute(gatedClient, created);
        await transactionRequested.promise;
        await fixture.concurrentClient.batch(mutation.statements, "write");
        releaseTransaction.resolve();
        await assertStale(deletion);
        await assertNoGraphDeletion(fixture.client, mutation.countSql);
      } finally {
        releaseTransaction.resolve();
        fixture.close();
      }
    });
  }
});

test("a writer that starts after deletion owns the lock cannot persist stale ownership", async () => {
  const fixture = await createFixture();
  const transactionPlanned = deferred();
  const releaseDeletion = deferred();
  try {
    const approvedPlan = await plan(fixture.client);
    const created = await preview(fixture.client, approvedPlan);
    const deletion = execute(fixture.client, created, [AUTH_A], {
      async replan(context) {
        const current = await planAccountDeletion({
          authUserIds: context.authUserIds,
          client: context.client,
          secret: context.secret,
          snapshot: context.snapshot,
        });
        transactionPlanned.resolve();
        await releaseDeletion.promise;
        return current;
      },
    });
    await transactionPlanned.promise;

    const writer = (async () => {
      const transaction = await fixture.concurrentClient.transaction("write");
      try {
        const identityRef = createDeletedIdentityReference(ROOT_A, { secret: SECRET });
        const state = await transaction.execute({
          sql: `SELECT
                  EXISTS(SELECT 1 FROM auth_users WHERE id = ?) AS auth_exists,
                  EXISTS(SELECT 1 FROM deleted_identity_tombstones WHERE identity_ref = ?) AS deleted`,
          args: [AUTH_A, identityRef],
        });
        if (Number(state.rows[0]?.auth_exists) !== 1 || Number(state.rows[0]?.deleted) === 1) {
          throw new Error("ownership is no longer writable");
        }
        await transaction.execute({
          sql: `INSERT INTO cookbook_recipes (
                  row_id, anon_user_id, recipe_id, recipe_json,
                  source_input_json, saved_at, created_at, updated_at
                ) VALUES ('late-recipe', ?, 'late', '{}', '{}', ?, ?, ?)`,
          args: [ROOT_A, EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString(), EXECUTE_NOW.toISOString()],
        });
        await transaction.commit();
      } finally {
        transaction.close();
      }
    })();
    releaseDeletion.resolve();
    const result = await deletion;
    assert.equal(result.status, "completed");
    await assert.rejects(writer, /ownership is no longer writable|SQLITE_BUSY/);
    const final = await fixture.client.execute(`
      SELECT
        (SELECT COUNT(*) FROM auth_users WHERE id = '${AUTH_A}') AS auth_users,
        (SELECT COUNT(*) FROM cookbook_recipes WHERE row_id = 'late-recipe') AS late_recipe,
        (SELECT COUNT(*) FROM deleted_identity_tombstones) AS tombstones
    `);
    assert.deepEqual(
      Object.fromEntries(Object.entries(final.rows[0]).map(([key, value]) => [key, Number(value)])),
      { auth_users: 0, late_recipe: 0, tombstones: 1 },
    );
  } finally {
    releaseDeletion.resolve();
    fixture.close();
  }
});

test("a stale later graph preserves a graph completed by an earlier transaction", async () => {
  const fixture = await createFixture([
    { authId: AUTH_A, root: ROOT_A },
    { authId: AUTH_B, root: ROOT_B },
  ]);
  const secondTransactionRequested = deferred();
  const releaseSecondTransaction = deferred();
  let transactionCount = 0;
  try {
    const approvedPlan = await plan(fixture.client, [AUTH_A, AUTH_B]);
    const created = await preview(fixture.client, approvedPlan);
    const gatedClient = {
      execute: fixture.client.execute.bind(fixture.client),
      batch: fixture.client.batch.bind(fixture.client),
      async transaction(mode) {
        transactionCount += 1;
        if (transactionCount === 2) {
          secondTransactionRequested.resolve();
          await releaseSecondTransaction.promise;
        }
        return fixture.client.transaction(mode);
      },
    };
    const deletion = execute(gatedClient, created, [AUTH_A, AUTH_B]);
    await secondTransactionRequested.promise;
    const remainingOwner = (
      await fixture.concurrentClient.execute(`
        SELECT users.id AS auth_user_id, links.canonical_anon_user_id
        FROM auth_users users
        JOIN auth_identity_links links ON links.auth_user_id = users.id
        ORDER BY users.id
        LIMIT 1
      `)
    ).rows[0];
    const laterAuth = String(remainingOwner.auth_user_id);
    const laterRoot = String(remainingOwner.canonical_anon_user_id);
    await fixture.concurrentClient.execute({
      sql: `INSERT INTO product_activity_events (
              event_id, auth_user_id, activity_type, occurred_at
            ) VALUES ('later-graph-activity', ?, 'fusion_generation', ?)`,
      args: [laterAuth, EXECUTE_NOW.toISOString()],
    });
    releaseSecondTransaction.resolve();
    await assertStale(deletion);

    const targetStates = await fixture.client.execute(
      "SELECT status, COUNT(*) AS count FROM account_deletion_job_targets GROUP BY status",
    );
    assert.deepEqual(
      Object.fromEntries(targetStates.rows.map((row) => [String(row.status), Number(row.count)])),
      { database_completed: 1, manual_review: 1 },
    );
    const laterState = await fixture.client.execute({
      sql: `SELECT
              EXISTS(SELECT 1 FROM auth_users WHERE id = ?) AS auth_exists,
              EXISTS(SELECT 1 FROM product_activity_events WHERE event_id = 'later-graph-activity') AS activity_exists,
              EXISTS(SELECT 1 FROM credit_balances WHERE anon_user_id = ?) AS balance_exists`,
      args: [laterAuth, laterRoot],
    });
    assert.deepEqual(
      Object.fromEntries(Object.entries(laterState.rows[0]).map(([key, value]) => [key, Number(value)])),
      { auth_exists: 1, activity_exists: 1, balance_exists: 1 },
    );
  } finally {
    releaseSecondTransaction.resolve();
    fixture.close();
  }
});

test("transactional replanning failure rolls back without graph cleanup", async () => {
  const fixture = await createFixture();
  try {
    const approvedPlan = await plan(fixture.client);
    const created = await preview(fixture.client, approvedPlan);
    await assert.rejects(
      execute(fixture.client, created, [AUTH_A], {
        async replan() {
          throw new Error("injected transactional replan failure");
        },
      }),
      (error) =>
        error instanceof AccountDeletionJobError &&
        error.code === "account_deletion_retryable_failure",
    );
    await assertNoGraphDeletion(fixture.client, "SELECT COUNT(*) FROM credit_balances");
  } finally {
    fixture.close();
  }
});

test("tombstone key mismatch stops deletion before any graph mutation", async () => {
  const fixture = await createFixture();
  try {
    await ensureDeletedIdentityTombstoneKey({
      client: fixture.client,
      secret: SECRET,
    });
    const approvedPlan = await plan(fixture.client);
    const created = await preview(fixture.client, approvedPlan);
    await assert.rejects(
      execute(fixture.client, created, [AUTH_A], {
        tombstoneSecret: "executor-mismatch-secret-at-least-32-bytes",
      }),
      (error) =>
        error instanceof DeletedIdentityTombstoneConfigurationError &&
        error.code === "identity_unavailable" &&
        error.statusCode === 503,
    );
    await assertNoGraphDeletion(fixture.client, "SELECT COUNT(*) FROM credit_balances");
  } finally {
    fixture.close();
  }
});

test("a destructive statement failure rolls back the complete graph transaction", async () => {
  const fixture = await createFixture();
  try {
    const approvedPlan = await plan(fixture.client);
    const created = await preview(fixture.client, approvedPlan);
    await assert.rejects(
      execute(fixture.client, created, [AUTH_A], {
        buildGraphStatements(context) {
          const statements = deletionStatements(context);
          statements.splice(2, 0, { sql: "INSERT INTO missing_fault_table DEFAULT VALUES" });
          return statements;
        },
      }),
      (error) =>
        error instanceof AccountDeletionJobError &&
        error.code === "account_deletion_retryable_failure",
    );
    await assertNoGraphDeletion(fixture.client, "SELECT COUNT(*) FROM credit_balances");
  } finally {
    fixture.close();
  }
});
