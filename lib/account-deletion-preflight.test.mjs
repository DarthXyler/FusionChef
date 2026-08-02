import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import { getAuthUserByIdReadOnly } from "./auth-users.ts";
import { runAccountDeletionPreflight } from "./account-deletion-preflight.ts";
import {
  AccountDeletionSchemaError,
  assertAccountDeletionSchemaReady,
} from "./account-deletion-schema.ts";

const pur01Migration = readFileSync(
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
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);
const authorizationSource = readFileSync(
  new URL("./account-deletion-authorization.ts", import.meta.url),
  "utf8",
);

const baseSchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT, normalized_email TEXT, name TEXT,
    avatar_url TEXT, provider TEXT, provider_subject TEXT, role TEXT,
    last_login_at TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE auth_identity_links (
    auth_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE mobile_identity_aliases (
    anon_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE mobile_identity_links (
    device_key TEXT PRIMARY KEY, canonical_anon_user_id TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE cookbook_recipes (
    row_id TEXT PRIMARY KEY, anon_user_id TEXT, recipe_id TEXT,
    recipe_json TEXT, source_input_json TEXT, image_url TEXT, saved_at TEXT,
    created_at TEXT, updated_at TEXT, is_favorite INTEGER, is_to_try INTEGER
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY, auth_user_id TEXT, activity_type TEXT,
    source_reference_id TEXT, occurred_at TEXT
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY, available_credits INTEGER,
    pending_credits INTEGER, updated_at TEXT
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY, anon_user_id TEXT, action_kind TEXT,
    amount INTEGER, status TEXT, reason TEXT, metadata_json TEXT,
    expires_at TEXT, idempotency_scope TEXT, idempotency_key TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE credit_daily_usage (
    anon_user_id TEXT, day_key TEXT, timezone TEXT, fuse_count INTEGER,
    reroll_count INTEGER, updated_at TEXT, created_at TEXT
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY, anon_user_id TEXT, event_type TEXT,
    amount INTEGER, balance_available_after INTEGER,
    balance_pending_after INTEGER, reservation_id TEXT,
    metadata_json TEXT, idempotency_scope TEXT, idempotency_key TEXT,
    actor TEXT, created_at TEXT
  );
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY, provider TEXT, provider_transaction_id TEXT,
    provider_original_transaction_id TEXT,
    anon_user_id TEXT, product_id TEXT, status TEXT, granted_credits INTEGER,
    reversed_credits INTEGER, outstanding_reversal_credits INTEGER,
    risk_flags_json TEXT, payload_json TEXT, verified_at TEXT,
    revoked_at TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY, auth_user_id TEXT,
    canonical_anon_user_id TEXT, email_hash TEXT, provider TEXT, role TEXT,
    requested_by TEXT, reason TEXT, counts_json TEXT,
    purchase_transactions_preserved INTEGER, idempotency_key TEXT,
    deleted_at TEXT
  );
  CREATE TABLE api_rate_limits (
    limiter_key TEXT PRIMARY KEY, count INTEGER NOT NULL
  );
`;

async function createFixture() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(baseSchema);
  await client.executeMultiple(pur01Migration);
  await client.executeMultiple(jobMigration);
  await client.executeMultiple(outboxMigration);
  await client.executeMultiple(`
    INSERT INTO auth_users (
      id, email, normalized_email, name, avatar_url, provider,
      provider_subject, role, last_login_at
    ) VALUES (
      'admin-1', 'admin@example.test', 'admin@example.test', 'Admin', '',
      'google', 'admin-provider', 'admin', '2026-08-02T00:00:00.000Z'
    );
    INSERT INTO cookbook_recipes (row_id, anon_user_id, recipe_id, image_url)
    VALUES ('recipe-1', 'identity-1', 'saved-1', '');
  `);
  return client;
}

function sqlText(statement) {
  return typeof statement === "string" ? statement : statement.sql;
}

async function countRowsIfPresent(client, tableName) {
  const table = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  if (table.rows.length === 0) return 0;
  const result = await client.execute(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return Number(result.rows[0].count);
}

async function captureMutationCounts(client) {
  return {
    jobs: await countRowsIfPresent(client, "account_deletion_jobs"),
    targets: await countRowsIfPresent(client, "account_deletion_job_targets"),
    outbox: await countRowsIfPresent(client, "account_deletion_storage_outbox"),
    recipes: await countRowsIfPresent(client, "cookbook_recipes"),
    rateLimits: await countRowsIfPresent(client, "api_rate_limits"),
  };
}

test("incomplete deletion schemas stop before authorization and rate-limit writes", async (t) => {
  const cases = [
    ["PUR-01 table", "DROP TABLE credit_purchase_ledger_links", "table:credit_purchase_ledger_links"],
    ["deletion job schema", "DROP TABLE account_deletion_job_targets", "table:account_deletion_job_targets"],
    ["storage outbox schema", "DROP TABLE account_deletion_storage_outbox", "table:account_deletion_storage_outbox"],
    ["required trigger", "DROP TRIGGER trg_purchase_reconciliation_completed_update", "trigger:trg_purchase_reconciliation_completed_update"],
    ["required index", "DROP INDEX ux_credit_purchase_ledger_links_base_grant", "index:ux_credit_purchase_ledger_links_base_grant"],
  ];
  for (const [name, dropSql, missingObject] of cases) {
    await t.test(name, async () => {
      const client = await createFixture();
      try {
        await client.execute(dropSql);
        const countsBefore = await captureMutationCounts(client);
        const statements = [];
        let authorizationCalls = 0;
        let rateLimitCalls = 0;
        const instrumented = {
          execute(statement) {
            const sql = sqlText(statement);
            statements.push(sql);
            assert.match(sql, /^\s*(?:SELECT|PRAGMA)\b/i);
            assert.doesNotMatch(
              sql,
              /\b(?:CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/i,
            );
            return client.execute(statement);
          },
        };
        await assert.rejects(
          runAccountDeletionPreflight({
            verifySchema: () =>
              assertAccountDeletionSchemaReady({ client: instrumented }),
            async authorize() {
              authorizationCalls += 1;
              return { ok: false, response: "unexpected" };
            },
            async enforceRateLimit() {
              rateLimitCalls += 1;
              return null;
            },
          }),
          (error) =>
            error instanceof AccountDeletionSchemaError &&
            error.statusCode === 503 &&
            error.missingObjects.includes(missingObject),
        );
        assert.ok(statements.length > 0);
        assert.equal(authorizationCalls, 0);
        assert.equal(rateLimitCalls, 0);
        assert.deepEqual(await captureMutationCounts(client), countsBefore);
      } finally {
        client.close();
      }
    });
  }
});

test("complete schema authorizes with a read-only lookup before rate limiting", async () => {
  const client = await createFixture();
  try {
    const readinessStatements = [];
    let schemaReady = false;
    let rateLimitCalls = 0;
    const instrumented = {
      execute(statement) {
        const sql = sqlText(statement);
        if (!schemaReady) {
          readinessStatements.push(sql);
          assert.match(sql, /^\s*(?:SELECT|PRAGMA)\b/i);
        }
        return client.execute(statement);
      },
    };
    const result = await runAccountDeletionPreflight({
      async verifySchema() {
        await assertAccountDeletionSchemaReady({ client: instrumented });
        schemaReady = true;
      },
      async authorize() {
        const user = await getAuthUserByIdReadOnly("admin-1", {
          client: instrumented,
        });
        return { ok: true, context: user };
      },
      async enforceRateLimit() {
        rateLimitCalls += 1;
        await instrumented.execute(
          "INSERT INTO api_rate_limits (limiter_key, count) VALUES ('admin', 1)",
        );
        return null;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.context.id, "admin-1");
    assert.ok(readinessStatements.length > 1);
    assert.equal(rateLimitCalls, 1);
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) AS count FROM api_rate_limits")).rows[0].count),
      1,
    );
  } finally {
    client.close();
  }
});

test("route parses deletion before schema, authorization, and stateful limiting", () => {
  const branch = routeSource.slice(
    routeSource.indexOf("export async function POST"),
    routeSource.indexOf("const payload = parseBatchPayload"),
  );
  const parseIndex = branch.indexOf("const payload = parseDeletePayload(rawBody)");
  const preflightIndex = branch.indexOf("runAccountDeletionPreflight");
  assert.ok(parseIndex >= 0 && preflightIndex > parseIndex);
  assert.match(branch, /verifySchema: \(\) => assertAccountDeletionSchemaReady\(\)/);
  assert.match(branch, /authorize: \(\) => requireAccountDeletionAdmin\(request\)/);
  assert.match(branch, /enforceRateLimit: \(\) =>/);
  assert.match(authorizationSource, /getAuthUserByIdReadOnly/);
  assert.doesNotMatch(authorizationSource, /getAuthUserById\(/);
});
