import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  AccountDeletionSchemaError,
  assertAccountDeletionSchemaReady,
} from "./account-deletion-schema.ts";

const pur01Migration = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const deletionJobMigration = readFileSync(
  new URL(
    "../migrations/20260802_001_create_account_deletion_jobs.sql",
    import.meta.url,
  ),
  "utf8",
);
const deletionStorageMigration = readFileSync(
  new URL(
    "../migrations/20260802_002_create_account_deletion_storage_outbox.sql",
    import.meta.url,
  ),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);

const authoritativeBaseSchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT, normalized_email TEXT, name TEXT,
    avatar_url TEXT, provider TEXT, provider_subject TEXT, role TEXT,
    last_login_at TEXT
  );
  CREATE TABLE auth_identity_links (
    auth_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT
  );
  CREATE TABLE mobile_identity_aliases (
    anon_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT
  );
  CREATE TABLE mobile_identity_links (
    device_key TEXT PRIMARY KEY, canonical_anon_user_id TEXT
  );
  CREATE TABLE cookbook_recipes (
    row_id TEXT PRIMARY KEY, anon_user_id TEXT, recipe_id TEXT, image_url TEXT
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY, auth_user_id TEXT, activity_type TEXT
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY, available_credits INTEGER,
    pending_credits INTEGER
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY, anon_user_id TEXT, status TEXT,
    expires_at TEXT
  );
  CREATE TABLE credit_daily_usage (
    anon_user_id TEXT, day_key TEXT
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY, anon_user_id TEXT, event_type TEXT,
    amount INTEGER, balance_available_after INTEGER,
    balance_pending_after INTEGER, reservation_id TEXT,
    metadata_json TEXT, idempotency_scope TEXT,
    idempotency_key TEXT, actor TEXT, created_at TEXT
  );
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY, provider TEXT, provider_transaction_id TEXT,
    anon_user_id TEXT, product_id TEXT, status TEXT, granted_credits INTEGER,
    reversed_credits INTEGER, outstanding_reversal_credits INTEGER,
    risk_flags_json TEXT, payload_json TEXT, verified_at TEXT,
    revoked_at TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY, auth_user_id TEXT,
    canonical_anon_user_id TEXT, email_hash TEXT, requested_by TEXT,
    provider TEXT, role TEXT, reason TEXT, counts_json TEXT,
    purchase_transactions_preserved INTEGER, idempotency_key TEXT,
    deleted_at TEXT
  );
`;

async function createFixture(options = {}) {
  const client = createClient({ url: "file::memory:" });
  if (options.incomplete !== true) {
    await client.executeMultiple(authoritativeBaseSchema);
    if (options.withPur01 !== false) {
      await client.executeMultiple(pur01Migration);
      await client.executeMultiple(deletionJobMigration);
      await client.executeMultiple(deletionStorageMigration);
    }
  } else {
    await client.execute("CREATE TABLE auth_users (id TEXT PRIMARY KEY)");
  }
  return client;
}

async function assertMissing(client, expected) {
  await assert.rejects(
    assertAccountDeletionSchemaReady({ client }),
    (error) =>
      error instanceof AccountDeletionSchemaError &&
      error.code === "account_deletion_schema_not_ready" &&
      error.missingObjects.includes(expected),
  );
}

test("current authoritative schema including PUR-01 is accepted", async () => {
  const client = await createFixture();
  try {
    await assert.doesNotReject(assertAccountDeletionSchemaReady({ client }));
  } finally {
    client.close();
  }
});

test("missing PUR-01 table fails closed", async () => {
  const client = await createFixture({ withPur01: false });
  try {
    await assertMissing(client, "table:credit_purchase_ledger_links");
  } finally {
    client.close();
  }
});

test("missing deletion job table fails closed", async () => {
  const client = await createFixture();
  try {
    await client.execute("DROP TABLE account_deletion_job_targets");
    await assertMissing(client, "table:account_deletion_job_targets");
  } finally {
    client.close();
  }
});

test("missing deletion storage outbox fails closed", async () => {
  const client = await createFixture();
  try {
    await client.execute("DROP TABLE account_deletion_storage_outbox");
    await assertMissing(client, "table:account_deletion_storage_outbox");
  } finally {
    client.close();
  }
});

test("missing required PUR-01 index or trigger fails closed", async (t) => {
  await t.test("index", async () => {
    const client = await createFixture();
    try {
      await client.execute("DROP INDEX ux_credit_purchase_ledger_links_base_grant");
      await assertMissing(
        client,
        "index:ux_credit_purchase_ledger_links_base_grant",
      );
    } finally {
      client.close();
    }
  });
  await t.test("trigger", async () => {
    const client = await createFixture();
    try {
      await client.execute("DROP TRIGGER trg_purchase_reconciliation_completed_update");
      await assertMissing(
        client,
        "trigger:trg_purchase_reconciliation_completed_update",
      );
    } finally {
      client.close();
    }
  });
});

test("fresh incomplete fixture fails before any destructive operation", async () => {
  const client = await createFixture({ incomplete: true });
  try {
    await assertMissing(client, "column:auth_users.email");
    await assertMissing(client, "table:credit_purchase_transactions");
  } finally {
    client.close();
  }
});

test("schema verification issues only read statements", async () => {
  const client = await createFixture();
  const statements = [];
  try {
    const readOnlyClient = {
      execute(statement) {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);
        assert.match(sql, /^\s*(?:SELECT|PRAGMA)\b/i);
        assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
        return client.execute(statement);
      },
    };
    await assertAccountDeletionSchemaReady({ client: readOnlyClient });
    assert.ok(statements.length > 1);
  } finally {
    client.close();
  }
});

test("deletion path verifies schema instead of creating route-local tables", () => {
  assert.match(
    routeSource,
    /verifySchema: \(\) => assertAccountDeletionSchemaReady\(\)/,
  );
  const deletionBranch = routeSource.slice(
    routeSource.indexOf('if (operation === "account_delete")'),
    routeSource.indexOf("const admin = requireMonetizationAdmin", routeSource.indexOf('if (operation === "account_delete")')),
  );
  assert.doesNotMatch(deletionBranch, /ensureAdminUserSchemas\(/);
});
