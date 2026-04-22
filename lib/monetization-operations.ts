/**
 * Monetization operational utilities:
 * - timezone-safe daily usage accounting
 * - expired reservation reconciliation
 */
import { executeTurso } from "@/lib/turso";
import {
  ensureMonetizationLedgerSchema,
  releaseReservedCredits,
  type MonetizationActionKind,
} from "@/lib/monetization-ledger";

const DEFAULT_MONETIZATION_TIMEZONE = "UTC";

let operationsSchemaReady: Promise<void> | null = null;

export type DailyUsageRecord = {
  anonUserId: string;
  dayKey: string;
  timezone: string;
  fuseCount: number;
  rerollCount: number;
  updatedAt: string;
};

export type ReconciliationPreview = {
  reservationId: string;
  anonUserId: string;
  actionKind: MonetizationActionKind;
  amount: number;
  expiresAt: string;
};

export type ReconciliationSummary = {
  scanned: number;
  released: number;
  alreadyFinalized: number;
  failed: number;
};

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function toUtcIsoOrNow(value: Date | null | undefined) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date().toISOString();
}

function isValidTimezone(value: string) {
  try {
    // Throws on unknown IANA timezone names.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function toDayKeyInTimezone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function rowToDailyUsage(row: Record<string, unknown>): DailyUsageRecord {
  return {
    anonUserId: asString(row.anon_user_id),
    dayKey: asString(row.day_key),
    timezone: asString(row.timezone),
    fuseCount: asInteger(row.fuse_count),
    rerollCount: asInteger(row.reroll_count),
    updatedAt: asString(row.updated_at),
  };
}

async function ensureOperationsSchema() {
  if (operationsSchemaReady) {
    return operationsSchemaReady;
  }

  operationsSchemaReady = (async () => {
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
      `CREATE INDEX IF NOT EXISTS idx_credit_daily_usage_day
       ON credit_daily_usage (day_key, updated_at DESC)`,
    );
  })();

  return operationsSchemaReady;
}

export function getMonetizationTimezone() {
  const configured = (process.env.MONETIZATION_TIMEZONE ?? DEFAULT_MONETIZATION_TIMEZONE).trim();
  if (!configured) {
    return DEFAULT_MONETIZATION_TIMEZONE;
  }
  return isValidTimezone(configured) ? configured : DEFAULT_MONETIZATION_TIMEZONE;
}

export function getMonetizationDayKey(params?: {
  now?: Date | null;
  timezone?: string | null;
}) {
  const now = params?.now instanceof Date ? params.now : new Date();
  const timezone =
    params?.timezone && isValidTimezone(params.timezone)
      ? params.timezone
      : getMonetizationTimezone();
  return toDayKeyInTimezone(now, timezone);
}

