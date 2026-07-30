import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createClient } from "@libsql/client";
import {
  ADMIN_USER_ACCOUNT_SETUP_ISSUE_SQL,
  ADMIN_USER_ACCOUNT_SETUP_SQL,
  ADMIN_USER_IDENTITY_HEALTH_CTES_SQL,
  ADMIN_USER_IDENTITY_HEALTH_JOIN_SQL,
  ADMIN_USER_SUMMARY_SQL,
  getAdminUserAccountSetupWhereClause,
  getAdminUserIdentityIssueLabel,
  getAdminUserIdentityIssueTooltip,
  getAdminUserIdentityIssueWhereClause,
  parseAdminUserAccountSetupFilter,
  parseAdminUserIdentityIssueFilter,
} from "./admin-user-identity-health.ts";

let client;
const cutoff = "2026-07-22T12:00:00.000Z";

function buildHealthQuery(whereSql = "1 = 1") {
  return `WITH RECURSIVE identity_health_config(value) AS (VALUES (1))
    ${ADMIN_USER_IDENTITY_HEALTH_CTES_SQL}
    SELECT
      u.id,
      u.email,
      ${ADMIN_USER_ACCOUNT_SETUP_SQL} AS account_setup,
      ${ADMIN_USER_ACCOUNT_SETUP_ISSUE_SQL} AS account_setup_issue
    FROM auth_users u
    ${ADMIN_USER_IDENTITY_HEALTH_JOIN_SQL}
    WHERE ${whereSql}
    ORDER BY u.id`;
}

async function queryHealth(whereSql = "1 = 1", args = [], targetClient = client) {
  const result = await targetClient.execute({
    sql: buildHealthQuery(whereSql),
    args,
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    accountSetup: String(row.account_setup),
    issue: row.account_setup_issue ? String(row.account_setup_issue) : "",
  }));
}

async function querySummary() {
  const result = await client.execute({
    sql: ADMIN_USER_SUMMARY_SQL,
    args: [cutoff],
  });
  const row = result.rows[0];
  return {
    totalUsers: Number(row?.total_users ?? 0),
    payingUsers: Number(row?.paying_users ?? 0),
    activeUsers: Number(row?.active_users ?? 0),
    inactiveUsers: Number(row?.inactive_users ?? 0),
    needsAttention: Number(row?.needs_attention ?? 0),
    completeAccounts: Number(row?.complete_accounts ?? 0),
    setupMissing: Number(row?.setup_missing ?? 0),
    sharedIdentity: Number(row?.shared_identity ?? 0),
    splitData: Number(row?.split_data ?? 0),
    invalidIdentity: Number(row?.invalid_identity ?? 0),
  };
}

const FIXTURE_CANONICAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXTURE_ALIAS_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIXTURE_ALIAS_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function withAliasEvidenceFixture(callback, aliases = [FIXTURE_ALIAS_A]) {
  const targetClient = createClient({ url: "file::memory:" });
  try {
    await targetClient.executeMultiple(`
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        normalized_email TEXT NOT NULL,
        provider TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
      CREATE TABLE auth_identity_links (
        auth_user_id TEXT PRIMARY KEY,
        canonical_anon_user_id TEXT NOT NULL
      );
      CREATE TABLE mobile_identity_aliases (
        anon_user_id TEXT PRIMARY KEY,
        canonical_anon_user_id TEXT NOT NULL
      );
      CREATE TABLE mobile_identity_links (
        device_key TEXT PRIMARY KEY,
        canonical_anon_user_id TEXT NOT NULL
      );
      CREATE TABLE credit_balances (
        anon_user_id TEXT PRIMARY KEY,
        available_credits INTEGER NOT NULL DEFAULT 0,
        pending_credits INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE credit_daily_usage (anon_user_id TEXT NOT NULL);
      CREATE TABLE credit_reservations (anon_user_id TEXT NOT NULL);
      CREATE TABLE credit_ledger_entries (anon_user_id TEXT NOT NULL);
      CREATE TABLE credit_purchase_transactions (
        row_id TEXT PRIMARY KEY,
        anon_user_id TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE TABLE cookbook_recipes (
        row_id TEXT PRIMARY KEY,
        anon_user_id TEXT NOT NULL
      );
      INSERT INTO auth_users VALUES (
        'fixture-user',
        'fixture@example.com',
        'fixture@example.com',
        'google',
        '2026-07-29T10:00:00.000Z'
      );
      INSERT INTO auth_identity_links VALUES (
        'fixture-user',
        '${FIXTURE_CANONICAL}'
      );
    `);
    for (const alias of aliases) {
      await targetClient.execute({
        sql: `INSERT INTO mobile_identity_aliases (
                anon_user_id,
                canonical_anon_user_id
              ) VALUES (?, ?)`,
        args: [alias, FIXTURE_CANONICAL],
      });
    }
    await callback({
      client: targetClient,
      canonical: FIXTURE_CANONICAL,
      aliases,
    });
  } finally {
    targetClient.close();
  }
}

