import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createClient } from "@libsql/client";
import {
  ADMIN_USER_ACTIVITY_STATUS_SQL,
  ADMIN_USER_ENGAGEMENT_CTES_SQL,
  ADMIN_USER_ENGAGEMENT_JOINS_SQL,
  ADMIN_USER_LAST_ACTIVITY_SQL,
  ADMIN_USER_TYPE_SQL,
  getAdminUserActivityCutoffIso,
  getAdminUserActivityStatusWhereClause,
  getAdminUserTypeWhereClause,
  parseAdminUserActivityStatusFilter,
  parseAdminUserTypeFilter,
} from "./admin-user-engagement.ts";
import { ADMIN_USER_SUMMARY_SQL } from "./admin-user-identity-health.ts";

let client;
const cutoff = "2026-07-22T12:00:00.000Z";

function buildClassificationSql(whereSql = "1 = 1") {
  return `${ADMIN_USER_ENGAGEMENT_CTES_SQL}
    SELECT
      u.id,
      ail.canonical_anon_user_id,
      ${ADMIN_USER_TYPE_SQL} AS user_type,
      ${ADMIN_USER_ACTIVITY_STATUS_SQL} AS activity_status,
      ${ADMIN_USER_LAST_ACTIVITY_SQL} AS last_activity_at
    FROM auth_users u
    LEFT JOIN auth_identity_links ail ON ail.auth_user_id = u.id
    ${ADMIN_USER_ENGAGEMENT_JOINS_SQL}
    WHERE ${whereSql}
    ORDER BY u.id`;
}

async function queryUsers(whereSql = "1 = 1", extraArgs = []) {
  const result = await client.execute({
    sql: buildClassificationSql(whereSql),
    args: [cutoff, ...extraArgs],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    linkStatus: row.canonical_anon_user_id ? "linked" : "unlinked",
    userType: String(row.user_type),
    activityStatus: String(row.activity_status),
    lastActivityAt: row.last_activity_at === null ? "" : String(row.last_activity_at),
  }));
}

