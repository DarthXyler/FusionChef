import { createHmac } from "crypto";
import type { InStatement } from "@libsql/client";

export const ACCOUNT_DELETION_RECONCILIATION_METADATA =
  '{"redacted_for_account_deletion":true}';
export const ACCOUNT_DELETION_LEDGER_METADATA =
  '{"retained_for_financial_audit":true,"redacted_for_account_deletion":true}';
export const ACCOUNT_DELETION_LEDGER_ACTOR =
  "account_deletion_retained_financial";

const PSEUDONYM_PREFIX = "deleted:v1:";

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function getPseudonymSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.ACCOUNT_DELETION_PSEUDONYM_SECRET?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    "";
  if (secret.length < 32) {
    throw new Error("Account-deletion pseudonymization is not configured.");
  }
  return secret;
}

export function createAccountDeletionPseudonym(options: {
  authUserIds: string[];
  identityNodes: string[];
  secret?: string;
}) {
  const payload = JSON.stringify({
    authUserIds: [...new Set(options.authUserIds)].sort(),
    identityNodes: [...new Set(options.identityNodes)].sort(),
  });
  const digest = createHmac("sha256", getPseudonymSecret(options.secret))
    .update("flavor-fusion-chef:account-deletion-owner:v1\u0000")
    .update(payload)
    .digest("hex");
  return `${PSEUDONYM_PREFIX}${digest}`;
}

export function isAccountDeletionPseudonym(value: string) {
  return /^deleted:v1:[0-9a-f]{64}$/.test(value);
}

/**
 * Redacts target-associated reconciliation metadata while purchase/ledger
 * ownership still points at the live graph. Completed action triggers allow
 * only this fixed privacy marker.
 */
export function buildPurchaseReconciliationAccountDeletionStatement(
  identityNodesOrCanonical: string[] | string,
): InStatement {
  const identityNodes = Array.isArray(identityNodesOrCanonical)
    ? identityNodesOrCanonical
    : [identityNodesOrCanonical];
  const nodeList = placeholders(identityNodes);
  return {
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
  };
}

/**
 * Moves all purchase evidence and every purchase-linked financial ledger row
 * to one non-reversible pseudonymous owner. Provider transaction IDs, amounts,
 * statuses, timestamps, risk/refund flags, links, and reconciliation facts are
 * retained; opaque provider payloads and ledger metadata/actors are redacted.
 */
export function buildPurchaseFinancialRetentionStatements(options: {
  identityNodes: string[];
  pseudonymousOwner: string;
}): InStatement[] {
  if (options.identityNodes.length === 0) {
    return [];
  }
  if (!isAccountDeletionPseudonym(options.pseudonymousOwner)) {
    throw new Error("Invalid account-deletion pseudonymous owner.");
  }
  const nodes = options.identityNodes;
  const nodeList = placeholders(nodes);
  return [
    buildPurchaseReconciliationAccountDeletionStatement(nodes),
    {
      sql: `UPDATE credit_ledger_entries
            SET anon_user_id = ?,
                reservation_id = NULL,
                actor = ?,
                metadata_json = ?
            WHERE anon_user_id IN (${nodeList})
              AND (
                event_type IN (
                  'purchase_grant',
                  'purchase_adjustment',
                  'purchase_reversal'
                )
                OR entry_id IN (
                  SELECT links.ledger_entry_id
                  FROM credit_purchase_ledger_links links
                  JOIN credit_purchase_transactions purchase
                    ON purchase.row_id = links.purchase_transaction_id
                  WHERE purchase.anon_user_id IN (${nodeList})
                )
              )`,
      args: [
        options.pseudonymousOwner,
        ACCOUNT_DELETION_LEDGER_ACTOR,
        ACCOUNT_DELETION_LEDGER_METADATA,
        ...nodes,
        ...nodes,
      ],
    },
    {
      sql: `UPDATE credit_purchase_transactions
            SET anon_user_id = ?,
                payload_json = '{}',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE anon_user_id IN (${nodeList})`,
      args: [options.pseudonymousOwner, ...nodes],
    },
  ];
}