before(async () => {
  client = createClient({ url: "file::memory:" });
  await client.executeMultiple(`
    CREATE TABLE auth_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      normalized_email TEXT NOT NULL,
      provider TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );
    CREATE TABLE auth_identity_links (
      auth_user_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE mobile_identity_aliases (
      anon_user_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE mobile_identity_links (
      device_key TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE credit_balances (
      anon_user_id TEXT PRIMARY KEY,
      available_credits INTEGER NOT NULL DEFAULT 0,
      pending_credits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE credit_daily_usage (anon_user_id TEXT NOT NULL);
    CREATE TABLE credit_reservations (anon_user_id TEXT NOT NULL);
    CREATE TABLE credit_ledger_entries (anon_user_id TEXT NOT NULL);
    CREATE TABLE credit_purchase_transactions (
      row_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL,
      verified_at TEXT
    );
    CREATE TABLE cookbook_recipes (
      row_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL
    );
    CREATE TABLE product_activity_events (
      event_id TEXT PRIMARY KEY,
      auth_user_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );

    INSERT INTO auth_users VALUES
      ('healthy', 'healthy@example.com', 'healthy@example.com', 'google', '2026-07-29T10:00:00.000Z'),
      ('missing', 'missing@example.com', 'missing@example.com', 'google', '2026-07-29T09:00:00.000Z'),
      ('shared-a', 'shared-a@example.com', 'shared-a@example.com', 'google', '2026-07-29T08:00:00.000Z'),
      ('shared-b', 'shared-b@example.com', 'shared-b@example.com', 'apple', '2026-07-29T07:00:00.000Z'),
      ('split', 'split@example.com', 'split@example.com', 'google', '2026-07-29T06:00:00.000Z'),
      ('invalid-malformed', 'invalid-a@example.com', 'invalid-a@example.com', 'google', '2026-07-29T05:00:00.000Z'),
      ('invalid-blank', 'invalid-b@example.com', 'invalid-b@example.com', 'apple', '2026-07-29T04:00:00.000Z'),
      ('same-email-google', 'same@example.com', 'same@example.com', 'google', '2026-07-29T03:00:00.000Z'),
      ('same-email-apple', 'same@example.com', 'same@example.com', 'apple', '2026-07-29T02:00:00.000Z');

    INSERT INTO auth_identity_links VALUES
      ('healthy', '11111111-1111-4111-8111-111111111111'),
      ('shared-a', '22222222-2222-4222-8222-222222222222'),
      ('shared-b', '22222222-2222-4222-8222-222222222222'),
      ('split', '33333333-3333-4333-8333-333333333333'),
      ('invalid-malformed', 'not-a-valid-identity'),
      ('invalid-blank', '   '),
      ('same-email-google', '55555555-5555-4555-8555-555555555555'),
      ('same-email-apple', '66666666-6666-4666-8666-666666666666');

    INSERT INTO mobile_identity_aliases VALUES
      ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333'),
      ('77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444');
    INSERT INTO cookbook_recipes VALUES
      ('split-recipe', '77777777-7777-4777-8777-777777777777');
  `);
});

after(() => {
  client.close();
});

test("healthy exclusive canonical identity is complete", async () => {
  assert.deepEqual(await queryHealth("u.id = 'healthy'"), [
    {
      id: "healthy",
      email: "healthy@example.com",
      accountSetup: "complete",
      issue: "",
    },
  ]);
});

test("missing auth link is needs attention with setup missing", async () => {
  const [row] = await queryHealth("u.id = 'missing'");
  assert.equal(row.accountSetup, "needs_attention");
  assert.equal(row.issue, "setup_missing");
});

test("every auth user sharing an exact canonical is marked shared identity", async () => {
  const rows = await queryHealth("u.id IN ('shared-a', 'shared-b')");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.accountSetup === "needs_attention"));
  assert.ok(rows.every((row) => row.issue === "shared_identity"));
});

test("shared identity comparison uses the resolver's trimmed UUID value", async () => {
  await client.execute({
    sql: `UPDATE auth_identity_links
          SET canonical_anon_user_id = ?
          WHERE auth_user_id = 'shared-b'`,
    args: ["  22222222-2222-4222-8222-222222222222  "],
  });
  try {
    const rows = await queryHealth("u.id IN ('shared-a', 'shared-b')");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.issue === "shared_identity"));
  } finally {
    await client.execute({
      sql: `UPDATE auth_identity_links
            SET canonical_anon_user_id = ?
            WHERE auth_user_id = 'shared-b'`,
      args: ["22222222-2222-4222-8222-222222222222"],
    });
  }
});

