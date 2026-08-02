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
import { planAccountDeletion as planAccountDeletionWithSecret } from "./account-deletion-planner.ts";
import { buildAccountDeletionStorageOutboxStatements } from "./account-deletion-storage.ts";
import { resolveAdminUserIdentifierTargets } from "./admin-user-target-resolution.ts";
import { createAccountDeletionPseudonym } from "./purchase-settlement-retention.ts";

const AUTH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "auth-only-route-test-secret-at-least-32-bytes";
const PUBLIC_BASE_URL = "https://cdn.example.test";

function createEphemeralClient() {
  const databasePath = path.join(
    tmpdir(),
    `ffc-account-deletion-route-${randomUUID()}.db`,
  );
  const client = createClient({
    url: `file:${databasePath.replace(/\\/g, "/")}`,
  });
  const close = client.close.bind(client);
  client.close = () => {
    close();
    try {
      unlinkSync(databasePath);
    } catch {
      // libSQL may retain the ephemeral file briefly on Windows.
    }
  };
  return client;
}
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
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

function planAccountDeletion(options) {
  return planAccountDeletionWithSecret({
    ...options,
    secret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
  });
}

const domainSchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, normalized_email TEXT NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'google',
    role TEXT NOT NULL DEFAULT 'user', last_login_at TEXT NOT NULL DEFAULT ''
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
    row_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY, available_credits INTEGER NOT NULL,
    pending_credits INTEGER NOT NULL
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, expires_at TEXT
  );
  CREATE TABLE credit_daily_usage (anon_user_id TEXT NOT NULL, day_key TEXT NOT NULL);
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL, amount INTEGER NOT NULL,
    reservation_id TEXT, actor TEXT NOT NULL DEFAULT 'fixture',
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE credit_purchase_ledger_links (
    id TEXT PRIMARY KEY, purchase_transaction_id TEXT NOT NULL,
    ledger_entry_id TEXT NOT NULL, link_kind TEXT NOT NULL
  );
  CREATE TABLE purchase_reconciliation_actions (
    id TEXT PRIMARY KEY, purchase_transaction_id TEXT,
    ledger_entry_id TEXT, metadata_json TEXT
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY, auth_user_id TEXT,
    canonical_anon_user_id TEXT
  );
