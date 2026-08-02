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
    "metadata_json",
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
    "payload_json",
  ],
  credit_purchase_ledger_links: [
    "id",
    "purchase_transaction_id",
    "ledger_entry_id",
    "link_kind",
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
    "status",
    "metadata_json",
  ],
  account_deletion_events: [
    "deletion_id",
    "auth_user_id",
    "canonical_anon_user_id",
    "email_hash",
    "requested_by",
    "reason",
    "counts_json",
    "idempotency_key",
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