test("durable product rows under an explicit alias chain are marked split data", async () => {
  const [row] = await queryHealth("u.id = 'split'");
  assert.equal(row.accountSetup, "needs_attention");
  assert.equal(row.issue, "split_data");
});

test("a zero-only secondary alias balance is harmless residue", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: `INSERT INTO credit_balances (
              anon_user_id,
              available_credits,
              pending_credits
            ) VALUES (?, 0, 0)`,
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.accountSetup, "complete");
    assert.equal(row.issue, "");
  });
});

test("multiple zero-only secondary alias balances remain complete", async () => {
  await withAliasEvidenceFixture(
    async (fixture) => {
      for (const alias of fixture.aliases) {
        await fixture.client.execute({
          sql: `INSERT INTO credit_balances (
                  anon_user_id,
                  available_credits,
                  pending_credits
                ) VALUES (?, 0, 0)`,
          args: [alias],
        });
      }
      const [row] = await queryHealth(
        "u.id = 'fixture-user'",
        [],
        fixture.client,
      );
      assert.equal(row.accountSetup, "complete");
      assert.equal(row.issue, "");
    },
    [FIXTURE_ALIAS_A, FIXTURE_ALIAS_B],
  );
});

test("nonzero secondary available or pending credits are split app data", async () => {
  for (const [availableCredits, pendingCredits] of [[1, 0], [0, 1]]) {
    await withAliasEvidenceFixture(async (fixture) => {
      await fixture.client.execute({
        sql: `INSERT INTO credit_balances (
                anon_user_id,
                available_credits,
                pending_credits
              ) VALUES (?, ?, ?)`,
        args: [fixture.aliases[0], availableCredits, pendingCredits],
      });
      const [row] = await queryHealth(
        "u.id = 'fixture-user'",
        [],
        fixture.client,
      );
      assert.equal(row.accountSetup, "needs_attention");
      assert.equal(row.issue, "split_data");
    });
  }
});

test("a secondary ledger row is split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: "INSERT INTO credit_ledger_entries (anon_user_id) VALUES (?)",
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.issue, "split_data");
  });
});

test("a secondary usage row is split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: "INSERT INTO credit_daily_usage (anon_user_id) VALUES (?)",
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.issue, "split_data");
  });
});

test("a secondary reservation row is split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: "INSERT INTO credit_reservations (anon_user_id) VALUES (?)",
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.issue, "split_data");
  });
});

