import type { InStatement } from "@libsql/client";

export type PurchaseReconciliationAuditInput = {
  actionId: string;
  issueType: string;
  purchaseTransactionId: string | null;
  ledgerEntryId: string | null;
  adminActor: string;
  reason: string;
  previewFingerprint: string;
  idempotencyKey: string;
  balanceBefore: number;
  balanceAfter: number;
  creditDelta: number;
  providerVerificationHash: string;
  completedAt: string;
  metadata?: Record<string, unknown> | null;
};

type StatementExecutor = {
  execute(statement: InStatement | string): Promise<unknown>;
};

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeJsonValue(nested)]),
    );
  }
  return value;
}

function assertAuditInput(input: PurchaseReconciliationAuditInput) {
  if (
    !input.actionId.trim() ||
    !input.issueType.trim() ||
    !input.adminActor.trim() ||
    !input.reason.trim() ||
    !input.previewFingerprint.trim() ||
    !input.idempotencyKey.trim() ||
    !input.providerVerificationHash.trim() ||
    !input.completedAt.trim()
  ) {
    throw new Error("Purchase reconciliation audit facts are incomplete.");
  }
  if (
    !Number.isInteger(input.balanceBefore) ||
    input.balanceBefore < 0 ||
    !Number.isInteger(input.balanceAfter) ||
    input.balanceAfter < 0 ||
    !Number.isInteger(input.creditDelta) ||
    input.balanceAfter - input.balanceBefore !== input.creditDelta
  ) {
    throw new Error("Purchase reconciliation audit balance facts are invalid.");
  }
}

export async function insertCompletedPurchaseReconciliationAudit(
  executor: StatementExecutor,
  input: PurchaseReconciliationAuditInput,
) {
  assertAuditInput(input);
  await executor.execute({
    sql: `INSERT INTO purchase_reconciliation_actions (
            id,
            issue_type,
            purchase_transaction_id,
            ledger_entry_id,
            admin_actor,
            reason,
            preview_fingerprint,
            idempotency_key,
            balance_before,
            balance_after,
            credit_delta,
            provider_verification_hash,
            status,
            created_at,
            completed_at,
            failure_code,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'completed', ?, ?, NULL, ?)`,
    args: [
      input.actionId,
      input.issueType,
      input.purchaseTransactionId,
      input.ledgerEntryId,
      input.adminActor,
      input.reason,
      input.previewFingerprint,
      input.idempotencyKey,
      input.balanceBefore,
      input.balanceAfter,
      input.creditDelta,
      input.providerVerificationHash,
      input.completedAt,
      input.completedAt,
      JSON.stringify(normalizeJsonValue(input.metadata ?? {})),
    ],
  });
}