export async function recordDailyMonetizationUsage(params: {
  anonUserId: string;
  actionKind: MonetizationActionKind;
  now?: Date | null;
}) {
  await ensureOperationsSchema();

  const timezone = getMonetizationTimezone();
  const now = params.now instanceof Date ? params.now : new Date();
  const dayKey = getMonetizationDayKey({ now, timezone });
  const nowIso = toUtcIsoOrNow(now);
  const isReroll = params.actionKind === "reroll";

  const result = await executeTurso({
    sql: `INSERT INTO credit_daily_usage (
            anon_user_id,
            day_key,
            timezone,
            fuse_count,
            reroll_count,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(anon_user_id, day_key) DO UPDATE SET
            fuse_count = credit_daily_usage.fuse_count + ?,
            reroll_count = credit_daily_usage.reroll_count + ?,
            timezone = excluded.timezone,
            updated_at = excluded.updated_at
          RETURNING
            anon_user_id,
            day_key,
            timezone,
            fuse_count,
            reroll_count,
            updated_at`,
    args: [
      params.anonUserId,
      dayKey,
      timezone,
      isReroll ? 0 : 1,
      isReroll ? 1 : 0,
      nowIso,
      isReroll ? 0 : 1,
      isReroll ? 1 : 0,
    ],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Could not record daily usage.");
  }
  return rowToDailyUsage(row);
}

export async function listDailyMonetizationUsage(anonUserId: string, limit = 30) {
  await ensureOperationsSchema();
  const safeLimit = Math.max(1, Math.min(120, Math.trunc(limit)));
  const result = await executeTurso({
    sql: `SELECT
            anon_user_id,
            day_key,
            timezone,
            fuse_count,
            reroll_count,
            updated_at
          FROM credit_daily_usage
          WHERE anon_user_id = ?
          ORDER BY day_key DESC
          LIMIT ?`,
    args: [anonUserId, safeLimit],
  });

  return result.rows
    .map((row) => rowToDailyUsage(row as Record<string, unknown>))
    .filter((row) => row.anonUserId.length > 0 && row.dayKey.length > 0);
}

export async function getTodayDailyMonetizationUsage(anonUserId: string) {
  await ensureOperationsSchema();
  const timezone = getMonetizationTimezone();
  const dayKey = getMonetizationDayKey({ timezone });
  const result = await executeTurso({
    sql: `SELECT
            anon_user_id,
            day_key,
            timezone,
            fuse_count,
            reroll_count,
            updated_at
          FROM credit_daily_usage
          WHERE anon_user_id = ?
            AND day_key = ?
          LIMIT 1`,
    args: [anonUserId, dayKey],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return {
      anonUserId,
      dayKey,
      timezone,
      fuseCount: 0,
      rerollCount: 0,
      updatedAt: new Date(0).toISOString(),
    } satisfies DailyUsageRecord;
  }
  return rowToDailyUsage(row);
}

export async function getExpiredReservationPreview(limit = 25) {
  await ensureMonetizationLedgerSchema();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const nowIso = new Date().toISOString();
  const result = await executeTurso({
    sql: `SELECT
            reservation_id,
            anon_user_id,
            action_kind,
            amount,
            expires_at
          FROM credit_reservations
          WHERE status = 'reserved'
            AND expires_at IS NOT NULL
            AND expires_at != ''
            AND expires_at <= ?
          ORDER BY expires_at ASC
          LIMIT ?`,
    args: [nowIso, safeLimit],
  });

  return result.rows
    .map((row) => ({
      reservationId: asString((row as Record<string, unknown>).reservation_id),
      anonUserId: asString((row as Record<string, unknown>).anon_user_id),
      actionKind:
        asString((row as Record<string, unknown>).action_kind) === "reroll" ? "reroll" : "fuse",
      amount: asInteger((row as Record<string, unknown>).amount),
      expiresAt: asString((row as Record<string, unknown>).expires_at),
    }))
    .filter((row) => row.reservationId.length > 0 && row.anonUserId.length > 0);
}

export async function reconcileExpiredReservations(params?: {
  maxCandidates?: number;
  actor?: string;
}) {
  await ensureMonetizationLedgerSchema();
  const maxCandidates = Math.max(1, Math.min(1000, Math.trunc(params?.maxCandidates ?? 200)));
  const actor = params?.actor?.trim() || "system_reconciliation";
  const candidates = await getExpiredReservationPreview(maxCandidates);

  const summary: ReconciliationSummary = {
    scanned: candidates.length,
    released: 0,
    alreadyFinalized: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const releaseResult = await releaseReservedCredits({
        anonUserId: candidate.anonUserId,
        reservationId: candidate.reservationId,
        actor,
        reason: "Reservation expired during reconciliation.",
        idempotencyScope: "reconciliation-expired-reservations",
        idempotencyKey: `release:${candidate.reservationId}`,
        metadata: {
          expiresAt: candidate.expiresAt,
          actionKind: candidate.actionKind,
          amount: candidate.amount,
        },
      });

      if (releaseResult.ok) {
        summary.released += 1;
        continue;
      }

      if (releaseResult.reason === "already_finalized" || releaseResult.reason === "not_found") {
        summary.alreadyFinalized += 1;
        continue;
      }

      summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