test("a verified secondary purchase is split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: `INSERT INTO credit_purchase_transactions (
              row_id,
              anon_user_id,
              verified_at
            ) VALUES ('verified-purchase', ?, '2026-07-29T10:00:00.000Z')`,
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.issue, "split_data");
  });
});

test("an unverified secondary purchase is not ownership evidence", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: `INSERT INTO credit_purchase_transactions (
              row_id,
              anon_user_id,
              verified_at
            ) VALUES ('unverified-purchase', ?, NULL)`,
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.accountSetup, "complete");
    assert.equal(row.issue, "");
  });
});

test("a secondary cookbook row is split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: `INSERT INTO cookbook_recipes (row_id, anon_user_id)
            VALUES ('secondary-recipe', ?)`,
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.issue, "split_data");
  });
});

test("a stale device mapping to a secondary identity is split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.execute({
      sql: `INSERT INTO mobile_identity_links (
              device_key,
              canonical_anon_user_id
            ) VALUES ('stale-device', ?)`,
      args: [fixture.aliases[0]],
    });
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.issue, "split_data");
  });
});

test("meaningful data under the current canonical never triggers split app data", async () => {
  await withAliasEvidenceFixture(async (fixture) => {
    await fixture.client.executeMultiple(`
      INSERT INTO credit_balances VALUES ('${fixture.canonical}', 4, 2);
      INSERT INTO credit_daily_usage VALUES ('${fixture.canonical}');
      INSERT INTO credit_reservations VALUES ('${fixture.canonical}');
      INSERT INTO credit_ledger_entries VALUES ('${fixture.canonical}');
      INSERT INTO credit_purchase_transactions VALUES (
        'canonical-purchase',
        '${fixture.canonical}',
        '2026-07-29T10:00:00.000Z'
      );
      INSERT INTO cookbook_recipes VALUES (
        'canonical-recipe',
        '${fixture.canonical}'
      );
      INSERT INTO mobile_identity_links VALUES (
        'current-device',
        '${fixture.canonical}'
      );
    `);
    const [row] = await queryHealth("u.id = 'fixture-user'", [], fixture.client);
    assert.equal(row.accountSetup, "complete");
    assert.equal(row.issue, "");
  });
});

test("malformed and blank canonical identities are invalid", async () => {
  const rows = await queryHealth(
    "u.id IN ('invalid-malformed', 'invalid-blank')",
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.issue === "invalid_identity"));
});

test("same-email Google and Apple accounts remain separate and healthy", async () => {
  const rows = await queryHealth(
    "u.id IN ('same-email-google', 'same-email-apple')",
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.accountSetup === "complete"));
  assert.ok(rows.every((row) => row.issue === ""));
});

test("global summary includes every unhealthy category without duplicate users", async () => {
  assert.deepEqual(await querySummary(), {
    totalUsers: 9,
    payingUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    needsAttention: 6,
    completeAccounts: 3,
    setupMissing: 1,
    sharedIdentity: 2,
    splitData: 1,
    invalidIdentity: 2,
  });
});

test("issue reason combines with search and paginated queries", async () => {
  const issueWhere = getAdminUserIdentityIssueWhereClause("shared_identity");
  const setupWhere = getAdminUserAccountSetupWhereClause("needs_attention");
  const firstPage = await client.execute({
    sql: `${buildHealthQuery(
      `${issueWhere} AND ${setupWhere} AND u.normalized_email LIKE ?`,
    )} LIMIT 1`,
    args: ["shared-%"],
  });
  assert.equal(firstPage.rows.length, 1);

  const firstId = String(firstPage.rows[0].id);
  const nextPage = await client.execute({
    sql: `${buildHealthQuery(
      `${issueWhere} AND ${setupWhere} AND u.normalized_email LIKE ? AND u.id > ?`,
    )} LIMIT 1`,
    args: ["shared-%", firstId],
  });
  assert.equal(nextPage.rows.length, 1);
  assert.notEqual(String(nextPage.rows[0].id), firstId);
});

test("filter parsing is closed to supported diagnostic values", () => {
  assert.equal(parseAdminUserAccountSetupFilter("complete"), "complete");
  assert.equal(
    parseAdminUserAccountSetupFilter("needs_attention"),
    "needs_attention",
  );
  assert.equal(parseAdminUserAccountSetupFilter("linked"), "all");
  assert.equal(parseAdminUserIdentityIssueFilter("split_data"), "split_data");
  assert.equal(parseAdminUserIdentityIssueFilter("repair_pending"), "all");
});

test("identity issues use business-facing labels and explanations", () => {
  assert.equal(getAdminUserIdentityIssueLabel("setup_missing"), "Setup incomplete");
  assert.equal(getAdminUserIdentityIssueLabel("shared_identity"), "Shared app data");
  assert.equal(getAdminUserIdentityIssueLabel("split_data"), "Split app data");
  assert.equal(
    getAdminUserIdentityIssueLabel("invalid_identity"),
    "Invalid account setup",
  );
  assert.equal(
    getAdminUserIdentityIssueTooltip("setup_missing"),
    "The signed-in account is not yet connected to its app data.",
  );
  assert.equal(
    getAdminUserIdentityIssueTooltip("shared_identity"),
    "Multiple signed-in accounts are connected to the same app data.",
  );
  assert.equal(
    getAdminUserIdentityIssueTooltip("split_data"),
    "Meaningful app data exists under more than one identity for this account.",
  );
  assert.equal(
    getAdminUserIdentityIssueTooltip("invalid_identity"),
    "The account connection contains an invalid or inconsistent identity.",
  );
});

test("CSV uses the same paginated filters and includes both setup columns", () => {
  const panelSource = readFileSync(
    new URL("../components/AdminMonetizationConfigPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panelSource, /buildUsersQuery\(cursor, 500\)/);
  assert.match(panelSource, /"Account Setup"/);
  assert.match(panelSource, /"Account Setup Issue"/);
  assert.match(
    panelSource,
    /getAdminUserIdentityIssueLabel\(user\.accountSetupIssue\)/,
  );
});

test("diagnostic SQL remains executable with the database in query-only mode", async () => {
  const diagnosticSql = [
    ADMIN_USER_IDENTITY_HEALTH_CTES_SQL,
    ADMIN_USER_SUMMARY_SQL,
    buildHealthQuery(),
  ].join("\n");
  assert.doesNotMatch(
    diagnosticSql,
    /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i,
  );

  await client.execute("PRAGMA query_only = ON");
  assert.equal((await queryHealth()).length, 9);
  assert.equal((await querySummary()).totalUsers, 9);

  const routeSource = readFileSync(
    new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
    "utf8",
  );
  const getHandler = routeSource.slice(
    routeSource.indexOf("export async function GET"),
    routeSource.indexOf("function parseBatchPayload"),
  );
  assert.doesNotMatch(getHandler, /ensureAdminUserSchemas\(/);
  assert.doesNotMatch(getHandler, /executeTursoBatch|grantCredits\(/);
});
