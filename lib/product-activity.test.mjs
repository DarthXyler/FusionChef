import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import {
  getLatestProductActivityForUser,
  listProductActivityForUser,
  recordCookbookSaveActivitySafely,
  recordSuccessfulGenerationActivitySafely,
  recordVerifiedPurchaseActivitySafely,
} from "./product-activity.ts";

const databasePath = path.join(
  tmpdir(),
  `flavor-fusion-product-activity-${process.pid}.db`,
);
process.env.TURSO_DATABASE_URL = pathToFileURL(databasePath).href;
process.env.TURSO_AUTH_TOKEN = "local-product-activity-test";

const { executeTurso, getTursoClient } = await import("./turso.ts");

async function createAuthUser(userId) {
  await executeTurso({
    sql: "INSERT INTO auth_users (id) VALUES (?)",
    args: [userId],
  });
}

before(async () => {
  await rm(databasePath, { force: true });
  await executeTurso("PRAGMA foreign_keys = ON");
  await executeTurso("CREATE TABLE auth_users (id TEXT PRIMARY KEY)");
  const migration = await readFile(
    new URL(
      "../migrations/20260729_001_create_product_activity_events.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await getTursoClient().executeMultiple(migration);
});

after(async () => {
  getTursoClient().close();
  await rm(databasePath, { force: true });
});

test("successful fusion is durable independently of monetization mode", async () => {
  const userId = "fusion-modes-user";
  await createAuthUser(userId);

  const offMode = await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "fuse",
    requestId: "fusion-while-off",
  });
  const enabledMode = await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "fuse",
    requestId: "fusion-while-enabled",
  });

  assert.equal(offMode.status, "recorded");
  assert.equal(enabledMode.status, "recorded");
  const events = await listProductActivityForUser(userId);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.activityType === "fusion_generation"));
  assert.ok(events.every((event) => Number.isFinite(Date.parse(event.occurredAt))));
});

test("failed fusion records nothing", async () => {
  const userId = "failed-fusion-user";
  await createAuthUser(userId);

  const result = await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "fuse",
    requestId: "failed-fusion",
    succeeded: false,
  });

  assert.deepEqual(result, { status: "skipped", reason: "unsuccessful" });
  assert.deepEqual(await listProductActivityForUser(userId), []);
});

test("successful reroll is recorded and separate requests are not suppressed", async () => {
  const userId = "reroll-user";
  await createAuthUser(userId);

  await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "reroll",
    requestId: "reroll-1",
  });
  await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "reroll",
    requestId: "reroll-2",
  });

  const events = await listProductActivityForUser(userId);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.activityType === "reroll"));
});

test("cookbook save history survives recipe deletion", async () => {
  const userId = "cookbook-user";
  await createAuthUser(userId);
  await executeTurso(
    "CREATE TABLE IF NOT EXISTS cookbook_recipes (row_id TEXT PRIMARY KEY, auth_user_id TEXT)",
  );
  await executeTurso({
    sql: "INSERT INTO cookbook_recipes (row_id, auth_user_id) VALUES (?, ?)",
    args: ["recipe-row", userId],
  });

  const recorded = await recordCookbookSaveActivitySafely({
    authUserId: userId,
    idempotencyKey: "cookbook-save-request",
  });
  await executeTurso({
    sql: "DELETE FROM cookbook_recipes WHERE row_id = ?",
    args: ["recipe-row"],
  });

  assert.equal(recorded.status, "recorded");
  const events = await listProductActivityForUser(userId);
  assert.equal(events.length, 1);
  assert.equal(events[0].activityType, "cookbook_save");
  assert.doesNotMatch(events[0].sourceReferenceId, /cookbook-save-request/);
});

test("failed cookbook save records nothing", async () => {
  const userId = "failed-cookbook-user";
  await createAuthUser(userId);

  const result = await recordCookbookSaveActivitySafely({
    authUserId: userId,
    idempotencyKey: "failed-cookbook-save",
    succeeded: false,
  });

  assert.deepEqual(result, { status: "skipped", reason: "unsuccessful" });
  assert.deepEqual(await listProductActivityForUser(userId), []);
});

test("verified purchase records once while unverified purchase records nothing", async () => {
  const userId = "purchase-user";
  await createAuthUser(userId);

  const unverified = await recordVerifiedPurchaseActivitySafely({
    authUserId: userId,
    provider: "apple_app_store",
    providerTransactionId: "unverified-transaction",
    verifiedAt: null,
  });
  const first = await recordVerifiedPurchaseActivitySafely({
    authUserId: userId,
    provider: "apple_app_store",
    providerTransactionId: "verified-transaction",
    verifiedAt: "2026-07-29T00:00:00.000Z",
  });
  const retry = await recordVerifiedPurchaseActivitySafely({
    authUserId: userId,
    provider: "apple_app_store",
    providerTransactionId: "verified-transaction",
    verifiedAt: "2026-07-29T00:00:00.000Z",
  });

  assert.deepEqual(unverified, { status: "skipped", reason: "unverified" });
  assert.equal(first.status, "recorded");
  assert.equal(retry.status, "duplicate");
  const events = await listProductActivityForUser(userId);
  assert.equal(events.length, 1);
  assert.equal(events[0].activityType, "credit_purchase");
  assert.doesNotMatch(events[0].sourceReferenceId, /verified-transaction/);
});

test("guest activity is not attached to an authenticated user", async () => {
  const result = await recordSuccessfulGenerationActivitySafely({
    authUserId: null,
    actionKind: "fuse",
    requestId: "guest-fusion",
  });

  assert.deepEqual(result, { status: "skipped", reason: "guest" });
});

test("retries deduplicate reliable references and latest activity is queryable", async () => {
  const userId = "retry-user";
  await createAuthUser(userId);

  const first = await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "fuse",
    requestId: "stable-request-id",
  });
  const retry = await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "fuse",
    requestId: "stable-request-id",
  });

  assert.equal(first.status, "recorded");
  assert.equal(retry.status, "duplicate");
  assert.equal((await listProductActivityForUser(userId)).length, 1);
  assert.equal(
    (await getLatestProductActivityForUser(userId))?.activityType,
    "fusion_generation",
  );
});

test("auth-user deletion cascades to product activity history", async () => {
  const userId = "deleted-user";
  await createAuthUser(userId);
  await recordSuccessfulGenerationActivitySafely({
    authUserId: userId,
    actionKind: "fuse",
    requestId: "before-account-deletion",
  });

  await executeTurso({
    sql: "DELETE FROM auth_users WHERE id = ?",
    args: [userId],
  });
  const remaining = await executeTurso({
    sql: "SELECT COUNT(*) AS count FROM product_activity_events WHERE auth_user_id = ?",
    args: [userId],
  });
  assert.equal(Number(remaining.rows[0]?.count ?? -1), 0);
});

test("activity-write failure never throws into the successful product action", async () => {
  const userId = "write-failure-user";
  await createAuthUser(userId);
  await executeTurso("DROP TABLE product_activity_events");

  const originalWarn = console.warn;
  const diagnostics = [];
  console.warn = (...args) => diagnostics.push(args.join(" "));
  try {
    const successfulResponse = { recipe: "still returned" };
    const result = await recordSuccessfulGenerationActivitySafely({
      authUserId: userId,
      actionKind: "fuse",
      requestId: "write-failure-request",
    });
    assert.deepEqual(successfulResponse, { recipe: "still returned" });
    assert.equal(result.status, "failed");
    assert.equal(diagnostics.length, 1);
    assert.doesNotMatch(diagnostics[0], new RegExp(userId));
  } finally {
    console.warn = originalWarn;
  }
});
