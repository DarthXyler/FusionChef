import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  buildAccountDeletionStorageOutboxStatements,
  collectAccountDeletionStorageObjects,
  processAccountDeletionStorageOutbox,
} from "./account-deletion-storage.ts";

const PUBLIC_BASE = "https://cdn.example.test";
const jobMigration = readFileSync(
  new URL(
    "../migrations/20260802_001_create_account_deletion_jobs.sql",
    import.meta.url,
  ),
  "utf8",
);
const outboxMigration = readFileSync(
  new URL(
    "../migrations/20260802_002_create_account_deletion_storage_outbox.sql",
    import.meta.url,
  ),
  "utf8",
);

function graph(storageReferences) {
  return {
    graphId: "account-graph:storage",
    status: "ready",
    blockers: [],
    selectedAuthUserIds: ["auth-storage"],
    ownerAuthUserIds: ["auth-storage"],
    unselectedOwnerAuthUserIds: [],
    identityNodes: ["11111111-1111-4111-8111-111111111111"],
    canonicalIdentityIds: ["11111111-1111-4111-8111-111111111111"],
    aliasEdges: [],
    deviceKeys: [],
    storageReferences,
    inventory: {},
  };
}

async function createFixture() {
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.executeMultiple(jobMigration);
  await client.executeMultiple(outboxMigration);
  await client.executeMultiple(`
    CREATE TABLE auth_users (
      id TEXT PRIMARY KEY,
      avatar_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE cookbook_recipes (
      row_id TEXT PRIMARY KEY,
      image_url TEXT
    );
    INSERT INTO account_deletion_jobs (
      job_id, request_id, request_source, acting_admin_ref, reason,
      preview_fingerprint, preview_expires_at, status, idempotency_key,
      approved_at, started_at
    ) VALUES (
      'job-storage', 'request-storage', 'admin_console', 'admin:v1:hash',
      'fixture',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '2026-08-02T01:00:00.000Z', 'storage_pending', 'storage-idempotency',
      '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
    );
    INSERT INTO account_deletion_job_targets (
      target_id, job_id, target_ref, graph_fingerprint, plan_json,
      status, started_at
    ) VALUES (
      'target-storage', 'job-storage', 'target:v1:storage',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '{}', 'storage_pending', '2026-08-02T00:00:00.000Z'
    );
  `);
  return client;
}

async function seedOutbox(client, key, category = "recipe_image", suffix = "one") {
  await client.execute({
    sql: `INSERT INTO account_deletion_storage_outbox (
            outbox_id, job_id, target_id, object_key, object_category,
            status
          ) VALUES (?, 'job-storage', 'target-storage', ?, ?, 'pending')`,
    args: [`outbox-${suffix}`, key, category],
  });
}

async function statusSnapshot(client) {
  const result = await client.execute(
    `SELECT
       (SELECT status FROM account_deletion_jobs WHERE job_id = 'job-storage') AS job_status,
       (SELECT status FROM account_deletion_job_targets WHERE target_id = 'target-storage') AS target_status,
       (SELECT status FROM account_deletion_storage_outbox LIMIT 1) AS outbox_status,
       (SELECT attempt_count FROM account_deletion_storage_outbox LIMIT 1) AS attempts,
       (SELECT last_safe_error FROM account_deletion_storage_outbox LIMIT 1) AS safe_error`,
  );
  return result.rows[0];
}

test("collector accepts only attributable app-owned recipe, avatar, and generated keys", () => {
  const objects = collectAccountDeletionStorageObjects({
    graph: graph([
      {
        category: "cookbook_image",
        value: `${PUBLIC_BASE}/recipe-images/recipe.webp`,
      },
      {
        category: "cookbook_image",
        value: `${PUBLIC_BASE}/fusion-images/generated.webp`,
      },
      {
        category: "profile_avatar",
        value: `${PUBLIC_BASE}/profile-photos/avatar.webp`,
      },
      {
        category: "cookbook_image",
        value: "https://external.example/image.webp",
      },
    ]),
    publicBaseUrl: PUBLIC_BASE,
  });
  assert.deepEqual(objects, [
    { key: "fusion-images/generated.webp", category: "generated_image" },
    { key: "profile-photos/avatar.webp", category: "profile_avatar" },
    { key: "recipe-images/recipe.webp", category: "recipe_image" },
  ]);
});

test("unattributable historical generated objects are not claimed", () => {
  const objects = collectAccountDeletionStorageObjects({
    graph: graph([]),
    publicBaseUrl: PUBLIC_BASE,
  });
  assert.deepEqual(objects, []);
  // A bucket-wide fusion-images object is deliberately absent because no
  // cookbook/profile ownership record attributed it to this graph.
});

