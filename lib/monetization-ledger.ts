/**
 * Credits ledger + reservation data layer.
 * S1 foundation: immutable ledger entries and safe reservation lifecycle operations.
 */
import { randomUUID } from "crypto";
import { executeTurso } from "@/lib/turso";

const MAX_ADMIN_CREDIT_AMOUNT = 100_000;

let schemaReady: Promise<void> | null = null;

export type MonetizationActionKind = "fuse" | "reroll";
export type CreditReservationStatus = "reserved" | "committed" | "released";
export type CreditLedgerEvent =
  | "observe_fuse"
  | "observe_reroll"
  | "grant"
  | "reserve"
  | "commit"
  | "release";

export type CreditBalance = {
  anonUserId: string;
  availableCredits: number;
  pendingCredits: number;
  updatedAt: string;
};

export type CreditReservation = {
  reservationId: string;
  anonUserId: string;
  actionKind: MonetizationActionKind;
  amount: number;
  status: CreditReservationStatus;
  reason: string;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  idempotencyScope: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreditLedgerEntry = {
  entryId: string;
  anonUserId: string;
  eventType: CreditLedgerEvent;
  amount: number;
  balanceAvailableAfter: number;
  balancePendingAfter: number;
  reservationId: string | null;
  idempotencyScope: string | null;
  idempotencyKey: string | null;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ReserveCreditsResult =
  | {
      ok: true;
      reservation: CreditReservation;
      balance: CreditBalance;
    }
  | {
      ok: false;
      reason: "insufficient_credits";
    };

type FinalizeReservationResult =
  | {
      ok: true;
      reservation: CreditReservation;
      balance: CreditBalance;
    }
  | { ok: false; reason: "not_found" | "already_finalized" };

type SnapshotOptions = {
  reservationsLimit?: number;
  ledgerLimit?: number;
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

function toMetadataJson(metadata: Record<string, unknown> | undefined) {
  return JSON.stringify(metadata ?? {});
}

function parseMetadata(raw: unknown) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function rowToBalance(row: Record<string, unknown> | null, anonUserId: string): CreditBalance {
  if (!row) {
    return {
      anonUserId,
      availableCredits: 0,
      pendingCredits: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  return {
    anonUserId,
    availableCredits: asInteger(row.available_credits),
    pendingCredits: asInteger(row.pending_credits),
    updatedAt: asString(row.updated_at),
  };
}

function rowToReservation(row: Record<string, unknown>): CreditReservation {
  return {
    reservationId: asString(row.reservation_id),
    anonUserId: asString(row.anon_user_id),
    actionKind: asString(row.action_kind) === "reroll" ? "reroll" : "fuse",
    amount: asInteger(row.amount),
    status:
      asString(row.status) === "committed"
        ? "committed"
        : asString(row.status) === "released"
          ? "released"
          : "reserved",
    reason: asString(row.reason),
    metadata: parseMetadata(row.metadata_json),
    expiresAt: asString(row.expires_at) || null,
    idempotencyScope: asString(row.idempotency_scope) || null,
    idempotencyKey: asString(row.idempotency_key) || null,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToLedgerEntry(row: Record<string, unknown>): CreditLedgerEntry {
  return {
    entryId: asString(row.entry_id),
    anonUserId: asString(row.anon_user_id),
    eventType: (asString(row.event_type) as CreditLedgerEvent) || "observe_fuse",
    amount: asInteger(row.amount),
    balanceAvailableAfter: asInteger(row.balance_available_after),
    balancePendingAfter: asInteger(row.balance_pending_after),
    reservationId: asString(row.reservation_id) || null,
    idempotencyScope: asString(row.idempotency_scope) || null,
    idempotencyKey: asString(row.idempotency_key) || null,
    actor: asString(row.actor),
    metadata: parseMetadata(row.metadata_json),
    createdAt: asString(row.created_at),
  };
}

function assertPositiveCreditAmount(amount: number) {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) {
    throw new Error("amount must be a positive integer.");
  }

  if (amount > MAX_ADMIN_CREDIT_AMOUNT) {
    throw new Error(`amount must be <= ${MAX_ADMIN_CREDIT_AMOUNT}.`);
  }
}

async function ensureSchema() {
  if (schemaReady) {
    return schemaReady;
  }

  schemaReady = (async () => {
    await executeTurso(
      `CREATE TABLE IF NOT EXISTS credit_balances (
        anon_user_id TEXT PRIMARY KEY,
        available_credits INTEGER NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
        pending_credits INTEGER NOT NULL DEFAULT 0 CHECK(pending_credits >= 0),
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
        reason TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT,
        idempotency_scope TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
    );
    await executeTurso(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_reservation_idempotency
       ON credit_reservations (idempotency_scope, idempotency_key)
       WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL`,
    );
    await executeTurso(
      `CREATE INDEX IF NOT EXISTS idx_credit_reservations_user_status
       ON credit_reservations (anon_user_id, status, created_at DESC)`,
    );
    await executeTurso(
      `CREATE TABLE IF NOT EXISTS credit_ledger_entries (
        entry_id TEXT PRIMARY KEY,
        anon_user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_available_after INTEGER NOT NULL CHECK(balance_available_after >= 0),
        balance_pending_after INTEGER NOT NULL CHECK(balance_pending_after >= 0),
        reservation_id TEXT,
        idempotency_scope TEXT,
        idempotency_key TEXT,
        actor TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
    );
    await executeTurso(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idempotency
       ON credit_ledger_entries (idempotency_scope, idempotency_key)
       WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL`,
    );
    await executeTurso(
      `CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
       ON credit_ledger_entries (anon_user_id, created_at DESC)`,
    );
  })();

  return schemaReady;
}

async function ensureBalanceRow(anonUserId: string) {
  await executeTurso({
    sql: `INSERT INTO credit_balances (
            anon_user_id,
            available_credits,
            pending_credits,
            updated_at
          ) VALUES (?, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(anon_user_id) DO NOTHING`,
    args: [anonUserId],
  });
}

async function fetchBalance(anonUserId: string) {
  const result = await executeTurso({
    sql: `SELECT anon_user_id, available_credits, pending_credits, updated_at
          FROM credit_balances
          WHERE anon_user_id = ?
          LIMIT 1`,
    args: [anonUserId],
  });

  const row = (result.rows[0] as Record<string, unknown>) ?? null;
  return rowToBalance(row, anonUserId);
}

async function fetchReservation(anonUserId: string, reservationId: string) {
  const result = await executeTurso({
    sql: `SELECT
            reservation_id,
            anon_user_id,
            action_kind,
            amount,
            status,
            reason,
            metadata_json,
            expires_at,
            idempotency_scope,
            idempotency_key,
            created_at,
            updated_at
          FROM credit_reservations
          WHERE reservation_id = ? AND anon_user_id = ?
          LIMIT 1`,
    args: [reservationId, anonUserId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToReservation(row) : null;
}

export async function getCreditBalance(anonUserId: string) {
  await ensureSchema();
  await ensureBalanceRow(anonUserId);
  return fetchBalance(anonUserId);
}

export async function recordObservedMonetizationAction(params: {
  anonUserId: string;
  actionKind: MonetizationActionKind;
  actor?: string;
  metadata?: Record<string, unknown>;
}) {
  await ensureSchema();
  await ensureBalanceRow(params.anonUserId);

  const nowIso = new Date().toISOString();
  const eventType: CreditLedgerEvent =
    params.actionKind === "reroll" ? "observe_reroll" : "observe_fuse";
  const entryId = randomUUID();
  const actor = params.actor?.trim() || "system_observer";

  const result = await executeTurso({
    sql: `WITH current_balance AS (
            SELECT available_credits, pending_credits
            FROM credit_balances
            WHERE anon_user_id = ?
          )
          INSERT INTO credit_ledger_entries (
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            reservation_id,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json,
            created_at
          )
          SELECT
            ?,
            ?,
            ?,
            0,
            current_balance.available_credits,
            current_balance.pending_credits,
            NULL,
            NULL,
            NULL,
            ?,
            ?,
            ?
          FROM current_balance
          RETURNING
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            reservation_id,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json,
            created_at`,
    args: [
      params.anonUserId,
      entryId,
      params.anonUserId,
      eventType,
      actor,
      toMetadataJson(params.metadata),
      nowIso,
    ],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Could not write observation ledger entry.");
  }
  return rowToLedgerEntry(row);
}

export async function grantCredits(params: {
  anonUserId: string;
  amount: number;
  reason?: string;
  actor: string;
  idempotencyScope?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}) {
  assertPositiveCreditAmount(params.amount);
  await ensureSchema();
  await ensureBalanceRow(params.anonUserId);

  const nowIso = new Date().toISOString();
  const entryId = randomUUID();
  const result = await executeTurso({
    sql: `WITH updated AS (
            UPDATE credit_balances
            SET
              available_credits = available_credits + ?,
              updated_at = ?
            WHERE anon_user_id = ?
            RETURNING available_credits, pending_credits
          )
          INSERT INTO credit_ledger_entries (
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            reservation_id,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json,
            created_at
          )
          SELECT
            ?,
            ?,
            'grant',
            ?,
            updated.available_credits,
            updated.pending_credits,
            NULL,
            ?,
            ?,
            ?,
            ?,
            ?
          FROM updated
          RETURNING
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            reservation_id,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json,
            created_at`,
    args: [
      params.amount,
      nowIso,
      params.anonUserId,
      entryId,
      params.anonUserId,
      params.amount,
      params.idempotencyScope ?? null,
      params.idempotencyKey ?? null,
      params.actor,
      toMetadataJson({
        reason: params.reason ?? "",
        ...(params.metadata ?? {}),
      }),
      nowIso,
    ],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("Could not grant credits.");
  }

  const ledgerEntry = rowToLedgerEntry(row);
  const balance: CreditBalance = {
    anonUserId: params.anonUserId,
    availableCredits: ledgerEntry.balanceAvailableAfter,
    pendingCredits: ledgerEntry.balancePendingAfter,
    updatedAt: nowIso,
  };
  return { balance, ledgerEntry };
}

export async function reserveCredits(params: {
  anonUserId: string;
  amount: number;
  actionKind: MonetizationActionKind;
  reason?: string;
  actor: string;
  expiresAt?: string | null;
  reservationId?: string;
  idempotencyScope?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ReserveCreditsResult> {
  assertPositiveCreditAmount(params.amount);
  await ensureSchema();
  await ensureBalanceRow(params.anonUserId);

  const nowIso = new Date().toISOString();
  const reservationId = params.reservationId?.trim() || randomUUID();
  const entryId = randomUUID();
  const result = await executeTurso({
    sql: `WITH updated_balance AS (
            UPDATE credit_balances
            SET
              available_credits = available_credits - ?,
              pending_credits = pending_credits + ?,
              updated_at = ?
            WHERE anon_user_id = ?
              AND available_credits >= ?
            RETURNING available_credits, pending_credits
          ),
          inserted_reservation AS (
            INSERT INTO credit_reservations (
              reservation_id,
              anon_user_id,
              action_kind,
              amount,
              status,
              reason,
              metadata_json,
              expires_at,
              idempotency_scope,
              idempotency_key,
              created_at,
              updated_at
            )
            SELECT
              ?,
              ?,
              ?,
              ?,
              'reserved',
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?
            FROM updated_balance
            RETURNING reservation_id
          )
          INSERT INTO credit_ledger_entries (
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            reservation_id,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json,
            created_at
          )
          SELECT
            ?,
            ?,
            'reserve',
            ?,
            updated_balance.available_credits,
            updated_balance.pending_credits,
            inserted_reservation.reservation_id,
            ?,
            ?,
            ?,
            ?,
            ?
          FROM updated_balance
          JOIN inserted_reservation ON 1 = 1
          RETURNING
            reservation_id,
            balance_available_after,
            balance_pending_after`,
    args: [
      params.amount,
      params.amount,
      nowIso,
      params.anonUserId,
      params.amount,
      reservationId,
      params.anonUserId,
      params.actionKind,
      params.amount,
      params.reason ?? "",
      toMetadataJson(params.metadata),
      params.expiresAt ?? null,
      params.idempotencyScope ?? null,
      params.idempotencyKey ?? null,
      nowIso,
      nowIso,
      entryId,
      params.anonUserId,
      params.amount,
      params.idempotencyScope ?? null,
      params.idempotencyKey ?? null,
      params.actor,
      toMetadataJson({
        reason: params.reason ?? "",
        ...(params.metadata ?? {}),
      }),
      nowIso,
    ],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { ok: false, reason: "insufficient_credits" };
  }

  const reservation = await fetchReservation(params.anonUserId, asString(row.reservation_id));
  if (!reservation) {
    throw new Error("Could not load created reservation.");
  }

  const balance: CreditBalance = {
    anonUserId: params.anonUserId,
    availableCredits: asInteger(row.balance_available_after),
    pendingCredits: asInteger(row.balance_pending_after),
    updatedAt: nowIso,
  };

  return {
    ok: true,
    reservation,
    balance,
  };
}

async function finalizeReservation(params: {
  anonUserId: string;
  reservationId: string;
  actor: string;
  targetStatus: "committed" | "released";
  reason?: string;
  idempotencyScope?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<FinalizeReservationResult> {
  await ensureSchema();
  await ensureBalanceRow(params.anonUserId);

  const existing = await fetchReservation(params.anonUserId, params.reservationId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "reserved") {
    return { ok: false, reason: "already_finalized" };
  }

  const nowIso = new Date().toISOString();
  const entryId = randomUUID();
  const shouldRelease = params.targetStatus === "released";
  const eventType: CreditLedgerEvent = shouldRelease ? "release" : "commit";

  const result = await executeTurso({
    sql: `WITH moved_reservation AS (
            UPDATE credit_reservations
            SET
              status = ?,
              reason = CASE
                WHEN ? = '' THEN reason
                ELSE ?
              END,
              metadata_json = CASE
                WHEN ? = '{}' THEN metadata_json
                ELSE ?
              END,
              updated_at = ?
            WHERE reservation_id = ?
              AND anon_user_id = ?
              AND status = 'reserved'
            RETURNING reservation_id, amount
          ),
          updated_balance AS (
            UPDATE credit_balances
            SET
              available_credits = available_credits + CASE
                WHEN ? THEN (SELECT amount FROM moved_reservation)
                ELSE 0
              END,
              pending_credits = pending_credits - (SELECT amount FROM moved_reservation),
              updated_at = ?
            WHERE anon_user_id = ?
              AND EXISTS (SELECT 1 FROM moved_reservation)
            RETURNING available_credits, pending_credits
          )
          INSERT INTO credit_ledger_entries (
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            reservation_id,
            idempotency_scope,
            idempotency_key,
            actor,
            metadata_json,
            created_at
          )
          SELECT
            ?,
            ?,
            ?,
            (SELECT amount FROM moved_reservation),
            updated_balance.available_credits,
            updated_balance.pending_credits,
            moved_reservation.reservation_id,
            ?,
            ?,
            ?,
            ?,
            ?
          FROM moved_reservation
          JOIN updated_balance ON 1 = 1
          RETURNING
            reservation_id,
            balance_available_after,
            balance_pending_after`,
    args: [
      params.targetStatus,
      params.reason ?? "",
      params.reason ?? "",
      toMetadataJson(params.metadata),
      toMetadataJson(params.metadata),
      nowIso,
      params.reservationId,
      params.anonUserId,
      shouldRelease ? 1 : 0,
      nowIso,
      params.anonUserId,
      entryId,
      params.anonUserId,
      eventType,
      params.idempotencyScope ?? null,
      params.idempotencyKey ?? null,
      params.actor,
      toMetadataJson({
        reason: params.reason ?? "",
        ...(params.metadata ?? {}),
      }),
      nowIso,
    ],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { ok: false, reason: "already_finalized" };
  }

  const reservation = await fetchReservation(params.anonUserId, asString(row.reservation_id));
  if (!reservation) {
    throw new Error("Could not load finalized reservation.");
  }

  const balance: CreditBalance = {
    anonUserId: params.anonUserId,
    availableCredits: asInteger(row.balance_available_after),
    pendingCredits: asInteger(row.balance_pending_after),
    updatedAt: nowIso,
  };

  return {
    ok: true,
    reservation,
    balance,
  };
}

export async function commitReservedCredits(params: {
  anonUserId: string;
  reservationId: string;
  actor: string;
  reason?: string;
  idempotencyScope?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return finalizeReservation({
    ...params,
    targetStatus: "committed",
  });
}

export async function releaseReservedCredits(params: {
  anonUserId: string;
  reservationId: string;
  actor: string;
  reason?: string;
  idempotencyScope?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return finalizeReservation({
    ...params,
    targetStatus: "released",
  });
}

export async function getCreditAccountSnapshot(
  anonUserId: string,
  options?: SnapshotOptions,
) {
  await ensureSchema();
  await ensureBalanceRow(anonUserId);

  const reservationsLimit = Math.max(1, Math.min(200, options?.reservationsLimit ?? 50));
  const ledgerLimit = Math.max(1, Math.min(200, options?.ledgerLimit ?? 50));

  const [balance, reservationsResult, ledgerResult] = await Promise.all([
    fetchBalance(anonUserId),
    executeTurso({
      sql: `SELECT
              reservation_id,
              anon_user_id,
              action_kind,
              amount,
              status,
              reason,
              metadata_json,
              expires_at,
              idempotency_scope,
              idempotency_key,
              created_at,
              updated_at
            FROM credit_reservations
            WHERE anon_user_id = ?
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [anonUserId, reservationsLimit],
    }),
    executeTurso({
      sql: `SELECT
              entry_id,
              anon_user_id,
              event_type,
              amount,
              balance_available_after,
              balance_pending_after,
              reservation_id,
              idempotency_scope,
              idempotency_key,
              actor,
              metadata_json,
              created_at
            FROM credit_ledger_entries
            WHERE anon_user_id = ?
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [anonUserId, ledgerLimit],
    }),
  ]);

  return {
    balance,
    reservations: reservationsResult.rows
      .map((row) => rowToReservation(row as Record<string, unknown>))
      .filter((row) => row.reservationId.length > 0),
    ledger: ledgerResult.rows
      .map((row) => rowToLedgerEntry(row as Record<string, unknown>))
      .filter((row) => row.entryId.length > 0),
  };
}
