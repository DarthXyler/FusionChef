import type { InStatement } from "@libsql/client";

export const ACCOUNT_DELETION_RECONCILIATION_METADATA =
  '{"redacted_for_account_deletion":true}';

/**
 * Redacts optional reconciliation metadata before the existing account-deletion
 * transaction anonymizes purchases and removes credit ledger rows.
 *
 * Completed financial facts remain immutable. Ledger references are later set
 * to NULL by the schema FK when retained ledger rows are deleted.
 */
export function buildPurchaseReconciliationAccountDeletionStatement(
  canonicalAnonUserId: string,
): InStatement {
  return {
    sql: `UPDATE purchase_reconciliation_actions
          SET metadata_json = CASE
                WHEN metadata_json IS NULL THEN NULL
                ELSE ?
              END
          WHERE purchase_transaction_id IN (
                  SELECT row_id
                  FROM credit_purchase_transactions
                  WHERE anon_user_id = ?
                )
             OR ledger_entry_id IN (
                  SELECT entry_id
                  FROM credit_ledger_entries
                  WHERE anon_user_id = ?
                )`,
    args: [
      ACCOUNT_DELETION_RECONCILIATION_METADATA,
      canonicalAnonUserId,
      canonicalAnonUserId,
    ],
  };
}
