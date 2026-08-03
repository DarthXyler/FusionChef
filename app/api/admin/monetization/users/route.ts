/**
 * /api/admin/monetization/users
 * Admin-only logged-in user listing, CSV-export support, and batch credit grant workflow.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac } from "crypto";
import type { InStatement } from "@libsql/client";
import {
  assertAccountDeletionDoesNotIncludeActor,
  requireAccountDeletionAdmin,
} from "@/lib/account-deletion-authorization";
import {
  AccountDeletionSchemaError,
  assertAccountDeletionSchemaReady,
} from "@/lib/account-deletion-schema";
import { runAccountDeletionPreflight } from "@/lib/account-deletion-preflight";
import { buildAccountDeletionGraphCleanupStatements } from "@/lib/account-deletion-execution";
import {
  buildDeletedIdentityTombstoneStatements,
  DeletedIdentityTombstoneConfigurationError,
} from "@/lib/deleted-identity-tombstones";
import {
  AccountDeletionJobError,
  assertAccountDeletionExecutionEnabled,
  createAccountDeletionOperationalReference,
  createAccountDeletionPreview,
  executeAccountDeletionJob,
  getAccountDeletionJobStatus,
} from "@/lib/account-deletion-jobs";
import {
  buildAccountDeletionStorageOutboxStatements,
  collectAccountDeletionStorageObjects,
  processAccountDeletionStorageOutbox,
} from "@/lib/account-deletion-storage";
import {
  AccountDeletionPlanningError,
  getEmptyAccountDeletionInventory,
  planAccountDeletion,
  type AccountDeletionGraphPlan,
  type AccountDeletionInventory,
} from "@/lib/account-deletion-planner";
import {
  getAdminUserLinkStatus,
  parseAdminUserLinkStatus,
  type AdminUserRowLinkStatus,
} from "@/lib/admin-user-link-status";
import { resolveAdminUserIdentifierTargets } from "@/lib/admin-user-target-resolution";
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
import { executeTurso } from "@/lib/turso";
import { createAccountDeletionPseudonym } from "@/lib/purchase-settlement-retention";

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
    | "blocked_shared_identity"
    | "manual_review";
  message: string;
  user: ResolvedUser | null;
  linkedAuthUsers: Array<{ authUserId: string; email: string }>;
  counts: AccountDeletionCounts;
  graph: AccountDeletionGraphPlan | null;
};

type AccountDeletionCounts = AccountDeletionInventory;

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
  if (!reason) {
    throw new RequestValidationError(
      "reason is required before previewing or deleting an account.",
    );
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
  const jobId = asString(body.jobId).trim();
  const fingerprint = asString(body.fingerprint).trim();
  if (mode === "commit" && (!UUID_PATTERN.test(jobId) || !/^[0-9a-f]{64}$/.test(fingerprint))) {
    throw new RequestValidationError(
      "A valid preview jobId and fingerprint are required before deletion.",
    );
  }
  return { mode, reason, confirmation, identifiers, jobId, fingerprint };
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

async function resolveBatchTargets(
  identifiers: string[],
  options: { allowAuthOnly?: boolean } = {},
): Promise<BatchGrantTarget[]> {
  return resolveAdminUserIdentifierTargets({
    identifiers,
    allowAuthOnly: options.allowAuthOnly === true,
    fetchUsers: fetchResolvedUsers,
  });
}

async function getDeletionOwnerLabels(authUserIds: string[]) {
  if (authUserIds.length === 0) {
    return [] as Array<{ authUserId: string; email: string }>;
  }
  const owners: Array<{ authUserId: string; email: string }> = [];
  for (let index = 0; index < authUserIds.length; index += RESOLVE_CHUNK_SIZE) {
    const chunk = authUserIds.slice(index, index + RESOLVE_CHUNK_SIZE);
    const result = await executeTurso({
      sql: `SELECT id AS auth_user_id, email
            FROM auth_users
            WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      args: chunk,
    });
    result.rows.forEach((row) => {
      owners.push({
        authUserId: asString(row.auth_user_id),
        email: asString(row.email),
      });
    });
  }
  return owners.sort((left, right) => left.email.localeCompare(right.email));
}

async function resolveDeleteTargets(identifiers: string[]) {
  const baseTargets = await resolveBatchTargets(identifiers, {
    allowAuthOnly: true,
  });
  const readyAuthIds = [...new Set(
    baseTargets
      .filter((target) => (target.status === "ready" || target.status === "duplicate_target") && target.user)
      .map((target) => target.user?.authUserId ?? ""),
  )].filter(Boolean);
  const plan = await planAccountDeletion({ authUserIds: readyAuthIds });
  const graphById = new Map(plan.graphs.map((graph) => [graph.graphId, graph]));
  const ownerLabelsByGraphId = new Map<string, Array<{ authUserId: string; email: string }>>();
  for (const graph of plan.graphs) {
    ownerLabelsByGraphId.set(
      graph.graphId,
      await getDeletionOwnerLabels(graph.ownerAuthUserIds),
    );
  }
  const output: DeleteTarget[] = [];
  for (const target of baseTargets) {
    const canEvaluateDeletion =
      (target.status === "ready" || target.status === "duplicate_target") && target.user;
    if (!canEvaluateDeletion || !target.user) {
      output.push({
        ...target,
        status: target.status,
        linkedAuthUsers: [],
        counts: getEmptyAccountDeletionInventory(),
        graph: null,
      });
      continue;
    }

    const graphId = plan.targetGraphIds[target.user.authUserId];
    const graph = graphId ? graphById.get(graphId) ?? null : null;
    if (!graph) {
      output.push({
        input: target.input,
        status: "manual_review",
        message: "The complete account identity graph could not be resolved safely.",
        user: target.user,
        linkedAuthUsers: [],
        counts: getEmptyAccountDeletionInventory(),
        graph: null,
      });
      continue;
    }
    const linkedAuthUsers = ownerLabelsByGraphId.get(graph.graphId) ?? [];
    if (graph.status === "manual_review") {
      const isUnselectedOwner = graph.blockers.includes(
        "unselected_authenticated_owner",
      );
      output.push({
        input: target.input,
        status: isUnselectedOwner ? "blocked_shared_identity" : "manual_review",
        message: isUnselectedOwner
          ? "This identity graph has another signed-in owner. Include every owner in the request."
          : `This identity graph requires manual review (${graph.blockers.join(", ")}).`,
        user: target.user,
        linkedAuthUsers,
        counts: graph.inventory,
        graph,
      });
      continue;
    }

    output.push({
      input: target.input,
      status: "ready",
      message: "Ready to delete.",
      user: target.user,
      linkedAuthUsers,
      counts: graph.inventory,
      graph,
    });
  }
  return { targets: output, plan };
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
  const countedGraphs = new Set<string>();
  return targets
    .filter((target) => {
      if (target.status !== "ready" || !target.graph) {
        return false;
      }
      if (countedGraphs.has(target.graph.graphId)) {
        return false;
      }
      countedGraphs.add(target.graph.graphId);
      return true;
    })
    .reduce<AccountDeletionCounts>(
      (total, target) => ({
        authUsers: total.authUsers + target.counts.authUsers,
        identityLinks: total.identityLinks + target.counts.identityLinks,
        mobileDeviceLinks: total.mobileDeviceLinks + target.counts.mobileDeviceLinks,
        mobileAliases: total.mobileAliases + target.counts.mobileAliases,
        cookbookRecipes: total.cookbookRecipes + target.counts.cookbookRecipes,
        productActivityEvents:
          total.productActivityEvents + target.counts.productActivityEvents,
        creditBalanceRows: total.creditBalanceRows + target.counts.creditBalanceRows,
        creditReservations: total.creditReservations + target.counts.creditReservations,
        creditReservationAmount:
          total.creditReservationAmount + target.counts.creditReservationAmount,
        activeCreditReservations:
          total.activeCreditReservations + target.counts.activeCreditReservations,
        activeCreditReservationAmount:
          total.activeCreditReservationAmount +
          target.counts.activeCreditReservationAmount,
        expiredCreditReservations:
          total.expiredCreditReservations + target.counts.expiredCreditReservations,
        expiredCreditReservationAmount:
          total.expiredCreditReservationAmount +
          target.counts.expiredCreditReservationAmount,
        finalizedCreditReservations:
          total.finalizedCreditReservations +
          target.counts.finalizedCreditReservations,
        finalizedCreditReservationAmount:
          total.finalizedCreditReservationAmount +
          target.counts.finalizedCreditReservationAmount,
        malformedCreditReservations:
          total.malformedCreditReservations +
          target.counts.malformedCreditReservations,
        malformedCreditReservationAmount:
          total.malformedCreditReservationAmount +
          target.counts.malformedCreditReservationAmount,
        creditLedgerEntries: total.creditLedgerEntries + target.counts.creditLedgerEntries,
        financialLedgerEntriesRetained:
          total.financialLedgerEntriesRetained +
          target.counts.financialLedgerEntriesRetained,
        operationalLedgerEntriesDeleted:
          total.operationalLedgerEntriesDeleted +
          target.counts.operationalLedgerEntriesDeleted,
        dailyUsageRows: total.dailyUsageRows + target.counts.dailyUsageRows,
        purchaseTransactionsPreserved:
          total.purchaseTransactionsPreserved + target.counts.purchaseTransactionsPreserved,
        purchaseLedgerLinks:
          total.purchaseLedgerLinks + target.counts.purchaseLedgerLinks,
        reconciliationActions:
          total.reconciliationActions + target.counts.reconciliationActions,
        priorDeletionEvents:
          total.priorDeletionEvents + target.counts.priorDeletionEvents,
      }),
      getEmptyAccountDeletionInventory(),
    );
}

function buildDeleteResponse(params: {
  mode: "dry_run" | "commit";
  targets: DeleteTarget[];
  deletedCount?: number;
  job?: {
    jobId: string;
    fingerprint: string;
    expiresAt: string;
    status: string;
    replayed: boolean;
    targets?: Array<{
      targetRef: string;
      status: string;
      attemptCount: number;
      lastErrorCode: string | null;
      lastErrorSummary: string | null;
    }>;
    storage?: Array<{ category: string; status: string; count: number }>;
  };
}) {
  return {
    operation: "account_delete",
    mode: params.mode,
    summary: {
      totalInputs: params.targets.length,
      ready: params.targets.filter((target) => target.status === "ready").length,
      missing: params.targets.filter((target) => target.status === "missing").length,
      ambiguous: params.targets.filter((target) => target.status === "ambiguous").length,
      manualReview: params.targets.filter((target) => target.status === "manual_review").length,
      blockedSharedIdentity: params.targets.filter((target) => target.status === "blocked_shared_identity").length,
      duplicateInputs: params.targets.filter((target) => target.status === "duplicate_input").length,
      duplicateTargets: params.targets.filter((target) => target.status === "duplicate_target").length,
      deleted: params.deletedCount ?? 0,
      counts: sumDeletionCounts(params.targets),
    },
    targets: params.targets.slice(0, 500).map((target) => ({
      status: target.status,
      message: target.message,
      user: target.user
        ? {
            email: target.user.email,
            name: target.user.name,
            accountSetup: target.user.accountSetup,
            accountSetupIssue: target.user.accountSetupIssue,
          }
        : null,
      linkedAuthUsers: target.linkedAuthUsers.map((user) => ({
        email: user.email,
      })),
      counts: target.counts,
      graph: target.graph
        ? {
            graphId: createAccountDeletionOperationalReference({
              kind: "response-identity",
              value: target.graph.graphId,
            }),
            status: target.graph.status,
            blockers: target.graph.blockers,
            identityNodes: target.graph.identityNodes.map((value) =>
              createAccountDeletionOperationalReference({
                kind: "response-identity",
                value,
              }),
            ),
            canonicalIdentityIds: target.graph.canonicalIdentityIds.map(
              (value) =>
                createAccountDeletionOperationalReference({
                  kind: "response-identity",
                  value,
                }),
            ),
            aliasEdges: target.graph.aliasEdges.map((edge) => ({
              anonUserId: createAccountDeletionOperationalReference({
                kind: "response-identity",
                value: edge.anonUserId,
              }),
              canonicalAnonUserId:
                createAccountDeletionOperationalReference({
                  kind: "response-identity",
                  value: edge.canonicalAnonUserId,
                }),
            })),
            deviceMappingCount: target.graph.deviceKeys.length,
            storage: (() => {
              const objects = collectAccountDeletionStorageObjects({
                graph: target.graph,
              });
              return {
                total: objects.length,
                recipeImages: objects.filter(
                  (object) => object.category === "recipe_image",
                ).length,
                profileAvatars: objects.filter(
                  (object) => object.category === "profile_avatar",
                ).length,
                generatedImages: objects.filter(
                  (object) => object.category === "generated_image",
                ).length,
              };
            })(),
          }
        : null,
    })),
    previewTruncated: params.targets.length > 500,
    deleted: [],
    job: params.job ?? null,
  };
}

function buildReadyGraphDeletionStatements(params: {
  graph: AccountDeletionGraphPlan;
  targets: DeleteTarget[];
  actorRef: string;
  reasonRef: string;
  jobId: string;
  targetId: string;
}): InStatement[] {
  const canonical =
    params.graph.canonicalIdentityIds[0] ??
    params.graph.identityNodes[0] ??
    "";
  const usersById = new Map(
    params.targets.flatMap((target) =>
      target.user ? [[target.user.authUserId, target.user] as const] : [],
    ),
  );
  const graphUsers = params.graph.ownerAuthUserIds.map((authUserId) => {
    const user = usersById.get(authUserId);
    if (!user) {
      throw new AccountDeletionJobError(
        "stale_preview",
        "The account deletion target no longer matches its approved graph.",
        409,
      );
    }
    return user;
  });
  const deletedPurchaseOwner = createAccountDeletionPseudonym({
    authUserIds: params.graph.ownerAuthUserIds,
    identityNodes: params.graph.identityNodes,
  });
  const deletionEventStatements: InStatement[] = graphUsers.map((user) => ({
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
        `deletion:${createHash("sha256")
          .update(`${params.jobId}\u0000${params.targetId}\u0000${user.authUserId}`)
          .digest("hex")}`,
        user.authUserId,
        canonical,
        hashDeletedEmail(user.email),
        user.provider || "unknown",
        user.role || "user",
        params.actorRef,
        params.reasonRef,
        JSON.stringify(params.graph.inventory),
        params.graph.inventory.purchaseTransactionsPreserved,
        params.jobId,
      ],
    }));
  return [
    ...deletionEventStatements,
    ...buildAccountDeletionStorageOutboxStatements({
      graph: params.graph,
      jobId: params.jobId,
      targetId: params.targetId,
    }),
    ...buildDeletedIdentityTombstoneStatements({
      identityNodes: params.graph.identityNodes,
      deletionJobId: params.jobId,
    }),
    ...buildAccountDeletionGraphCleanupStatements({
      graph: params.graph,
      deletedPurchaseOwner,
    }),
  ];
}

export async function POST(request: NextRequest) {
  let idempotencyContext: IdempotencyContext | null = null;
  try {
    if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }
    const rawBody = (await request.json()) as unknown;
    const operation = isObjectRecord(rawBody) && rawBody.operation === "account_delete" ? "account_delete" : "credit_grant";
    if (operation === "account_delete") {
      const payload = parseDeletePayload(rawBody);
      const preflight = await runAccountDeletionPreflight({
        verifySchema: () => assertAccountDeletionSchemaReady(),
        authorize: () => requireAccountDeletionAdmin(request),
        enforceRateLimit: () =>
          enforceRateLimit(request, {
            bucket: "api-admin-monetization-users-write",
            limit: 20,
            windowMs: 60_000,
          }),
      });
      if (!preflight.ok) {
        return preflight.response;
      }
      const deletionAdmin = {
        ok: true as const,
        context: preflight.context,
      };
      const { targets, plan } = await resolveDeleteTargets(payload.identifiers);
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

      if (payload.mode === "commit") {
        assertAccountDeletionExecutionEnabled();
      }

      if (payload.mode === "dry_run") {
        const preview = await createAccountDeletionPreview({
          plan,
          reason: payload.reason,
          actingAdminAuthUserId: deletionAdmin.context.actorAuthUserId,
          requestId: deletionAdmin.context.requestId,
          idempotencyKey:
            getIdempotencyKeyFromHeaders(request.headers) ?? undefined,
        });
        const previewStatus = await getAccountDeletionJobStatus({
          jobId: preview.jobId,
          actingAdminAuthUserId: deletionAdmin.context.actorAuthUserId,
        });
        const response = NextResponse.json(
          buildDeleteResponse({
            mode: payload.mode,
            targets,
            job: {
              ...previewStatus,
              replayed: preview.replayed,
            },
          }),
        );
        withNoStore(response);
        return response;
      }

      const execution = await executeAccountDeletionJob({
        jobId: payload.jobId,
        fingerprint: payload.fingerprint,
        authUserIds: plan.selectedAuthUserIds,
        reason: payload.reason,
        actingAdminAuthUserId: deletionAdmin.context.actorAuthUserId,
        buildGraphStatements: ({ graph, jobId, targetId }) =>
          buildReadyGraphDeletionStatements({
            graph,
            targets,
            actorRef: createAccountDeletionOperationalReference({
              kind: "admin",
              value: deletionAdmin.context.actorAuthUserId,
            }),
            reasonRef: createAccountDeletionOperationalReference({
              kind: "reason",
              value: payload.reason,
            }),
            jobId,
            targetId,
          }),
      });
      let finalJobStatus: string = execution.status;
      let storageResult:
        | Awaited<ReturnType<typeof processAccountDeletionStorageOutbox>>
        | null = null;
      if (
        execution.status === "storage_pending" ||
        execution.status === "database_completed"
      ) {
        try {
          storageResult = await processAccountDeletionStorageOutbox({
            jobId: execution.jobId,
          });
          finalJobStatus = storageResult.status;
        } catch {
          logMonetizationAudit({
            requestId: deletionAdmin.context.requestId,
            event: "account_delete_storage_processing_unavailable",
            actorRef: createAccountDeletionOperationalReference({
              kind: "admin",
              value: deletionAdmin.context.actorAuthUserId,
            }),
            jobId: execution.jobId,
          });
        }
      }
      const persistedJob = await getAccountDeletionJobStatus({
        jobId: execution.jobId,
        actingAdminAuthUserId: deletionAdmin.context.actorAuthUserId,
      });
      const responseBody = buildDeleteResponse({
        mode: payload.mode,
        targets,
        deletedCount: plan.selectedAuthUserIds.length,
        job: {
          ...persistedJob,
          status: finalJobStatus,
          replayed: execution.replayed,
        },
      });
      logMonetizationAudit({
        requestId: deletionAdmin.context.requestId,
        event: "account_delete_succeeded",
        actorRef: createAccountDeletionOperationalReference({
          kind: "admin",
          value: deletionAdmin.context.actorAuthUserId,
        }),
        networkRef: createAccountDeletionOperationalReference({
          kind: "network",
          value: deletionAdmin.context.ip,
        }),
        deleted: plan.selectedAuthUserIds.length,
        jobId: execution.jobId,
        replayed: execution.replayed,
        storageStatus: finalJobStatus,
        storageAttempted: storageResult?.attempted ?? 0,
        storageFailed: storageResult?.failed ?? 0,
      });
      const response = NextResponse.json(responseBody);
      response.headers.set(
        "Idempotency-Status",
        execution.replayed ? "replayed" : "stored",
      );
      withNoStore(response);
      return response;
    }

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
    await ensureAdminUserSchemas();
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
    const schemaError =
      error instanceof AccountDeletionSchemaError ? error : null;
    const planningError =
      error instanceof AccountDeletionPlanningError ? error : null;
    const jobError = error instanceof AccountDeletionJobError ? error : null;
    const tombstoneError =
      error instanceof DeletedIdentityTombstoneConfigurationError
        ? error
        : null;
    const isValidationError = error instanceof RequestValidationError;
    const response = NextResponse.json(
      {
        error: jobError
          ? jobError.message
          : tombstoneError
          ? tombstoneError.message
          : planningError
          ? planningError.message
          : schemaError
          ? schemaError.message
          : isValidationError
            ? error.message
            : "Could not complete user batch operation.",
        ...(jobError
          ? { code: jobError.code }
          : tombstoneError
          ? { code: tombstoneError.code }
          : planningError
          ? { code: planningError.code }
          : schemaError
          ? {
              code: schemaError.code,
              missingObjects: schemaError.missingObjects,
            }
          : {}),
      },
      {
        status:
          jobError?.statusCode ??
          tombstoneError?.statusCode ??
          planningError?.statusCode ??
          schemaError?.statusCode ??
          (isValidationError ? 400 : 500),
      },
    );
    withNoStore(response);
    return response;
  }
}
