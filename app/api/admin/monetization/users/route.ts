/**
 * /api/admin/monetization/users
 * Admin-only logged-in user listing, CSV-export support, and batch credit grant workflow.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { getMonetizationRuntimeConfig } from "@/lib/monetization-config";
import { grantCredits } from "@/lib/monetization-ledger";
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
  canonicalAnonUserId: string;
  availableCredits: number;
  pendingCredits: number;
  purchaseCount: number;
  cookbookCount: number;
};

type BatchGrantTarget = {
  input: string;
  status: "ready" | "missing" | "ambiguous" | "duplicate_input" | "duplicate_target";
  message: string;
  user: ResolvedUser | null;
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
    return lastLoginAt && authUserId ? { lastLoginAt, authUserId } : null;
  } catch {
    return null;
  }
}

function encodeCursor(row: { lastLoginAt: string; authUserId: string }) {
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
}

function rowToResolvedUser(row: Record<string, unknown>): ResolvedUser {
  return {
    authUserId: asString(row.auth_user_id),
    email: asString(row.email),
    normalizedEmail: asString(row.normalized_email),
    name: asString(row.name),
    role: asString(row.role),
    canonicalAnonUserId: asString(row.canonical_anon_user_id),
    availableCredits: asInteger(row.available_credits),
    pendingCredits: asInteger(row.pending_credits),
    purchaseCount: asInteger(row.purchase_count),
    cookbookCount: asInteger(row.cookbook_count),
  };
}

function buildUserSelectSql(whereSql: string) {
  return `SELECT
      u.id AS auth_user_id,
      u.email,
      u.normalized_email,
      u.name,
      u.role,
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
      ), 0) AS cookbook_count
    FROM auth_users u
    LEFT JOIN auth_identity_links ail ON ail.auth_user_id = u.id
    LEFT JOIN credit_balances cb ON cb.anon_user_id = ail.canonical_anon_user_id
    ${whereSql}`;
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
    await ensureAdminUserSchemas();
    const params = request.nextUrl.searchParams;
    const limit = Math.max(
      1,
      Math.min(MAX_LIST_LIMIT, Number.parseInt(params.get("limit") ?? String(DEFAULT_LIST_LIMIT), 10)),
    );
    const cursor = parseCursor(params.get("cursor"));
    const search = normalizeIdentifier(params.get("search") ?? "");
    const role = params.get("role") ?? "all";
    const payment = params.get("payment") ?? "all";
    const cookbook = params.get("cookbook") ?? "all";
    const linkStatus = params.get("linkStatus") ?? "linked";
    const minCredits = params.get("minCredits");
    const maxCredits = params.get("maxCredits");
    const lastLoginSince = params.get("lastLoginSince")?.trim() ?? "";

    // Admin users can be filtered by identity, payment state, cookbook usage,
    // credits, and login recency without loading everyone into memory.
    const where: string[] = ["1 = 1"];
    const args: Array<string | number> = [];

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
    if (linkStatus === "linked") {
      where.push("ail.canonical_anon_user_id IS NOT NULL");
    } else if (linkStatus === "unlinked") {
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

    const result = await executeTurso({
      sql: `${buildUserSelectSql(`WHERE ${where.join(" AND ")}`)}
            ORDER BY u.last_login_at DESC, u.id DESC
            LIMIT ?`,
      args: [...args, limit + 1],
    });

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
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              lastLoginAt: asString(last.last_login_at),
              authUserId: asString(last.auth_user_id),
            })
          : null,
      filters: {
        search,
        role,
        payment,
        cookbook,
        linkStatus,
        minCredits,
        maxCredits,
        lastLoginSince,
      },
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
      args: chunk,
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
    await ensureAdminUserSchemas();
    const payload = parseBatchPayload((await request.json()) as unknown);
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