`;

function resolutionFetcher(users) {
  return async (column, values) => {
    const output = new Map();
    for (const value of values) {
      const matches = users.filter((user) => {
        if (column === "normalized_email") return user.normalizedEmail === value;
        if (column === "id") return user.authUserId === value;
        return user.canonicalAnonUserId === value;
      });
      if (matches.length > 0) output.set(value, matches);
    }
    return output;
  };
}

function authOnlyUser(overrides = {}) {
  return {
    authUserId: AUTH_ID,
    normalizedEmail: "only@example.test",
    canonicalAnonUserId: "",
    ...overrides,
  };
}

async function createFixture() {
  const client = createEphemeralClient();
  await client.executeMultiple(domainSchema);
  await client.executeMultiple(jobMigration);
  await client.executeMultiple(outboxMigration);
  await client.executeMultiple(`
    INSERT INTO auth_users (
      id, email, normalized_email, avatar_url, provider, role, last_login_at
    ) VALUES (
      '${AUTH_ID}', 'only@example.test', 'only@example.test',
      '${PUBLIC_BASE_URL}/profile-photos/auth-only.webp',
      'google', 'user', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO product_activity_events (event_id, auth_user_id)
      VALUES ('activity-auth-only', '${AUTH_ID}');
  `);
  return client;
}

function deletionStatements(graph, jobId, targetId) {
  return [
    ...buildAccountDeletionStorageOutboxStatements({
      graph,
      jobId,
      targetId,
      publicBaseUrl: PUBLIC_BASE_URL,
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

test("deletion route resolution accepts auth-only users by auth ID and email", async () => {
  const user = authOnlyUser();
  for (const identifier of [AUTH_ID, "ONLY@example.test"]) {
    const [target] = await resolveAdminUserIdentifierTargets({
      identifiers: [identifier],
      allowAuthOnly: true,
      fetchUsers: resolutionFetcher([user]),
    });
    assert.equal(target.status, "ready");
    assert.equal(target.user.authUserId, AUTH_ID);
    assert.equal(target.user.canonicalAnonUserId, "");
  }
  assert.match(
    routeSource,
    /resolveBatchTargets\(identifiers, \{\s*allowAuthOnly: true,\s*\}\)/,
  );
});

test("missing and ambiguous identifiers stay blocked while grant resolution stays strict", async () => {
  const user = authOnlyUser();
  const [missing] = await resolveAdminUserIdentifierTargets({
    identifiers: ["missing@example.test"],
    allowAuthOnly: true,
    fetchUsers: resolutionFetcher([user]),
  });
  assert.equal(missing.status, "missing");

  const [ambiguous] = await resolveAdminUserIdentifierTargets({
    identifiers: ["shared@example.test"],
    allowAuthOnly: true,
    fetchUsers: resolutionFetcher([
      authOnlyUser({ normalizedEmail: "shared@example.test" }),
      authOnlyUser({
        authUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        normalizedEmail: "shared@example.test",
      }),
    ]),
  });
  assert.equal(ambiguous.status, "ambiguous");

  const [grantTarget] = await resolveAdminUserIdentifierTargets({
    identifiers: [AUTH_ID],
    allowAuthOnly: false,
    fetchUsers: resolutionFetcher([user]),
  });
  assert.equal(grantTarget.status, "missing");
});

test("auth-only preview executes through the durable job and replays idempotently", async () => {
  const client = await createFixture();
  try {
    const currentPlan = await planAccountDeletion({ authUserIds: [AUTH_ID], client });
    const [graph] = currentPlan.graphs;
    assert.equal(graph.status, "ready");
    assert.deepEqual(graph.identityNodes, []);
    assert.equal(graph.inventory.authUsers, 1);
    assert.equal(graph.inventory.productActivityEvents, 1);
    assert.equal(graph.inventory.cookbookRecipes, 0);
    assert.equal(graph.inventory.creditBalanceRows, 0);
    assert.deepEqual(graph.storageReferences, [
      {
        category: "profile_avatar",
        value: `${PUBLIC_BASE_URL}/profile-photos/auth-only.webp`,
      },
    ]);

    const preview = await createAccountDeletionPreview({
      plan: currentPlan,
      reason: "Verified auth-only deletion request.",
      actingAdminAuthUserId: "admin-auth-user",
      requestId: "auth-only-preview",
      idempotencyKey: "auth-only-preview",
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      client,
      secret: SECRET,
    });
    const result = await executeAccountDeletionJob({
      jobId: preview.jobId,
      fingerprint: preview.fingerprint,
      authUserIds: currentPlan.selectedAuthUserIds,
      reason: "Verified auth-only deletion request.",
      actingAdminAuthUserId: "admin-auth-user",
      now: () => new Date("2026-08-02T00:01:00.000Z"),
      client,
      secret: SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
      buildGraphStatements: ({ graph: targetGraph, jobId, targetId }) =>
        deletionStatements(targetGraph, jobId, targetId),
    });
    assert.equal(result.status, "storage_pending");
    const counts = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM auth_users) AS auth_users,
        (SELECT COUNT(*) FROM product_activity_events) AS activity,
        (SELECT COUNT(*) FROM auth_identity_links) AS auth_links,
        (SELECT COUNT(*) FROM cookbook_recipes) AS cookbook,
        (SELECT COUNT(*) FROM credit_balances) AS balances,
        (SELECT COUNT(*) FROM account_deletion_storage_outbox) AS outbox
    `);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(counts.rows[0]).map(([key, value]) => [key, Number(value)]),
      ),
      {
        auth_users: 0,
        activity: 0,
        auth_links: 0,
        cookbook: 0,
        balances: 0,
        outbox: 1,
      },
    );
    const queued = await client.execute(
      "SELECT object_key, object_category, status FROM account_deletion_storage_outbox",
    );
    assert.deepEqual({ ...queued.rows[0] }, {
      object_key: "profile-photos/auth-only.webp",
      object_category: "profile_avatar",
      status: "pending",
    });

    const replay = await executeAccountDeletionJob({
      jobId: preview.jobId,
      fingerprint: preview.fingerprint,
      authUserIds: [],
      reason: "Verified auth-only deletion request.",
      actingAdminAuthUserId: "admin-auth-user",
      client,
      secret: SECRET,
      buildGraphStatements() {
        throw new Error("replay must not execute deletion statements");
      },
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, "storage_pending");
  } finally {
    client.close();
  }
});

test("auth-only preview becomes stale when its profile storage fact changes", async () => {
  const client = await createFixture();
  try {
    const previewPlan = await planAccountDeletion({ authUserIds: [AUTH_ID], client });
    const preview = await createAccountDeletionPreview({
      plan: previewPlan,
      reason: "Verified auth-only deletion request.",
      actingAdminAuthUserId: "admin-auth-user",
      requestId: "auth-only-stale",
      idempotencyKey: "auth-only-stale",
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      client,
      secret: SECRET,
    });
    await client.execute({
      sql: "UPDATE auth_users SET avatar_url = ? WHERE id = ?",
      args: [`${PUBLIC_BASE_URL}/profile-photos/changed.webp`, AUTH_ID],
    });
    const changedPlan = await planAccountDeletion({ authUserIds: [AUTH_ID], client });
    await assert.rejects(
      executeAccountDeletionJob({
        jobId: preview.jobId,
        fingerprint: preview.fingerprint,
        authUserIds: changedPlan.selectedAuthUserIds,
        reason: "Verified auth-only deletion request.",
        actingAdminAuthUserId: "admin-auth-user",
        now: () => new Date("2026-08-02T00:01:00.000Z"),
        client,
        secret: SECRET,
        publicBaseUrl: PUBLIC_BASE_URL,
        buildGraphStatements() {
          throw new Error("stale plan must not execute");
        },
      }),
      (error) =>
        error instanceof AccountDeletionJobError &&
        error.code === "stale_preview" &&
        error.statusCode === 409,
    );
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) AS count FROM auth_users")).rows[0].count),
      1,
    );
  } finally {
    client.close();
  }
});