async function querySummary(targetClient = client) {
  const result = await targetClient.execute({
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

before(async () => {
  client = createClient({ url: "file::memory:" });
  await client.executeMultiple(`
    CREATE TABLE auth_users (
      id TEXT PRIMARY KEY,
      normalized_email TEXT NOT NULL,
      last_login_at TEXT NOT NULL
    );
    CREATE TABLE auth_identity_links (
      auth_user_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE product_activity_events (
      event_id TEXT PRIMARY KEY,
      auth_user_id TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE credit_purchase_transactions (
      row_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL,
      verified_at TEXT
    );
    CREATE TABLE credit_balances (
      anon_user_id TEXT PRIMARY KEY,
      available_credits INTEGER NOT NULL DEFAULT 0,
      pending_credits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE credit_daily_usage (anon_user_id TEXT NOT NULL);
    CREATE TABLE credit_reservations (anon_user_id TEXT NOT NULL);
    CREATE TABLE credit_ledger_entries (anon_user_id TEXT NOT NULL);
    CREATE TABLE cookbook_recipes (anon_user_id TEXT NOT NULL);
    CREATE TABLE mobile_identity_aliases (
      anon_user_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );
    CREATE TABLE mobile_identity_links (
      device_key TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL
    );

    INSERT INTO auth_users VALUES
      ('login-only-linked', 'login@example.com', '2026-07-29T11:59:00.000Z'),
      ('recent-free-unlinked', 'recent-free@example.com', '2026-01-01T00:00:00.000Z'),
      ('old-free-linked', 'old-free@example.com', '2026-07-29T11:00:00.000Z'),
      ('recent-paying-linked', 'recent-paying@example.com', '2026-01-01T00:00:00.000Z'),
      ('old-paying-linked', 'old-paying@example.com', '2026-07-29T11:30:00.000Z'),
      ('durable-paying-unlinked', 'durable-paying@example.com', '2026-01-01T00:00:00.000Z'),
      ('boundary-free-linked', 'boundary-free@example.com', '2026-01-01T00:00:00.000Z');

    INSERT INTO auth_identity_links VALUES
      ('login-only-linked', 'anon-login'),
      ('old-free-linked', 'anon-old-free'),
      ('recent-paying-linked', 'anon-recent-paying'),
      ('old-paying-linked', 'anon-old-paying'),
      ('boundary-free-linked', 'anon-boundary-free');

    INSERT INTO product_activity_events VALUES
      ('activity-recent-free', 'recent-free-unlinked', 'fusion_generation', '2026-07-29T10:00:00.000Z'),
      ('activity-recent-free-duplicate-source', 'recent-free-unlinked', 'reroll', '2026-07-28T10:00:00.000Z'),
      ('activity-old-free', 'old-free-linked', 'fusion_generation', '2026-07-20T10:00:00.000Z'),
      ('activity-durable-purchase', 'durable-paying-unlinked', 'credit_purchase', '2026-07-29T11:00:00.000Z'),
      ('activity-boundary-free', 'boundary-free-linked', 'cookbook_save', '2026-07-22T12:00:00.000Z');

    INSERT INTO credit_purchase_transactions VALUES
      ('purchase-recent', 'anon-recent-paying', '2026-07-29T09:00:00.000Z'),
      ('purchase-recent-second', 'anon-recent-paying', '2026-07-28T09:00:00.000Z'),
      ('purchase-old', 'anon-old-paying', '2026-07-20T09:00:00.000Z'),
      ('purchase-unverified', 'anon-login', NULL);
  `);
});

after(async () => {
  client.close();
});

test("classifies never-active, free-only, and paying users from authoritative sources", async () => {
  const rows = await queryUsers();
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.deepEqual(byId.get("login-only-linked"), {
    id: "login-only-linked",
    linkStatus: "linked",
    userType: "no_activity",
    activityStatus: "never_active",
    lastActivityAt: "",
  });
  assert.equal(byId.get("recent-free-unlinked")?.userType, "free_only");
  assert.equal(byId.get("recent-free-unlinked")?.activityStatus, "active");
  assert.equal(byId.get("old-free-linked")?.userType, "free_only");
  assert.equal(byId.get("old-free-linked")?.activityStatus, "inactive");
  assert.equal(byId.get("recent-paying-linked")?.userType, "paying");
  assert.equal(byId.get("recent-paying-linked")?.activityStatus, "active");
  assert.equal(byId.get("old-paying-linked")?.userType, "paying");
  assert.equal(byId.get("old-paying-linked")?.activityStatus, "inactive");
  assert.equal(byId.get("durable-paying-unlinked")?.userType, "paying");
  assert.equal(byId.get("durable-paying-unlinked")?.activityStatus, "active");
  assert.equal(byId.get("boundary-free-linked")?.userType, "free_only");
  assert.equal(byId.get("boundary-free-linked")?.activityStatus, "inactive");
});

test("overall summary counts each user once and ignores list scope", async () => {
  const page = await queryUsers("u.id = ?", ["recent-free-unlinked"]);
  assert.equal(page.length, 1);
  assert.deepEqual(await querySummary(), {
    totalUsers: 7,
    payingUsers: 3,
    activeUsers: 3,
    inactiveUsers: 3,
    needsAttention: 7,
    completeAccounts: 0,
    setupMissing: 2,
    sharedIdentity: 0,
    splitData: 0,
    invalidIdentity: 5,
  });
});

test("new meaningful activity changes an inactive user back to active", async () => {
  await client.execute({
    sql: `INSERT INTO product_activity_events
          (event_id, auth_user_id, activity_type, occurred_at)
          VALUES (?, ?, ?, ?)`,
    args: [
      "activity-old-free-returned",
      "old-free-linked",
      "cookbook_save",
      "2026-07-29T11:00:00.000Z",
    ],
  });

  const [row] = await queryUsers("u.id = ?", ["old-free-linked"]);
  assert.equal(row.activityStatus, "active");
  assert.equal(row.lastActivityAt, "2026-07-29T11:00:00.000Z");
});

test("login and link status never determine engagement classification", async () => {
  const rows = await queryUsers("u.id IN (?, ?)", [
    "login-only-linked",
    "recent-free-unlinked",
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.equal(byId.get("login-only-linked")?.linkStatus, "linked");
  assert.equal(byId.get("login-only-linked")?.activityStatus, "never_active");
  assert.equal(byId.get("recent-free-unlinked")?.linkStatus, "unlinked");
  assert.equal(byId.get("recent-free-unlinked")?.activityStatus, "active");
});

test("combined engagement and link filters select the matching users", async () => {
  const where = [
    getAdminUserTypeWhereClause("free_only"),
    getAdminUserActivityStatusWhereClause("active"),
    "ail.canonical_anon_user_id IS NULL",
  ].map((clause) => `(${clause})`).join(" AND ");

  const rows = await queryUsers(where);
  assert.deepEqual(rows.map((row) => row.id), ["recent-free-unlinked"]);
});

test("filter parsing defaults to all and the threshold is exactly seven days", () => {
  assert.equal(parseAdminUserTypeFilter("paying"), "paying");
  assert.equal(parseAdminUserTypeFilter("invalid"), "all");
  assert.equal(parseAdminUserActivityStatusFilter("never_active"), "never_active");
  assert.equal(parseAdminUserActivityStatusFilter(null), "all");
  assert.equal(
    getAdminUserActivityCutoffIso(new Date("2026-07-29T12:00:00.000Z")),
    cutoff,
  );
});

test("overall summary returns zero for every metric when there are no users", async () => {
  const emptyClient = createClient({ url: "file::memory:" });
  try {
    await emptyClient.executeMultiple(`
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        normalized_email TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
      CREATE TABLE auth_identity_links (
        auth_user_id TEXT PRIMARY KEY,
        canonical_anon_user_id TEXT NOT NULL
      );
      CREATE TABLE product_activity_events (
        event_id TEXT PRIMARY KEY,
        auth_user_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE credit_purchase_transactions (
        row_id TEXT PRIMARY KEY,
        anon_user_id TEXT NOT NULL,
        verified_at TEXT
      );
      CREATE TABLE credit_balances (
        anon_user_id TEXT PRIMARY KEY,
        available_credits INTEGER NOT NULL DEFAULT 0,
        pending_credits INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE credit_daily_usage (anon_user_id TEXT NOT NULL);
      CREATE TABLE credit_reservations (anon_user_id TEXT NOT NULL);
      CREATE TABLE credit_ledger_entries (anon_user_id TEXT NOT NULL);
      CREATE TABLE cookbook_recipes (anon_user_id TEXT NOT NULL);
      CREATE TABLE mobile_identity_aliases (
        anon_user_id TEXT PRIMARY KEY,
        canonical_anon_user_id TEXT NOT NULL
      );
      CREATE TABLE mobile_identity_links (
        device_key TEXT PRIMARY KEY,
        canonical_anon_user_id TEXT NOT NULL
      );
    `);

    assert.deepEqual(await querySummary(emptyClient), {
      totalUsers: 0,
      payingUsers: 0,
      activeUsers: 0,
      inactiveUsers: 0,
      needsAttention: 0,
      completeAccounts: 0,
      setupMissing: 0,
      sharedIdentity: 0,
      splitData: 0,
      invalidIdentity: 0,
    });
  } finally {
    emptyClient.close();
  }
});