test("outbox rows and reference deletion commit atomically", async () => {
  const client = await createFixture();
  try {
    await client.execute({
      sql: "INSERT INTO cookbook_recipes (row_id, image_url) VALUES ('recipe-target', ?)",
      args: [`${PUBLIC_BASE}/recipe-images/target.webp`],
    });
    const statements = buildAccountDeletionStorageOutboxStatements({
      graph: graph([
        {
          category: "cookbook_image",
          value: `${PUBLIC_BASE}/recipe-images/target.webp`,
        },
      ]),
      jobId: "job-storage",
      targetId: "target-storage",
      publicBaseUrl: PUBLIC_BASE,
    });
    await client.batch(
      [
        ...statements,
        { sql: "DELETE FROM cookbook_recipes WHERE row_id = 'recipe-target'" },
      ],
      "write",
    );
    const result = await client.execute(
      `SELECT
         (SELECT COUNT(*) FROM cookbook_recipes) AS recipe_count,
         (SELECT object_key FROM account_deletion_storage_outbox) AS object_key`,
    );
    assert.equal(Number(result.rows[0].recipe_count), 0);
    assert.equal(result.rows[0].object_key, "recipe-images/target.webp");
  } finally {
    client.close();
  }
});

test("successful and already-missing deletes complete storage and the job", async (t) => {
  await t.test("success", async () => {
    const client = await createFixture();
    try {
      await seedOutbox(client, "recipe-images/success.webp");
      const deleted = [];
      const result = await processAccountDeletionStorageOutbox({
        jobId: "job-storage",
        client,
        publicBaseUrl: PUBLIC_BASE,
        now: () => new Date("2026-08-02T00:10:00.000Z"),
        async deleteObject(key) {
          deleted.push(key);
        },
      });
      assert.deepEqual(deleted, ["recipe-images/success.webp"]);
      assert.equal(result.status, "completed");
      assert.deepEqual(
        { ...await statusSnapshot(client) },
        {
          job_status: "completed",
          target_status: "completed",
          outbox_status: "completed",
          attempts: 1,
          safe_error: null,
        },
      );
    } finally {
      client.close();
    }
  });

  await t.test("missing", async () => {
    const client = await createFixture();
    try {
      await seedOutbox(client, "profile-photos/missing.webp", "profile_avatar");
      const result = await processAccountDeletionStorageOutbox({
        jobId: "job-storage",
        client,
        publicBaseUrl: PUBLIC_BASE,
        async deleteObject() {
          const error = new Error("missing");
          error.name = "NoSuchKey";
          throw error;
        },
      });
      assert.equal(result.status, "completed");
      assert.equal((await statusSnapshot(client)).outbox_status, "completed");
    } finally {
      client.close();
    }
  });
});

test("temporary failure remains storage_pending and retry succeeds with safe errors", async () => {
  const client = await createFixture();
  try {
    await seedOutbox(client, "fusion-images/retry.webp", "generated_image");
    const first = await processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      now: () => new Date("2026-08-02T00:10:00.000Z"),
      async deleteObject() {
        throw new Error("secret-token personal@example.test provider receipt");
      },
    });
    assert.equal(first.status, "storage_pending");
    const failed = await statusSnapshot(client);
    assert.equal(failed.job_status, "storage_pending");
    assert.equal(failed.target_status, "storage_pending");
    assert.equal(failed.outbox_status, "failed_retryable");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.safe_error, "R2 deletion failed and can be retried.");

    const deleted = [];
    const retry = await processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      now: () => new Date("2026-08-02T00:11:00.000Z"),
      async deleteObject(key) {
        deleted.push(key);
      },
    });
    assert.equal(retry.status, "completed");
    assert.deepEqual(deleted, ["fusion-images/retry.webp"]);
    assert.equal((await statusSnapshot(client)).attempts, 2);
  } finally {
    client.close();
  }
});

test("object still referenced by another active row is protected for manual review", async () => {
  const client = await createFixture();
  try {
    const url = `${PUBLIC_BASE}/recipe-images/shared.webp`;
    await seedOutbox(client, "recipe-images/shared.webp");
    await client.execute({
      sql: "INSERT INTO cookbook_recipes (row_id, image_url) VALUES ('active-shared', ?)",
      args: [url],
    });
    let deleteCalls = 0;
    const result = await processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        deleteCalls += 1;
      },
    });
    assert.equal(result.status, "manual_review");
    assert.equal(deleteCalls, 0);
    const state = await statusSnapshot(client);
    assert.equal(state.job_status, "manual_review");
    assert.equal(state.target_status, "manual_review");
    assert.equal(state.outbox_status, "manual_review");
  } finally {
    client.close();
  }
});

test("duplicate worker execution does not repeat a completed delete", async () => {
  const client = await createFixture();
  try {
    await seedOutbox(client, "recipe-images/once.webp");
    let deleteCalls = 0;
    const workerOptions = {
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        deleteCalls += 1;
      },
    };
    await processAccountDeletionStorageOutbox(workerOptions);
    await processAccountDeletionStorageOutbox(workerOptions);
    assert.equal(deleteCalls, 1);
    assert.equal((await statusSnapshot(client)).attempts, 1);
  } finally {
    client.close();
  }
});

test("worker is private server orchestration, not a public deletion endpoint", () => {
  const apiFiles = [
    "../app/api/r2-delete/route.ts",
    "../app/api/r2-upload/route.ts",
  ];
  for (const file of apiFiles) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /processAccountDeletionStorageOutbox/);
    assert.doesNotMatch(source, /account_deletion_storage_outbox/);
  }
});
