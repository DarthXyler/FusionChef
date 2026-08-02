import type { Client } from "@libsql/client";
import { getTursoClient } from "./turso.ts";

type SchemaClient = Pick<Client, "execute">;

const REQUIRED_TABLE_COLUMNS: Record<string, readonly string[]> = {
  auth_users: [
    "id",
    "email",
    "normalized_email",
    "name",
    "avatar_url",
    "provider",
    "provider_subject",
    "role",
    "last_login_at",
  ],
  auth_identity_links: ["auth_user_id", "canonical_anon_user_id"],
  mobile_identity_aliases: ["anon_user_id", "canonical_anon_user_id"],
  mobile_identity_links: ["device_key", "canonical_anon_user_id"],
  cookbook_recipes: ["row_id", "anon_user_id", "recipe_id", "image_url"],
  product_activity_events: ["event_id", "auth_user_id", "activity_type"],
  credit_balances: ["anon_user_id", "available_credits", "pending_credits"],
  credit_reservations: [
    "reservation_id",
    "anon_user_id",
    "status",
    "expires_at",
  ],
  credit_daily_usage: ["anon_user_id", "day_key"],
  credit_ledger_entries: [
    "entry_id",
    "anon_user_id",
    "event_type",
    "amount",
    "balance_available_after",
    "balance_pending_after",
    "reservation_id",
    "metadata_json",
    "idempotency_scope",
    "idempotency_key",
    "actor",
    "created_at",
  ],
  credit_purchase_transactions: [
    "row_id",
    "provider",
    "provider_transaction_id",
    "anon_user_id",
    "product_id",
    "status",
    "granted_credits",
    "reversed_credits",
    "outstanding_reversal_credits",
    "risk_flags_json",
    "payload_json",
    "verified_at",
    "revoked_at",
    "created_at",
    "updated_at",
  ],
  credit_purchase_ledger_links: [
    "id",
    "purchase_transaction_id",
    "ledger_entry_id",
    "link_kind",
    "created_at",
  ],
  purchase_reconciliation_actions: [
    "id",
    "issue_type",
    "purchase_transaction_id",
    "ledger_entry_id",
    "admin_actor",
    "reason",
    "preview_fingerprint",
    "idempotency_key",
    "balance_before",
    "balance_after",
    "credit_delta",
    "provider_verification_hash",
    "status",
    "created_at",
    "completed_at",
    "failure_code",
    "metadata_json",
  ],
  account_deletion_events: [
    "deletion_id",
    "auth_user_id",
    "canonical_anon_user_id",
    "email_hash",
    "provider",
    "role",
    "requested_by",
    "reason",
    "counts_json",
    "purchase_transactions_preserved",
    "idempotency_key",
    "deleted_at",
  ],
  account_deletion_jobs: [
    "job_id",
    "request_id",
    "request_source",
    "acting_admin_ref",
    "reason",
    "plan_json",
    "preview_fingerprint",
    "preview_expires_at",
    "status",
    "attempt_count",
    "last_error_code",
    "last_error_summary",
    "idempotency_key",
    "created_at",
    "approved_at",
    "started_at",
    "updated_at",
    "completed_at",
  ],
  account_deletion_job_targets: [
    "target_id",
    "job_id",
    "target_ref",
    "graph_fingerprint",
    "plan_json",
    "status",
    "attempt_count",
    "last_error_code",
    "last_error_summary",
    "created_at",
    "started_at",
    "updated_at",
    "completed_at",
  ],
};

const REQUIRED_PUR01_OBJECTS: Record<string, "index" | "trigger" | "view"> = {
  idx_credit_purchase_ledger_links_purchase: "index",
  ux_credit_purchase_ledger_links_base_grant: "index",
  idx_purchase_reconciliation_actions_purchase: "index",
  idx_purchase_reconciliation_actions_ledger: "index",
  idx_purchase_reconciliation_actions_status: "index",
  idx_purchase_reconciliation_actions_created: "index",
  trg_purchase_reconciliation_completed_update: "trigger",
  trg_purchase_reconciliation_completed_delete: "trigger",
  purchase_ledger_backfill_report: "view",
  idx_account_deletion_jobs_status_updated: "index",
  idx_account_deletion_jobs_preview_expiration: "index",
  idx_account_deletion_jobs_created: "index",
  idx_account_deletion_targets_job_status: "index",
  idx_account_deletion_targets_status_updated: "index",
};

export class AccountDeletionSchemaError extends Error {
  code = "account_deletion_schema_not_ready";
  statusCode = 503;
  missingObjects: string[];

  constructor(missingObjects: string[]) {
    super(
      "Account deletion is unavailable because the required database schema is not ready.",
    );
    this.missingObjects = [...new Set(missingObjects)].sort();
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function assertAccountDeletionSchemaReady(
  options: { client?: SchemaClient } = {},
) {
  const client = options.client ?? getTursoClient();
  const requiredNames = [
    ...Object.keys(REQUIRED_TABLE_COLUMNS),
    ...Object.keys(REQUIRED_PUR01_OBJECTS),
  ];
  const placeholders = requiredNames.map(() => "?").join(", ");
  const objects = await client.execute({
    sql: `SELECT type, name
          FROM sqlite_master
          WHERE name IN (${placeholders})`,
    args: requiredNames,
  });
  const objectTypes = new Map(
    objects.rows.map((row) => [asString(row.name), asString(row.type)]),
  );
  const missing: string[] = [];

  for (const tableName of Object.keys(REQUIRED_TABLE_COLUMNS)) {
    if (objectTypes.get(tableName) !== "table") {
      missing.push(`table:${tableName}`);
      continue;
    }
    const columns = await client.execute(
      `PRAGMA table_info('${tableName}')`,
    );
    const presentColumns = new Set(
      columns.rows.map((row) => asString(row.name)),
    );
    for (const column of REQUIRED_TABLE_COLUMNS[tableName]) {
      if (!presentColumns.has(column)) {
        missing.push(`column:${tableName}.${column}`);
      }
    }
  }

  for (const [name, type] of Object.entries(REQUIRED_PUR01_OBJECTS)) {
    if (objectTypes.get(name) !== type) {
      missing.push(`${type}:${name}`);
    }
  }

  if (missing.length > 0) {
    throw new AccountDeletionSchemaError(missing);
  }
}
