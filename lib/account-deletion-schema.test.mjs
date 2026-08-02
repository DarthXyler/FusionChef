import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  AccountDeletionSchemaError,
  assertAccountDeletionSchemaReady,
} from "./account-deletion-schema.ts";
import { runAccountDeletionPreflight } from "./account-deletion-preflight.ts";

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
const deletedIdentityMigration = readFileSync(
  new URL(
    "../migrations/20260802_003_create_deleted_identity_tombstones.sql",
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
    metadata_json TEXT, idempotency_scope TEXT,
    idempotency_key TEXT, actor TEXT, created_at TEXT
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
      await client.executeMultiple(options.pur01Migration ?? pur01Migration);
      await client.executeMultiple(
        options.deletionJobMigration ?? deletionJobMigration,
      );
      if (options.withStorage !== false) {
        await client.executeMultiple(
          options.deletionStorageMigration ?? deletionStorageMigration,
        );
      }
      if (options.withTombstones !== false) {
        await client.executeMultiple(
          options.deletedIdentityMigration ?? deletedIdentityMigration,
        );
      }
    }
  } else {
    await client.execute("CREATE TABLE auth_users (id TEXT PRIMARY KEY)");
  }
  return client;
}

function replaceRequired(source, search, replacement) {
  assert.ok(source.includes(search), `fixture mutation source not found: ${search}`);
  return source.replace(search, replacement);
}

function replaceRequiredPattern(source, pattern, replacement) {
  const updated = source.replace(pattern, replacement);
  assert.notEqual(updated, source, `fixture mutation pattern not found: ${pattern}`);
  return updated;
}

function mutateTable(source, tableName, mutate) {
  const normalized = source.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
  assert.ok(start >= 0, `fixture table not found: ${tableName}`);
  const end = normalized.indexOf("\n);", start);
  assert.ok(end > start, `fixture table terminator not found: ${tableName}`);
  const tableSql = normalized.slice(start, end + 3);
  const mutated = mutate(tableSql);
  assert.notEqual(mutated, tableSql, `fixture table was not changed: ${tableName}`);
  return `${normalized.slice(0, start)}${mutated}${normalized.slice(end + 3)}`;
}

async function assertRejectedBeforeAuthorizationOrState(client) {
  const statements = [];
  let authorizationCalls = 0;
  let rateLimitCalls = 0;
  const instrumented = {
    execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      statements.push(sql);
      assert.match(sql, /^\s*(?:SELECT|PRAGMA)\b/i);
      assert.doesNotMatch(
        sql,
        /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i,
      );
      return client.execute(statement);
    },
  };
  await assert.rejects(
    runAccountDeletionPreflight({
      verifySchema: () => assertAccountDeletionSchemaReady({ client: instrumented }),
      async authorize() {
        authorizationCalls += 1;
        return { ok: true, context: {} };
      },
      async enforceRateLimit() {
        rateLimitCalls += 1;
        return null;
      },
    }),
    (error) =>
      error instanceof AccountDeletionSchemaError &&
      error.code === "account_deletion_schema_not_ready" &&
      error.statusCode === 503,
  );
  assert.ok(statements.length > 0);
  assert.equal(authorizationCalls, 0);
  assert.equal(rateLimitCalls, 0);
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

test("missing deleted identity tombstones fail closed", async () => {
  const client = await createFixture();
  try {
    await client.execute("DROP TABLE deleted_identity_tombstones");
    await assertMissing(client, "table:deleted_identity_tombstones");
  } finally {
    client.close();
  }
});

