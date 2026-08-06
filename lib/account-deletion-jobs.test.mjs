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
  getAccountDeletionJobStatus,
} from "./account-deletion-jobs.ts";

const migrationSql = readFileSync(
  new URL(
    "../migrations/20260802_001_create_account_deletion_jobs.sql",
    import.meta.url,
  ),
  "utf8",
);
const outboxMigrationSql = readFileSync(
  new URL(
    "../migrations/20260802_002_create_account_deletion_storage_outbox.sql",
    import.meta.url,
  ),
  "utf8",
);
const tombstoneMigrationSql = readFileSync(
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
const SECRET = "account-deletion-job-test-secret-at-least-32-bytes";
const PREVIEW_NOW = new Date("2026-08-02T00:00:00.000Z");
const EXECUTE_NOW = new Date("2026-08-02T00:05:00.000Z");

function createEphemeralClient() {
  const databasePath = path.join(
    tmpdir(),
    `ffc-account-deletion-jobs-${randomUUID()}.db`,
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

function inventory(overrides = {}) {
  return {
    authUsers: 1,
    identityLinks: 1,
    mobileDeviceLinks: 1,
    mobileAliases: 0,
    cookbookRecipes: 1,
    productActivityEvents: 1,
    creditBalanceRows: 1,
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
    creditLedgerEntries: 1,
    financialLedgerEntriesRetained: 1,
    operationalLedgerEntriesDeleted: 0,
    dailyUsageRows: 1,
    purchaseTransactionsPreserved: 1,
    purchaseLedgerLinks: 1,
    reconciliationActions: 0,
    priorDeletionEvents: 0,
    ...overrides,
  };
}

function graph(name, suffix) {
  const root = `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
  const uploadSuffix = suffix.repeat(8);
  return {
    graphId: `account-graph:${name}`,
    status: "ready",
    blockers: [],
    selectedAuthUserIds: [`auth-${name}`],
    ownerAuthUserIds: [`auth-${name}`],
    unselectedOwnerAuthUserIds: [],
    identityNodes: [root],
    canonicalIdentityIds: [root],
    aliasEdges: [],
    deviceKeys: [`device-${name}`],
    storageReferences: [
      {
        category: "cookbook_image",
        value: `https://cdn.example.test/recipe-images/${name}-1780000000000-${uploadSuffix}.webp`,
      },
      {
        category: "profile_avatar",
        value: `https://cdn.example.test/profile-photos/${name}-1780000000000-${uploadSuffix}.webp`,
      },
    ],
    mutableFactDigests: {
      authAndProfile: `auth-profile:v1:${name}`,
      identityGraph: `identity-graph:v1:${name}`,
      purchases: `purchases:v1:${name}`,
      purchaseLinksAndAudit: `purchase-links-audit:v1:${name}`,
      ledger: `ledger:v1:${name}`,
      reservations: `reservations:v1:${name}`,
      balancesAndUsage: `balances-usage:v1:${name}`,
      cookbookAndActivity: `cookbook-activity:v1:${name}`,
      storageReferences: `storage-references:v1:${name}`,
    },
    inventory: inventory(),
  };
}

function plan(graphNames = ["a"]) {
  const graphs = graphNames.map((name, index) =>
    graph(name, String(index + 1)),
  );
  return {
    selectedAuthUserIds: graphs.flatMap((item) => item.selectedAuthUserIds),
    missingAuthUserIds: [],
    graphs,
    targetGraphIds: Object.fromEntries(
      graphs.flatMap((item) =>
        item.selectedAuthUserIds.map((authUserId) => [authUserId, item.graphId]),
      ),
    ),
  };
}

async function createFixture(graphNames = ["a"]) {
  const client = createEphemeralClient();
  await client.execute("PRAGMA foreign_keys = ON");
  await client.executeMultiple(migrationSql);
  await client.executeMultiple(outboxMigrationSql);
  await client.executeMultiple(tombstoneMigrationSql);
  await client.executeMultiple(`
    CREATE TABLE domain_rows (
      row_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      stage TEXT NOT NULL
    );
    CREATE TABLE deletion_receipts (
      receipt_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL
    );
  `);
  for (const name of graphNames) {
    await client.execute({
      sql: "INSERT INTO domain_rows (row_id, graph_id, stage) VALUES (?, ?, 'live')",
      args: [`row-${name}`, `account-graph:${name}`],
    });
  }
  return client;
}

