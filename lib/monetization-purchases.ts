/**
 * Purchase transaction store with anti-replay uniqueness.
 */
import { randomUUID } from "crypto";
import { executeTurso } from "@/lib/turso";
import type { PurchaseProvider } from "@/lib/monetization-credit-packs";

export type PurchaseRecordStatus =
  | "verified"
  | "rejected"
  | "revoked"
  | "reversal_pending";

export type PurchaseRecord = {
  rowId: string;
  provider: PurchaseProvider;
  providerTransactionId: string;
  providerOriginalTransactionId: string | null;
  anonUserId: string;
  productId: string;
  status: PurchaseRecordStatus;
  grantedCredits: number;
  reversedCredits: number;
  outstandingReversalCredits: number;
  riskFlags: string[];
  verifiedAt: string | null;
  revokedAt: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type PurchaseVerificationInsert = {
  provider: PurchaseProvider;
  providerTransactionId: string;
  providerOriginalTransactionId?: string | null;
  anonUserId: string;
  productId: string;
  status: PurchaseRecordStatus;
  grantedCredits: number;
  reversedCredits?: number;
  outstandingReversalCredits?: number;
  verifiedAt?: string | null;
  revokedAt?: string | null;
  payload?: Record<string, unknown>;
  riskFlags?: string[];
};

let schemaReady: Promise<void> | null = null;

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

function parseRiskFlags(raw: unknown) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [] as string[];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
  } catch {
    return [];
  }
}

function parsePayload(raw: unknown) {
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

function rowToPurchaseRecord(row: Record<string, unknown>): PurchaseRecord {
  const statusRaw = asString(row.status);
  const status: PurchaseRecordStatus =
    statusRaw === "verified" ||
    statusRaw === "rejected" ||
    statusRaw === "revoked" ||
    statusRaw === "reversal_pending"
      ? statusRaw
      : "rejected";

  return {
    rowId: asString(row.row_id),
    provider:
      asString(row.provider) === "google_play" ? "google_play" : "apple_app_store",
    providerTransactionId: asString(row.provider_transaction_id),
    providerOriginalTransactionId: asString(row.provider_original_transaction_id) || null,
    anonUserId: asString(row.anon_user_id),
    productId: asString(row.product_id),
    status,
    grantedCredits: asInteger(row.granted_credits),
    reversedCredits: asInteger(row.reversed_credits),
    outstandingReversalCredits: asInteger(row.outstanding_reversal_credits),
    riskFlags: parseRiskFlags(row.risk_flags_json),
    verifiedAt: asString(row.verified_at) || null,
    revokedAt: asString(row.revoked_at) || null,
    payload: parsePayload(row.payload_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

async function ensureSchema() {
  if (schemaReady) {
    return schemaReady;
  }

  schemaReady = (async () => {
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
      `CREATE INDEX IF NOT EXISTS idx_credit_purchase_status
       ON credit_purchase_transactions (status, updated_at DESC)`,
    );
  })();

  return schemaReady;
}

export async function ensureMonetizationPurchaseSchema() {
  await ensureSchema();
}

export async function getPurchaseByProviderTransaction(
  provider: PurchaseProvider,
  providerTransactionId: string,
) {
  await ensureSchema();
  const result = await executeTurso({
    sql: `SELECT
            row_id,
            provider,
            provider_transaction_id,
            provider_original_transaction_id,
            anon_user_id,
            product_id,
            status,
            granted_credits,
            reversed_credits,
            outstanding_reversal_credits,
            risk_flags_json,
            payload_json,
            verified_at,
            revoked_at,
            created_at,
            updated_at
          FROM credit_purchase_transactions
          WHERE provider = ? AND provider_transaction_id = ?
          LIMIT 1`,
    args: [provider, providerTransactionId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToPurchaseRecord(row) : null;
}

export async function listRecentPurchasesForUser(anonUserId: string, limit = 20) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const result = await executeTurso({
    sql: `SELECT
            row_id,
            provider,
            provider_transaction_id,
            provider_original_transaction_id,
            anon_user_id,
            product_id,
            status,
            granted_credits,
            reversed_credits,
            outstanding_reversal_credits,
            risk_flags_json,
            payload_json,
            verified_at,
            revoked_at,
            created_at,
            updated_at
          FROM credit_purchase_transactions
          WHERE anon_user_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [anonUserId, safeLimit],
  });

  return result.rows
    .map((row) => rowToPurchaseRecord(row as Record<string, unknown>))
    .filter((row) => row.rowId.length > 0);
}

export async function createPurchaseRecord(input: PurchaseVerificationInsert) {
  await ensureSchema();
  const rowId = randomUUID();
  const nowIso = new Date().toISOString();

  await executeTurso({
    sql: `INSERT INTO credit_purchase_transactions (
            row_id,
            provider,
            provider_transaction_id,
            provider_original_transaction_id,
            anon_user_id,
            product_id,
            status,
            granted_credits,
            reversed_credits,
            outstanding_reversal_credits,
            risk_flags_json,
            payload_json,
            verified_at,
            revoked_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      rowId,
      input.provider,
      input.providerTransactionId,
      input.providerOriginalTransactionId ?? null,
      input.anonUserId,
      input.productId,
      input.status,
      input.grantedCredits,
      input.reversedCredits ?? 0,
      input.outstandingReversalCredits ?? 0,
      JSON.stringify(input.riskFlags ?? []),
      JSON.stringify(input.payload ?? {}),
      input.verifiedAt ?? null,
      input.revokedAt ?? null,
      nowIso,
      nowIso,
    ],
  });

  const created = await getPurchaseByProviderTransaction(
    input.provider,
    input.providerTransactionId,
  );
  if (!created) {
    throw new Error("Could not load created purchase record.");
  }
  return created;
}

export async function updatePurchaseRecord(params: {
  provider: PurchaseProvider;
  providerTransactionId: string;
  status: PurchaseRecordStatus;
  reversedCredits?: number;
  outstandingReversalCredits?: number;
  revokedAt?: string | null;
  payload?: Record<string, unknown>;
  addRiskFlags?: string[];
}) {
  await ensureSchema();
  const existing = await getPurchaseByProviderTransaction(
    params.provider,
    params.providerTransactionId,
  );
  if (!existing) {
    return null;
  }

  const mergedRiskFlags = Array.from(
    new Set([...(existing.riskFlags ?? []), ...(params.addRiskFlags ?? [])]),
  );
  const nowIso = new Date().toISOString();
  await executeTurso({
    sql: `UPDATE credit_purchase_transactions
          SET
            status = ?,
            reversed_credits = ?,
            outstanding_reversal_credits = ?,
            revoked_at = ?,
            risk_flags_json = ?,
            payload_json = ?,
            updated_at = ?
          WHERE provider = ? AND provider_transaction_id = ?`,
    args: [
      params.status,
      params.reversedCredits ?? existing.reversedCredits,
      params.outstandingReversalCredits ?? existing.outstandingReversalCredits,
      params.revokedAt ?? existing.revokedAt ?? null,
      JSON.stringify(mergedRiskFlags),
      JSON.stringify(params.payload ?? existing.payload),
      nowIso,
      params.provider,
      params.providerTransactionId,
    ],
  });

  return getPurchaseByProviderTransaction(params.provider, params.providerTransactionId);
}
