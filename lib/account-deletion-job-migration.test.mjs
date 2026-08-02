import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";

const migrationSql = readFileSync(
  new URL(
    "../migrations/20260802_001_create_account_deletion_jobs.sql",
    import.meta.url,
  ),
  "utf8",
);

async function createFixture() {
  const client = createClient({ url: "file::memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  return client;
}

async function insertJob(client, overrides = {}) {
  const values = {
    jobId: "job-1",
    requestId: "request-1",
    source: "admin_console",
    actor: "admin:v1:actor-hash",
    reason: "Verified account-deletion request.",
    fingerprint: "a".repeat(64),
    expiresAt: "2026-08-02T01:00:00.000Z",
    status: "previewed",
    idempotencyKey: "preview-request-1",
    completedAt: null,
    ...overrides,
  };
  return client.execute({
    sql: `INSERT INTO account_deletion_jobs (
            job_id, request_id, request_source, acting_admin_ref, reason,
            plan_json, preview_fingerprint, preview_expires_at, status,
            idempotency_key, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      values.jobId,
      values.requestId,
      values.source,
      values.actor,
      values.reason,
      '{"targetRefs":["target:v1:hash"]}',
      values.fingerprint,
      values.expiresAt,
      values.status,
      values.idempotencyKey,
      values.completedAt,
    ],
  });
}

test("migration is additive, idempotent, and creates required indexes", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(migrationSql);
    await client.executeMultiple(migrationSql);
    const objects = await client.execute(
      "SELECT type, name FROM sqlite_master ORDER BY type, name",
    );
    const names = new Set(objects.rows.map((row) => row.name));
    for (const name of [
      "account_deletion_jobs",
      "account_deletion_job_targets",
      "idx_account_deletion_jobs_status_updated",
      "idx_account_deletion_jobs_preview_expiration",
      "idx_account_deletion_jobs_created",
      "idx_account_deletion_targets_job_status",
      "idx_account_deletion_targets_status_updated",
    ]) {
      assert.ok(names.has(name), name);
    }
    assert.equal(
      Number(
        (
          await client.execute(
            "SELECT COUNT(*) AS count FROM account_deletion_jobs",
          )
        ).rows[0].count,
      ),
      0,
    );
  } finally {
    client.close();
  }
});

test("job stores durable plan state without dedicated profile PII columns", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(migrationSql);
    const columns = await client.execute("PRAGMA table_info('account_deletion_jobs')");
    const names = columns.rows.map((row) => String(row.name));
    assert.ok(names.includes("plan_json"));
    assert.ok(names.includes("acting_admin_ref"));
    assert.ok(names.includes("preview_fingerprint"));
    assert.ok(names.includes("preview_expires_at"));
    assert.ok(names.includes("attempt_count"));
    assert.ok(names.includes("last_error_code"));
    assert.ok(names.includes("last_error_summary"));
    assert.ok(!names.some((name) => /email|name|profile|avatar/i.test(name)));
    await insertJob(client);
    const row = (
      await client.execute(
        `SELECT status, attempt_count, approved_at, started_at, completed_at
         FROM account_deletion_jobs`,
      )
    ).rows[0];
    assert.deepEqual(
      { ...row },
      {
        status: "previewed",
        attempt_count: 0,
        approved_at: null,
        started_at: null,
        completed_at: null,
      },
    );
  } finally {
    client.close();
  }
});

test("job and target status, JSON, completion, and error constraints fail closed", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(migrationSql);
    await assert.rejects(
      insertJob(client, { status: "unknown" }),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      insertJob(client, { status: "completed", completedAt: null }),
      /CHECK constraint failed/,
    );
    await insertJob(client, {
      status: "completed",
      completedAt: "2026-08-02T00:30:00.000Z",
    });
    await assert.rejects(
      client.execute({
        sql: `INSERT INTO account_deletion_job_targets (
                target_id, job_id, target_ref, graph_fingerprint,
                plan_json, status, completed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "target-1",
          "job-1",
          "target:v1:hash",
          "b".repeat(64),
          "not-json",
          "previewed",
          null,
        ],
      }),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      client.execute({
        sql: `INSERT INTO account_deletion_job_targets (
                target_id, job_id, target_ref, graph_fingerprint,
                plan_json, status, completed_at
              ) VALUES (?, ?, ?, ?, '{}', 'completed', NULL)`,
        args: ["target-2", "job-1", "target:v1:two", "c".repeat(64)],
      }),
      /CHECK constraint failed/,
    );
  } finally {
    client.close();
  }
});

test("idempotency, per-job target, graph, and foreign-key constraints are stable", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(migrationSql);
    await insertJob(client);
    await assert.rejects(
      insertJob(client, {
        jobId: "job-duplicate",
        requestId: "request-duplicate",
      }),
      /UNIQUE constraint failed/,
    );
    await client.execute({
      sql: `INSERT INTO account_deletion_job_targets (
              target_id, job_id, target_ref, graph_fingerprint,
              plan_json, status
            ) VALUES (?, ?, ?, ?, '{}', 'previewed')`,
      args: ["target-1", "job-1", "target:v1:one", "b".repeat(64)],
    });
    await assert.rejects(
      client.execute({
        sql: `INSERT INTO account_deletion_job_targets (
                target_id, job_id, target_ref, graph_fingerprint,
                plan_json, status
              ) VALUES (?, ?, ?, ?, '{}', 'previewed')`,
        args: ["target-2", "job-1", "target:v1:one", "c".repeat(64)],
      }),
      /UNIQUE constraint failed/,
    );
    await assert.rejects(
      client.execute({
        sql: `INSERT INTO account_deletion_job_targets (
                target_id, job_id, target_ref, graph_fingerprint,
                plan_json, status
              ) VALUES (?, ?, ?, ?, '{}', 'previewed')`,
        args: ["target-3", "job-1", "target:v1:three", "b".repeat(64)],
      }),
      /UNIQUE constraint failed/,
    );
    await assert.rejects(
      client.execute({
        sql: `INSERT INTO account_deletion_job_targets (
                target_id, job_id, target_ref, graph_fingerprint,
                plan_json, status
              ) VALUES (?, ?, ?, ?, '{}', 'previewed')`,
        args: ["target-orphan", "missing-job", "target:v1:orphan", "d".repeat(64)],
      }),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    client.close();
  }
});
