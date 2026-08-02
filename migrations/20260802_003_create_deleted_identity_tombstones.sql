-- Pseudonymous identity graph tombstones retained after admin fulfillment.
-- Apply after the account-deletion job and storage-outbox migrations.
CREATE TABLE IF NOT EXISTS deleted_identity_tombstones (
  identity_ref TEXT PRIMARY KEY
    CHECK(
      identity_ref GLOB 'identity:v1:[0-9a-f]*'
      AND substr(identity_ref, 13) NOT GLOB '*[^0-9a-f]*'
      AND length(identity_ref) = 76
    ),
  identity_kind TEXT NOT NULL
    CHECK(identity_kind = 'graph_node'),
  deletion_job_id TEXT NOT NULL
    REFERENCES account_deletion_jobs(job_id) ON DELETE RESTRICT,
  reason_category TEXT NOT NULL DEFAULT 'admin_fulfillment'
    CHECK(reason_category = 'admin_fulfillment'),
  schema_version INTEGER NOT NULL DEFAULT 1
    CHECK(schema_version = 1),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deleted_identity_tombstones_job
  ON deleted_identity_tombstones (deletion_job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deleted_identity_tombstones_kind_created
  ON deleted_identity_tombstones (identity_kind, created_at DESC);
