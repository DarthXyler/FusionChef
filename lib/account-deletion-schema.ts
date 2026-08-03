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
    "created_at",
    "updated_at",
  ],
  auth_identity_links: [
    "auth_user_id",
    "canonical_anon_user_id",
    "created_at",
    "updated_at",
  ],
  mobile_identity_aliases: [
    "anon_user_id",
    "canonical_anon_user_id",
    "created_at",
    "updated_at",
  ],
  mobile_identity_links: [
    "device_key",
    "canonical_anon_user_id",
    "created_at",
    "updated_at",
  ],
  cookbook_recipes: [
    "row_id",
    "anon_user_id",
    "recipe_id",
    "recipe_json",
    "source_input_json",
    "image_url",
    "saved_at",
    "created_at",
    "updated_at",
    "is_favorite",
    "is_to_try",
  ],
  product_activity_events: [
    "event_id",
    "auth_user_id",
    "activity_type",
    "source_reference_id",
    "occurred_at",
  ],
  credit_balances: [
    "anon_user_id",
    "available_credits",
    "pending_credits",
    "updated_at",
  ],
  credit_reservations: [
    "reservation_id",
    "anon_user_id",
    "action_kind",
    "amount",
    "status",
    "reason",
    "metadata_json",
    "expires_at",
    "idempotency_scope",
    "idempotency_key",
    "created_at",
    "updated_at",
  ],
  credit_daily_usage: [
    "anon_user_id",
    "day_key",
    "timezone",
    "fuse_count",
    "reroll_count",
    "updated_at",
    "created_at",
  ],
  credit_ledger_entries: [
    "entry_id",
    "anon_user_id",
    "event_type",
    "amount",
    "balance_available_after",
    "balance_pending_after",
    "reservation_id",
    "idempotency_scope",
    "idempotency_key",
    "metadata_json",
    "actor",
    "created_at",
  ],
  credit_purchase_transactions: [
    "row_id",
    "provider",
    "provider_transaction_id",
    "provider_original_transaction_id",
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
    "plan_version",
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
  account_deletion_storage_outbox: [
    "outbox_id",
    "job_id",
    "target_id",
    "object_key",
    "object_category",
    "status",
    "attempt_count",
    "last_safe_error",
    "created_at",
    "updated_at",
    "attempted_at",
    "completed_at",
  ],
  deleted_identity_tombstones: [
    "identity_ref",
    "identity_kind",
    "deletion_job_id",
    "reason_category",
    "schema_version",
    "key_version",
    "key_reference",
    "created_at",
  ],
  deleted_identity_tombstone_key_metadata: [
    "singleton_id",
    "key_version",
    "key_reference",
    "hmac_algorithm",
    "schema_version",
    "created_at",
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
  ux_account_deletion_targets_job_target: "index",
  idx_account_deletion_outbox_job_status: "index",
  idx_account_deletion_outbox_target_status: "index",
  idx_account_deletion_outbox_status_updated: "index",
  idx_account_deletion_outbox_created: "index",
  idx_deleted_identity_tombstones_job: "index",
  idx_deleted_identity_tombstones_kind_created: "index",
  idx_deleted_identity_tombstones_key: "index",
  trg_deleted_identity_tombstone_key_no_update: "trigger",
  trg_deleted_identity_tombstone_key_no_delete: "trigger",
};

type ForeignKeyExpectation = {
  from: readonly string[];
  table: string;
  to: readonly string[];
  onUpdate: "CASCADE" | "NO ACTION" | "RESTRICT" | "SET NULL";
  onDelete: "CASCADE" | "NO ACTION" | "RESTRICT" | "SET NULL";
};

type IndexExpectation = {
  table: string;
  name?: string;
  columns: readonly string[];
  descending?: readonly boolean[];
  unique: boolean;
  partial?: boolean;
  sqlFragments?: readonly string[];
  wherePredicate?: string;
  label: string;
};

const REQUIRED_PRIMARY_KEYS: Record<string, readonly string[]> = {
  credit_purchase_ledger_links: ["id"],
  purchase_reconciliation_actions: ["id"],
  account_deletion_jobs: ["job_id"],
  account_deletion_job_targets: ["target_id"],
  account_deletion_storage_outbox: ["outbox_id"],
  deleted_identity_tombstones: ["identity_ref"],
  deleted_identity_tombstone_key_metadata: ["singleton_id"],
};

const REQUIRED_FOREIGN_KEYS: Record<string, readonly ForeignKeyExpectation[]> = {
  credit_purchase_ledger_links: [
    {
      from: ["purchase_transaction_id"],
      table: "credit_purchase_transactions",
      to: ["row_id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
    {
      from: ["ledger_entry_id"],
      table: "credit_ledger_entries",
      to: ["entry_id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
  ],
  purchase_reconciliation_actions: [
    {
      from: ["purchase_transaction_id"],
      table: "credit_purchase_transactions",
      to: ["row_id"],
      onUpdate: "NO ACTION",
      onDelete: "SET NULL",
    },
    {
      from: ["ledger_entry_id"],
      table: "credit_ledger_entries",
      to: ["entry_id"],
      onUpdate: "NO ACTION",
      onDelete: "SET NULL",
    },
  ],
  account_deletion_job_targets: [
    {
      from: ["job_id"],
      table: "account_deletion_jobs",
      to: ["job_id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
  ],
  account_deletion_storage_outbox: [
    {
      from: ["job_id"],
      table: "account_deletion_jobs",
      to: ["job_id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
    {
      from: ["job_id", "target_id"],
      table: "account_deletion_job_targets",
      to: ["job_id", "target_id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
  ],
  deleted_identity_tombstones: [
    {
      from: ["deletion_job_id"],
      table: "account_deletion_jobs",
      to: ["job_id"],
      onUpdate: "NO ACTION",
      onDelete: "RESTRICT",
    },
    {
      from: ["key_version", "key_reference"],
      table: "deleted_identity_tombstone_key_metadata",
      to: ["key_version", "key_reference"],
      onUpdate: "RESTRICT",
      onDelete: "RESTRICT",
    },
  ],
};

const REQUIRED_INDEXES: readonly IndexExpectation[] = [
  {
    table: "credit_purchase_ledger_links",
    columns: ["ledger_entry_id"],
    unique: true,
    label: "unique:credit_purchase_ledger_links.ledger_entry_id",
  },
  {
    table: "credit_purchase_ledger_links",
    name: "idx_credit_purchase_ledger_links_purchase",
    columns: ["purchase_transaction_id", "created_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_credit_purchase_ledger_links_purchase",
  },
  {
    table: "credit_purchase_ledger_links",
    name: "ux_credit_purchase_ledger_links_base_grant",
    columns: ["purchase_transaction_id"],
    unique: true,
    partial: true,
    wherePredicate: "link_kind = 'base_grant'",
    label: "index:ux_credit_purchase_ledger_links_base_grant",
  },
  {
    table: "purchase_reconciliation_actions",
    columns: ["idempotency_key"],
    unique: true,
    label: "unique:purchase_reconciliation_actions.idempotency_key",
  },
  {
    table: "purchase_reconciliation_actions",
    name: "idx_purchase_reconciliation_actions_purchase",
    columns: ["purchase_transaction_id", "created_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_purchase_reconciliation_actions_purchase",
  },
  {
    table: "purchase_reconciliation_actions",
    name: "idx_purchase_reconciliation_actions_ledger",
    columns: ["ledger_entry_id", "created_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_purchase_reconciliation_actions_ledger",
  },
  {
    table: "purchase_reconciliation_actions",
    name: "idx_purchase_reconciliation_actions_status",
    columns: ["status", "created_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_purchase_reconciliation_actions_status",
  },
  {
    table: "purchase_reconciliation_actions",
    name: "idx_purchase_reconciliation_actions_created",
    columns: ["created_at"],
    descending: [true],
    unique: false,
    label: "index:idx_purchase_reconciliation_actions_created",
  },
  {
    table: "account_deletion_jobs",
    columns: ["request_id"],
    unique: true,
    label: "unique:account_deletion_jobs.request_id",
  },
  {
    table: "account_deletion_jobs",
    columns: ["request_source", "idempotency_key"],
    unique: true,
    label: "unique:account_deletion_jobs.request_source,idempotency_key",
  },
  {
    table: "account_deletion_jobs",
    name: "idx_account_deletion_jobs_status_updated",
    columns: ["status", "updated_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_account_deletion_jobs_status_updated",
  },
  {
    table: "account_deletion_jobs",
    name: "idx_account_deletion_jobs_preview_expiration",
    columns: ["preview_expires_at", "status"],
    unique: false,
    label: "index:idx_account_deletion_jobs_preview_expiration",
  },
  {
    table: "account_deletion_jobs",
    name: "idx_account_deletion_jobs_created",
    columns: ["created_at"],
    descending: [true],
    unique: false,
    label: "index:idx_account_deletion_jobs_created",
  },
  {
    table: "account_deletion_job_targets",
    columns: ["job_id", "target_ref"],
    unique: true,
    label: "unique:account_deletion_job_targets.job_id,target_ref",
  },
  {
    table: "account_deletion_job_targets",
    columns: ["job_id", "graph_fingerprint"],
    unique: true,
    label: "unique:account_deletion_job_targets.job_id,graph_fingerprint",
  },
  {
    table: "account_deletion_job_targets",
    name: "ux_account_deletion_targets_job_target",
    columns: ["job_id", "target_id"],
    unique: true,
    label: "index:ux_account_deletion_targets_job_target",
  },
  {
    table: "account_deletion_job_targets",
    name: "idx_account_deletion_targets_job_status",
    columns: ["job_id", "status", "updated_at"],
    descending: [false, false, true],
    unique: false,
    label: "index:idx_account_deletion_targets_job_status",
  },
  {
    table: "account_deletion_job_targets",
    name: "idx_account_deletion_targets_status_updated",
    columns: ["status", "updated_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_account_deletion_targets_status_updated",
  },
  {
    table: "account_deletion_storage_outbox",
    columns: ["job_id", "object_key"],
    unique: true,
    label: "unique:account_deletion_storage_outbox.job_id,object_key",
  },
  {
    table: "account_deletion_storage_outbox",
    name: "idx_account_deletion_outbox_job_status",
    columns: ["job_id", "status", "updated_at"],
    descending: [false, false, true],
    unique: false,
    label: "index:idx_account_deletion_outbox_job_status",
  },
  {
    table: "account_deletion_storage_outbox",
    name: "idx_account_deletion_outbox_target_status",
    columns: ["target_id", "status", "updated_at"],
    descending: [false, false, true],
    unique: false,
    label: "index:idx_account_deletion_outbox_target_status",
  },
  {
    table: "account_deletion_storage_outbox",
    name: "idx_account_deletion_outbox_status_updated",
    columns: ["status", "updated_at"],
    descending: [false, false],
    unique: false,
    label: "index:idx_account_deletion_outbox_status_updated",
  },
  {
    table: "account_deletion_storage_outbox",
    name: "idx_account_deletion_outbox_created",
    columns: ["created_at"],
    descending: [true],
    unique: false,
    label: "index:idx_account_deletion_outbox_created",
  },
  {
    table: "deleted_identity_tombstone_key_metadata",
    columns: ["key_version", "key_reference"],
    unique: true,
    label:
      "unique:deleted_identity_tombstone_key_metadata.key_version,key_reference",
  },
  {
    table: "deleted_identity_tombstones",
    name: "idx_deleted_identity_tombstones_job",
    columns: ["deletion_job_id", "created_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_deleted_identity_tombstones_job",
  },
  {
    table: "deleted_identity_tombstones",
    name: "idx_deleted_identity_tombstones_kind_created",
    columns: ["identity_kind", "created_at"],
    descending: [false, true],
    unique: false,
    label: "index:idx_deleted_identity_tombstones_kind_created",
  },
  {
    table: "deleted_identity_tombstones",
    name: "idx_deleted_identity_tombstones_key",
    columns: ["key_version", "key_reference", "created_at"],
    descending: [false, false, true],
    unique: false,
    label: "index:idx_deleted_identity_tombstones_key",
  },
];

const REQUIRED_SQL_FRAGMENTS: Record<string, readonly string[]> = {
  credit_purchase_ledger_links: [
    "link_kind text not null check(link_kind in ('base_grant','repair_adjustment','reversal'))",
    "unique(ledger_entry_id)",
  ],
  purchase_reconciliation_actions: [
    "issue_type text not null check(length(trim(issue_type)) > 0)",
    "admin_actor text not null check(length(trim(admin_actor)) > 0)",
    "idempotency_key text not null unique check(length(trim(idempotency_key)) > 0)",
    "balance_before integer not null check(balance_before >= 0)",
    "balance_after integer not null check(balance_after >= 0)",
    "status text not null check(status in ('pending','completed','failed'))",
    "status = 'pending' and completed_at is null and failure_code is null",
    "status = 'completed' and completed_at is not null and failure_code is null",
    "status = 'failed' and completed_at is not null",
  ],
  account_deletion_jobs: [
    "request_id text not null unique",
    "check(length(trim(request_id)) between 1 and 160)",
    "request_source text not null",
    "check(length(trim(request_source)) between 1 and 80)",
    "acting_admin_ref text not null check(length(trim(acting_admin_ref)) between 1 and 160)",
    "reason text not null check(length(trim(reason)) between 1 and 500)",
    "plan_version integer not null default 1 check(plan_version >= 1)",
    "plan_json text not null default '{}' check(json_valid(plan_json) and json_type(plan_json) = 'object')",
    "preview_fingerprint text not null",
    "check(length(trim(preview_fingerprint)) between 32 and 160)",
    "preview_expires_at text not null",
    "status text not null check(status in ('previewed','approved','executing','database_completed','storage_pending','completed','failed_retryable','manual_review'))",
    "attempt_count integer not null default 0 check(attempt_count >= 0)",
    "idempotency_key text not null check(length(trim(idempotency_key)) between 1 and 240)",
    "unique(request_source,idempotency_key)",
    "status = 'completed' and completed_at is not null",
    "status <> 'completed' and completed_at is null",
  ],
  account_deletion_job_targets: [
    "target_ref text not null check(length(trim(target_ref)) between 1 and 160)",
    "graph_fingerprint text not null check(length(trim(graph_fingerprint)) between 32 and 160)",
    "plan_json text not null default '{}' check(json_valid(plan_json) and json_type(plan_json) = 'object')",
    "status text not null check(status in ('previewed','approved','executing','database_completed','storage_pending','completed','failed_retryable','manual_review'))",
    "attempt_count integer not null default 0 check(attempt_count >= 0)",
    "unique(job_id,target_ref)",
    "unique(job_id,graph_fingerprint)",
    "status = 'completed' and completed_at is not null",
    "status <> 'completed' and completed_at is null",
  ],
  account_deletion_storage_outbox: [
    "length(object_key) between 1 and 1024",
    "object_key = trim(object_key)",
    "substr(object_key,1,1) <> '/'",
    "instr(object_key,'://') = 0",
    "object_key not like '%/../%'",
    "object_category text not null check(object_category in ('recipe_image','profile_avatar','generated_image'))",
    "status text not null default 'pending' check(status in ('pending','processing','completed','failed_retryable','manual_review'))",
    "attempt_count integer not null default 0 check(attempt_count >= 0)",
    "created_at text not null",
    "updated_at text not null",
    "attempted_at text",
    "completed_at text",
    "unique(job_id,object_key)",
    "status = 'completed' and completed_at is not null",
    "status <> 'completed' and completed_at is null",
    "last_safe_error is null or length(trim(last_safe_error)) between 1 and 500",
  ],
  deleted_identity_tombstones: [
    "identity_ref text primary key check(identity_ref glob 'identity:v1:[0-9a-f]*'",
    "substr(identity_ref,13) not glob '*[^0-9a-f]*'",
    "length(identity_ref) = 76",
    "identity_kind text not null check(identity_kind = 'graph_node')",
    "reason_category text not null default 'admin_fulfillment' check(reason_category = 'admin_fulfillment')",
    "schema_version integer not null default 1 check(schema_version = 1)",
    "key_version integer not null default 1 check(key_version = 1)",
    "key_reference text not null check(key_reference glob 'key:v1:[0-9a-f]*'",
    "substr(key_reference,8) not glob '*[^0-9a-f]*'",
    "length(key_reference) = 71",
  ],
  deleted_identity_tombstone_key_metadata: [
    "singleton_id integer primary key check(singleton_id = 1)",
    "key_version integer not null check(key_version = 1)",
    "key_reference text not null check(key_reference glob 'key:v1:[0-9a-f]*'",
    "substr(key_reference,8) not glob '*[^0-9a-f]*'",
    "length(key_reference) = 71",
    "hmac_algorithm text not null check(hmac_algorithm = 'hmac-sha256')",
    "schema_version integer not null default 1 check(schema_version = 1)",
    "unique(key_version,key_reference)",
  ],
  trg_purchase_reconciliation_completed_update: [
    "before update on purchase_reconciliation_actions",
    "when old.status = 'completed'",
    "new.purchase_transaction_id is not old.purchase_transaction_id",
    "new.ledger_entry_id is not old.ledger_entry_id",
    "new.balance_before is not old.balance_before",
    "new.balance_after is not old.balance_after",
    "new.credit_delta is not old.credit_delta",
    "new.provider_verification_hash is not old.provider_verification_hash",
    "new.status is not old.status",
    "raise(abort,'completed reconciliation actions are immutable')",
  ],
  trg_purchase_reconciliation_completed_delete: [
    "before delete on purchase_reconciliation_actions",
    "when old.status = 'completed'",
    "raise(abort,'completed reconciliation actions are immutable')",
  ],
  purchase_ledger_backfill_report: [
    "from credit_purchase_transactions",
    "from credit_ledger_entries",
    "idempotency_scope = 'purchase-credit-grant'",
    "mg.purchase_count = 1",
    "mg.ledger_count = 1",
    "expected_linked_count",
    "linked_count",
    "skipped_count",
    "ambiguous_count",
  ],
  trg_deleted_identity_tombstone_key_no_update: [
    "before update on deleted_identity_tombstone_key_metadata",
    "raise(abort,'deleted identity tombstone key metadata is immutable')",
  ],
  trg_deleted_identity_tombstone_key_no_delete: [
    "before delete on deleted_identity_tombstone_key_metadata",
    "raise(abort,'deleted identity tombstone key metadata is immutable')",
  ],
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

type SqlToken = {
  kind: "word" | "string" | "number" | "symbol";
  value: string;
};

type CheckExpectation = {
  label: string;
  expression: string;
};

type TriggerExpectation = {
  name: string;
  action: "update" | "delete";
  table: string;
};

const DELETION_STATUS_CHECK = `status IN (
  'previewed',
  'approved',
  'executing',
  'database_completed',
  'storage_pending',
  'completed',
  'failed_retryable',
  'manual_review'
)`;

const COMPLETION_TIMESTAMP_CHECK = `
  (status = 'completed' AND completed_at IS NOT NULL)
  OR (status <> 'completed' AND completed_at IS NULL)
`;

const KEY_REFERENCE_CHECK = `
  key_reference GLOB 'key:v1:[0-9a-f]*'
  AND substr(key_reference, 8) NOT GLOB '*[^0-9a-f]*'
  AND length(key_reference) = 71
`;

const CRITICAL_CHECKS: Record<string, readonly CheckExpectation[]> = {
  account_deletion_jobs: [
    { label: "status", expression: DELETION_STATUS_CHECK },
    { label: "completion_timestamp", expression: COMPLETION_TIMESTAMP_CHECK },
  ],
  account_deletion_job_targets: [
    { label: "status", expression: DELETION_STATUS_CHECK },
    { label: "completion_timestamp", expression: COMPLETION_TIMESTAMP_CHECK },
  ],
  account_deletion_storage_outbox: [
    {
      label: "object_category",
      expression:
        "object_category IN ('recipe_image', 'profile_avatar', 'generated_image')",
    },
    {
      label: "status",
      expression:
        "status IN ('pending', 'processing', 'completed', 'failed_retryable', 'manual_review')",
    },
    { label: "completion_timestamp", expression: COMPLETION_TIMESTAMP_CHECK },
  ],
  deleted_identity_tombstones: [
    {
      label: "identity_ref_format",
      expression: `
        identity_ref GLOB 'identity:v1:[0-9a-f]*'
        AND substr(identity_ref, 13) NOT GLOB '*[^0-9a-f]*'
        AND length(identity_ref) = 76
      `,
    },
    { label: "identity_kind", expression: "identity_kind = 'graph_node'" },
    {
      label: "reason_category",
      expression: "reason_category = 'admin_fulfillment'",
    },
    { label: "schema_version", expression: "schema_version = 1" },
    { label: "key_version", expression: "key_version = 1" },
    { label: "key_reference_format", expression: KEY_REFERENCE_CHECK },
  ],
  deleted_identity_tombstone_key_metadata: [
    { label: "singleton", expression: "singleton_id = 1" },
    { label: "key_version", expression: "key_version = 1" },
    { label: "key_reference_format", expression: KEY_REFERENCE_CHECK },
    {
      label: "hmac_algorithm",
      expression: "hmac_algorithm = 'HMAC-SHA256'",
    },
    { label: "schema_version", expression: "schema_version = 1" },
  ],
};

const TOMBSTONE_METADATA_TRIGGERS: readonly TriggerExpectation[] = [
  {
    name: "trg_deleted_identity_tombstone_key_no_update",
    action: "update",
    table: "deleted_identity_tombstone_key_metadata",
  },
  {
    name: "trg_deleted_identity_tombstone_key_no_delete",
    action: "delete",
    table: "deleted_identity_tombstone_key_metadata",
  },
];

const TOMBSTONE_METADATA_IMMUTABLE_MESSAGE =
  "deleted identity tombstone key metadata is immutable";

/**
 * Removes SQLite comments without treating comment markers inside quoted SQL as
 * comments. Characters inside comments are replaced with whitespace so tokens
 * on either side cannot be accidentally joined.
 */
export function stripSqlComments(sql: string) {
  let result = "";
  let index = 0;
  let quote: "single" | "double" | "bracket" | "backtick" | null = null;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (quote) {
      result += character;
      if (quote === "single" && character === "'") {
        if (next === "'") {
          result += next;
          index += 2;
          continue;
        }
        quote = null;
      } else if (quote === "double" && character === '"') {
        if (next === '"') {
          result += next;
          index += 2;
          continue;
        }
        quote = null;
      } else if (quote === "backtick" && character === "`") {
        if (next === "`") {
          result += next;
          index += 2;
          continue;
        }
        quote = null;
      } else if (quote === "bracket" && character === "]") {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (character === "'") {
      quote = "single";
      result += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = "double";
      result += character;
      index += 1;
      continue;
    }
    if (character === "[") {
      quote = "bracket";
      result += character;
      index += 1;
      continue;
    }
    if (character === "`") {
      quote = "backtick";
      result += character;
      index += 1;
      continue;
    }

    if (character === "-" && next === "-") {
      result += "  ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        result += " ";
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          result += "  ";
          index += 2;
          break;
        }
        result += sql[index] === "\n" || sql[index] === "\r" ? sql[index] : " ";
        index += 1;
      }
      continue;
    }

    result += character;
    index += 1;
  }

  return result;
}

function tokenizeSql(sql: string): SqlToken[] {
  const source = stripSqlComments(sql);
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "'") {
      let value = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        if (source[index] === "'") {
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: "string", value });
      continue;
    }

    if (character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let value = "";
      index += 1;
      while (index < source.length) {
        if (
          character !== "[" &&
          source[index] === closing &&
          source[index + 1] === closing
        ) {
          value += closing;
          index += 2;
          continue;
        }
        if (source[index] === closing) {
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: "word", value: value.toLowerCase() });
      continue;
    }

    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        index += 1;
      }
      tokens.push({
        kind: "word",
        value: source.slice(start, index).toLowerCase(),
      });
      continue;
    }

    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[0-9.]/.test(source[index])) {
        index += 1;
      }
      tokens.push({ kind: "number", value: source.slice(start, index) });
      continue;
    }

    const threeCharacterOperator = source.slice(index, index + 3);
    const twoCharacterOperator = source.slice(index, index + 2);
    if (threeCharacterOperator === "->>") {
      tokens.push({ kind: "symbol", value: threeCharacterOperator });
      index += 3;
      continue;
    }
    if (["<>", "!=", "<=", ">=", "==", "||", "->"].includes(twoCharacterOperator)) {
      tokens.push({ kind: "symbol", value: twoCharacterOperator });
      index += 2;
      continue;
    }

    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }

  return tokens;
}

function withoutTrailingSemicolons(tokens: readonly SqlToken[]) {
  let end = tokens.length;
  while (
    end > 0 &&
    tokens[end - 1].kind === "symbol" &&
    tokens[end - 1].value === ";"
  ) {
    end -= 1;
  }
  return tokens.slice(0, end);
}

function withoutRedundantOuterParentheses(tokens: readonly SqlToken[]) {
  let result = withoutTrailingSemicolons(tokens);
  while (
    result.length >= 2 &&
    result[0].kind === "symbol" &&
    result[0].value === "(" &&
    result[result.length - 1].kind === "symbol" &&
    result[result.length - 1].value === ")"
  ) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < result.length; index += 1) {
      const token = result[index];
      if (token.kind === "symbol" && token.value === "(") depth += 1;
      if (token.kind === "symbol" && token.value === ")") depth -= 1;
      if (depth === 0) {
        closesAtEnd = index === result.length - 1;
        break;
      }
    }
    if (!closesAtEnd) break;
    result = result.slice(1, -1);
  }
  return result;
}

function sameTokens(left: readonly SqlToken[], right: readonly SqlToken[]) {
  return (
    left.length === right.length &&
    left.every(
      (token, index) =>
        token.kind === right[index].kind && token.value === right[index].value,
    )
  );
}

function exactSqlExpressionMatches(
  actual: readonly SqlToken[],
  expectedSql: string,
) {
  return sameTokens(
    withoutRedundantOuterParentheses(actual),
    withoutRedundantOuterParentheses(tokenizeSql(expectedSql)),
  );
}

function extractCheckExpressions(sql: string) {
  const tokens = tokenizeSql(sql);
  const checks: SqlToken[][] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      tokens[index].kind !== "word" ||
      tokens[index].value !== "check" ||
      tokens[index + 1].kind !== "symbol" ||
      tokens[index + 1].value !== "("
    ) {
      continue;
    }
    let depth = 1;
    const expression: SqlToken[] = [];
    let cursor = index + 2;
    for (; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.kind === "symbol" && token.value === "(") depth += 1;
      if (token.kind === "symbol" && token.value === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      expression.push(token);
    }
    if (depth === 0) {
      checks.push(expression);
      index = cursor;
    }
  }
  return checks;
}

function extractIndexWherePredicate(sql: string) {
  const tokens = withoutTrailingSemicolons(tokenizeSql(sql));
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    if (token.kind === "symbol" && token.value === ")") depth -= 1;
    if (token.kind === "word" && token.value === "where" && depth === 0) {
      return tokens.slice(index + 1);
    }
  }
  return null;
}

function tokenIs(token: SqlToken | undefined, kind: SqlToken["kind"], value: string) {
  return token?.kind === kind && token.value === value;
}

function triggerMatches(sql: string, expected: TriggerExpectation) {
  const tokens = withoutTrailingSemicolons(tokenizeSql(sql));
  let cursor = 0;
  const consume = (kind: SqlToken["kind"], value: string) => {
    if (!tokenIs(tokens[cursor], kind, value)) return false;
    cursor += 1;
    return true;
  };

  if (!consume("word", "create") || !consume("word", "trigger")) return false;
  if (
    tokenIs(tokens[cursor], "word", "if") &&
    tokenIs(tokens[cursor + 1], "word", "not") &&
    tokenIs(tokens[cursor + 2], "word", "exists")
  ) {
    cursor += 3;
  }
  if (
    !consume("word", expected.name) ||
    !consume("word", "before") ||
    !consume("word", expected.action) ||
    !consume("word", "on") ||
    !consume("word", expected.table) ||
    !consume("word", "begin") ||
    !consume("word", "select") ||
    !consume("word", "raise") ||
    !consume("symbol", "(") ||
    !consume("word", "abort") ||
    !consume("symbol", ",") ||
    !consume("string", TOMBSTONE_METADATA_IMMUTABLE_MESSAGE) ||
    !consume("symbol", ")")
  ) {
    return false;
  }
  if (tokenIs(tokens[cursor], "symbol", ";")) cursor += 1;
  if (!consume("word", "end")) return false;
  return cursor === tokens.length;
}

function verifyCriticalChecks(
  objectSql: ReadonlyMap<string, string>,
  missing: string[],
) {
  for (const [tableName, expectations] of Object.entries(CRITICAL_CHECKS)) {
    const sql = objectSql.get(tableName);
    if (!sql) continue;
    const checks = extractCheckExpressions(sql);
    for (const expected of expectations) {
      if (
        !checks.some((actual) =>
          exactSqlExpressionMatches(actual, expected.expression),
        )
      ) {
        missing.push(`constraint_semantics:${tableName}:${expected.label}`);
      }
    }
  }
}

function verifyTombstoneMetadataTriggers(
  objectSql: ReadonlyMap<string, string>,
  missing: string[],
) {
  for (const expected of TOMBSTONE_METADATA_TRIGGERS) {
    const sql = objectSql.get(expected.name);
    if (sql && !triggerMatches(sql, expected)) {
      missing.push(`trigger_semantics:${expected.name}`);
    }
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeSql(sql: string) {
  return stripSqlComments(sql)
    .toLowerCase()
    .replace(/["`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .trim();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameBooleans(left: readonly boolean[], right: readonly boolean[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizedContains(sql: string, fragment: string) {
  return normalizeSql(sql).includes(normalizeSql(fragment));
}

async function verifyPrimaryKeys(
  client: SchemaClient,
  availableTables: ReadonlySet<string>,
  missing: string[],
) {
  for (const [tableName, expectedColumns] of Object.entries(
    REQUIRED_PRIMARY_KEYS,
  )) {
    if (!availableTables.has(tableName)) continue;
    const tableInfo = await client.execute(`PRAGMA table_info('${tableName}')`);
    const primaryKeyColumns = tableInfo.rows
      .filter((row) => asNumber(row.pk) > 0)
      .sort((left, right) => asNumber(left.pk) - asNumber(right.pk))
      .map((row) => asString(row.name));
    if (!sameStrings(primaryKeyColumns, expectedColumns)) {
      missing.push(`primary_key:${tableName}.${expectedColumns.join(",")}`);
    }
  }
}

async function verifyForeignKeys(
  client: SchemaClient,
  availableTables: ReadonlySet<string>,
  missing: string[],
) {
  for (const [tableName, expectations] of Object.entries(
    REQUIRED_FOREIGN_KEYS,
  )) {
    if (!availableTables.has(tableName)) continue;
    const foreignKeys = await client.execute(
      `PRAGMA foreign_key_list('${tableName}')`,
    );
    const grouped = new Map<number, typeof foreignKeys.rows>();
    for (const row of foreignKeys.rows) {
      const id = asNumber(row.id);
      const group = grouped.get(id) ?? [];
      group.push(row);
      grouped.set(id, group);
    }
    const actual = [...grouped.values()].map((rows) => {
      const ordered = [...rows].sort(
        (left, right) => asNumber(left.seq) - asNumber(right.seq),
      );
      return {
        from: ordered.map((row) => asString(row.from)),
        table: asString(ordered[0]?.table),
        to: ordered.map((row) => asString(row.to)),
        onUpdate: asString(ordered[0]?.on_update).toUpperCase(),
        onDelete: asString(ordered[0]?.on_delete).toUpperCase(),
      };
    });
    if (actual.length !== expectations.length) {
      missing.push(`foreign_key_set:${tableName}`);
    }
    for (const expected of expectations) {
      const match = actual.some(
        (candidate) =>
          sameStrings(candidate.from, expected.from) &&
          candidate.table === expected.table &&
          sameStrings(candidate.to, expected.to) &&
          candidate.onUpdate === expected.onUpdate &&
          candidate.onDelete === expected.onDelete,
      );
      if (!match) {
        missing.push(
          `foreign_key:${tableName}.${expected.from.join("+")}->${
            expected.table
          }.${expected.to.join("+")}:${expected.onUpdate}/${expected.onDelete}`,
        );
      }
    }
  }
}

async function readIndexDefinition(
  client: SchemaClient,
  tableName: string,
  indexName: string,
) {
  const [info, extended, definition] = await Promise.all([
    client.execute(`PRAGMA index_info('${indexName}')`),
    client.execute(`PRAGMA index_xinfo('${indexName}')`),
    client.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      args: [indexName],
    }),
  ]);
  const columns = [...info.rows]
    .sort((left, right) => asNumber(left.seqno) - asNumber(right.seqno))
    .map((row) => asString(row.name));
  const directions = [...extended.rows]
    .filter((row) => asNumber(row.key) === 1)
    .sort((left, right) => asNumber(left.seqno) - asNumber(right.seqno))
    .map((row) => asNumber(row.desc) === 1);
  return {
    tableName,
    indexName,
    columns,
    directions,
    sql: asString(definition.rows[0]?.sql),
  };
}

async function verifyIndexes(
  client: SchemaClient,
  availableTables: ReadonlySet<string>,
  missing: string[],
) {
  const byTable = new Map<
    string,
    Array<{ name: string; unique: boolean; partial: boolean }>
  >();
  for (const tableName of new Set(REQUIRED_INDEXES.map((item) => item.table))) {
    if (!availableTables.has(tableName)) continue;
    const indexList = await client.execute(`PRAGMA index_list('${tableName}')`);
    byTable.set(
      tableName,
      indexList.rows.map((row) => ({
        name: asString(row.name),
        unique: asNumber(row.unique) === 1,
        partial: asNumber(row.partial) === 1,
      })),
    );
  }

  for (const expected of REQUIRED_INDEXES) {
    if (!availableTables.has(expected.table)) continue;
    const candidates = (byTable.get(expected.table) ?? []).filter(
      (candidate) =>
        (!expected.name || candidate.name === expected.name) &&
        candidate.unique === expected.unique &&
        candidate.partial === (expected.partial ?? false),
    );
    let found = false;
    for (const candidate of candidates) {
      const definition = await readIndexDefinition(
        client,
        expected.table,
        candidate.name,
      );
      if (!sameStrings(definition.columns, expected.columns)) continue;
      if (
        expected.descending &&
        !sameBooleans(definition.directions, expected.descending)
      ) {
        continue;
      }
      if (
        expected.sqlFragments?.some(
          (fragment) => !normalizedContains(definition.sql, fragment),
        )
      ) {
        continue;
      }
      if (expected.wherePredicate) {
        const predicate = extractIndexWherePredicate(definition.sql);
        if (
          !predicate ||
          !exactSqlExpressionMatches(predicate, expected.wherePredicate)
        ) {
          continue;
        }
      }
      found = true;
      break;
    }
    if (!found) missing.push(expected.label);
  }
}

function verifySqlFragments(
  objectSql: ReadonlyMap<string, string>,
  missing: string[],
) {
  for (const [objectName, fragments] of Object.entries(
    REQUIRED_SQL_FRAGMENTS,
  )) {
    const sql = objectSql.get(objectName);
    if (!sql) continue;
    for (const fragment of fragments) {
      if (!normalizedContains(sql, fragment)) {
        missing.push(`constraint:${objectName}:${normalizeSql(fragment)}`);
      }
    }
  }
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
    sql: `SELECT type, name, sql
          FROM sqlite_master
          WHERE name IN (${placeholders})`,
    args: requiredNames,
  });
  const objectTypes = new Map(
    objects.rows.map((row) => [asString(row.name), asString(row.type)]),
  );
  const objectSql = new Map(
    objects.rows.map((row) => [asString(row.name), asString(row.sql)]),
  );
  const missing: string[] = [];
  const availableTables = new Set<string>();

  for (const tableName of Object.keys(REQUIRED_TABLE_COLUMNS)) {
    if (objectTypes.get(tableName) !== "table") {
      missing.push(`table:${tableName}`);
      continue;
    }
    availableTables.add(tableName);
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

  await verifyPrimaryKeys(client, availableTables, missing);
  await verifyForeignKeys(client, availableTables, missing);
  await verifyIndexes(client, availableTables, missing);
  verifySqlFragments(objectSql, missing);
  verifyCriticalChecks(objectSql, missing);
  verifyTombstoneMetadataTriggers(objectSql, missing);

  if (missing.length > 0) {
    throw new AccountDeletionSchemaError(missing);
  }
}
