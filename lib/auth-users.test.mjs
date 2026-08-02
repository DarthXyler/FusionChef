import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const databasePath = path.join(
  tmpdir(),
  `flavor-fusion-auth-users-${process.pid}.db`,
);
process.env.TURSO_DATABASE_URL = pathToFileURL(databasePath).href;
process.env.TURSO_AUTH_TOKEN = "local-auth-users-test";

const {
  getOAuthUserByProviderSubject,
  upsertOAuthUser,
} = await import("./auth-users.ts");
const { executeTurso, getTursoClient } = await import("./turso.ts");

function createBarrier(participantCount) {
  let remaining = participantCount;
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    remaining -= 1;
    if (remaining === 0) {
      release();
    }
    await released;
  };
}

async function runConcurrently(...operations) {
  const meetAtBarrier = createBarrier(operations.length);
  return Promise.all(
    operations.map(async (operation) => {
      await meetAtBarrier();
      return operation();
    }),
  );
}

async function readUsersByProviderSubject(provider, providerSubject) {
  const result = await executeTurso({
    sql: `SELECT id, email, name, avatar_url, provider, provider_subject, role
          FROM auth_users
          WHERE provider = ? AND provider_subject = ?`,
    args: [provider, providerSubject],
  });
  return result.rows;
}

function googleParams(providerSubject, overrides = {}) {
  return {
    provider: "google",
    providerSubject,
    email: `${providerSubject}@example.com`,
    name: "Google User",
    avatarUrl: "https://example.com/google.png",
    role: "user",
    ...overrides,
  };
}

function appleParams(providerSubject, overrides = {}) {
  return {
    provider: "apple",
    providerSubject,
    email: `${providerSubject}@privaterelay.appleid.com`,
    name: "Apple User",
    avatarUrl: "",
    role: "user",
    ...overrides,
  };
}

async function removeDatabaseWithRetry() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(databasePath, { force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
      if (attempt === 5) {
        // Assertions are complete; Windows can retain libSQL's temp file until process exit.
        return;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

after(async () => {
  getTursoClient().close();
  await removeDatabaseWithRetry();
});

test("normal first and returning Google logins use the persisted row", async () => {
  const providerSubject = "google-normal";
  const first = await upsertOAuthUser(googleParams(providerSubject));
  const returning = await upsertOAuthUser(
    googleParams(providerSubject, {
      name: "Updated Google User",
      avatarUrl: "https://example.com/google-updated.png",
      role: "admin",
    }),
  );

  assert.equal(returning.id, first.id);
  assert.equal(returning.name, "Updated Google User");
  assert.equal(returning.avatarUrl, "https://example.com/google-updated.png");
  assert.equal(returning.role, "admin");
  assert.equal((await readUsersByProviderSubject("google", providerSubject)).length, 1);
});

test("concurrent first Google logins both return the one persisted user ID", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const providerSubject = `google-concurrent-${attempt}`;
    const [first, second] = await runConcurrently(
      () => upsertOAuthUser(googleParams(providerSubject)),
      () => upsertOAuthUser(googleParams(providerSubject)),
    );
    const rows = await readUsersByProviderSubject("google", providerSubject);

    assert.equal(rows.length, 1);
    assert.equal(first.id, rows[0].id);
    assert.equal(second.id, rows[0].id);
    assert.equal(first.id, second.id);
  }
});

test("normal first and returning Apple logins preserve omitted profile data", async () => {
  const providerSubject = "apple-normal";
  const first = await upsertOAuthUser(
    appleParams(providerSubject, {
      email: "apple-normal@privaterelay.appleid.com",
      name: "Original Apple User",
    }),
  );

  const existing = await getOAuthUserByProviderSubject({
    provider: "apple",
    providerSubject,
  });
  assert.ok(existing);

  // This is the same fallback used by the Apple route when a later Apple
  // response omits email and the client omits fullName.
  const returning = await upsertOAuthUser(
    appleParams(providerSubject, {
      email: existing.email,
      name: existing.name,
      avatarUrl: existing.avatarUrl,
    }),
  );

  assert.equal(returning.id, first.id);
  assert.equal(returning.email, "apple-normal@privaterelay.appleid.com");
  assert.equal(returning.name, "Original Apple User");
  assert.equal((await readUsersByProviderSubject("apple", providerSubject)).length, 1);
});

test("concurrent first Apple logins return one ID and do not erase supplied profile data", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const providerSubject = `apple-concurrent-${attempt}`;
    const email = `${providerSubject}@privaterelay.appleid.com`;
    const [withProfile, withoutName] = await runConcurrently(
      () =>
        upsertOAuthUser(
          appleParams(providerSubject, {
            email,
            name: "Concurrent Apple User",
          }),
        ),
      () =>
        upsertOAuthUser(
          appleParams(providerSubject, {
            email,
            name: "",
          }),
        ),
    );
    const rows = await readUsersByProviderSubject("apple", providerSubject);

    assert.equal(rows.length, 1);
    assert.equal(withProfile.id, rows[0].id);
    assert.equal(withoutName.id, rows[0].id);
    assert.equal(withProfile.id, withoutName.id);
    assert.equal(rows[0].email, email);
    assert.equal(rows[0].name, "Concurrent Apple User");
  }
});

