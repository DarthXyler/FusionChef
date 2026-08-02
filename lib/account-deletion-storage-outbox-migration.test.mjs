import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";

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

async function createFixture() {
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.executeMultiple(jobMigration);
  return client;
}

async function seedJob(client, suffix = "one") {
  await client.execute({
    sql: `INSERT INTO account_deletion_jobs (
            job_id, request_id, request_source, acting_admin_ref, reason,
            preview_fingerprint, preview_expires_at, status, idempotency_key
          ) VALUES (?, ?, 'admin_console', 'admin:v1:hash', 'fixture', ?, ?,
                    'previewed', ?)`,
    args: [
      `job-${suffix}`,
      `request-${suffix}`,
      suffix.repeat(64).slice(0, 64),
      "2026-08-02T01:00:00.000Z",
      `idempotency-${suffix}`,
    ],
  });
  await client.execute({
    sql: `INSERT INTO account_deletion_job_targets (
            target_id, job_id, target_ref, graph_fingerprint,
            plan_json, status
          ) VALUES (?, ?, ?, ?, '{}', 'previewed')`,
    args: [
      `target-${suffix}`,
      `job-${suffix}`,
      `target:v1:${suffix}`,
      suffix.repeat(64).slice(0, 64),
    ],
  });
}

async function insertOutbox(client, overrides = {}) {
  const values = {
    outboxId: "outbox-1",
    jobId: "job-one",
    targetId: "target-one",
    key: "recipe-images/fixture.webp",
    category: "recipe_image",
    status: "pending",
    completedAt: null,
    ...overrides,
  };
  return client.execute({
    sql: `INSERT INTO account_deletion_storage_outbox (
            outbox_id, job_id, target_id, object_key, object_category,
            status, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      values.outboxId,
      values.jobId,
      values.targetId,
      values.key,
      values.category,
      values.status,
      values.completedAt,
    ],
  });
}

test("outbox migration is additive, idempotent, indexed, and has no backfill", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(outboxMigration);
    await client.executeMultiple(outboxMigration);
    const objects = await client.execute(
      "SELECT type, name FROM sqlite_master ORDER BY type, name",
    );
    const names = new Set(objects.rows.map((row) => row.name));
    for (const name of [
      "account_deletion_storage_outbox",
      "ux_account_deletion_targets_job_target",
      "idx_account_deletion_outbox_job_status",
      "idx_account_deletion_outbox_target_status",
      "idx_account_deletion_outbox_status_updated",
      "idx_account_deletion_outbox_created",
    ]) {
      assert.ok(names.has(name), name);
    }
    const count = await client.execute(
      "SELECT COUNT(*) AS count FROM account_deletion_storage_outbox",
    );
    assert.equal(Number(count.rows[0].count), 0);
  } finally {
    client.close();
  }
});

test("outbox accepts each attributable category and completion lifecycle", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(outboxMigration);
    await seedJob(client);
    await insertOutbox(client);
    await insertOutbox(client, {
      outboxId: "outbox-avatar",
      key: "profile-photos/fixture.webp",
      category: "profile_avatar",
    });
    await insertOutbox(client, {
      outboxId: "outbox-generated",
      key: "fusion-images/fixture.webp",
      category: "generated_image",
    });
    await client.execute(
      `UPDATE account_deletion_storage_outbox
       SET status = 'completed', completed_at = '2026-08-02T00:10:00.000Z'
       WHERE outbox_id = 'outbox-1'`,
    );
    const rows = await client.execute(
      `SELECT object_category, status, attempt_count
       FROM account_deletion_storage_outbox ORDER BY outbox_id`,
    );
    assert.equal(rows.rows.length, 3);
    assert.ok(rows.rows.some((row) => row.object_category === "recipe_image"));
    assert.ok(rows.rows.some((row) => row.object_category === "profile_avatar"));
    assert.ok(rows.rows.some((row) => row.object_category === "generated_image"));
  } finally {
    client.close();
  }
});

test("job/key uniqueness and exact job-target ownership are enforced", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(outboxMigration);
    await seedJob(client, "one");
    await seedJob(client, "two");
    await insertOutbox(client);
    await assert.rejects(
      insertOutbox(client, { outboxId: "outbox-duplicate" }),
      /UNIQUE constraint failed/,
    );
    await assert.rejects(
      insertOutbox(client, {
        outboxId: "outbox-cross-job",
        jobId: "job-two",
        targetId: "target-one",
        key: "recipe-images/cross.webp",
      }),
      /FOREIGN KEY constraint failed/,
    );
    await assert.rejects(
      insertOutbox(client, {
        outboxId: "outbox-missing-target",
        targetId: "target-missing",
        key: "recipe-images/missing.webp",
      }),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    client.close();
  }
});

test("unsafe keys, unknown categories, invalid states, and negative attempts fail closed", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(outboxMigration);
    await seedJob(client);
    for (const [index, key] of [
      "",
      "/absolute.webp",
      "https://cdn.example.test/image.webp",
      "../escape.webp",
      "folder/../escape.webp",
    ].entries()) {
      await assert.rejects(
        insertOutbox(client, { outboxId: `bad-key-${index}`, key }),
        /CHECK constraint failed/,
      );
    }
    await assert.rejects(
      insertOutbox(client, {
        outboxId: "bad-category",
        key: "recipe-images/category.webp",
        category: "historical_unattributed",
      }),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      insertOutbox(client, {
        outboxId: "bad-complete",
        key: "recipe-images/complete.webp",
        status: "completed",
        completedAt: null,
      }),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      client.execute({
        sql: `INSERT INTO account_deletion_storage_outbox (
                outbox_id, job_id, target_id, object_key, object_category,
                status, attempt_count
              ) VALUES (?, ?, ?, ?, 'recipe_image', 'pending', -1)`,
        args: [
          "bad-attempt",
          "job-one",
          "target-one",
          "recipe-images/attempt.webp",
        ],
      }),
      /CHECK constraint failed/,
    );
  } finally {
    client.close();
  }
});