test("missing tombstone key metadata fails closed", async () => {
  const client = await createFixture();
  try {
    await client.execute("DROP TABLE deleted_identity_tombstone_key_metadata");
    await assertMissing(
      client,
      "table:deleted_identity_tombstone_key_metadata",
    );
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
  await t.test("tombstone index", async () => {
    const client = await createFixture();
    try {
      await client.execute("DROP INDEX idx_deleted_identity_tombstones_job");
      await assertMissing(
        client,
        "index:idx_deleted_identity_tombstones_job",
      );
    } finally {
      client.close();
    }
  });
  await t.test("tombstone key trigger", async () => {
    const client = await createFixture();
    try {
      await client.execute(
        "DROP TRIGGER trg_deleted_identity_tombstone_key_no_update",
      );
      await assertMissing(
        client,
        "trigger:trg_deleted_identity_tombstone_key_no_update",
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

test("malformed production-shaped constraints fail closed before authorization or state", async (t) => {
  const jobStatus = /status TEXT NOT NULL\s+CHECK\(status IN \(\s*'previewed',[\s\S]*?'manual_review'\s*\)\),/;
  const outboxStatus = /status TEXT NOT NULL DEFAULT 'pending'\s+CHECK\(status IN \(\s*'pending',[\s\S]*?'manual_review'\s*\)\),/;
  const objectCategory = /object_category TEXT NOT NULL\s+CHECK\(object_category IN \(\s*'recipe_image',[\s\S]*?'generated_image'\s*\)\),/;
  const compositeTargetForeignKey = /\s*FOREIGN KEY\(job_id, target_id\)\s+REFERENCES account_deletion_job_targets\(job_id, target_id\)\s+ON DELETE CASCADE,/;

  const cases = [
    {
      name: "outbox with no foreign keys",
      options: () => ({
        deletionStorageMigration: mutateTable(
          deletionStorageMigration,
          "account_deletion_storage_outbox",
          (sql) => {
            let changed = replaceRequiredPattern(
              sql,
              /job_id TEXT NOT NULL\s+REFERENCES account_deletion_jobs\(job_id\) ON DELETE CASCADE,/,
              "job_id TEXT NOT NULL,",
            );
            changed = replaceRequiredPattern(
              changed,
              compositeTargetForeignKey,
              "",
            );
            return changed;
          },
        ),
      }),
    },
    {
      name: "outbox job foreign key targets the wrong table",
      options: () => ({
        deletionStorageMigration: mutateTable(
          deletionStorageMigration,
          "account_deletion_storage_outbox",
          (sql) =>
            replaceRequired(
              sql,
              "REFERENCES account_deletion_jobs(job_id) ON DELETE CASCADE",
              "REFERENCES auth_users(id) ON DELETE CASCADE",
            ),
        ),
      }),
    },
    {
      name: "outbox job foreign key uses NO ACTION",
      options: () => ({
        deletionStorageMigration: mutateTable(
          deletionStorageMigration,
          "account_deletion_storage_outbox",
          (sql) =>
            replaceRequired(
              sql,
              "REFERENCES account_deletion_jobs(job_id) ON DELETE CASCADE",
              "REFERENCES account_deletion_jobs(job_id) ON DELETE NO ACTION",
            ),
        ),
      }),
    },
    {
      name: "outbox is missing the composite target foreign key",
      options: () => ({
        deletionStorageMigration: mutateTable(
          deletionStorageMigration,
          "account_deletion_storage_outbox",
          (sql) =>
            replaceRequiredPattern(sql, compositeTargetForeignKey, ""),
        ),
      }),
    },
    {
      name: "target table lacks job and target-id composite uniqueness",
      options: () => ({
        deletionStorageMigration: replaceRequired(
          deletionStorageMigration.replace(/\r\n/g, "\n"),
          "CREATE UNIQUE INDEX IF NOT EXISTS ux_account_deletion_targets_job_target\n  ON account_deletion_job_targets (job_id, target_id);\n",
          "",
        ),
      }),
    },
    {
      name: "expected index name points at the wrong column",
      options: () => ({
        deletionStorageMigration: replaceRequired(
          deletionStorageMigration.replace(/\r\n/g, "\n"),
          "ON account_deletion_storage_outbox (created_at DESC)",
          "ON account_deletion_storage_outbox (status DESC)",
        ),
      }),
    },
    {
      name: "expected index has columns in the wrong order",
      options: () => ({
        deletionJobMigration: replaceRequired(
          deletionJobMigration.replace(/\r\n/g, "\n"),
          "ON account_deletion_job_targets (job_id, status, updated_at DESC)",
          "ON account_deletion_job_targets (status, job_id, updated_at DESC)",
        ),
      }),
    },
    {
      name: "required target composite index is nonunique",
      options: () => ({
        deletionStorageMigration: replaceRequired(
          deletionStorageMigration.replace(/\r\n/g, "\n"),
          "CREATE UNIQUE INDEX IF NOT EXISTS ux_account_deletion_targets_job_target",
          "CREATE INDEX IF NOT EXISTS ux_account_deletion_targets_job_target",
        ),
      }),
    },
    {
      name: "job status allowlist check is missing",
      options: () => ({
        deletionJobMigration: mutateTable(
          deletionJobMigration,
          "account_deletion_jobs",
          (sql) => replaceRequiredPattern(sql, jobStatus, "status TEXT NOT NULL,"),
        ),
      }),
    },
    {
      name: "target status allowlist check is missing",
      options: () => ({
        deletionJobMigration: mutateTable(
          deletionJobMigration,
          "account_deletion_job_targets",
          (sql) => replaceRequiredPattern(sql, jobStatus, "status TEXT NOT NULL,"),
        ),
      }),
    },
    {
      name: "outbox status allowlist check is missing",
      options: () => ({
        deletionStorageMigration: mutateTable(
          deletionStorageMigration,
          "account_deletion_storage_outbox",
          (sql) =>
            replaceRequiredPattern(sql, outboxStatus, "status TEXT NOT NULL,"),
        ),
      }),
    },
    {
      name: "outbox object-category allowlist check is missing",
      options: () => ({
        deletionStorageMigration: mutateTable(
          deletionStorageMigration,
          "account_deletion_storage_outbox",
          (sql) =>
            replaceRequiredPattern(
              sql,
              objectCategory,
              "object_category TEXT NOT NULL,",
            ),
        ),
      }),
    },
    {
      name: "tombstone job foreign key has the wrong delete action",
      options: () => ({
        deletedIdentityMigration: mutateTable(
          deletedIdentityMigration,
          "deleted_identity_tombstones",
          (sql) =>
            replaceRequired(
              sql,
              "REFERENCES account_deletion_jobs(job_id) ON DELETE RESTRICT",
              "REFERENCES account_deletion_jobs(job_id) ON DELETE CASCADE",
            ),
        ),
      }),
    },
    {
      name: "tombstone identity-kind constraint is missing",
      options: () => ({
        deletedIdentityMigration: mutateTable(
          deletedIdentityMigration,
          "deleted_identity_tombstones",
          (sql) =>
            replaceRequired(
              sql,
              "identity_kind TEXT NOT NULL\n    CHECK(identity_kind = 'graph_node'),",
              "identity_kind TEXT NOT NULL,",
            ),
        ),
      }),
    },
    {
      name: "tombstone version and key-reference constraints are incomplete",
      options: () => ({
        deletedIdentityMigration: mutateTable(
          deletedIdentityMigration,
          "deleted_identity_tombstones",
          (sql) => {
            let changed = replaceRequired(
              sql,
              "key_version INTEGER NOT NULL DEFAULT 1\n    CHECK(key_version = 1),",
              "key_version INTEGER NOT NULL DEFAULT 1,",
            );
            changed = replaceRequired(
              changed,
              "      AND length(key_reference) = 71\n",
              "",
            );
            return changed;
          },
        ),
      }),
    },
    {
      name: "tombstone metadata lacks singleton and version uniqueness",
      options: () => ({
        deletedIdentityMigration: mutateTable(
          deletedIdentityMigration,
          "deleted_identity_tombstone_key_metadata",
          (sql) => {
            let changed = replaceRequired(
              sql,
              "singleton_id INTEGER PRIMARY KEY\n    CHECK(singleton_id = 1),",
              "singleton_id INTEGER PRIMARY KEY,",
            );
            changed = replaceRequired(
              changed,
              ",\n  UNIQUE(key_version, key_reference)",
              "",
            );
            return changed;
          },
        ),
      }),
    },
    {
      name: "key metadata has correct columns but malformed algorithm semantics",
      options: () => ({
        deletedIdentityMigration: mutateTable(
          deletedIdentityMigration,
          "deleted_identity_tombstone_key_metadata",
          (sql) =>
            replaceRequired(
              sql,
              "CHECK(hmac_algorithm = 'HMAC-SHA256')",
              "CHECK(length(trim(hmac_algorithm)) > 0)",
            ),
        ),
      }),
    },
    {
      name: "PUR purchase link foreign key has the wrong delete action",
      options: () => ({
        pur01Migration: mutateTable(
          pur01Migration,
          "credit_purchase_ledger_links",
          (sql) =>
            replaceRequired(
              sql,
              "REFERENCES credit_purchase_transactions(row_id) ON DELETE CASCADE",
              "REFERENCES credit_purchase_transactions(row_id) ON DELETE SET NULL",
            ),
        ),
      }),
    },
    {
      name: "PUR base-grant unique index has the wrong predicate",
      options: () => ({
        pur01Migration: replaceRequired(
          pur01Migration.replace(/\r\n/g, "\n"),
          "WHERE link_kind = 'base_grant'",
          "WHERE link_kind = 'repair_adjustment'",
        ),
      }),
    },
    {
      name: "PUR completed-record trigger is semantically weakened",
      options: () => ({
        pur01Migration: replaceRequired(
          pur01Migration.replace(/\r\n/g, "\n"),
          "WHEN OLD.status = 'completed'",
          "WHEN OLD.status = 'never'",
        ),
      }),
    },
    {
      name: "partially applied deletion migrations",
      options: () => ({ withStorage: false, withTombstones: false }),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const client = await createFixture(fixture.options());
      try {
        await assertRejectedBeforeAuthorizationOrState(client);
      } finally {
        client.close();
      }
    });
  }
});

test("a second independently-created production-shaped schema is accepted", async () => {
  const client = await createFixture();
  try {
    await assert.doesNotReject(assertAccountDeletionSchemaReady({ client }));
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
