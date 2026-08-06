import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  AccountDeletionJobError,
  createAccountDeletionPreview,
  executeAccountDeletionJob,
  fingerprintAccountDeletionPlan,
  getAccountDeletionJobStatus,
} from "./account-deletion-jobs.ts";
import { runAccountDeletionPreflight } from "./account-deletion-preflight.ts";
import { planAccountDeletion } from "./account-deletion-planner.ts";
import { assertAccountDeletionSchemaReady } from "./account-deletion-schema.ts";
import { AccountDeletionStorageError } from "./account-deletion-storage.ts";
import { resolveAdminUserIdentifierTargets } from "./admin-user-target-resolution.ts";

const AUTH_ID = "auth-fact-user";
const ROOT = "11111111-1111-4111-8111-111111111111";
const ALIAS = "22222222-2222-4222-8222-222222222222";
const SECRET = "mutable-fact-fixture-secret-at-least-32-bytes";
const PUBLIC_BASE_URL = "https://cdn.example.test";

function createEphemeralClient() {
  const databasePath = path.join(
    tmpdir(),
    `ffc-account-deletion-facts-${randomUUID()}.db`,
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
const REASON = "Verified mutable-fact deletion request.";
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

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, normalized_email TEXT NOT NULL,
    name TEXT NOT NULL, avatar_url TEXT NOT NULL, provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL, role TEXT NOT NULL,
    last_login_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE auth_identity_links (
    auth_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE mobile_identity_aliases (
    anon_user_id TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE mobile_identity_links (
    device_key TEXT PRIMARY KEY, canonical_anon_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE cookbook_recipes (
    row_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL, recipe_id TEXT NOT NULL,
    recipe_json TEXT NOT NULL, source_input_json TEXT NOT NULL, image_url TEXT,
    saved_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0, is_to_try INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL,
    activity_type TEXT NOT NULL, source_reference_id TEXT, occurred_at TEXT NOT NULL
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY, available_credits INTEGER NOT NULL,
    pending_credits INTEGER NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY, anon_user_id TEXT NOT NULL,
    action_kind TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
    reason TEXT NOT NULL, metadata_json TEXT NOT NULL, expires_at TEXT,
    idempotency_scope TEXT, idempotency_key TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
    granted_credits INTEGER NOT NULL, reversed_credits INTEGER NOT NULL,
    outstanding_reversal_credits INTEGER NOT NULL, risk_flags_json TEXT NOT NULL,
    payload_json TEXT NOT NULL, verified_at TEXT, revoked_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_transaction_id)
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY, auth_user_id TEXT,
    canonical_anon_user_id TEXT, email_hash TEXT, provider TEXT, role TEXT,
    requested_by TEXT, reason TEXT, counts_json TEXT,
    purchase_transactions_preserved INTEGER, idempotency_key TEXT,
    deleted_at TEXT
  );
`;

async function createFixture() {
  const client = createEphemeralClient();
  await client.executeMultiple(schema);
  await client.executeMultiple(purMigration);
  await client.executeMultiple(jobMigration);
  await client.executeMultiple(outboxMigration);
  await client.executeMultiple(tombstoneMigration);
  await client.executeMultiple(`
    INSERT INTO auth_users VALUES (
      '${AUTH_ID}', 'sensitive@example.test', 'sensitive@example.test',
      'Sensitive User', '${PUBLIC_BASE_URL}/profile-photos/private-avatar-1780000000000-deadbeef.webp',
      'google', 'provider-subject-private', 'user',
      '2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO auth_identity_links VALUES (
      '${AUTH_ID}', '${ROOT}', '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO mobile_identity_aliases VALUES
      ('${ROOT}', '${ROOT}', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('${ALIAS}', '${ROOT}', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    INSERT INTO mobile_identity_links VALUES (
      'private-device-key', '${ROOT}', '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO cookbook_recipes VALUES (
      'recipe-row', '${ALIAS}', 'recipe-id', '{"title":"Private Soup"}',
      '{"ingredients":["secret"]}',
      '${PUBLIC_BASE_URL}/recipe-images/private-recipe-1780000000000-cafebabe.webp',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z', 0, 0
    );
    INSERT INTO product_activity_events VALUES (
      'activity-row', '${AUTH_ID}', 'fusion_generation',
      'private-source-reference', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO credit_balances VALUES (
      '${ROOT}', 10, 2, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO credit_reservations VALUES (
      'reservation-row', '${ROOT}', 'fuse', 2, 'reserved', 'private reason',
      '{"private":true}', '2999-08-02T00:00:00.000Z', 'scope', 'private-key',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO credit_daily_usage VALUES (
      '${ROOT}', '2026-08-01', 'UTC', 1, 2,
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO credit_ledger_entries VALUES (
      'ledger-row', '${ROOT}', 'purchase_grant', 'purchase', 10, 10, 2,
      'reservation-row', 'purchase-credit-grant', 'google_play:private-txn',
      'purchase:sensitive@example.test', 'private ledger reason',
      '{"token":"private-ledger-token"}', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO credit_purchase_transactions VALUES (
      'purchase-row', 'google_play', 'private-txn', 'private-original-txn',
      '${ROOT}', 'credits.small', 'verified', 10, 0, 0, '[]',
      '{"token":"private-purchase-token"}', '2026-08-01T00:00:00.000Z',
      NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO credit_purchase_ledger_links (
      id, purchase_transaction_id, ledger_entry_id, link_kind
    ) VALUES ('purchase-link', 'purchase-row', 'ledger-row', 'base_grant');
  `);
  return client;
}

function plan(client) {
  return planAccountDeletion({
    authUserIds: [AUTH_ID],
    client,
    secret: SECRET,
    publicBaseUrl: PUBLIC_BASE_URL,
  });
}

async function snapshotProductCounts(client) {
  const result = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM auth_users) AS auth_users,
      (SELECT COUNT(*) FROM cookbook_recipes) AS cookbook,
      (SELECT COUNT(*) FROM product_activity_events) AS activity,
      (SELECT COUNT(*) FROM credit_purchase_transactions) AS purchases,
      (SELECT COUNT(*) FROM credit_ledger_entries) AS ledger,
      (SELECT COUNT(*) FROM credit_reservations) AS reservations,
      (SELECT COUNT(*) FROM credit_balances) AS balances
  `);
  return Object.fromEntries(
    Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]),
  );
}

test("production-generated storage keys pass preflight through durable preview status", async () => {
  const client = await createFixture();
  try {
    const profileKey = `profile-photos/${"a".repeat(48)}-1780000000000-deadbeef.webp`;
    const recipeKey = `recipe-images/${"b".repeat(48)}-1780000000000-cafebabe.webp`;
    await client.batch(
      [
        {
          sql: "UPDATE auth_users SET avatar_url = ? WHERE id = ?",
          args: [`${PUBLIC_BASE_URL}/${profileKey}`, AUTH_ID],
        },
        {
          sql: "UPDATE cookbook_recipes SET image_url = ? WHERE row_id = 'recipe-row'",
          args: [`${PUBLIC_BASE_URL}/${recipeKey}`],
        },
      ],
      "write",
    );
    const productCountsBefore = await snapshotProductCounts(client);
    const preflightOrder = [];
    const preflight = await runAccountDeletionPreflight({
      async verifySchema() {
        preflightOrder.push("schema");
        await assertAccountDeletionSchemaReady({ client });
      },
      async authorize() {
        preflightOrder.push("authorization");
        return { ok: true, context: { actorAuthUserId: "admin-auth-user" } };
      },
      async enforceRateLimit() {
        preflightOrder.push("rate_limit");
        return null;
      },
    });
    assert.equal(preflight.ok, true);
    assert.deepEqual(preflightOrder, ["schema", "authorization", "rate_limit"]);

    const resolutionRecord = {
      authUserId: AUTH_ID,
      normalizedEmail: "fixture@example.test",
      canonicalAnonUserId: ROOT,
    };
    const [resolved] = await resolveAdminUserIdentifierTargets({
      identifiers: [resolutionRecord.normalizedEmail],
      allowAuthOnly: true,
      async fetchUsers(column, values) {
        const key =
          column === "id"
            ? resolutionRecord.authUserId
            : column === "normalized_email"
              ? resolutionRecord.normalizedEmail
              : resolutionRecord.canonicalAnonUserId;
        return values.includes(key)
          ? new Map([[key, [resolutionRecord]]])
          : new Map();
      },
    });
    assert.equal(resolved.status, "ready");

    const previewPlan = await planAccountDeletion({
      authUserIds: [resolved.user.authUserId],
      client,
      secret: SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
      snapshot: new Date("2026-08-05T00:00:00.000Z"),
    });
    assert.deepEqual(previewPlan.graphs[0].storageReferences, [
      {
        category: "cookbook_image",
        value: `${PUBLIC_BASE_URL}/${recipeKey}`,
      },
      {
        category: "profile_avatar",
        value: `${PUBLIC_BASE_URL}/${profileKey}`,
      },
    ]);
    const preview = await createAccountDeletionPreview({
      plan: previewPlan,
      reason: "Verified preview-only deletion request.",
      actingAdminAuthUserId: preflight.context.actorAuthUserId,
      requestId: "production-key-preview",
      idempotencyKey: "production-key-preview",
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      client,
      secret: SECRET,
      executionEnabled: false,
    });
    const status = await getAccountDeletionJobStatus({
      jobId: preview.jobId,
      actingAdminAuthUserId: preflight.context.actorAuthUserId,
      client,
      secret: SECRET,
    });
    assert.equal(status.status, "previewed");
    assert.equal(status.targets.length, 1);
    assert.equal(status.targets[0].status, "previewed");
    assert.deepEqual(status.storage, []);
    assert.deepEqual(await snapshotProductCounts(client), productCountsBefore);

    const state = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM account_deletion_jobs) AS jobs,
        (SELECT COUNT(*) FROM account_deletion_job_targets) AS targets,
        (SELECT COUNT(*) FROM account_deletion_storage_outbox) AS outbox,
        (SELECT COUNT(*) FROM deleted_identity_tombstones) AS tombstones,
        (SELECT COUNT(*) FROM deleted_identity_tombstone_key_metadata) AS tombstone_keys,
        (SELECT COUNT(*) FROM account_deletion_events) AS deletion_events
    `);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(state.rows[0]).map(([key, value]) => [key, Number(value)]),
      ),
      {
        jobs: 1,
        targets: 1,
        outbox: 0,
        tombstones: 0,
        tombstone_keys: 0,
        deletion_events: 0,
      },
    );
  } finally {
    client.close();
  }
});

test("historical noncanonical storage references stop before preview persistence", async () => {
  const client = await createFixture();
  try {
    await client.execute({
      sql: "UPDATE cookbook_recipes SET image_url = ? WHERE row_id = 'recipe-row'",
      args: [`${PUBLIC_BASE_URL}/recipe-images/historical-short.webp`],
    });
    const productCountsBefore = await snapshotProductCounts(client);
    await assert.rejects(
      planAccountDeletion({
        authUserIds: [AUTH_ID],
        client,
        secret: SECRET,
        publicBaseUrl: PUBLIC_BASE_URL,
        snapshot: new Date("2026-08-05T00:00:00.000Z"),
      }),
      (error) =>
        error instanceof AccountDeletionStorageError &&
        error.code === "storage_reference_invalid" &&
        !error.message.includes("historical-short"),
    );
    assert.deepEqual(await snapshotProductCounts(client), productCountsBefore);
    const state = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM account_deletion_jobs) AS jobs,
        (SELECT COUNT(*) FROM account_deletion_job_targets) AS targets,
        (SELECT COUNT(*) FROM account_deletion_storage_outbox) AS outbox,
        (SELECT COUNT(*) FROM deleted_identity_tombstones) AS tombstones,
        (SELECT COUNT(*) FROM deleted_identity_tombstone_key_metadata) AS tombstone_keys,
        (SELECT COUNT(*) FROM account_deletion_events) AS deletion_events
    `);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(state.rows[0]).map(([key, value]) => [key, Number(value)]),
      ),
      {
        jobs: 0,
        targets: 0,
        outbox: 0,
        tombstones: 0,
        tombstone_keys: 0,
        deletion_events: 0,
      },
    );
  } finally {
    client.close();
  }
});

const sameCountMutations = [
  ["purchase status", "UPDATE credit_purchase_transactions SET status = 'revoked' WHERE row_id = 'purchase-row'"],
  ["purchase granted amount", "UPDATE credit_purchase_transactions SET granted_credits = 11 WHERE row_id = 'purchase-row'"],
  ["purchase refund state", "UPDATE credit_purchase_transactions SET reversed_credits = 1, revoked_at = '2026-08-02T00:00:00.000Z' WHERE row_id = 'purchase-row'"],
  ["purchase timestamp", "UPDATE credit_purchase_transactions SET updated_at = '2026-08-02T00:00:00.000Z' WHERE row_id = 'purchase-row'"],
  ["purchase-to-ledger link", "UPDATE credit_purchase_ledger_links SET link_kind = 'reversal' WHERE id = 'purchase-link'"],
  ["financial ledger amount", "UPDATE credit_ledger_entries SET amount = 11 WHERE entry_id = 'ledger-row'"],
  ["ledger operation", "UPDATE credit_ledger_entries SET event_type = 'purchase_adjustment' WHERE entry_id = 'ledger-row'"],
  ["reservation status", "UPDATE credit_reservations SET status = 'released' WHERE reservation_id = 'reservation-row'"],
  ["reservation expiry", "UPDATE credit_reservations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE reservation_id = 'reservation-row'"],
  ["balance value", "UPDATE credit_balances SET available_credits = 11 WHERE anon_user_id = '11111111-1111-4111-8111-111111111111'"],
  ["daily usage value", "UPDATE credit_daily_usage SET fuse_count = 2 WHERE anon_user_id = '11111111-1111-4111-8111-111111111111'"],
  ["auth role", "UPDATE auth_users SET role = 'admin' WHERE id = 'auth-fact-user'"],
  ["auth provider", "UPDATE auth_users SET provider = 'apple' WHERE id = 'auth-fact-user'"],
  ["identity link state", "UPDATE auth_identity_links SET updated_at = '2026-08-02T00:00:00.000Z' WHERE auth_user_id = 'auth-fact-user'"],
  ["cookbook content", "UPDATE cookbook_recipes SET recipe_json = '{\"title\":\"Changed\"}' WHERE row_id = 'recipe-row'"],
  ["cookbook updated timestamp", "UPDATE cookbook_recipes SET updated_at = '2026-08-02T00:00:00.000Z' WHERE row_id = 'recipe-row'"],
  ["cookbook image reference", "UPDATE cookbook_recipes SET image_url = 'https://cdn.example.test/recipe-images/changed-1780000000000-feedface.webp' WHERE row_id = 'recipe-row'"],
  ["product activity type", "UPDATE product_activity_events SET activity_type = 'reroll' WHERE event_id = 'activity-row'"],
  ["product activity timestamp", "UPDATE product_activity_events SET occurred_at = '2026-08-02T00:00:00.000Z' WHERE event_id = 'activity-row'"],
  ["device mapping", "UPDATE mobile_identity_links SET device_key = 'changed-device-key' WHERE device_key = 'private-device-key'"],
  ["R2 profile reference", "UPDATE auth_users SET avatar_url = 'https://cdn.example.test/profile-photos/changed-1780000000000-feedface.webp' WHERE id = 'auth-fact-user'"],
];

test("same-count mutable fact changes reject execution before destructive writes", async (t) => {
  for (const [name, mutation] of sameCountMutations) {
    await t.test(name, async () => {
      const client = await createFixture();
      try {
        const previewPlan = await plan(client);
        const preview = await createAccountDeletionPreview({
          plan: previewPlan,
          reason: REASON,
          actingAdminAuthUserId: "admin-user",
          requestId: `request-${name}`,
          idempotencyKey: `idempotency-${name}`,
          now: () => new Date("2026-08-02T00:00:00.000Z"),
          client,
          secret: SECRET,
          executionEnabled: true,
        });
        await client.execute(mutation);
        const countsAfterMutation = await snapshotProductCounts(client);
        const currentPlan = await plan(client);
        assert.notDeepEqual(
          currentPlan.graphs[0].mutableFactDigests,
          previewPlan.graphs[0].mutableFactDigests,
        );
        let buildCalls = 0;
        await assert.rejects(
          executeAccountDeletionJob({
            jobId: preview.jobId,
            fingerprint: preview.fingerprint,
            authUserIds: currentPlan.selectedAuthUserIds,
            reason: REASON,
            actingAdminAuthUserId: "admin-user",
            now: () => new Date("2026-08-02T00:01:00.000Z"),
            client,
            secret: SECRET,
            publicBaseUrl: PUBLIC_BASE_URL,
            tombstoneSecret: SECRET,
            executionEnabled: true,
            buildGraphStatements() {
              buildCalls += 1;
              return [{ sql: "DELETE FROM auth_users", args: [] }];
            },
          }),
          (error) =>
            error instanceof AccountDeletionJobError &&
            error.code === "stale_preview" &&
            error.statusCode === 409,
        );
        assert.equal(buildCalls, 0);
        assert.deepEqual(await snapshotProductCounts(client), countsAfterMutation);
        const job = await client.execute(
          "SELECT status, last_error_code FROM account_deletion_jobs",
        );
        assert.deepEqual({ ...job.rows[0] }, {
          status: "manual_review",
          last_error_code: "stale_preview",
        });
      } finally {
        client.close();
      }
    });
  }
});

test("unchanged facts and reversed database row ordering keep deterministic digests", async () => {
  const client = await createFixture();
  try {
    const first = await plan(client);
    const second = await plan(client);
    assert.deepEqual(first.graphs[0].mutableFactDigests, second.graphs[0].mutableFactDigests);
    assert.equal(
      fingerprintAccountDeletionPlan({ plan: first, reason: REASON, secret: SECRET }),
      fingerprintAccountDeletionPlan({ plan: second, reason: REASON, secret: SECRET }),
    );
    const reversedClient = {
      async execute(statement) {
        const result = await client.execute(statement);
        return { ...result, rows: [...result.rows].reverse() };
      },
    };
    const reversed = await planAccountDeletion({
      authUserIds: [AUTH_ID],
      client: reversedClient,
      secret: SECRET,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    assert.deepEqual(first.graphs[0].mutableFactDigests, reversed.graphs[0].mutableFactDigests);
  } finally {
    client.close();
  }
});

test("persisted fact snapshots expose no raw private values", async () => {
  const client = await createFixture();
  try {
    const currentPlan = await plan(client);
    await createAccountDeletionPreview({
      plan: currentPlan,
      reason: REASON,
      actingAdminAuthUserId: "admin-user",
      requestId: "privacy-request",
      idempotencyKey: "privacy-idempotency",
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      client,
      secret: SECRET,
    });
    const persisted = await client.execute(`
      SELECT plan_json FROM account_deletion_jobs
      UNION ALL
      SELECT plan_json FROM account_deletion_job_targets
    `);
    const text = persisted.rows.map((row) => String(row.plan_json)).join("\n");
    for (const privateValue of [
      "sensitive@example.test",
      "private-purchase-token",
      "private-ledger-token",
      "provider-subject-private",
      "private-device-key",
      "private-avatar.webp",
      "private-recipe.webp",
      "private reason",
      REASON,
    ]) {
      assert.ok(!text.includes(privateValue), privateValue);
    }
    assert.match(text, /mutableFactDigests/);
    assert.match(text, /auth-profile:v1:[0-9a-f]{64}/);
  } finally {
    client.close();
  }
});
