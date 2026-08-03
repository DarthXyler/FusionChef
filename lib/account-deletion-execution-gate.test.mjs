import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  AccountDeletionJobError,
  assertAccountDeletionExecutionEnabled,
  createAccountDeletionPreview,
  executeAccountDeletionJob,
  isAccountDeletionExecutionEnabled,
} from "./account-deletion-jobs.ts";
import {
  buildDeletedIdentityTombstoneStatements,
  ensureDeletedIdentityTombstoneKey,
  filterDeletedIdentityCandidates,
  getDeletedIdentityWriteGuard,
} from "./deleted-identity-tombstones.ts";

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
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);
const jobsSource = readFileSync(
  new URL("./account-deletion-jobs.ts", import.meta.url),
  "utf8",
);
const tombstoneSource = readFileSync(
  new URL("./deleted-identity-tombstones.ts", import.meta.url),
  "utf8",
);
const rolloutRunbook = readFileSync(
  new URL("../docs/account-deletion-rollout-runbook.md", import.meta.url),
  "utf8",
);
const unrelatedApiSources = [
  "../app/api/auth/session/route.ts",
  "../app/api/auth/profile/route.ts",
  "../app/api/cookbook/route.ts",
  "../app/api/cookbook/[id]/route.ts",
  "../app/api/monetization/account/route.ts",
  "../app/api/monetization/purchases/verify/route.ts",
].map((relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8"),
);

const SECRET = "account-deletion-gate-test-secret-at-least-32-bytes";
const OLD_IDENTITY = "11111111-1111-4111-8111-111111111111";
const FRESH_IDENTITY = "22222222-2222-4222-8222-222222222222";
const PREVIEW_TIME = new Date("2026-08-02T00:00:00.000Z");
const EXECUTION_TIME = new Date("2026-08-02T00:01:00.000Z");

function inventory() {
  return {
    authUsers: 1,
    identityLinks: 1,
    mobileDeviceLinks: 0,
    mobileAliases: 0,
    cookbookRecipes: 1,
    productActivityEvents: 0,
    creditBalanceRows: 0,
    creditReservations: 0,
    creditReservationAmount: 0,
    activeCreditReservations: 0,
    activeCreditReservationAmount: 0,
    expiredCreditReservations: 0,
    expiredCreditReservationAmount: 0,
    finalizedCreditReservations: 0,
    finalizedCreditReservationAmount: 0,
    malformedCreditReservations: 0,
    malformedCreditReservationAmount: 0,
    creditLedgerEntries: 0,
    financialLedgerEntriesRetained: 0,
    operationalLedgerEntriesDeleted: 0,
    dailyUsageRows: 0,
    purchaseTransactionsPreserved: 0,
    purchaseLedgerLinks: 0,
    reconciliationActions: 0,
    priorDeletionEvents: 0,
  };
}

function plan() {
  const graph = {
    graphId: "account-graph:gate-test",
    status: "ready",
    blockers: [],
    selectedAuthUserIds: ["auth-gate-test"],
    ownerAuthUserIds: ["auth-gate-test"],
    unselectedOwnerAuthUserIds: [],
    identityNodes: [OLD_IDENTITY],
    canonicalIdentityIds: [OLD_IDENTITY],
    aliasEdges: [],
    deviceKeys: [],
    storageReferences: [],
    mutableFactDigests: {
      authAndProfile: "auth-profile:v1:gate",
      identityGraph: "identity-graph:v1:gate",
      purchases: "purchases:v1:gate",
      purchaseLinksAndAudit: "purchase-links-audit:v1:gate",
      ledger: "ledger:v1:gate",
      reservations: "reservations:v1:gate",
      balancesAndUsage: "balances-usage:v1:gate",
      cookbookAndActivity: "cookbook-activity:v1:gate",
      storageReferences: "storage-references:v1:gate",
    },
    inventory: inventory(),
  };
  return {
    selectedAuthUserIds: ["auth-gate-test"],
    missingAuthUserIds: [],
    graphs: [graph],
    targetGraphIds: { "auth-gate-test": graph.graphId },
  };
}

function createEphemeralClient() {
  const databasePath = path.join(
    tmpdir(),
    `ffc-account-deletion-gate-${randomUUID()}.db`,
  );
  const client = createClient({ url: `file:${databasePath.replace(/\\/g, "/")}` });
  const close = client.close.bind(client);
  client.close = () => {
    close();
    try {
      unlinkSync(databasePath);
    } catch {
      // libSQL may retain an ephemeral test file briefly on Windows.
    }
  };
  return client;
}

async function createFixture() {
  const client = createEphemeralClient();
  await client.execute("PRAGMA foreign_keys = ON");
  await client.executeMultiple(jobMigration);
  await client.executeMultiple(outboxMigration);
  await client.executeMultiple(tombstoneMigration);
  await client.executeMultiple(`
    CREATE TABLE domain_rows (
      row_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL
    );
    CREATE TABLE guarded_identity_writes (
      row_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE account_deletion_events (
      deletion_id TEXT PRIMARY KEY,
      auth_user_id TEXT NOT NULL
    );
    INSERT INTO domain_rows (row_id, graph_id)
    VALUES ('domain-gate', 'account-graph:gate-test');
  `);
  return client;
}

async function createPreview(client, executionEnabled) {
  return createAccountDeletionPreview({
    plan: plan(),
    reason: "Verified execution-gate test request.",
    actingAdminAuthUserId: "admin-gate-test",
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    now: () => PREVIEW_TIME,
    client,
    secret: SECRET,
    executionEnabled,
  });
}

async function snapshot(client) {
  const result = await client.execute(`
    SELECT
      (SELECT status FROM account_deletion_jobs LIMIT 1) AS job_status,
      (SELECT status FROM account_deletion_job_targets LIMIT 1) AS target_status,
      (SELECT COUNT(*) FROM domain_rows) AS domain_rows,
      (SELECT COUNT(*) FROM deleted_identity_tombstones) AS tombstones,
      (SELECT COUNT(*) FROM deleted_identity_tombstone_key_metadata) AS key_metadata,
      (SELECT COUNT(*) FROM account_deletion_storage_outbox) AS outbox,
      (SELECT COUNT(*) FROM account_deletion_events) AS audit_events
  `);
  return {
    jobStatus: String(result.rows[0].job_status),
    targetStatus: String(result.rows[0].target_status),
    domainRows: Number(result.rows[0].domain_rows),
    tombstones: Number(result.rows[0].tombstones),
    keyMetadata: Number(result.rows[0].key_metadata),
    outbox: Number(result.rows[0].outbox),
    auditEvents: Number(result.rows[0].audit_events),
  };
}

test("execution is enabled only by the explicit server value true", () => {
  const previous = process.env.ACCOUNT_DELETION_EXECUTION_ENABLED;
  try {
    delete process.env.ACCOUNT_DELETION_EXECUTION_ENABLED;
    assert.equal(isAccountDeletionExecutionEnabled(), false);
    for (const value of ["", "false", "TRUE", "1", "enabled"]) {
      process.env.ACCOUNT_DELETION_EXECUTION_ENABLED = value;
      assert.equal(isAccountDeletionExecutionEnabled(), false);
    }
    process.env.ACCOUNT_DELETION_EXECUTION_ENABLED = " true ";
    assert.equal(isAccountDeletionExecutionEnabled(), true);
    assert.throws(
      () => assertAccountDeletionExecutionEnabled(false),
      (error) =>
        error instanceof AccountDeletionJobError &&
        error.code === "account_deletion_execution_disabled" &&
        error.statusCode === 409,
    );
    assert.doesNotThrow(() => assertAccountDeletionExecutionEnabled(true));
  } finally {
    if (previous === undefined) {
      delete process.env.ACCOUNT_DELETION_EXECUTION_ENABLED;
    } else {
      process.env.ACCOUNT_DELETION_EXECUTION_ENABLED = previous;
    }
  }
});

test("preview remains available while execution is disabled", async () => {
  const client = await createFixture();
  try {
    const preview = await createPreview(client, false);
    assert.equal(preview.status, "previewed");
    const persisted = await client.execute(
      "SELECT plan_version, plan_json FROM account_deletion_jobs",
    );
    assert.equal(Number(persisted.rows[0].plan_version), 3);
    assert.equal(JSON.parse(String(persisted.rows[0].plan_json)).executionPolicy, "disabled");
  } finally {
    client.close();
  }
});

test("disabled execution fails before job, target, audit, tombstone, outbox, or product mutation", async () => {
  const client = await createFixture();
  try {
    const preview = await createPreview(client, false);
    const before = await snapshot(client);
    let replanCalls = 0;
    let buildCalls = 0;
    await assert.rejects(
      executeAccountDeletionJob({
        jobId: preview.jobId,
        fingerprint: preview.fingerprint,
        authUserIds: ["auth-gate-test"],
        reason: "Verified execution-gate test request.",
        actingAdminAuthUserId: "admin-gate-test",
        client,
        secret: SECRET,
        tombstoneSecret: SECRET,
        executionEnabled: false,
        async replan() {
          replanCalls += 1;
          return plan();
        },
        buildGraphStatements() {
          buildCalls += 1;
          return [{ sql: "DELETE FROM domain_rows", args: [] }];
        },
      }),
      (error) =>
        error instanceof AccountDeletionJobError &&
        error.code === "account_deletion_execution_disabled" &&
        error.statusCode === 409,
    );
    assert.equal(replanCalls, 0);
    assert.equal(buildCalls, 0);
    assert.deepEqual(await snapshot(client), before);
  } finally {
    client.close();
  }
});

test("explicitly enabled execution follows the normal protected transaction path", async () => {
  const client = await createFixture();
  try {
    const preview = await createPreview(client, true);
    const result = await executeAccountDeletionJob({
      jobId: preview.jobId,
      fingerprint: preview.fingerprint,
      authUserIds: ["auth-gate-test"],
      reason: "Verified execution-gate test request.",
      actingAdminAuthUserId: "admin-gate-test",
      now: () => EXECUTION_TIME,
      client,
      secret: SECRET,
      tombstoneSecret: SECRET,
      executionEnabled: true,
      replan: async () => plan(),
      buildGraphStatements: () => [
        {
          sql: "DELETE FROM domain_rows WHERE graph_id = ?",
          args: ["account-graph:gate-test"],
        },
      ],
    });
    assert.equal(result.status, "completed");
    const after = await snapshot(client);
    assert.equal(after.jobStatus, "completed");
    assert.equal(after.targetStatus, "completed");
    assert.equal(after.domainRows, 0);
    assert.equal(after.keyMetadata, 1);
  } finally {
    client.close();
  }
});

test("enabling execution invalidates a preview issued in disabled mode", async () => {
  const client = await createFixture();
  try {
    const preview = await createPreview(client, false);
    let buildCalls = 0;
    await assert.rejects(
      executeAccountDeletionJob({
        jobId: preview.jobId,
        fingerprint: preview.fingerprint,
        authUserIds: ["auth-gate-test"],
        reason: "Verified execution-gate test request.",
        actingAdminAuthUserId: "admin-gate-test",
        now: () => EXECUTION_TIME,
        client,
        secret: SECRET,
        tombstoneSecret: SECRET,
        executionEnabled: true,
        replan: async () => plan(),
        buildGraphStatements() {
          buildCalls += 1;
          return [{ sql: "DELETE FROM domain_rows", args: [] }];
        },
      }),
      (error) =>
        error instanceof AccountDeletionJobError &&
        error.code === "stale_preview" &&
        error.statusCode === 409,
    );
    assert.equal(buildCalls, 0);
    const after = await snapshot(client);
    assert.equal(after.jobStatus, "manual_review");
    assert.equal(after.targetStatus, "manual_review");
    assert.equal(after.domainRows, 1);
    assert.equal(after.tombstones, 0);
    assert.equal(after.keyMetadata, 0);
    assert.equal(after.outbox, 0);
    assert.equal(after.auditEvents, 0);
  } finally {
    client.close();
  }
});

test("tombstone filtering and write guards stay active in compatibility mode", async () => {
  const client = await createFixture();
  try {
    const preview = await createPreview(client, false);
    await ensureDeletedIdentityTombstoneKey({ client, secret: SECRET });
    await client.batch(
      buildDeletedIdentityTombstoneStatements({
        identityNodes: [OLD_IDENTITY],
        deletionJobId: preview.jobId,
        secret: SECRET,
      }),
      "write",
    );
    assert.deepEqual(
      await filterDeletedIdentityCandidates([OLD_IDENTITY, FRESH_IDENTITY], {
        client,
        secret: SECRET,
      }),
      [FRESH_IDENTITY],
    );
    const guard = getDeletedIdentityWriteGuard([OLD_IDENTITY], { secret: SECRET });
    const write = await client.execute({
      sql: `INSERT INTO guarded_identity_writes (row_id, canonical_anon_user_id)
            SELECT ?, ? WHERE ${guard.sql}`,
      args: ["blocked-write", OLD_IDENTITY, ...guard.args],
    });
    assert.equal(write.rowsAffected, 0);
  } finally {
    client.close();
  }
});

test("the gate is server-only and scoped away from tombstone consumers and unrelated APIs", () => {
  assert.match(jobsSource, /process\.env\.ACCOUNT_DELETION_EXECUTION_ENABLED/);
  assert.doesNotMatch(jobsSource, /NEXT_PUBLIC_ACCOUNT_DELETION_EXECUTION_ENABLED/);
  assert.doesNotMatch(tombstoneSource, /ACCOUNT_DELETION_EXECUTION_ENABLED/);
  for (const source of unrelatedApiSources) {
    assert.doesNotMatch(source, /ACCOUNT_DELETION_EXECUTION_ENABLED/);
  }
  const deletionBranch = routeSource.slice(
    routeSource.indexOf('if (operation === "account_delete")'),
    routeSource.indexOf("const admin = requireMonetizationAdmin", routeSource.indexOf('if (operation === "account_delete")')),
  );
  assert.ok(
    deletionBranch.indexOf("runAccountDeletionPreflight") <
      deletionBranch.indexOf("assertAccountDeletionExecutionEnabled"),
  );
  assert.ok(
    deletionBranch.indexOf("assertAccountDeletionDoesNotIncludeActor") <
      deletionBranch.indexOf("assertAccountDeletionExecutionEnabled"),
  );
  assert.ok(
    deletionBranch.indexOf("assertAccountDeletionExecutionEnabled") <
      deletionBranch.indexOf("executeAccountDeletionJob"),
  );
  assert.match(deletionBranch, /if \(payload\.mode === "dry_run"\)/);
});

test("the rollback runbook designates only tombstone-aware compatibility mode", () => {
  const first = rolloutRunbook.indexOf(
    "20260802_001_create_account_deletion_jobs.sql",
  );
  const second = rolloutRunbook.indexOf(
    "20260802_002_create_account_deletion_storage_outbox.sql",
  );
  const third = rolloutRunbook.indexOf(
    "20260802_003_create_deleted_identity_tombstones.sql",
  );
  assert.ok(first >= 0 && second > first && third > second);
  assert.match(rolloutRunbook, /ACCOUNT_DELETION_EXECUTION_ENABLED=false/);
  assert.match(rolloutRunbook, /ACCOUNT_DELETION_EXECUTION_ENABLED=true/);
  assert.match(rolloutRunbook, /same recorded tombstone-aware SHA/);
  assert.match(rolloutRunbook, /Never roll back to a tombstone-unaware build/);
  assert.match(rolloutRunbook, /Do not drop or reverse the tombstone/);
  assert.match(rolloutRunbook, /fresh preview after enablement/);
});
