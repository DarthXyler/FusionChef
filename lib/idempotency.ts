/**
 * Idempotency utilities for API write operations.
 * Prevents duplicate processing when clients retry the same request.
 */
import { createHash } from "crypto";
import { executeTurso } from "@/lib/turso";

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

declare global {
  var __flavorIdempotencySchemaReady: Promise<void> | undefined;
  var __flavorIdempotencyLastCleanupMs: number | undefined;
}

export type IdempotencyContext = {
  scope: string;
  key: string;
  requestHash: string;
  ttlMs: number;
};

export type IdempotencyBeginResult =
  | { state: "disabled" }
  | { state: "started"; context: IdempotencyContext }
  | { state: "in_progress" }
  | { state: "conflict" }
  | { state: "replay"; responseStatus: number; responseBody: unknown };

type BeginIdempotencyRequest = {
  key: string | null;
  scope: string;
  requestPayload: unknown;
  ttlMs?: number;
};

function isTursoConfigured() {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

function normalizeIdempotencyKey(key: string | null) {
  // Accepts only reasonable key lengths.
  if (!key) {
    return null;
  }
  const normalized = key.trim();
  if (normalized.length < 8 || normalized.length > 128) {
    return null;
  }
  return normalized;
}

export function getIdempotencyKeyFromHeaders(headers: Headers) {
  return normalizeIdempotencyKey(headers.get("idempotency-key"));
}

function buildRequestHash(requestPayload: unknown) {
  // Hash of request body to detect conflicting key reuse.
  const input = JSON.stringify(requestPayload);
  return createHash("sha256").update(input).digest("base64url");
}

async function ensureIdempotencySchema() {
  // Creates idempotency table/index lazily when first used.
  if (globalThis.__flavorIdempotencySchemaReady) {
    return globalThis.__flavorIdempotencySchemaReady;
  }

  globalThis.__flavorIdempotencySchemaReady = (async () => {
    await executeTurso(
      `CREATE TABLE IF NOT EXISTS api_idempotency (
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY (scope, idempotency_key)
      )`,
    );
    await executeTurso(
      `CREATE INDEX IF NOT EXISTS idx_api_idempotency_expiry
       ON api_idempotency (expires_at_ms)`,
    );
  })();

  return globalThis.__flavorIdempotencySchemaReady;
}

async function cleanupExpiredRows(nowMs: number) {
  // Periodic background cleanup of expired idempotency records.
  const lastCleanupMs = globalThis.__flavorIdempotencyLastCleanupMs ?? 0;
  if (nowMs - lastCleanupMs <= 60_000) {
    return;
  }
  globalThis.__flavorIdempotencyLastCleanupMs = nowMs;
  await executeTurso({
    sql: "DELETE FROM api_idempotency WHERE expires_at_ms < ?",
    args: [nowMs],
  });
}

export async function beginIdempotentRequest(
  request: BeginIdempotencyRequest,
): Promise<IdempotencyBeginResult> {
  // Starts request tracking or returns replay/conflict/in-progress result.
  if (!isTursoConfigured()) {
    return { state: "disabled" };
  }

  const key = normalizeIdempotencyKey(request.key);
  if (!key) {
    return { state: "disabled" };
  }

  const scope = request.scope.trim();
  if (!scope) {
    return { state: "disabled" };
  }

  const ttlMs = request.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const requestHash = buildRequestHash(request.requestPayload);
  const nowMs = Date.now();
  const expiresAtMs = nowMs + ttlMs;

  try {
    await ensureIdempotencySchema();
    await cleanupExpiredRows(nowMs);

    const insertResult = await executeTurso({
      sql: `INSERT INTO api_idempotency (
              scope,
              idempotency_key,
              request_hash,
              status,
              created_at_ms,
              updated_at_ms,
              expires_at_ms
            ) VALUES (?, ?, ?, 'in_progress', ?, ?, ?)
            ON CONFLICT(scope, idempotency_key) DO NOTHING`,
      args: [scope, key, requestHash, nowMs, nowMs, expiresAtMs],
    });

    if ((insertResult.rowsAffected ?? 0) > 0) {
      return {
        state: "started",
        context: {
          scope,
          key,
          requestHash,
          ttlMs,
        },
      };
    }

    const existing = await executeTurso({
      sql: `SELECT request_hash, status, response_status, response_body, expires_at_ms
            FROM api_idempotency
            WHERE scope = ? AND idempotency_key = ?
            LIMIT 1`,
      args: [scope, key],
    });

    const row = existing.rows[0];
    if (!row) {
      return {
        state: "started",
        context: {
          scope,
          key,
          requestHash,
          ttlMs,
        },
      };
    }

    const existingHash =
      typeof row.request_hash === "string" ? row.request_hash : String(row.request_hash ?? "");
    if (existingHash !== requestHash) {
      return { state: "conflict" };
    }

    const status = typeof row.status === "string" ? row.status : String(row.status ?? "");
    if (status === "completed") {
      const responseStatus =
        typeof row.response_status === "number"
          ? row.response_status
          : Number(row.response_status ?? 200);
      const rawResponseBody =
        typeof row.response_body === "string"
          ? row.response_body
          : String(row.response_body ?? "null");
      let responseBody: unknown = null;
      try {
        responseBody = JSON.parse(rawResponseBody);
      } catch {
        responseBody = null;
      }
      return {
        state: "replay",
        responseStatus: Number.isFinite(responseStatus) ? responseStatus : 200,
        responseBody,
      };
    }

    return { state: "in_progress" };
  } catch {
    return { state: "disabled" };
  }
}

export async function completeIdempotentRequest(
  context: IdempotencyContext,
  responseStatus: number,
  responseBody: unknown,
) {
  // Marks request as completed and stores replay response.
  if (!isTursoConfigured()) {
    return;
  }

  try {
    await ensureIdempotencySchema();
    const nowMs = Date.now();
    await executeTurso({
      sql: `UPDATE api_idempotency
            SET status = 'completed',
                response_status = ?,
                response_body = ?,
                updated_at_ms = ?,
                expires_at_ms = ?
            WHERE scope = ?
              AND idempotency_key = ?
              AND request_hash = ?`,
      args: [
        responseStatus,
        JSON.stringify(responseBody),
        nowMs,
        nowMs + context.ttlMs,
        context.scope,
        context.key,
        context.requestHash,
      ],
    });
  } catch {
    // Ignore best-effort completion update failures.
  }
}

export async function clearIdempotentRequest(context: IdempotencyContext) {
  // Clears in-progress marker after failures so retries can proceed.
  if (!isTursoConfigured()) {
    return;
  }

  try {
    await ensureIdempotencySchema();
    await executeTurso({
      sql: `DELETE FROM api_idempotency
            WHERE scope = ?
              AND idempotency_key = ?
              AND request_hash = ?`,
      args: [context.scope, context.key, context.requestHash],
    });
  } catch {
    // Ignore best-effort cleanup failures.
  }
}
