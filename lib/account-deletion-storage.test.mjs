import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  AccountDeletionStorageError,
  buildAccountDeletionStorageOutboxStatements,
  collectAccountDeletionStorageObjects,
  processAccountDeletionStorageOutbox,
} from "./account-deletion-storage.ts";
import { updateAuthUserProfile, upsertOAuthUser } from "./auth-users.ts";
import { upsertCookbookRecord } from "./cookbook-db.ts";
import { StorageReferenceClaimError } from "./storage-reference-claims.ts";

const PUBLIC_BASE = "https://cdn.example.test";
const PRODUCTION_TIMESTAMP = "1780000000000";

function productionKey(prefix, slug, uuidPrefix = "deadbeef") {
  return `${prefix}/${slug}-${PRODUCTION_TIMESTAMP}-${uuidPrefix}.webp`;
}
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
      email TEXT NOT NULL DEFAULT '',
      normalized_email TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'google',
      provider_subject TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      last_login_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE(provider, provider_subject)
    );
    CREATE TABLE cookbook_recipes (
      row_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL DEFAULT '',
      recipe_id TEXT NOT NULL DEFAULT '',
      recipe_json TEXT NOT NULL DEFAULT '{}',
      source_input_json TEXT NOT NULL DEFAULT '{}',
      image_url TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_to_try INTEGER NOT NULL DEFAULT 0,
      saved_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      UNIQUE(anon_user_id, recipe_id)
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

function cookbookRecord(recipeId, imageUrl) {
  return {
    recipe: { id: recipeId, title: recipeId, imageUrl },
    sourceInput: { baseRecipe: "fixture" },
    savedAt: "2026-08-02T00:00:00.000Z",
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
  const recipeKey = productionKey("recipe-images", "recipe");
  const generatedKey = productionKey("fusion-images", "generated", "cafebabe");
  const profileKey = productionKey("profile-photos", "avatar", "feedface");
  const objects = collectAccountDeletionStorageObjects({
    graph: graph([
      {
        category: "cookbook_image",
        value: `${PUBLIC_BASE}/${recipeKey}`,
      },
      {
        category: "cookbook_image",
        value: `${PUBLIC_BASE}/${generatedKey}`,
      },
      {
        category: "profile_avatar",
        value: `${PUBLIC_BASE}/${profileKey}`,
      },
      {
        category: "cookbook_image",
        value: "https://external.example/image.webp",
      },
    ]),
    publicBaseUrl: PUBLIC_BASE,
  });
  assert.deepEqual(objects, [
    { key: generatedKey, category: "generated_image" },
    { key: profileKey, category: "profile_avatar" },
    { key: recipeKey, category: "recipe_image" },
  ]);
});

test("collector accepts exact app-generated keys at the production slug boundaries", () => {
  const cases = [
    ["recipe-images", "cookbook_image", "recipe_image"],
    ["fusion-images", "cookbook_image", "generated_image"],
    ["profile-photos", "profile_avatar", "profile_avatar"],
  ];
  for (const [prefix, sourceCategory, objectCategory] of cases) {
    for (const slugLength of [25, 26, 48]) {
      const key = `${prefix}/${"a".repeat(slugLength)}-1780000000000-deadbeef.webp`;
      assert.deepEqual(
        collectAccountDeletionStorageObjects({
          graph: graph([
            {
              category: sourceCategory,
              value: `${PUBLIC_BASE}/${key}`,
            },
          ]),
          publicBaseUrl: PUBLIC_BASE,
        }),
        [{ key, category: objectCategory }],
      );
    }
  }
  const truncatedAtSeparator = `recipe-images/${"a".repeat(47)}--1780000000000-deadbeef.webp`;
  assert.deepEqual(
    collectAccountDeletionStorageObjects({
      graph: graph([
        {
          category: "cookbook_image",
          value: `${PUBLIC_BASE}/${truncatedAtSeparator}`,
        },
      ]),
      publicBaseUrl: PUBLIC_BASE,
    }),
    [{ key: truncatedAtSeparator, category: "recipe_image" }],
  );

  const overlongSlug = `recipe-images/${"a".repeat(49)}-1780000000000-deadbeef.webp`;
  assert.throws(
    () =>
      collectAccountDeletionStorageObjects({
        graph: graph([
          {
            category: "cookbook_image",
            value: `${PUBLIC_BASE}/${overlongSlug}`,
          },
        ]),
        publicBaseUrl: PUBLIC_BASE,
      }),
    (error) =>
      error instanceof AccountDeletionStorageError &&
      error.code === "storage_reference_sensitive",
  );
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

test("sensitive or token-like object keys fail before outbox persistence", () => {
  for (const key of [
    "recipe-images/personal@example.test.webp",
    "profile-photos/provider-payload-secret.webp",
    `fusion-images/${"a".repeat(60)}.webp`,
  ]) {
    assert.throws(
      () =>
        buildAccountDeletionStorageOutboxStatements({
          graph: graph([
            {
              category: key.startsWith("profile-photos/")
                ? "profile_avatar"
                : "cookbook_image",
              value: `${PUBLIC_BASE}/${key}`,
            },
          ]),
          jobId: "job-storage",
          targetId: "target-storage",
          publicBaseUrl: PUBLIC_BASE,
        }),
      (error) => {
        assert.ok(error instanceof AccountDeletionStorageError);
        assert.equal(error.code, "storage_reference_sensitive");
        assert.doesNotMatch(error.message, /personal@example|provider-payload/);
        return true;
      },
    );
  }
});

test("production-shaped keys do not bypass email or prohibited-keyword rejection", () => {
  for (const key of [
    "recipe-images/personal@example.test-1780000000000-deadbeef.webp",
    "recipe-images/provider-payload-secret-1780000000000-deadbeef.webp",
    "fusion-images/purchase-token-secret-1780000000000-deadbeef.webp",
    "profile-photos/oauth-secret-1780000000000-deadbeef.webp",
  ]) {
    assert.throws(
      () =>
        collectAccountDeletionStorageObjects({
          graph: graph([
            {
              category: key.startsWith("profile-photos/")
                ? "profile_avatar"
                : "cookbook_image",
              value: `${PUBLIC_BASE}/${key}`,
            },
          ]),
          publicBaseUrl: PUBLIC_BASE,
        }),
      (error) =>
        error instanceof AccountDeletionStorageError &&
        error.code === "storage_reference_sensitive" &&
        !error.message.includes(key),
    );
  }
});

test("opaque tokens, invalid encoding, and unsupported prefixes still fail closed", () => {
  const failures = [
    {
      value: `${PUBLIC_BASE}/fusion-images/${"a".repeat(30)}-${"b".repeat(30)}.webp`,
      code: "storage_reference_sensitive",
    },
    {
      value: `${PUBLIC_BASE}/recipe-images/%E0%A4%A`,
      code: "storage_reference_invalid",
    },
    {
      value: `${PUBLIC_BASE}/archive-images/fixture-1780000000000-deadbeef.webp`,
      code: "storage_reference_unsupported",
    },
  ];
  for (const failure of failures) {
    assert.throws(
      () =>
        collectAccountDeletionStorageObjects({
          graph: graph([
            {
              category: "cookbook_image",
              value: failure.value,
            },
          ]),
          publicBaseUrl: PUBLIC_BASE,
        }),
      (error) =>
        error instanceof AccountDeletionStorageError &&
        error.code === failure.code &&
        !error.message.includes(failure.value),
    );
  }
  assert.deepEqual(
    collectAccountDeletionStorageObjects({
      graph: graph([
        {
          category: "cookbook_image",
          value: `${PUBLIC_BASE}.external.example/recipe-images/ambiguous.webp`,
        },
      ]),
      publicBaseUrl: PUBLIC_BASE,
    }),
    [],
  );
});

test("noncanonical same-origin storage references fail closed", () => {
  const canonicalKey = productionKey("recipe-images", "safe");
  const invalidReferences = [
    `${PUBLIC_BASE}/recipe-images%2Fsafe.webp`,
    `${PUBLIC_BASE}/recipe-images%2fsafe.webp`,
    `${PUBLIC_BASE}/recipe-images/%5Csafe.webp`,
    `${PUBLIC_BASE}/recipe-images/%5csafe.webp`,
    `${PUBLIC_BASE}/${canonicalKey}%3Fdownload`,
    `${PUBLIC_BASE}/${canonicalKey}%3fdownload`,
    `${PUBLIC_BASE}/${canonicalKey}%23fragment`,
    `${PUBLIC_BASE}/recipe-images/\\safe.webp`,
    `${PUBLIC_BASE}/recipe-images//safe.webp`,
    `${PUBLIC_BASE}/recipe-images/safe.webp/extra`,
    `${PUBLIC_BASE}/${canonicalKey}/extra`,
    `${PUBLIC_BASE}/${canonicalKey}?download=1`,
    `${PUBLIC_BASE}/${canonicalKey}#fragment`,
    `${PUBLIC_BASE}/recipe-images/../safe.webp`,
    `${PUBLIC_BASE}/recipe-images/%2E%2E%2Fsafe.webp`,
    `${PUBLIC_BASE}/recipe-images/%2e%2e%2fsafe.webp`,
    `HTTPS://CDN.EXAMPLE.TEST/${canonicalKey}`,
    `https://cdn.example.test:443/${canonicalKey}`,
    `${PUBLIC_BASE}/%72ecipe-images/safe.webp`,
    `${PUBLIC_BASE}/recipe-images/safe.webp`,
  ];
  for (const value of invalidReferences) {
    assert.throws(
      () =>
        buildAccountDeletionStorageOutboxStatements({
          graph: graph([{ category: "cookbook_image", value }]),
          jobId: "job-storage",
          targetId: "target-storage",
          publicBaseUrl: PUBLIC_BASE,
        }),
      (error) =>
        error instanceof AccountDeletionStorageError &&
        error.code === "storage_reference_invalid" &&
        !error.message.includes(value),
    );
  }
});

test("prefix confusion and unsupported prefixes never become deletion targets", () => {
  for (const value of [
    `${PUBLIC_BASE}/recipe-images-archive/safe-${PRODUCTION_TIMESTAMP}-deadbeef.webp`,
    `${PUBLIC_BASE}/archive-images/safe-${PRODUCTION_TIMESTAMP}-deadbeef.webp`,
  ]) {
    assert.throws(
      () =>
        buildAccountDeletionStorageOutboxStatements({
          graph: graph([{ category: "cookbook_image", value }]),
          jobId: "job-storage",
          targetId: "target-storage",
          publicBaseUrl: PUBLIC_BASE,
        }),
      (error) =>
        error instanceof AccountDeletionStorageError &&
        error.code === "storage_reference_unsupported" &&
        !error.message.includes(value),
    );
  }
});

test("outbox rows and reference deletion commit atomically", async () => {
  const client = await createFixture();
  try {
    const key = productionKey("recipe-images", "target");
    await client.execute({
      sql: "INSERT INTO cookbook_recipes (row_id, image_url) VALUES ('recipe-target', ?)",
      args: [`${PUBLIC_BASE}/${key}`],
    });
    const statements = buildAccountDeletionStorageOutboxStatements({
      graph: graph([
        {
          category: "cookbook_image",
          value: `${PUBLIC_BASE}/${key}`,
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
    assert.equal(result.rows[0].object_key, key);
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

test("cookbook create commits before claim and forces a reference conflict", async () => {
  const client = await createFixture();
  try {
    const key = "recipe-images/committed-first.webp";
    const url = `${PUBLIC_BASE}/${key}`;
    await seedOutbox(client, key);
    const committed = deferred();
    const releaseWrite = deferred();
    const writeClient = {
      async execute(statement) {
        const result = await client.execute(statement);
        committed.resolve();
        await releaseWrite.promise;
        return result;
      },
    };
    const write = upsertCookbookRecord(
      "cookbook-owner",
      cookbookRecord("committed-first", url),
      {
        client: writeClient,
        publicBaseUrl: PUBLIC_BASE,
        schemaReady: true,
      },
    );
    await committed.promise;
    let deleteCalls = 0;
    const worker = processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        deleteCalls += 1;
      },
    });
    releaseWrite.resolve();
    await write;
    const result = await worker;
    assert.equal(result.status, "manual_review");
    assert.equal(deleteCalls, 0);
    assert.equal((await statusSnapshot(client)).outbox_status, "manual_review");
    assert.equal(
      Number(
        (await client.execute("SELECT COUNT(*) AS count FROM cookbook_recipes")).rows[0]
          .count,
      ),
      1,
    );
  } finally {
    client.close();
  }
});

test("worker claim commits before cookbook create and update, so both writes reject", async () => {
  const client = await createFixture();
  try {
    const key = "recipe-images/claim-first.webp";
    const url = `${PUBLIC_BASE}/${key}`;
    await seedOutbox(client, key);
    await upsertCookbookRecord(
      "cookbook-owner",
      cookbookRecord("existing", undefined),
      { client, publicBaseUrl: PUBLIC_BASE, schemaReady: true },
    );
    const claimed = deferred();
    const releaseDelete = deferred();
    const worker = processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        claimed.resolve();
        await releaseDelete.promise;
      },
    });
    await claimed.promise;
    for (const recipeId of ["new", "existing"]) {
      await assert.rejects(
        upsertCookbookRecord(
          "cookbook-owner",
          cookbookRecord(recipeId, url),
          { client, publicBaseUrl: PUBLIC_BASE, schemaReady: true },
        ),
        (error) =>
          error instanceof StorageReferenceClaimError &&
          error.code === "storage_reference_unavailable" &&
          !error.message.includes(key),
      );
    }
    assert.equal(
      Number(
        (
          await client.execute(
            "SELECT COUNT(*) AS count FROM cookbook_recipes WHERE image_url IS NOT NULL",
          )
        ).rows[0].count,
      ),
      0,
    );
    releaseDelete.resolve();
    const result = await worker;
    assert.equal(result.status, "completed");
  } finally {
    client.close();
  }
});

test("worker claim commits before profile avatar update, so the update rejects", async () => {
  const client = await createFixture();
  try {
    const key = "profile-photos/claim-first.webp";
    const url = `${PUBLIC_BASE}/${key}`;
    await seedOutbox(client, key, "profile_avatar");
    await client.execute({
      sql: `INSERT INTO auth_users (
              id, email, name, provider_subject, updated_at
            ) VALUES ('profile-user', 'profile@example.test', 'Profile',
                      'profile-subject', '2026-08-02T00:00:00.000Z')`,
      args: [],
    });
    const claimed = deferred();
    const releaseDelete = deferred();
    const worker = processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        claimed.resolve();
        await releaseDelete.promise;
      },
    });
    await claimed.promise;
    await assert.rejects(
      updateAuthUserProfile(
        { userId: "profile-user", avatarUrl: url },
        { client, publicBaseUrl: PUBLIC_BASE, schemaReady: true },
      ),
      (error) =>
        error instanceof StorageReferenceClaimError &&
        error.statusCode === 409 &&
        !error.message.includes(key),
    );
    await assert.rejects(
      upsertOAuthUser(
        {
          provider: "google",
          providerSubject: "claimed-oauth-avatar",
          email: "oauth@example.test",
          name: "OAuth",
          avatarUrl: url,
          role: "user",
        },
        { client, publicBaseUrl: PUBLIC_BASE, schemaReady: true },
      ),
      (error) =>
        error instanceof StorageReferenceClaimError &&
        error.statusCode === 409,
    );
    const avatar = await client.execute(
      "SELECT avatar_url FROM auth_users WHERE id = 'profile-user'",
    );
    assert.equal(avatar.rows[0].avatar_url, "");
    releaseDelete.resolve();
    assert.equal((await worker).status, "completed");
  } finally {
    client.close();
  }
});

test("a remaining reference prevents completion even after the R2 call", async () => {
  const client = await createFixture();
  try {
    const key = "recipe-images/late-reference.webp";
    const url = `${PUBLIC_BASE}/${key}`;
    await seedOutbox(client, key);
    const result = await processAccountDeletionStorageOutbox({
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        await client.execute({
          sql: `INSERT INTO cookbook_recipes (
                  row_id, anon_user_id, recipe_id, image_url
                ) VALUES ('legacy-bypass', 'owner', 'legacy', ?)`,
          args: [url],
        });
      },
    });
    assert.equal(result.status, "manual_review");
    assert.equal((await statusSnapshot(client)).outbox_status, "manual_review");
  } finally {
    client.close();
  }
});

test("two workers racing the same row produce one R2 deletion", async () => {
  const client = await createFixture();
  try {
    await seedOutbox(client, "recipe-images/two-workers.webp");
    const enteredDelete = deferred();
    const releaseDelete = deferred();
    let deleteCalls = 0;
    const workerOptions = {
      jobId: "job-storage",
      client,
      publicBaseUrl: PUBLIC_BASE,
      async deleteObject() {
        deleteCalls += 1;
        enteredDelete.resolve();
        await releaseDelete.promise;
      },
    };
    const first = processAccountDeletionStorageOutbox(workerOptions);
    await enteredDelete.promise;
    const second = processAccountDeletionStorageOutbox(workerOptions);
    await second;
    releaseDelete.resolve();
    await first;
    assert.equal(deleteCalls, 1);
    assert.equal((await statusSnapshot(client)).attempts, 1);
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
  const orphanSource = readFileSync(
    new URL("./r2-orphan-cleanup.ts", import.meta.url),
    "utf8",
  );
  assert.match(orphanSource, /listStorageKeysOwnedByDeletionOutbox/);
  assert.match(orphanSource, /deletionOwnedKeys\.forEach/);

  for (const file of [
    "./cookbook-db.ts",
    "./auth-users.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /getStorageReferenceWriteGuard/);
    assert.match(source, /StorageReferenceClaimError/);
  }
});