async function preview(client, currentPlan = plan(), overrides = {}) {
  return createAccountDeletionPreview({
    plan: currentPlan,
    reason: "Verified support deletion request.",
    actingAdminAuthUserId: "admin-auth-user",
    requestId: "request-1",
    idempotencyKey: "preview-idempotency-1",
    now: () => PREVIEW_NOW,
    previewTtlSeconds: 900,
    client,
    secret: SECRET,
    executionEnabled: true,
    ...overrides,
  });
}

function successfulStatements({ graph: currentGraph, targetId }) {
  return [
    {
      sql: "INSERT INTO deletion_receipts (receipt_id, graph_id) VALUES (?, ?)",
      args: [`receipt:${targetId}`, currentGraph.graphId],
    },
    {
      sql: "DELETE FROM domain_rows WHERE graph_id = ?",
      args: [currentGraph.graphId],
    },
  ];
}

async function execute(client, previewResult, currentPlan = plan(), overrides = {}) {
  return executeAccountDeletionJob({
    jobId: previewResult.jobId,
    fingerprint: previewResult.fingerprint,
    authUserIds: currentPlan.selectedAuthUserIds,
    replan: async () => currentPlan,
    reason: "Verified support deletion request.",
    actingAdminAuthUserId: "admin-auth-user",
    buildGraphStatements: successfulStatements,
    now: () => EXECUTE_NOW,
    client,
    secret: SECRET,
    tombstoneSecret: SECRET,
    executionEnabled: true,
    ...overrides,
  });
}

async function expectJobError(operation, code, statusCode) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof AccountDeletionJobError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test("unchanged preview executes once and duplicate execution returns a minimal replay", async () => {
  const client = await createFixture();
  try {
    const currentPlan = plan();
    const created = await preview(client, currentPlan);
    assert.equal(created.status, "previewed");
    const result = await execute(client, created, currentPlan);
    assert.deepEqual(
      { jobId: result.jobId, status: result.status, replayed: result.replayed },
      { jobId: created.jobId, status: "completed", replayed: false },
    );
    const replay = await execute(client, created, currentPlan, {
      buildGraphStatements() {
        throw new Error("completed target must not execute again");
      },
    });
    assert.equal(replay.replayed, true);
    assert.equal(
      Number(
        (
          await client.execute(
            "SELECT COUNT(*) AS count FROM deletion_receipts",
          )
        ).rows[0].count,
      ),
      1,
    );
  } finally {
    client.close();
  }
});

test("database completion with queued objects remains storage_pending", async () => {
  const client = await createFixture();
  try {
    const currentPlan = plan();
    const created = await preview(client, currentPlan);
    const result = await execute(client, created, currentPlan, {
      buildGraphStatements(context) {
        return [
          ...successfulStatements(context),
          {
            sql: `INSERT INTO account_deletion_storage_outbox (
                    outbox_id, job_id, target_id, object_key,
                    object_category, status
                  ) VALUES (?, ?, ?, ?, 'recipe_image', 'pending')`,
            args: [
              `outbox:${context.targetId}`,
              context.jobId,
              context.targetId,
              "recipe-images/job-pending.webp",
            ],
          },
        ];
      },
    });
    assert.equal(result.status, "storage_pending");
    const state = await client.execute(
      `SELECT
         (SELECT status FROM account_deletion_jobs) AS job_status,
         (SELECT status FROM account_deletion_job_targets) AS target_status,
         (SELECT status FROM account_deletion_storage_outbox) AS outbox_status`,
    );
    assert.deepEqual(
      { ...state.rows[0] },
      {
        job_status: "storage_pending",
        target_status: "storage_pending",
        outbox_status: "pending",
      },
    );
    const replay = await execute(client, created, { ...plan(), graphs: [] });
    assert.equal(replay.status, "storage_pending");
    assert.equal(replay.replayed, true);
  } finally {
    client.close();
  }
});

