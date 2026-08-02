import type { InStatement } from "@libsql/client";
import type { AccountDeletionGraphPlan } from "./account-deletion-planner.ts";
import { ACCOUNT_DELETION_RECONCILIATION_METADATA } from "./purchase-settlement-retention.ts";

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function deleteWhereIn(table: string, column: string, values: string[]): InStatement | null {
  if (values.length === 0) {
    return null;
  }
  return {
    sql: `DELETE FROM ${table} WHERE ${column} IN (${placeholders(values)})`,
    args: values,
  };
}

export function buildAccountDeletionGraphCleanupStatements(options: {
  graph: AccountDeletionGraphPlan;
  deletedPurchaseOwner: string;
}): InStatement[] {
  const authUserIds = options.graph.ownerAuthUserIds;
  const identityNodes = options.graph.identityNodes;
  const statements: Array<InStatement | null> = [];

  if (identityNodes.length > 0) {
    const nodeList = placeholders(identityNodes);
    statements.push(
      {
        sql: `UPDATE purchase_reconciliation_actions
              SET metadata_json = CASE
                    WHEN metadata_json IS NULL THEN NULL
                    ELSE ?
                  END
              WHERE purchase_transaction_id IN (
                      SELECT row_id
                      FROM credit_purchase_transactions
                      WHERE anon_user_id IN (${nodeList})
                    )
                 OR ledger_entry_id IN (
                      SELECT entry_id
                      FROM credit_ledger_entries
                      WHERE anon_user_id IN (${nodeList})
                    )`,
        args: [
          ACCOUNT_DELETION_RECONCILIATION_METADATA,
          ...identityNodes,
          ...identityNodes,
        ],
      },
      {
        sql: `UPDATE credit_purchase_transactions
              SET anon_user_id = ?, payload_json = '{}',
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE anon_user_id IN (${nodeList})`,
        args: [options.deletedPurchaseOwner, ...identityNodes],
      },
      deleteWhereIn("cookbook_recipes", "anon_user_id", identityNodes),
      deleteWhereIn("credit_balances", "anon_user_id", identityNodes),
      deleteWhereIn("credit_reservations", "anon_user_id", identityNodes),
      deleteWhereIn("credit_ledger_entries", "anon_user_id", identityNodes),
      deleteWhereIn("credit_daily_usage", "anon_user_id", identityNodes),
      deleteWhereIn(
        "mobile_identity_links",
        "canonical_anon_user_id",
        identityNodes,
      ),
      {
        sql: `DELETE FROM mobile_identity_aliases
              WHERE anon_user_id IN (${nodeList})
                 OR canonical_anon_user_id IN (${nodeList})`,
        args: [...identityNodes, ...identityNodes],
      },
    );
  }

  if (authUserIds.length > 0) {
    const authList = placeholders(authUserIds);
    if (identityNodes.length > 0) {
      statements.push({
        sql: `DELETE FROM auth_identity_links
              WHERE auth_user_id IN (${authList})
                 OR canonical_anon_user_id IN (${placeholders(identityNodes)})`,
        args: [...authUserIds, ...identityNodes],
      });
    } else {
      statements.push(
        deleteWhereIn("auth_identity_links", "auth_user_id", authUserIds),
      );
    }
    statements.push(
      deleteWhereIn(
        "product_activity_events",
        "auth_user_id",
        authUserIds,
      ),
      deleteWhereIn("auth_users", "id", authUserIds),
    );
  }

  return statements.filter((statement): statement is InStatement => statement !== null);
}
