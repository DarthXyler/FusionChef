/**
 * API safety utilities:
 * - client IP detection
 * - rate limiting (memory + optional Turso-backed)
 * - request size checks
 * - internal token guard
 */
import { NextResponse } from "next/server";
import { executeTurso } from "@/lib/turso";

type RateLimitOptions = {
  bucket: string;
  limit: number;
  windowMs: number;
  strategy?: "auto" | "memory" | "turso";
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

declare global {
  var __flavorRateLimitStore: Map<string, RateLimitEntry> | undefined;
  var __flavorRateLimitSchemaReady: Promise<void> | undefined;
  var __flavorRateLimitLastCleanupMs: number | undefined;
  var __flavorRateLimitLastTursoFailureMs: number | undefined;
}

function getStore() {
  // In-memory fallback store for non-distributed rate limiting.
  if (!globalThis.__flavorRateLimitStore) {
    globalThis.__flavorRateLimitStore = new Map<string, RateLimitEntry>();
  }
  return globalThis.__flavorRateLimitStore;
}

export function getClientIp(request: Request) {
  // Standard proxy headers first, then fallback.
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function isTursoRateLimitEnabled() {
  const backend = (process.env.RATE_LIMIT_BACKEND ?? "turso").toLowerCase();
  return (
    backend === "turso" &&
    typeof process.env.TURSO_DATABASE_URL === "string" &&
    process.env.TURSO_DATABASE_URL.length > 0 &&
    typeof process.env.TURSO_AUTH_TOKEN === "string" &&
    process.env.TURSO_AUTH_TOKEN.length > 0
  );
}

async function ensureRateLimitSchema() {
  // Lazy-create DB table/index only when Turso rate limit is used.
  if (globalThis.__flavorRateLimitSchemaReady) {
    return globalThis.__flavorRateLimitSchemaReady;
  }

  globalThis.__flavorRateLimitSchemaReady = (async () => {
    await executeTurso(
      `CREATE TABLE IF NOT EXISTS api_rate_limits (
        limiter_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )`,
    );
    await executeTurso(
      `CREATE INDEX IF NOT EXISTS idx_api_rate_limits_reset
       ON api_rate_limits (reset_at_ms)`,
    );
  })();

  return globalThis.__flavorRateLimitSchemaReady;
}

function shouldAttemptTursoRateLimit() {
  // Temporary backoff after errors to reduce repeated failing DB calls.
  if (!isTursoRateLimitEnabled()) {
    return false;
  }

  const lastFailureMs = globalThis.__flavorRateLimitLastTursoFailureMs ?? 0;
  // Back off briefly after a Turso failure to avoid hammering on each request.
  return Date.now() - lastFailureMs > 15_000;
}

async function enforceDistributedRateLimit(request: Request, options: RateLimitOptions) {
  // Distributed limiter key = bucket + IP + window.
  const now = Date.now();
  const ip = getClientIp(request);
  const windowStart = now - (now % options.windowMs);
  const resetAt = windowStart + options.windowMs;
  const limiterKey = `${options.bucket}:${ip}:${windowStart}`;

  await ensureRateLimitSchema();

  const result = await executeTurso({
    sql: `INSERT INTO api_rate_limits (
            limiter_key,
            count,
            reset_at_ms,
            updated_at_ms
          ) VALUES (?, 1, ?, ?)
          ON CONFLICT(limiter_key) DO UPDATE SET
            count = count + 1,
            updated_at_ms = excluded.updated_at_ms
          RETURNING count, reset_at_ms`,
    args: [limiterKey, resetAt, now],
  });

  const row = result.rows[0];
  const count = typeof row?.count === "number" ? row.count : Number(row?.count ?? 0);
  const resetAtMs =
    typeof row?.reset_at_ms === "number" ? row.reset_at_ms : Number(row?.reset_at_ms ?? resetAt);

  const lastCleanupMs = globalThis.__flavorRateLimitLastCleanupMs ?? 0;
  if (now - lastCleanupMs > 60_000) {
    globalThis.__flavorRateLimitLastCleanupMs = now;
    void executeTurso({
      sql: "DELETE FROM api_rate_limits WHERE reset_at_ms < ?",
      args: [now],
    }).catch(() => {
      // Ignore background cleanup failures.
    });
  }

  if (count > options.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }

  return null;
}

function enforceInMemoryRateLimit(request: Request, options: RateLimitOptions) {
  // Lightweight fallback limiter.
  const now = Date.now();
  const store = getStore();
  const ip = getClientIp(request);
  const key = `${options.bucket}:${ip}`;
  const existing = store.get(key);

  const entry: RateLimitEntry =
    !existing || now >= existing.resetAt
      ? { count: 0, resetAt: now + options.windowMs }
      : existing;

  entry.count += 1;
  store.set(key, entry);

  if (entry.count > options.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }

  // Prevent unbounded memory growth in long-lived processes.
  if (store.size > 5000) {
    for (const [storeKey, value] of store.entries()) {
      if (now >= value.resetAt) {
        store.delete(storeKey);
      }
    }
  }

  return null;
}

export async function enforceRateLimit(request: Request, options: RateLimitOptions) {
  // Prefer distributed limiter when available, fallback to in-memory.
  if (options.strategy === "memory") {
    return enforceInMemoryRateLimit(request, options);
  }

  if (options.strategy === "turso" || shouldAttemptTursoRateLimit()) {
    try {
      return await enforceDistributedRateLimit(request, options);
    } catch {
      globalThis.__flavorRateLimitLastTursoFailureMs = Date.now();
    }
  }

  return enforceInMemoryRateLimit(request, options);
}

export function isRequestBodyTooLarge(request: Request, maxBytes: number) {
  // Fast check using Content-Length header.
  const contentLength = request.headers.get("content-length");
  if (!contentLength) {
    return false;
  }
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

export function requireInternalToken(request: Request) {
  // Internal-only endpoint protection.
  const expectedToken = process.env.INTERNAL_API_TOKEN;
  if (!expectedToken) {
    return NextResponse.json(
      { error: "INTERNAL_API_TOKEN is not configured." },
      { status: 500 },
    );
  }

  const providedToken = request.headers.get("x-internal-token");
  if (providedToken !== expectedToken) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return null;
}