test("job status returns durable target and storage state only to the issuing admin", async () => {
  const client = await createFixture();
  try {
    const currentPlan = plan();
    const created = await preview(client, currentPlan);
    await execute(client, created, currentPlan, {
      buildGraphStatements(context) {
        return [
          ...successfulStatements(context),
          {
            sql: `INSERT INTO account_deletion_storage_outbox (
                    outbox_id, job_id, target_id, object_key,
                    object_category, status
                  ) VALUES (?, ?, ?, ?, 'recipe_image', 'pending')`,
            args: [
              `outbox:${context.targetId}`,
              context.jobId,
              context.targetId,
              "recipe-images/status-test.webp",
            ],
          },
        ];
      },
    });
    const status = await getAccountDeletionJobStatus({
      jobId: created.jobId,
      actingAdminAuthUserId: "admin-auth-user",
      client,
      secret: SECRET,
    });
    assert.equal(status.status, "storage_pending");
    assert.deepEqual(
      status.targets.map((target) => ({
        status: target.status,
        attemptCount: target.attemptCount,
      })),
      [{ status: "storage_pending", attemptCount: 1 }],
    );
    assert.deepEqual(status.storage, [
      { category: "recipe_image", status: "pending", count: 1 },
    ]);
    await expectJobError(
      getAccountDeletionJobStatus({
        jobId: created.jobId,
        actingAdminAuthUserId: "different-admin",
        client,
        secret: SECRET,
      }),
      "account_deletion_job_forbidden",
      403,
    );
  } finally {
    client.close();
  }
});

test("preview persistence is idempotent but conflicts on changed scope", async () => {
  const client = await createFixture();
  try {
    const first = await preview(client);
    const replay = await preview(client);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.replayed, true);
    const changed = plan();
    changed.graphs[0].inventory.cookbookRecipes += 1;
    await expectJobError(
      preview(client, changed),
      "account_deletion_idempotency_conflict",
      409,
    );
    const count = await client.execute(
      "SELECT COUNT(*) AS count FROM account_deletion_jobs",
    );
    assert.equal(Number(count.rows[0].count), 1);
  } finally {
    client.close();
  }
});

test("persisted plan hashes user, identity, device, and storage references", async () => {
  const client = await createFixture();
  try {
    const currentPlan = plan();
    await preview(client, currentPlan);
    const row = (
      await client.execute(
        "SELECT acting_admin_ref, plan_json FROM account_deletion_jobs",
      )
    ).rows[0];
    const persisted = `${row.acting_admin_ref} ${row.plan_json}`;
    for (const raw of [
      "admin-auth-user",
      "auth-a",
      currentPlan.graphs[0].identityNodes[0],
      "device-a",
      "https://cdn.example.test/recipe-images/a-1780000000000-11111111.webp",
      "https://cdn.example.test/profile-photos/a-1780000000000-11111111.webp",
    ]) {
      assert.ok(!persisted.includes(raw), raw);
    }
    assert.match(String(row.plan_json), /storageRefs/);
    assert.match(String(row.plan_json), /inventory/);
  } finally {
    client.close();
  }
});

test("job persistence hashes free-form reason and client idempotency key", async () => {
  const client = await createFixture();
  try {
    const sensitiveReason =
      "Delete Ada Lovelace ada@example.test profile after support verification.";
    const sensitiveIdempotencyKey = "support:ada@example.test:provider-token";
    const created = await preview(client, plan(), {
      reason: sensitiveReason,
      idempotencyKey: sensitiveIdempotencyKey,
    });
    const row = (
      await client.execute(
        "SELECT reason, idempotency_key, plan_json FROM account_deletion_jobs",
      )
    ).rows[0];
    const persisted = `${row.reason} ${row.idempotency_key} ${row.plan_json}`;
    assert.doesNotMatch(persisted, /Ada Lovelace|ada@example\.test|provider-token/);
    assert.match(String(row.reason), /^reason:v1:[0-9a-f]{64}$/);
    assert.match(
      String(row.idempotency_key),
      /^idempotency:v1:[0-9a-f]{64}$/,
    );
    const replay = await preview(client, plan(), {
      reason: sensitiveReason,
      idempotencyKey: sensitiveIdempotencyKey,
    });
    assert.equal(replay.jobId, created.jobId);
    assert.equal(replay.replayed, true);
    const result = await execute(client, created, plan(), {
      reason: sensitiveReason,
    });
    assert.equal(result.status, "completed");
  } finally {
    client.close();
  }
});