test("different provider subjects create different auth users", async () => {
  const first = await upsertOAuthUser(googleParams("google-distinct-one"));
  const second = await upsertOAuthUser(googleParams("google-distinct-two"));

  assert.notEqual(first.id, second.id);
});

test("Google and Apple accounts with the same email remain separate", async () => {
  const sharedEmail = "shared-provider-email@example.com";
  const google = await upsertOAuthUser(
    googleParams("google-shared-email", { email: sharedEmail }),
  );
  const apple = await upsertOAuthUser(
    appleParams("apple-shared-email", { email: sharedEmail }),
  );

  assert.notEqual(google.id, apple.id);
  assert.equal(
    Number(
      (
        await executeTurso({
          sql: "SELECT COUNT(*) AS count FROM auth_users WHERE normalized_email = ?",
          args: [sharedEmail],
        })
      ).rows[0]?.count,
    ),
    2,
  );
});

test("auth database failure prevents session creation", async () => {
  await executeTurso(`
    CREATE TRIGGER fail_oauth_user_insert
    BEFORE INSERT ON auth_users
    WHEN NEW.provider_subject = 'forced-database-failure'
    BEGIN
      SELECT RAISE(FAIL, 'forced auth database failure');
    END
  `);

  let sessionSignCalls = 0;
  const signSession = () => {
    sessionSignCalls += 1;
  };
  try {
    await assert.rejects(async () => {
      const persistedUser = await upsertOAuthUser(
        googleParams("forced-database-failure"),
      );
      signSession(persistedUser);
    }, /forced auth database failure/);
    assert.equal(sessionSignCalls, 0);
  } finally {
    await executeTurso("DROP TRIGGER fail_oauth_user_insert");
  }
});

test("OAuth session callers sign only the persisted row returned by the upsert", async () => {
  const routePaths = [
    "../app/api/auth/google/callback/route.ts",
    "../app/api/auth/apple/mobile/route.ts",
  ];

  for (const routePath of routePaths) {
    const source = await readFile(new URL(routePath, import.meta.url), "utf8");
    const upsertIndex = source.indexOf(
      "const persistedUser = await upsertOAuthUser({",
    );
    const sessionIndex = source.indexOf(
      "const token = createAuthSessionToken({",
      upsertIndex,
    );
    const sessionSource = source.slice(
      sessionIndex,
      source.indexOf("});", sessionIndex) + 3,
    );

    assert.ok(upsertIndex >= 0, routePath);
    assert.ok(sessionIndex > upsertIndex, routePath);
    assert.match(sessionSource, /userId: persistedUser\.id/);
    assert.match(sessionSource, /email: persistedUser\.email/);
    assert.match(sessionSource, /name: persistedUser\.name/);
    assert.match(sessionSource, /role: persistedUser\.role/);
    assert.doesNotMatch(sessionSource, /randomUUID|providerSubject|body\./);
  }
});
