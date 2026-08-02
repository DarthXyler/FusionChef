/**
 * /api/admin/monetization/users
 * Admin-only logged-in user listing, CSV-export support, and batch credit grant workflow.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, randomUUID } from "crypto";
import {
  assertAccountDeletionDoesNotIncludeActor,
  requireAccountDeletionAdmin,
} from "@/lib/account-deletion-authorization";
import {
  getAdminUserLinkStatus,
  parseAdminUserLinkStatus,
  type AdminUserRowLinkStatus,
} from "@/lib/admin-user-link-status";
import {
  ADMIN_USER_ACCOUNT_SETUP_ISSUE_SQL,
  ADMIN_USER_ACCOUNT_SETUP_SQL,
  ADMIN_USER_IDENTITY_HEALTH_CTES_SQL,
  ADMIN_USER_IDENTITY_HEALTH_JOIN_SQL,
  ADMIN_USER_SUMMARY_SQL,
  getAdminUserAccountSetupWhereClause,
  getAdminUserIdentityIssueWhereClause,
  parseAdminUserAccountSetup,
  parseAdminUserAccountSetupFilter,
  parseAdminUserIdentityIssue,
  parseAdminUserIdentityIssueFilter,
  type AdminUserAccountSetup,
  type AdminUserIdentityIssue,
  type AdminUserSummary,
} from "@/lib/admin-user-identity-health";
import {
  ADMIN_USER_ACTIVITY_STATUS_SQL,
  ADMIN_USER_ENGAGEMENT_CTES_SQL,
  ADMIN_USER_ENGAGEMENT_JOINS_SQL,
  ADMIN_USER_INACTIVITY_DAYS,
  ADMIN_USER_LAST_ACTIVITY_SQL,
  ADMIN_USER_TYPE_SQL,
  getAdminUserActivityCutoffIso,
  getAdminUserActivityStatusWhereClause,
  getAdminUserTypeWhereClause,
  parseAdminUserActivityStatusFilter,
  parseAdminUserTypeFilter,
  type AdminUserActivityStatus,
  type AdminUserType,
} from "@/lib/admin-user-engagement";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { getMonetizationRuntimeConfig } from "@/lib/monetization-config";
import { grantCredits } from "@/lib/monetization-ledger";
import { ensureProductActivitySchema } from "@/lib/product-activity";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";
import {
  beginIdempotentRequest,
  clearIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKeyFromHeaders,
  type IdempotencyContext,
} from "@/lib/idempotency";
import { executeTurso, executeTursoBatch } from "@/lib/turso";
import {
  buildPurchaseReconciliationAccountDeletionStatement,
} from "@/lib/purchase-settlement-retention";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;
const MAX_BATCH_IDENTIFIERS = 10_000;
const MAX_BODY_BYTES = 700_000;
const RESOLVE_CHUNK_SIZE = 300;

type ResolvedUser = {
  authUserId: string;
  email: string;
  normalizedEmail: string;
  name: string;
  role: string;
  provider: string;
  canonicalAnonUserId: string;
  linkStatus: AdminUserRowLinkStatus;
  accountSetup: AdminUserAccountSetup;
  accountSetupIssue: AdminUserIdentityIssue | null;
  availableCredits: number;
  pendingCredits: number;
  purchaseCount: number;
  cookbookCount: number;
  userType: AdminUserType;
  activityStatus: AdminUserActivityStatus;
  lastActivityAt: string;
};

type BatchGrantTarget = {
  input: string;
  status: "ready" | "missing" | "ambiguous" | "duplicate_input" | "duplicate_target";
  message: string;
  user: ResolvedUser | null;
};

type DeleteTarget = {
  input: string;
  status:
    | "ready"
    | "missing"
    | "ambiguous"
    | "duplicate_input"
    | "duplicate_target"
    | "blocked_shared_identity";
  message: string;
  user: ResolvedUser | null;
  linkedAuthUsers: Array<{ authUserId: string; email: string }>;
  counts: AccountDeletionCounts;
};

type AccountDeletionCounts = {
  authUsers: number;
  identityLinks: number;
  mobileDeviceLinks: number;
  mobileAliases: number;
  cookbookRecipes: number;
  creditBalanceRows: number;
  creditReservations: number;
  creditLedgerEntries: number;
  dailyUsageRows: number;
  purchaseTransactionsPreserved: number;
};

class RequestValidationError extends Error {}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asInteger(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value.trim());
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeIdentifier(value: string) {
  const trimmed = value.trim();
  return trimmed.includes("@") ? normalizeEmail(trimmed) : trimmed;
}

function parseCursor(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isObjectRecord(parsed)) {
      return null;
    }
    const lastLoginAt = asString(parsed.lastLoginAt);
    const authUserId = asString(parsed.authUserId);
    const activityCutoff = asString(parsed.activityCutoff);
    return lastLoginAt && authUserId && Number.isFinite(Date.parse(activityCutoff))
      ? { lastLoginAt, authUserId, activityCutoff }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(row: {
  lastLoginAt: string;
  authUserId: string;
  activityCutoff: string;
}) {
  return Buffer.from(JSON.stringify(row), "utf8").toString("base64url");
}

async function ensureAdminUserSchemas() {
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      normalized_email TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_url TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      role TEXT NOT NULL,
      last_login_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE INDEX IF NOT EXISTS idx_auth_users_normalized_email
     ON auth_users(normalized_email)`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS auth_identity_links (
      auth_user_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE INDEX IF NOT EXISTS idx_auth_identity_links_canonical
     ON auth_identity_links (canonical_anon_user_id)`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS credit_balances (
      anon_user_id TEXT PRIMARY KEY,
      available_credits INTEGER NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
      pending_credits INTEGER NOT NULL DEFAULT 0 CHECK(pending_credits >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS credit_purchase_transactions (
      row_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK(provider IN ('apple_app_store','google_play')),
      provider_transaction_id TEXT NOT NULL,
      provider_original_transaction_id TEXT,
      anon_user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('verified','rejected','revoked','reversal_pending')),
      granted_credits INTEGER NOT NULL DEFAULT 0 CHECK(granted_credits >= 0),
      reversed_credits INTEGER NOT NULL DEFAULT 0 CHECK(reversed_credits >= 0),
      outstanding_reversal_credits INTEGER NOT NULL DEFAULT 0 CHECK(outstanding_reversal_credits >= 0),
      risk_flags_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      verified_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider, provider_transaction_id)
    )`,
  );
  await executeTurso(
    `CREATE INDEX IF NOT EXISTS idx_credit_purchase_user_created
     ON credit_purchase_transactions (anon_user_id, created_at DESC)`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS cookbook_recipes (
      row_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_json TEXT NOT NULL,
      source_input_json TEXT NOT NULL,
      image_url TEXT,
      saved_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(anon_user_id, recipe_id)
    )`,
  );
  await executeTurso(
    `CREATE INDEX IF NOT EXISTS idx_cookbook_user_saved
     ON cookbook_recipes (anon_user_id, saved_at DESC)`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS mobile_identity_links (
      device_key TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS mobile_identity_aliases (
      anon_user_id TEXT PRIMARY KEY,
      canonical_anon_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS credit_reservations (
      reservation_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL,
      action_kind TEXT NOT NULL CHECK(action_kind IN ('fuse','reroll')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
      idempotency_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS credit_ledger_entries (
      entry_id TEXT PRIMARY KEY,
      anon_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action_kind TEXT,
      amount INTEGER NOT NULL,
      balance_available_after INTEGER NOT NULL,
      balance_pending_after INTEGER NOT NULL,
      reservation_id TEXT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      idempotency_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS credit_daily_usage (
      anon_user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      timezone TEXT NOT NULL,
      fuse_count INTEGER NOT NULL DEFAULT 0 CHECK(fuse_count >= 0),
      reroll_count INTEGER NOT NULL DEFAULT 0 CHECK(reroll_count >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (anon_user_id, day_key)
    )`,
  );
  await executeTurso(
    `CREATE TABLE IF NOT EXISTS account_deletion_events (
      deletion_id TEXT PRIMARY KEY,
      auth_user_id TEXT NOT NULL,
      canonical_anon_user_id TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      counts_json TEXT NOT NULL,
      purchase_transactions_preserved INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  await executeTurso(
    `CREATE INDEX IF NOT EXISTS idx_account_deletion_events_deleted_at
     ON account_deletion_events (deleted_at DESC)`,
  );
  await executeTurso(
    `CREATE INDEX IF NOT EXISTS idx_account_deletion_events_email_hash
     ON account_deletion_events (email_hash)`,
  );
  await ensureProductActivitySchema();
}

function rowToResolvedUser(row: Record<string, unknown>): ResolvedUser {
  return {
    authUserId: asString(row.auth_user_id),
    email: asString(row.email),
    normalizedEmail: asString(row.normalized_email),
    name: asString(row.name),
    role: asString(row.role),
    provider: asString(row.provider),
    canonicalAnonUserId: asString(row.canonical_anon_user_id),
    linkStatus: getAdminUserLinkStatus(asString(row.canonical_anon_user_id)),
    accountSetup: parseAdminUserAccountSetup(asString(row.account_setup)),
    accountSetupIssue: parseAdminUserIdentityIssue(
      asString(row.account_setup_issue),
    ),
    availableCredits: asInteger(row.available_credits),
    pendingCredits: asInteger(row.pending_credits),
    purchaseCount: asInteger(row.purchase_count),
    cookbookCount: asInteger(row.cookbook_count),
    userType: asString(row.user_type) as AdminUserType,
    activityStatus: asString(row.activity_status) as AdminUserActivityStatus,
    lastActivityAt: asString(row.last_activity_at),
  };
}

function buildUserSelectSql(whereSql: string) {
  return `${ADMIN_USER_ENGAGEMENT_CTES_SQL}
    ${ADMIN_USER_IDENTITY_HEALTH_CTES_SQL}
    SELECT
      u.id AS auth_user_id,
      u.email,
      u.normalized_email,
      u.name,
      u.role,
      u.provider,
      u.last_login_at,
      u.created_at,
      ail.canonical_anon_user_id,
      COALESCE(cb.available_credits, 0) AS available_credits,
      COALESCE(cb.pending_credits, 0) AS pending_credits,
      COALESCE((
        SELECT COUNT(*)
        FROM credit_purchase_transactions p
        WHERE p.anon_user_id = ail.canonical_anon_user_id
          AND p.status IN ('verified','reversal_pending')
      ), 0) AS purchase_count,
      COALESCE((
        SELECT COUNT(*)
        FROM cookbook_recipes cr
        WHERE cr.anon_user_id = ail.canonical_anon_user_id
      ), 0) AS cookbook_count,
      ${ADMIN_USER_TYPE_SQL} AS user_type,
      ${ADMIN_USER_ACTIVITY_STATUS_SQL} AS activity_status,
      ${ADMIN_USER_LAST_ACTIVITY_SQL} AS last_activity_at,
      ${ADMIN_USER_ACCOUNT_SETUP_SQL} AS account_setup,
      ${ADMIN_USER_ACCOUNT_SETUP_ISSUE_SQL} AS account_setup_issue
    FROM auth_users u
    ${ADMIN_USER_IDENTITY_HEALTH_JOIN_SQL}
    LEFT JOIN credit_balances cb ON cb.anon_user_id = ail.canonical_anon_user_id
    ${ADMIN_USER_ENGAGEMENT_JOINS_SQL}
    ${whereSql}`;
}

async function loadAdminUserSummary(activityCutoff: string): Promise<AdminUserSummary> {
  const result = await executeTurso({
    sql: ADMIN_USER_SUMMARY_SQL,
    args: [activityCutoff],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return {
    totalUsers: asInteger(row?.total_users),
    payingUsers: asInteger(row?.paying_users),
    activeUsers: asInteger(row?.active_users),
    inactiveUsers: asInteger(row?.inactive_users),
    needsAttention: asInteger(row?.needs_attention),
    completeAccounts: asInteger(row?.complete_accounts),
    setupMissing: asInteger(row?.setup_missing),
    sharedIdentity: asInteger(row?.shared_identity),
    splitData: asInteger(row?.split_data),
    invalidIdentity: asInteger(row?.invalid_identity),
  };
}

function getDeletionAuditHashSecret() {
  return (
    process.env.AUTH_SESSION_SECRET?.trim() ||
    process.env.INTERNAL_API_TOKEN?.trim() ||
    process.env.MONETIZATION_ADMIN_TOKEN?.trim() ||
    "local-account-deletion-audit"
  );
}

function hashDeletedEmail(email: string) {
  return createHmac("sha256", getDeletionAuditHashSecret())
    .update(normalizeEmail(email))
    .digest("base64url");
}

export async function GET(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-users-read",
    limit: 120,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  try {
    const params = request.nextUrl.searchParams;
    const includeSummary = params.get("includeSummary") === "true";
    const limit = Math.max(
      1,
      Math.min(MAX_LIST_LIMIT, Number.parseInt(params.get("limit") ?? String(DEFAULT_LIST_LIMIT), 10)),
    );
    const cursor = parseCursor(params.get("cursor"));
    const search = normalizeIdentifier(params.get("search") ?? "");
    const role = params.get("role") ?? "all";
    const payment = params.get("payment") ?? "all";
    const cookbook = params.get("cookbook") ?? "all";
    const userType = parseAdminUserTypeFilter(params.get("userType"));
    const activityStatus = parseAdminUserActivityStatusFilter(params.get("activityStatus"));
    const accountSetup = parseAdminUserAccountSetupFilter(params.get("accountSetup"));
    const issueReason = parseAdminUserIdentityIssueFilter(params.get("issueReason"));
    const linkStatus = parseAdminUserLinkStatus(params.get("linkStatus"));
    const minCredits = params.get("minCredits");
    const maxCredits = params.get("maxCredits");
    const lastLoginSince = params.get("lastLoginSince")?.trim() ?? "";

    // The cursor freezes the inactivity cutoff so pagination and CSV export do
    // not change classification while an admin is traversing the result set.
    const activityCutoff = cursor?.activityCutoff ?? getAdminUserActivityCutoffIso();

    // Admin users can be filtered by engagement, identity, payment state,
    // cookbook usage, credits, and login recency without loading everyone into memory.
    const where: string[] = ["1 = 1"];
    const args: Array<string | number> = [activityCutoff];

    if (cursor) {
      where.push("(u.last_login_at < ? OR (u.last_login_at = ? AND u.id < ?))");
      args.push(cursor.lastLoginAt, cursor.lastLoginAt, cursor.authUserId);
    }
    if (search) {
      const like = `%${search}%`;
      where.push(
        "(u.normalized_email LIKE ? OR lower(u.name) LIKE ? OR u.id = ? OR ail.canonical_anon_user_id = ?)",
      );
      args.push(like, like, search, search);
    }
    if (role === "user" || role === "admin") {
      where.push("u.role = ?");
      args.push(role);
    }
    const userTypeWhere = getAdminUserTypeWhereClause(userType);
    if (userTypeWhere) {
      where.push(`(${userTypeWhere})`);
    }
    const activityStatusWhere = getAdminUserActivityStatusWhereClause(activityStatus);
    if (activityStatusWhere) {
      where.push(`(${activityStatusWhere})`);
    }
    const accountSetupWhere = getAdminUserAccountSetupWhereClause(accountSetup);
    if (accountSetupWhere) {
      where.push(`(${accountSetupWhere})`);
    }
    const issueReasonWhere = getAdminUserIdentityIssueWhereClause(issueReason);
    if (issueReasonWhere) {
      where.push(`(${issueReasonWhere})`);
    }
    if (!params.has("accountSetup") && linkStatus === "linked") {
      where.push("ail.canonical_anon_user_id IS NOT NULL");
    } else if (!params.has("accountSetup") && linkStatus === "unlinked") {
      where.push("ail.canonical_anon_user_id IS NULL");
    }
    if (payment === "paying") {
      where.push(`EXISTS (
        SELECT 1 FROM credit_purchase_transactions p
        WHERE p.anon_user_id = ail.canonical_anon_user_id
          AND p.status IN ('verified','reversal_pending')
      )`);
    } else if (payment === "non_paying") {
      where.push(`NOT EXISTS (
        SELECT 1 FROM credit_purchase_transactions p
        WHERE p.anon_user_id = ail.canonical_anon_user_id
          AND p.status IN ('verified','reversal_pending')
      )`);
    }
    if (cookbook === "has_saved") {
      where.push(`EXISTS (
        SELECT 1 FROM cookbook_recipes cr
        WHERE cr.anon_user_id = ail.canonical_anon_user_id
      )`);
    } else if (cookbook === "none_saved") {
      where.push(`NOT EXISTS (
        SELECT 1 FROM cookbook_recipes cr
        WHERE cr.anon_user_id = ail.canonical_anon_user_id
      )`);
    }
    if (minCredits !== null && minCredits.trim() !== "") {
      where.push("COALESCE(cb.available_credits, 0) >= ?");
      args.push(asInteger(minCredits));
    }
    if (maxCredits !== null && maxCredits.trim() !== "") {
      where.push("COALESCE(cb.available_credits, 0) <= ?");
      args.push(asInteger(maxCredits));
    }
    if (lastLoginSince) {
      where.push("u.last_login_at >= ?");
      args.push(lastLoginSince);
    }

    const listPromise = executeTurso({
      sql: `${buildUserSelectSql(`WHERE ${where.join(" AND ")}`)}
            ORDER BY u.last_login_at DESC, u.id DESC
            LIMIT ?`,
      args: [...args, limit + 1],
    });
    const summaryPromise = includeSummary
      ? loadAdminUserSummary(activityCutoff)
          .then((summary) => ({ summary, summaryError: "" }))
          .catch((error: unknown) => {
            logMonetizationAudit({
              requestId: admin.context.requestId,
              event: "admin_user_summary_load_failed",
              actor: admin.context.actor,
              errorName: error instanceof Error ? error.name : "unknown",
            });
            return {
              summary: null,
              summaryError: "Could not load overall user summary.",
            };
          })
      : Promise.resolve({
          summary: null,
          summaryError: "",
        });
    const [result, summaryResult] = await Promise.all([listPromise, summaryPromise]);

    const rows = result.rows.map((row) => row as Record<string, unknown>);
    const pageRows = rows.slice(0, limit);
    const users = pageRows.map((row) => ({
      ...rowToResolvedUser(row),
      lastLoginAt: asString(row.last_login_at),
      createdAt: asString(row.created_at),
    }));
    const last = pageRows[pageRows.length - 1];
    const response = NextResponse.json({
      users,
      summary: summaryResult.summary,
      summaryError: summaryResult.summaryError,
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              lastLoginAt: asString(last.last_login_at),
              authUserId: asString(last.auth_user_id),
              activityCutoff,
            })
          : null,
      filters: {
        search,
        role,
        payment,
        cookbook,
        userType,
        activityStatus,
        accountSetup,
        issueReason,
        linkStatus,
        minCredits,
        maxCredits,
        lastLoginSince,
      },
      inactivityThresholdDays: ADMIN_USER_INACTIVITY_DAYS,
      activityCutoff,
      maxPageSize: MAX_LIST_LIMIT,
    });
    withNoStore(response);
    return response;
  } catch {
    return NextResponse.json({ error: "Could not load users." }, { status: 500 });
  }
}

function parseBatchPayload(body: unknown) {
  if (!isObjectRecord(body)) {
    throw new RequestValidationError("Invalid request body.");
  }
  const mode: "dry_run" | "commit" | "" =
    body.mode === "commit" ? "commit" : body.mode === "dry_run" ? "dry_run" : "";
  if (!mode) {
    throw new RequestValidationError("mode must be dry_run or commit.");
  }
  const amount = asInteger(body.amount);
  if (amount < 1 || amount > 100_000) {
    throw new RequestValidationError("amount must be between 1 and 100000.");
  }
  const reason = asString(body.reason).trim().slice(0, 500);
  if (mode === "commit" && !reason) {
    throw new RequestValidationError("reason is required before granting credits.");
  }
  const batchLabel = asString(body.batchLabel).trim().slice(0, 120);
  const rawIdentifiers = Array.isArray(body.identifiers)
    ? body.identifiers.map((value) => asString(value))
    : asString(body.identifiersText).split(/[\n,;\t ]+/);
  // Batch grants accept pasted emails/user IDs so support can handle one user
  // or a large list with the same dry-run/commit flow.
  const identifiers = rawIdentifiers.map((value) => value.trim()).filter(Boolean);
  if (identifiers.length < 1) {
    throw new RequestValidationError("At least one email or user id is required.");
  }
  if (identifiers.length > MAX_BATCH_IDENTIFIERS) {
    throw new RequestValidationError(`Batch cannot exceed ${MAX_BATCH_IDENTIFIERS} identifiers.`);
  }
  return { mode, amount, reason, batchLabel, identifiers };
}

function parseDeletePayload(body: unknown) {
  if (!isObjectRecord(body)) {
    throw new RequestValidationError("Invalid request body.");
  }
  const mode: "dry_run" | "commit" | "" =
    body.mode === "commit" ? "commit" : body.mode === "dry_run" ? "dry_run" : "";
  if (!mode) {
    throw new RequestValidationError("mode must be dry_run or commit.");
  }
  const reason = asString(body.reason).trim().slice(0, 500);
  if (mode === "commit" && !reason) {
    throw new RequestValidationError("reason is required before deleting an account.");
  }
  const confirmation = asString(body.confirmation).trim();
  if (mode === "commit" && confirmation !== "DELETE") {
    throw new RequestValidationError("confirmation must be DELETE.");
  }
  const rawIdentifiers = Array.isArray(body.identifiers)
    ? body.identifiers.map((value) => asString(value))
    : asString(body.identifiersText).split(/[\n,;\t ]+/);
  const identifiers = rawIdentifiers.map((value) => value.trim()).filter(Boolean);
  if (identifiers.length < 1) {
    throw new RequestValidationError("At least one email or user id is required.");
  }
  if (identifiers.length > MAX_BATCH_IDENTIFIERS) {
    throw new RequestValidationError(`Batch cannot exceed ${MAX_BATCH_IDENTIFIERS} identifiers.`);
  }
  return { mode, reason, confirmation, identifiers };
}

async function fetchResolvedUsers(column: "normalized_email" | "id" | "canonical", values: string[]) {
  const output = new Map<string, ResolvedUser[]>();
  for (let index = 0; index < values.length; index += RESOLVE_CHUNK_SIZE) {
    const chunk = values.slice(index, index + RESOLVE_CHUNK_SIZE);
    if (chunk.length === 0) {
      continue;
    }
    const placeholders = chunk.map(() => "?").join(", ");
    const where =
      column === "canonical"
        ? `ail.canonical_anon_user_id IN (${placeholders})`
        : `u.${column} IN (${placeholders})`;
    const result = await executeTurso({
      sql: buildUserSelectSql(`WHERE ${where}`),
      args: [getAdminUserActivityCutoffIso(), ...chunk],
    });
    for (const row of result.rows) {
      const record = rowToResolvedUser(row as Record<string, unknown>);
      const keys =
        column === "normalized_email"
          ? [record.normalizedEmail]
          : column === "id"
            ? [record.authUserId]
            : [record.canonicalAnonUserId];
      for (const key of keys) {
        if (!key) {
          continue;
        }
        const existing = output.get(key) ?? [];
        existing.push(record);
        output.set(key, existing);
      }
    }
  }
  return output;
}

async function resolveBatchTargets(identifiers: string[]) {
  const seenInputs = new Set<string>();
  const normalizedInputs = identifiers.map((input) => ({
    input,
    key: normalizeIdentifier(input),
  }));
  const emails = [...new Set(normalizedInputs.filter((item) => item.key.includes("@")).map((item) => item.key))];
  const uuids = [...new Set(normalizedInputs.filter((item) => isUuid(item.key)).map((item) => item.key))];
  const [emailMatches, authIdMatches, anonIdMatches] = await Promise.all([
    fetchResolvedUsers("normalized_email", emails),
    fetchResolvedUsers("id", uuids),
    fetchResolvedUsers("canonical", uuids),
  ]);

  const targets: BatchGrantTarget[] = [];
  const targetAnonIds = new Set<string>();
  for (const item of normalizedInputs) {
    if (seenInputs.has(item.key)) {
      targets.push({
        input: item.input,
        status: "duplicate_input",
        message: "Duplicate input row.",
        user: null,
      });
      continue;
    }
    seenInputs.add(item.key);

    const matches = item.key.includes("@")
      ? emailMatches.get(item.key) ?? []
      : [...(authIdMatches.get(item.key) ?? []), ...(anonIdMatches.get(item.key) ?? [])];
    const uniqueMatches = Array.from(
      new Map(matches.map((record) => [record.authUserId, record])).values(),
    );

    if (uniqueMatches.length === 0) {
      targets.push({
        input: item.input,
        status: "missing",
        message: "No logged-in user found.",
        user: null,
      });
      continue;
    }
    if (uniqueMatches.length > 1) {
      targets.push({
        input: item.input,
        status: "ambiguous",
        message: "Identifier matched more than one logged-in user.",
        user: null,
      });
      continue;
    }

    const user = uniqueMatches[0];
    if (!user.canonicalAnonUserId) {
      targets.push({
        input: item.input,
        status: "missing",
        message: "User has not opened the app with this account yet.",
        user,
      });
      continue;
    }
    if (targetAnonIds.has(user.canonicalAnonUserId)) {
      targets.push({
        input: item.input,
        status: "duplicate_target",
        message: "Another row already targets this credit account.",
        user,
      });
      continue;
    }
    targetAnonIds.add(user.canonicalAnonUserId);
    targets.push({
      input: item.input,
      status: "ready",
      message: "Ready to grant.",
      user,
    });
  }
  return targets;
}

async function getLinkedAuthUsers(canonicalAnonUserId: string) {
  if (!canonicalAnonUserId) {
    return [] as Array<{ authUserId: string; email: string }>;
  }
  const result = await executeTurso({
    sql: `SELECT u.id AS auth_user_id, u.email
          FROM auth_identity_links ail
          JOIN auth_users u ON u.id = ail.auth_user_id
          WHERE ail.canonical_anon_user_id = ?
          ORDER BY u.email ASC`,
    args: [canonicalAnonUserId],
  });
  return result.rows.map((row) => ({
    authUserId: asString((row as Record<string, unknown>).auth_user_id),
    email: asString((row as Record<string, unknown>).email),
  }));
}

async function getAccountDeletionCounts(user: ResolvedUser): Promise<AccountDeletionCounts> {
  const canonical = user.canonicalAnonUserId;
  const authUserId = user.authUserId;
  const result = await executeTurso({
    sql: `SELECT
            (SELECT COUNT(*) FROM auth_users WHERE id = ?) AS auth_users,
            (SELECT COUNT(*) FROM auth_identity_links WHERE auth_user_id = ? OR canonical_anon_user_id = ?) AS identity_links,
            (SELECT COUNT(*) FROM mobile_identity_links WHERE canonical_anon_user_id = ?) AS mobile_device_links,
            (SELECT COUNT(*) FROM mobile_identity_aliases WHERE anon_user_id = ? OR canonical_anon_user_id = ?) AS mobile_aliases,
            (SELECT COUNT(*) FROM cookbook_recipes WHERE anon_user_id = ?) AS cookbook_recipes,
            (SELECT COUNT(*) FROM credit_balances WHERE anon_user_id = ?) AS credit_balance_rows,
            (SELECT COUNT(*) FROM credit_reservations WHERE anon_user_id = ?) AS credit_reservations,
            (SELECT COUNT(*) FROM credit_ledger_entries WHERE anon_user_id = ?) AS credit_ledger_entries,
            (SELECT COUNT(*) FROM credit_daily_usage WHERE anon_user_id = ?) AS daily_usage_rows,
            (SELECT COUNT(*) FROM credit_purchase_transactions WHERE anon_user_id = ?) AS purchase_transactions_preserved`,
    args: [
      authUserId,
      authUserId,
      canonical,
      canonical,
      canonical,
      canonical,
      canonical,
      canonical,
      canonical,
      canonical,
      canonical,
      canonical,
    ],
  });
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    authUsers: asInteger(row.auth_users),
    identityLinks: asInteger(row.identity_links),
    mobileDeviceLinks: asInteger(row.mobile_device_links),
    mobileAliases: asInteger(row.mobile_aliases),
    cookbookRecipes: asInteger(row.cookbook_recipes),
    creditBalanceRows: asInteger(row.credit_balance_rows),
    creditReservations: asInteger(row.credit_reservations),
    creditLedgerEntries: asInteger(row.credit_ledger_entries),
    dailyUsageRows: asInteger(row.daily_usage_rows),
    purchaseTransactionsPreserved: asInteger(row.purchase_transactions_preserved),
  };
}

async function resolveDeleteTargets(identifiers: string[]) {
  const baseTargets = await resolveBatchTargets(identifiers);
  const readyAuthIds = new Set(
    baseTargets
      .filter((target) => (target.status === "ready" || target.status === "duplicate_target") && target.user)
      .map((target) => target.user?.authUserId ?? ""),
  );
  const output: DeleteTarget[] = [];
  for (const target of baseTargets) {
    const emptyCounts: AccountDeletionCounts = {
      authUsers: 0,
      identityLinks: 0,
      mobileDeviceLinks: 0,
      mobileAliases: 0,
      cookbookRecipes: 0,
      creditBalanceRows: 0,
      creditReservations: 0,
      creditLedgerEntries: 0,
      dailyUsageRows: 0,
      purchaseTransactionsPreserved: 0,
    };
    const canEvaluateDeletion =
      (target.status === "ready" || target.status === "duplicate_target") && target.user;
    if (!canEvaluateDeletion || !target.user) {
      output.push({
        ...target,
        status: target.status,
        linkedAuthUsers: [],
        counts: emptyCounts,
      });
      continue;
    }

    const [linkedAuthUsers, counts] = await Promise.all([
      getLinkedAuthUsers(target.user.canonicalAnonUserId),
      getAccountDeletionCounts(target.user),
    ]);
    const unselectedLinkedUsers = linkedAuthUsers.filter((linked) => !readyAuthIds.has(linked.authUserId));
    if (unselectedLinkedUsers.length > 0) {
      output.push({
        input: target.input,
        status: "blocked_shared_identity",
        message: "This account shares cookbook/credits with another signed-in account. Include all linked accounts or separate them first.",
        user: target.user,
        linkedAuthUsers,
        counts,
      });
      continue;
    }

    output.push({
      input: target.input,
      status: "ready",
      message: "Ready to delete.",
      user: target.user,
      linkedAuthUsers,
      counts,
    });
  }
  return output;
}

function buildBatchResponse(params: {
  mode: "dry_run" | "commit";
  amount: number;
  batchLabel: string;
  allowCompActions: boolean;
  targets: BatchGrantTarget[];
  grants?: unknown[];
}) {
  const ready = params.targets.filter((target) => target.status === "ready");
  return {
    mode: params.mode,
    batchLabel: params.batchLabel,
    allowCompActions: params.allowCompActions,
    amount: params.amount,
    summary: {
      totalInputs: params.targets.length,
      ready: ready.length,
      missing: params.targets.filter((target) => target.status === "missing").length,
      ambiguous: params.targets.filter((target) => target.status === "ambiguous").length,
      duplicateInputs: params.targets.filter((target) => target.status === "duplicate_input").length,
      duplicateTargets: params.targets.filter((target) => target.status === "duplicate_target").length,
      totalCredits: ready.length * params.amount,
      granted: params.grants?.length ?? 0,
    },
    targets: params.targets.slice(0, 500),
    previewTruncated: params.targets.length > 500,
    grants: params.grants ?? [],
  };
}

function sumDeletionCounts(targets: DeleteTarget[]) {
  const countedCanonicals = new Set<string>();
  return targets
    .filter((target) => {
      if (target.status !== "ready" || !target.user?.canonicalAnonUserId) {
        return false;
      }
      if (countedCanonicals.has(target.user.canonicalAnonUserId)) {
        return false;
      }
      countedCanonicals.add(target.user.canonicalAnonUserId);
      return true;
    })
    .reduce<AccountDeletionCounts>(
      (total, target) => ({
        authUsers: total.authUsers + target.counts.authUsers,
        identityLinks: total.identityLinks + target.counts.identityLinks,
        mobileDeviceLinks: total.mobileDeviceLinks + target.counts.mobileDeviceLinks,
        mobileAliases: total.mobileAliases + target.counts.mobileAliases,
        cookbookRecipes: total.cookbookRecipes + target.counts.cookbookRecipes,
        creditBalanceRows: total.creditBalanceRows + target.counts.creditBalanceRows,
        creditReservations: total.creditReservations + target.counts.creditReservations,
        creditLedgerEntries: total.creditLedgerEntries + target.counts.creditLedgerEntries,
        dailyUsageRows: total.dailyUsageRows + target.counts.dailyUsageRows,
        purchaseTransactionsPreserved:
          total.purchaseTransactionsPreserved + target.counts.purchaseTransactionsPreserved,
      }),
      {
        authUsers: 0,
        identityLinks: 0,
        mobileDeviceLinks: 0,
        mobileAliases: 0,
        cookbookRecipes: 0,
        creditBalanceRows: 0,
        creditReservations: 0,
        creditLedgerEntries: 0,
        dailyUsageRows: 0,
        purchaseTransactionsPreserved: 0,
      },
    );
}

function buildDeleteResponse(params: {
  mode: "dry_run" | "commit";
  targets: DeleteTarget[];
  deleted?: Array<{ authUserId: string; email: string; canonicalAnonUserId: string }>;
}) {
  return {
    operation: "account_delete",
    mode: params.mode,
    summary: {
      totalInputs: params.targets.length,
      ready: params.targets.filter((target) => target.status === "ready").length,
      missing: params.targets.filter((target) => target.status === "missing").length,
      ambiguous: params.targets.filter((target) => target.status === "ambiguous").length,
      blockedSharedIdentity: params.targets.filter((target) => target.status === "blocked_shared_identity").length,
      duplicateInputs: params.targets.filter((target) => target.status === "duplicate_input").length,
      duplicateTargets: params.targets.filter((target) => target.status === "duplicate_target").length,
      deleted: params.deleted?.length ?? 0,
      counts: sumDeletionCounts(params.targets),
    },
    targets: params.targets.slice(0, 500),
    previewTruncated: params.targets.length > 500,
    deleted: params.deleted ?? [],
  };
}

async function deleteReadyAccounts(params: {
  targets: Array<DeleteTarget & { user: ResolvedUser }>;
  actor: string;
  reason: string;
  batchId: string;
}) {
  const deleted: Array<{ authUserId: string; email: string; canonicalAnonUserId: string }> = [];
  const targetsByCanonical = new Map<string, Array<DeleteTarget & { user: ResolvedUser }>>();
  for (const target of params.targets) {
    const existing = targetsByCanonical.get(target.user.canonicalAnonUserId) ?? [];
    existing.push(target);
    targetsByCanonical.set(target.user.canonicalAnonUserId, existing);
  }

  for (const [canonical, canonicalTargets] of targetsByCanonical.entries()) {
    const primaryAuthUserId = canonicalTargets[0]?.user.authUserId ?? canonical;
    const authUserIds = [...new Set(canonicalTargets.map((target) => target.user.authUserId))];
    const authPlaceholders = authUserIds.map(() => "?").join(", ");
    const deletedPurchaseOwner = `deleted:${primaryAuthUserId}`;
    const deletionEventStatements = canonicalTargets.map((target) => ({
      sql: `INSERT INTO account_deletion_events (
              deletion_id,
              auth_user_id,
              canonical_anon_user_id,
              email_hash,
              provider,
              role,
              requested_by,
              reason,
              counts_json,
              purchase_transactions_preserved,
              idempotency_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        target.user.authUserId,
        canonical,
        hashDeletedEmail(target.user.email),
        target.user.provider || "unknown",
        target.user.role || "user",
        params.actor,
        params.reason,
        JSON.stringify(target.counts),
        target.counts.purchaseTransactionsPreserved,
        params.batchId,
      ],
    }));
    await executeTursoBatch([
      ...deletionEventStatements,
      buildPurchaseReconciliationAccountDeletionStatement(canonical),
      {
        sql: `UPDATE credit_purchase_transactions
              SET anon_user_id = ?, payload_json = '{}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE anon_user_id = ?`,
        args: [deletedPurchaseOwner, canonical],
      },
      { sql: `DELETE FROM cookbook_recipes WHERE anon_user_id = ?`, args: [canonical] },
      { sql: `DELETE FROM credit_balances WHERE anon_user_id = ?`, args: [canonical] },
      { sql: `DELETE FROM credit_reservations WHERE anon_user_id = ?`, args: [canonical] },
      { sql: `DELETE FROM credit_ledger_entries WHERE anon_user_id = ?`, args: [canonical] },
      { sql: `DELETE FROM credit_daily_usage WHERE anon_user_id = ?`, args: [canonical] },
      { sql: `DELETE FROM mobile_identity_links WHERE canonical_anon_user_id = ?`, args: [canonical] },
      {
        sql: `DELETE FROM mobile_identity_aliases
              WHERE anon_user_id = ? OR canonical_anon_user_id = ?`,
        args: [canonical, canonical],
      },
      {
        sql: `DELETE FROM auth_identity_links
              WHERE auth_user_id IN (${authPlaceholders}) OR canonical_anon_user_id = ?`,
        args: [...authUserIds, canonical],
      },
      {
        sql: `DELETE FROM product_activity_events
              WHERE auth_user_id IN (${authPlaceholders})`,
        args: authUserIds,
      },
      { sql: `DELETE FROM auth_users WHERE id IN (${authPlaceholders})`, args: authUserIds },
    ], 30_000);
    canonicalTargets.forEach((target) => {
      deleted.push({
        authUserId: target.user.authUserId,
        email: target.user.email,
        canonicalAnonUserId: canonical,
      });
    });
  }
  return deleted;
}

export async function POST(request: NextRequest) {
  const admin = requireMonetizationAdmin(request, { requireActor: true });
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-users-write",
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let idempotencyContext: IdempotencyContext | null = null;
  try {
    if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    const rawBody = (await request.json()) as unknown;
    const operation = isObjectRecord(rawBody) && rawBody.operation === "account_delete" ? "account_delete" : "credit_grant";
    const deletionAdmin =
      operation === "account_delete"
        ? await requireAccountDeletionAdmin(request)
        : null;
    if (deletionAdmin && !deletionAdmin.ok) {
      return deletionAdmin.response;
    }
    await ensureAdminUserSchemas();
    if (operation === "account_delete") {
      if (!deletionAdmin?.ok) {
        return NextResponse.json(
          {
            error: "Account deletion authorization is unavailable.",
            code: "account_deletion_authorization_unavailable",
          },
          { status: 503 },
        );
      }
      const payload = parseDeletePayload(rawBody);
      const targets = await resolveDeleteTargets(payload.identifiers);
      try {
        assertAccountDeletionDoesNotIncludeActor(
          deletionAdmin.context.actorAuthUserId,
          targets.flatMap((target) =>
            target.user ? [target.user.authUserId] : [],
          ),
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && "statusCode" in error) {
          const response = NextResponse.json(
            {
              error: error.message,
              code: String(error.code),
            },
            { status: Number(error.statusCode) },
          );
          withNoStore(response);
          return response;
        }
        throw error;
      }

      if (payload.mode === "dry_run") {
        const response = NextResponse.json(buildDeleteResponse({ mode: payload.mode, targets }));
        withNoStore(response);
        return response;
      }

      const ready = targets.filter(
        (target): target is DeleteTarget & { user: ResolvedUser } =>
          target.status === "ready" && target.user !== null,
      );
      if (ready.length < 1) {
        return NextResponse.json(
          { error: "No accounts are ready to delete. Run dry-run and resolve blocked rows first." },
          { status: 409 },
        );
      }
      if (targets.some((target) => target.status === "blocked_shared_identity")) {
        return NextResponse.json(
          { error: "One or more accounts share cookbook/credits with another account. Resolve the dry-run blockers first." },
          { status: 409 },
        );
      }

      const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
      if (!idempotencyKey) {
        return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
      }
      const idempotency = await beginIdempotentRequest({
        key: idempotencyKey,
        scope: "admin-monetization-users:account-delete",
        requestPayload: {
          actor: deletionAdmin.context.actor,
          reason: payload.reason,
          identifiers: payload.identifiers.map(normalizeIdentifier),
        },
      });
      if (idempotency.state === "in_progress") {
        return NextResponse.json({ error: "This delete request is already processing." }, { status: 409 });
      }
      if (idempotency.state === "conflict") {
        return NextResponse.json(
          { error: "Idempotency key was reused with a different delete request." },
          { status: 409 },
        );
      }
      if (idempotency.state === "replay") {
        const response = NextResponse.json(idempotency.responseBody, {
          status: idempotency.responseStatus,
        });
        response.headers.set("Idempotency-Status", "replayed");
        withNoStore(response);
        return response;
      }
      if (idempotency.state === "started") {
        idempotencyContext = idempotency.context;
      }

      const deleted = await deleteReadyAccounts({
        targets: ready,
        actor: deletionAdmin.context.actor,
        reason: payload.reason,
        batchId: idempotencyKey,
      });
      const responseBody = buildDeleteResponse({ mode: payload.mode, targets, deleted });
      if (idempotencyContext) {
        await completeIdempotentRequest(idempotencyContext, 200, responseBody);
      }
      logMonetizationAudit({
        requestId: deletionAdmin.context.requestId,
        event: "account_delete_succeeded",
        actor: deletionAdmin.context.actor,
        actorAuthUserId: deletionAdmin.context.actorAuthUserId,
        actorEmail: deletionAdmin.context.actorEmail,
        ip: deletionAdmin.context.ip,
        deleted: deleted.length,
      });
      const response = NextResponse.json(responseBody);
      response.headers.set("Idempotency-Status", idempotencyContext ? "stored" : "disabled");
      withNoStore(response);
      return response;
    }

    const payload = parseBatchPayload(rawBody);
    const runtimeConfig = await getMonetizationRuntimeConfig();
    const targets = await resolveBatchTargets(payload.identifiers);

    if (payload.mode === "dry_run") {
      const response = NextResponse.json(
        buildBatchResponse({
          mode: payload.mode,
          amount: payload.amount,
          batchLabel: payload.batchLabel,
          allowCompActions: runtimeConfig.allowCompActions,
          targets,
        }),
      );
      withNoStore(response);
      return response;
    }

    if (!runtimeConfig.allowCompActions) {
      return NextResponse.json(
        { error: "Manual credit grants are disabled by monetization policy." },
        { status: 409 },
      );
    }

    const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
    }
    const idempotency = await beginIdempotentRequest({
      key: idempotencyKey,
      scope: "admin-monetization-users:bulk-grant",
      requestPayload: {
        actor: admin.context.actor,
        amount: payload.amount,
        reason: payload.reason,
        batchLabel: payload.batchLabel,
        identifiers: payload.identifiers.map(normalizeIdentifier),
      },
    });
    if (idempotency.state === "in_progress") {
      return NextResponse.json({ error: "This batch is already processing." }, { status: 409 });
    }
    if (idempotency.state === "conflict") {
      return NextResponse.json(
        { error: "Idempotency key was reused with a different batch." },
        { status: 409 },
      );
    }
    if (idempotency.state === "replay") {
      const response = NextResponse.json(idempotency.responseBody, {
        status: idempotency.responseStatus,
      });
      response.headers.set("Idempotency-Status", "replayed");
      withNoStore(response);
      return response;
    }
    if (idempotency.state === "started") {
      idempotencyContext = idempotency.context;
    }

    const ready = targets.filter(
      (target): target is BatchGrantTarget & { user: ResolvedUser } =>
        target.status === "ready" && target.user !== null,
    );
    const batchId = idempotencyKey;
    const grants = [];
    for (const target of ready) {
      const grant = await grantCredits({
        anonUserId: target.user.canonicalAnonUserId,
        amount: payload.amount,
        actor: admin.context.actor,
        reason: payload.reason,
        idempotencyScope: "admin-bulk-credit-grant",
        idempotencyKey: `${batchId}:${target.user.canonicalAnonUserId}`,
        metadata: {
          batchId,
          batchLabel: payload.batchLabel,
          sourceInput: target.input,
          authUserId: target.user.authUserId,
          email: target.user.email,
        },
      });
      grants.push({
        authUserId: target.user.authUserId,
        email: target.user.email,
        canonicalAnonUserId: target.user.canonicalAnonUserId,
        balance: grant.balance,
        ledgerEntryId: grant.ledgerEntry.entryId,
      });
    }

    const responseBody = buildBatchResponse({
      mode: payload.mode,
      amount: payload.amount,
      batchLabel: payload.batchLabel,
      allowCompActions: runtimeConfig.allowCompActions,
      targets,
      grants,
    });
    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "bulk_credit_grant_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
      amount: payload.amount,
      granted: grants.length,
      totalCredits: grants.length * payload.amount,
    });
    const response = NextResponse.json(responseBody);
    response.headers.set("Idempotency-Status", idempotencyContext ? "stored" : "disabled");
    withNoStore(response);
    return response;
  } catch (error) {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    const isValidationError = error instanceof RequestValidationError;
    return NextResponse.json(
      {
        error: isValidationError
          ? error.message
          : "Could not complete user batch operation.",
      },
      { status: isValidationError ? 400 : 500 },
    );
  }
}