test("alias, row-count, purchase, R2 reference, and reason changes are stale previews", async (t) => {
  const mutations = [
    {
      name: "alias",
      mutate(currentPlan) {
        currentPlan.graphs[0].aliasEdges.push({
          anonUserId: "22222222-2222-4222-8222-222222222222",
          canonicalAnonUserId: currentPlan.graphs[0].identityNodes[0],
        });
      },
    },
    {
      name: "row count",
      mutate(currentPlan) {
        currentPlan.graphs[0].inventory.cookbookRecipes += 1;
      },
    },
    {
      name: "added purchase",
      mutate(currentPlan) {
        currentPlan.graphs[0].inventory.purchaseTransactionsPreserved += 1;
      },
    },
    {
      name: "R2 reference",
      mutate(currentPlan) {
        currentPlan.graphs[0].storageReferences[0].value += "-changed";
      },
    },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const client = await createFixture();
      try {
        const approved = plan();
        const created = await preview(client, approved);
        const changed = structuredClone(approved);
        mutation.mutate(changed);
        await expectJobError(
          execute(client, created, changed),
          "stale_preview",
          409,
        );
        const rows = await client.execute(
          "SELECT COUNT(*) AS count FROM domain_rows",
        );
        assert.equal(Number(rows.rows[0].count), 1);
      } finally {
        client.close();
      }
    });
  }

  await t.test("reason", async () => {
    const client = await createFixture();
    try {
      const approved = plan();
      const created = await preview(client, approved);
      await expectJobError(
        execute(client, created, approved, { reason: "Changed reason." }),
        "stale_preview",
        409,
      );
    } finally {
      client.close();
    }
  });
});

test("expired preview performs no destructive write", async () => {
  const client = await createFixture();
  try {
    const created = await preview(client);
    await expectJobError(
      execute(client, created, plan(), {
        now: () => new Date("2026-08-02T00:15:00.000Z"),
      }),
      "expired_preview",
      409,
    );
    const rows = await client.execute(
      "SELECT COUNT(*) AS count FROM domain_rows",
    );
    assert.equal(Number(rows.rows[0].count), 1);
  } finally {
    client.close();
  }
});

test("failure after each database stage rolls back and a retry succeeds without duplicate event", async (t) => {
  for (const failureIndex of [0, 1, 2]) {
    await t.test(`stage ${failureIndex}`, async () => {
      const client = await createFixture();
      try {
        const currentPlan = plan();
        const created = await preview(client, currentPlan);
        await expectJobError(
          execute(client, created, currentPlan, {
            buildGraphStatements(context) {
              const statements = successfulStatements(context);
              statements.splice(failureIndex, 0, {
                sql: "INSERT INTO missing_fault_table DEFAULT VALUES",
              });
              return statements;
            },
          }),
          "account_deletion_retryable_failure",
          503,
        );
        const beforeRetry = await client.execute(
          `SELECT
             (SELECT COUNT(*) FROM domain_rows) AS rows_count,
             (SELECT COUNT(*) FROM deletion_receipts) AS receipt_count`,
        );
        assert.equal(Number(beforeRetry.rows[0].rows_count), 1);
        assert.equal(Number(beforeRetry.rows[0].receipt_count), 0);
        const retried = await execute(client, created, currentPlan);
        assert.equal(retried.status, "completed");
        const afterRetry = await client.execute(
          `SELECT
             (SELECT COUNT(*) FROM domain_rows) AS rows_count,
             (SELECT COUNT(*) FROM deletion_receipts) AS receipt_count`,
        );
        assert.equal(Number(afterRetry.rows[0].rows_count), 0);
        assert.equal(Number(afterRetry.rows[0].receipt_count), 1);
      } finally {
        client.close();
      }
    });
  }
});

