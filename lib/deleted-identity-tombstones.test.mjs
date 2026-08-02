import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  IdentityResolutionError,
  resolveCookbookIdentityCore,
} from "./cookbook-identity-core.ts";
import {
  buildDeletedIdentityTombstoneStatements,
  createDeletedIdentityReference,
  filterDeletedIdentityCandidates,
} from "./deleted-identity-tombstones.ts";
import { upsertOAuthUser } from "./auth-users.ts";

const SECRET = "deleted-identity-test-secret-at-least-32-bytes";
const JOB_ID = "deletion-job-tombstone-test";
const OLD_CANONICAL = "11111111-1111-4111-8111-111111111111";
const OLD_ALIAS = "22222222-2222-4222-8222-222222222222";
const FRESH_CANONICAL = "33333333-3333-4333-8333-333333333333";
const AUTH_USER_ID = "new-auth-user";
const DEVICE_KEY = "44444444-4444-4444-8444-444444444444";

const jobMigration = readFileSync(
  new URL("../migrations/20260802_001_create_account_deletion_jobs.sql", import.meta.url),
  "utf8",
);
const tombstoneMigration = readFileSync(
  new URL("../migrations/20260802_003_create_deleted_identity_tombstones.sql", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);
const resolverSource = readFileSync(
  new URL("./cookbook-identity.ts", import.meta.url),
  "utf8",
);

async function createFixture({ withTombstones = true } = {}) {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE auth_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, normalized_email TEXT NOT NULL,
      name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
      role TEXT NOT NULL, last_login_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_subject)
    );
    CREATE TABLE mobile_identity_aliases (
      anon_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE credit_ledger_entries (
      entry_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL, amount INTEGER NOT NULL
    );
  `);
  await client.executeMultiple(jobMigration);
  if (withTombstones) {
    await client.executeMultiple(tombstoneMigration);
  }
  await client.execute({
    sql: `INSERT INTO account_deletion_jobs (
            job_id, request_id, request_source, acting_admin_ref, reason,
            preview_fingerprint, preview_expires_at, status, idempotency_key
          ) VALUES (?, 'request-tombstone', 'admin', 'admin:v1:test',
            'reason:v1:test', ?, '2026-08-03T00:00:00.000Z', 'executing',
            'idempotency-tombstone')`,
    args: [JOB_ID, "f".repeat(64)],
  });
  return client;
}

function coreDependencies(client, overrides = {}) {
  const aliasWrites = [];
  const deviceWrites = [];
  const authWrites = [];
  return {
    aliasWrites,
    deviceWrites,
    authWrites,
    dependencies: {
      getBaseIdentity: () => ({ anonUserId: OLD_ALIAS, shouldSetCookie: false }),
      ensureSchema: async () => {},
      readCanonicalIdForDevice: async () => OLD_CANONICAL,
      readCanonicalIdForAuthUser: async () => OLD_CANONICAL,
      resolveAliasCanonicalId: async () => OLD_CANONICAL,
      filterDeletedIdentityCandidates: (candidateIds) =>
        filterDeletedIdentityCandidates(candidateIds, { client, secret: SECRET }),
      filterCandidatesForAuthUser: async (candidateIds) => candidateIds,
      filterCandidatesForSignedOutUser: async (candidateIds) => candidateIds,
      pickCanonicalAnonId: async (candidateIds) => candidateIds[0],
      mergeCookbookAnonymousUsers: async () => {},
      upsertAliasForAnonId: async (...args) => aliasWrites.push(args),
      upsertCanonicalIdForDevice: async (...args) => deviceWrites.push(args),
      upsertCanonicalIdForAuthUser: async (...args) => authWrites.push(args),
      createAnonymousId: () => FRESH_CANONICAL,
      ...overrides,
    },
  };
}

async function insertOldGraphTombstones(client) {
  await client.batch(
    buildDeletedIdentityTombstoneStatements({
      identityNodes: [OLD_CANONICAL, OLD_ALIAS, OLD_CANONICAL],
      deletionJobId: JOB_ID,
      secret: SECRET,
    }),
    "write",
  );
}

test("migration is additive, idempotent, indexed, constrained, and pseudonymous", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(tombstoneMigration);
    await insertOldGraphTombstones(client);
    await insertOldGraphTombstones(client);

    const rows = await client.execute(
      "SELECT identity_ref, identity_kind, deletion_job_id, schema_version FROM deleted_identity_tombstones ORDER BY identity_ref",
    );
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.every((row) => row.identity_kind === "graph_node"));
    assert.ok(rows.rows.every((row) => row.deletion_job_id === JOB_ID));
    assert.ok(rows.rows.every((row) => Number(row.schema_version) === 1));
    assert.ok(rows.rows.every((row) => /^identity:v1:[0-9a-f]{64}$/.test(String(row.identity_ref))));
    assert.doesNotMatch(JSON.stringify(rows.rows), new RegExp(`${OLD_CANONICAL}|${OLD_ALIAS}`));

    const indexes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_deleted_identity_tombstones_%'",
    );
    assert.deepEqual(
      indexes.rows.map((row) => row.name).sort(),
      [
        "idx_deleted_identity_tombstones_job",
        "idx_deleted_identity_tombstones_kind_created",
      ],
    );
    await assert.rejects(
      client.execute("DELETE FROM account_deletion_jobs WHERE job_id = 'deletion-job-tombstone-test'"),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    client.close();
  }
});

test("tombstones commit atomically with graph deletion and duplicate insertion is safe", async () => {
  const client = await createFixture();
  try {
    await client.execute({
      sql: "INSERT INTO mobile_identity_aliases VALUES (?, ?)",
      args: [OLD_ALIAS, OLD_CANONICAL],
    });
    const statements = buildDeletedIdentityTombstoneStatements({
      identityNodes: [OLD_CANONICAL, OLD_ALIAS],
      deletionJobId: JOB_ID,
      secret: SECRET,
    });
    await assert.rejects(
      client.batch(
        [...statements, { sql: "DELETE FROM missing_identity_table", args: [] }],
        "write",
      ),
    );
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) AS count FROM deleted_identity_tombstones")).rows[0].count),
      0,
    );

    await client.batch(
      [
        ...statements,
        {
          sql: "DELETE FROM mobile_identity_aliases WHERE anon_user_id = ?",
          args: [OLD_ALIAS],
        },
      ],
      "write",
    );
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) AS count FROM deleted_identity_tombstones")).rows[0].count),
      2,
    );
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) AS count FROM mobile_identity_aliases")).rows[0].count),
      0,
    );

    const tombstoneIndex = routeSource.indexOf("buildDeletedIdentityTombstoneStatements({");
    const cleanupIndex = routeSource.indexOf("buildAccountDeletionGraphCleanupStatements({", tombstoneIndex);
    assert.ok(tombstoneIndex >= 0 && cleanupIndex > tombstoneIndex);
  } finally {
    client.close();
  }
});

test("Google and Apple recreation allocate a fresh canonical and never recreate the old self-alias", async () => {
  for (const provider of ["google", "apple"]) {
    const client = await createFixture();
    try {
      await insertOldGraphTombstones(client);
      const original = await upsertOAuthUser(
        {
          provider,
          providerSubject: `${provider}-same-subject`,
          email: `${provider}@example.test`,
          name: `${provider} user`,
          role: "user",
        },
        { client, schemaReady: true },
      );
      await client.execute({ sql: "DELETE FROM auth_users WHERE id = ?", args: [original.id] });
      const recreated = await upsertOAuthUser(
        {
          provider,
          providerSubject: `${provider}-same-subject`,
          email: `${provider}@example.test`,
          name: "",
          role: "user",
        },
        { client, schemaReady: true },
      );
      assert.notEqual(recreated.id, original.id);

      const harness = coreDependencies(client);
      const resolved = await resolveCookbookIdentityCore(
        { authUserId: recreated.id, deviceKey: DEVICE_KEY },
        harness.dependencies,
      );
      assert.equal(resolved.anonUserId, FRESH_CANONICAL, provider);
      assert.equal(resolved.shouldSetCookie, true, provider);
      assert.deepEqual(harness.aliasWrites, [[FRESH_CANONICAL, FRESH_CANONICAL]]);
      assert.deepEqual(harness.authWrites, [[recreated.id, FRESH_CANONICAL]]);
      assert.deepEqual(harness.deviceWrites, [[DEVICE_KEY, FRESH_CANONICAL]]);
      assert.ok(harness.aliasWrites.flat().every((value) => value !== OLD_CANONICAL && value !== OLD_ALIAS));
    } finally {
      client.close();
    }
  }
});

test("stale anonymous, canonical, alias, and device-derived candidates are rejected", async () => {
  const client = await createFixture();
  try {
    await insertOldGraphTombstones(client);
    const scenarios = [
      { name: "anonymous", params: { authUserId: null, deviceKey: null } },
      { name: "canonical", params: { authUserId: AUTH_USER_ID, deviceKey: null } },
      { name: "alias", params: { authUserId: null, deviceKey: null } },
      { name: "device", params: { authUserId: null, deviceKey: DEVICE_KEY } },
      { name: "reinstall", params: { authUserId: AUTH_USER_ID, deviceKey: DEVICE_KEY } },
    ];
    for (const scenario of scenarios) {
      const harness = coreDependencies(client);
      const result = await resolveCookbookIdentityCore(
        scenario.params,
        harness.dependencies,
      );
      assert.equal(result.anonUserId, FRESH_CANONICAL, scenario.name);
      assert.equal(result.shouldSetCookie, true, scenario.name);
    }
  } finally {
    client.close();
  }
});

test("a tombstoned candidate mixed with a clean candidate keeps only the clean identity", async () => {
  const client = await createFixture();
  try {
    await insertOldGraphTombstones(client);
    const harness = coreDependencies(client, {
      readCanonicalIdForDevice: async () => FRESH_CANONICAL,
      readCanonicalIdForAuthUser: async () => null,
    });
    const result = await resolveCookbookIdentityCore(
      { authUserId: AUTH_USER_ID, deviceKey: DEVICE_KEY },
      harness.dependencies,
    );
    assert.equal(result.anonUserId, FRESH_CANONICAL);
    assert.ok(harness.aliasWrites.flat().every((value) => value !== OLD_CANONICAL && value !== OLD_ALIAS));
  } finally {
    client.close();
  }
});

test("retained financial evidence remains inaccessible to the fresh canonical", async () => {
  const client = await createFixture();
  try {
    await insertOldGraphTombstones(client);
    await client.execute({
      sql: "INSERT INTO credit_ledger_entries VALUES ('retained-entry', 'deleted:v1:pseudonym', 100)",
    });
    const harness = coreDependencies(client);
    const result = await resolveCookbookIdentityCore(
      { authUserId: AUTH_USER_ID, deviceKey: DEVICE_KEY },
      harness.dependencies,
    );
    const visible = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM credit_ledger_entries WHERE anon_user_id = ?",
      args: [result.anonUserId],
    });
    assert.equal(Number(visible.rows[0].count), 0);
  } finally {
    client.close();
  }
});

test("missing tombstone schema fails identity resolution closed", async () => {
  const client = await createFixture({ withTombstones: false });
  try {
    const harness = coreDependencies(client);
    await assert.rejects(
      resolveCookbookIdentityCore(
        { authUserId: AUTH_USER_ID, deviceKey: DEVICE_KEY },
        harness.dependencies,
      ),
      (error) =>
        error instanceof IdentityResolutionError &&
        error.code === "identity_unavailable" &&
        error.stage === "tombstone_filtering",
    );
    assert.deepEqual(harness.aliasWrites, []);
    assert.deepEqual(harness.deviceWrites, []);
    assert.deepEqual(harness.authWrites, []);
  } finally {
    client.close();
  }
});

test("identity mapping writes use tombstone guards and rollback remains migration-safe", () => {
  assert.equal(
    (resolverSource.match(/getDeletedIdentityWriteGuard\(/g) ?? []).length,
    3,
  );
  assert.match(resolverSource, /filterDeletedIdentityCandidates/);
  assert.doesNotMatch(tombstoneMigration, /^\s*(?:DROP|DELETE|UPDATE)\b/im);
  assert.equal(
    createDeletedIdentityReference(OLD_CANONICAL, { secret: SECRET }),
    createDeletedIdentityReference(OLD_CANONICAL, { secret: SECRET }),
  );
});