test("later target failure preserves completed graph and retry skips it", async () => {
  const client = await createFixture(["a", "b"]);
  try {
    const currentPlan = plan(["a", "b"]);
    const created = await preview(client, currentPlan);
    const firstRunGraphs = [];
    await expectJobError(
      execute(client, created, currentPlan, {
        buildGraphStatements(context) {
          firstRunGraphs.push(context.graph.graphId);
          const statements = successfulStatements(context);
          if (firstRunGraphs.length === 2) {
            statements.push({ sql: "INSERT INTO missing_fault_table DEFAULT VALUES" });
          }
          return statements;
        },
      }),
      "account_deletion_retryable_failure",
      503,
    );
    assert.equal(firstRunGraphs.length, 2);
    const statuses = await client.execute(
      `SELECT status, COUNT(*) AS count
       FROM account_deletion_job_targets GROUP BY status`,
    );
    assert.deepEqual(
      Object.fromEntries(
        statuses.rows.map((row) => [row.status, Number(row.count)]),
      ),
      { database_completed: 1, failed_retryable: 1 },
    );
    const failedGraphId = firstRunGraphs[1];
    const resumeGraphs = currentPlan.graphs.filter(
      (item) => item.graphId === failedGraphId,
    );
    const resumePlan = {
      selectedAuthUserIds: resumeGraphs.flatMap(
        (item) => item.selectedAuthUserIds,
      ),
      missingAuthUserIds: [],
      graphs: resumeGraphs,
      targetGraphIds: Object.fromEntries(
        resumeGraphs.flatMap((item) =>
          item.selectedAuthUserIds.map((authUserId) => [
            authUserId,
            item.graphId,
          ]),
        ),
      ),
    };
    const retryGraphs = [];
    await execute(client, created, resumePlan, {
      buildGraphStatements(context) {
        retryGraphs.push(context.graph.graphId);
        return successfulStatements(context);
      },
    });
    assert.equal(retryGraphs.length, 1);
    assert.equal(retryGraphs[0], failedGraphId);
    const final = await client.execute(
      `SELECT
         (SELECT COUNT(*) FROM domain_rows) AS rows_count,
         (SELECT COUNT(*) FROM deletion_receipts) AS receipt_count`,
    );
    assert.equal(Number(final.rows[0].rows_count), 0);
    assert.equal(Number(final.rows[0].receipt_count), 2);
  } finally {
    client.close();
  }
});

test("preview and execution state persistence failures fail closed", async (t) => {
  await t.test("preview batch", async () => {
    const client = await createFixture();
    try {
      const failingClient = {
        execute: client.execute.bind(client),
        batch() {
          throw new Error("injected preview persistence failure");
        },
      };
      await expectJobError(
        preview(failingClient),
        "account_deletion_job_unavailable",
        503,
      );
      const jobs = await client.execute(
        "SELECT COUNT(*) AS count FROM account_deletion_jobs",
      );
      assert.equal(Number(jobs.rows[0].count), 0);
    } finally {
      client.close();
    }
  });

  await t.test("execution start", async () => {
    const client = await createFixture();
    try {
      const created = await preview(client);
      const failingClient = {
        batch: client.batch.bind(client),
        execute(statement) {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (/UPDATE account_deletion_jobs\s+SET status = 'executing'/s.test(sql)) {
            throw new Error("injected execution persistence failure");
          }
          return client.execute(statement);
        },
      };
      await expectJobError(
        execute(failingClient, created),
        "account_deletion_job_unavailable",
        503,
      );
      const rows = await client.execute(
        "SELECT COUNT(*) AS count FROM domain_rows",
      );
      assert.equal(Number(rows.rows[0].count), 1);
    } finally {
      client.close();
    }
  });
});

test("route binds commit to job and fingerprint without generic deletion replay payloads", () => {
  const deletionBranch = routeSource.slice(
    routeSource.indexOf('if (operation === "account_delete")'),
    routeSource.indexOf("const payload = parseBatchPayload"),
  );
  assert.match(deletionBranch, /createAccountDeletionPreview/);
  assert.match(deletionBranch, /executeAccountDeletionJob/);
  assert.match(deletionBranch, /jobId: payload\.jobId/);
  assert.match(deletionBranch, /fingerprint: payload\.fingerprint/);
  assert.match(deletionBranch, /authUserIds: plan\.selectedAuthUserIds/);
  assert.doesNotMatch(deletionBranch, /currentPlan:/);
  assert.doesNotMatch(deletionBranch, /beginIdempotentRequest/);
  assert.doesNotMatch(deletionBranch, /completeIdempotentRequest/);
});
