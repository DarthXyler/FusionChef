-- Durable, resumable account-deletion plans and per-identity-graph progress.
-- This migration is additive and performs no backfill or destructive writes.
CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE
    CHECK(length(trim(request_id)) BETWEEN 1 AND 160),
  request_source TEXT NOT NULL
    CHECK(length(trim(request_source)) BETWEEN 1 AND 80),
  acting_admin_ref TEXT NOT NULL
    CHECK(length(trim(acting_admin_ref)) BETWEEN 1 AND 160),
  reason TEXT NOT NULL
    CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  plan_version INTEGER NOT NULL DEFAULT 1
    CHECK(plan_version >= 1),
  plan_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  preview_fingerprint TEXT NOT NULL
    CHECK(length(trim(preview_fingerprint)) BETWEEN 32 AND 160),
  preview_expires_at TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN (
      'previewed',
      'approved',
      'executing',
      'database_completed',
      'storage_pending',
      'completed',
      'failed_retryable',
      'manual_review'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(attempt_count >= 0),
  last_error_code TEXT,
  last_error_summary TEXT,
  idempotency_key TEXT NOT NULL
    CHECK(length(trim(idempotency_key)) BETWEEN 1 AND 240),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  UNIQUE(request_source, idempotency_key),
  CHECK(
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CHECK(
    (last_error_code IS NULL AND last_error_summary IS NULL)
    OR (
      length(trim(last_error_code)) BETWEEN 1 AND 120
      AND length(trim(last_error_summary)) BETWEEN 1 AND 500
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_jobs_status_updated
  ON account_deletion_jobs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_deletion_jobs_preview_expiration
  ON account_deletion_jobs (preview_expires_at, status);

CREATE INDEX IF NOT EXISTS idx_account_deletion_jobs_created
  ON account_deletion_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS account_deletion_job_targets (
  target_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL
    REFERENCES account_deletion_jobs(job_id) ON DELETE CASCADE,
  target_ref TEXT NOT NULL
    CHECK(length(trim(target_ref)) BETWEEN 1 AND 160),
  graph_fingerprint TEXT NOT NULL
    CHECK(length(trim(graph_fingerprint)) BETWEEN 32 AND 160),
  plan_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(plan_json) AND json_type(plan_json) = 'object'),
  status TEXT NOT NULL
    CHECK(status IN (
      'previewed',
      'approved',
      'executing',
      'database_completed',
      'storage_pending',
      'completed',
      'failed_retryable',
      'manual_review'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(attempt_count >= 0),
  last_error_code TEXT,
  last_error_summary TEXT,
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  UNIQUE(job_id, target_ref),
  UNIQUE(job_id, graph_fingerprint),
  CHECK(
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CHECK(
    (last_error_code IS NULL AND last_error_summary IS NULL)
    OR (
      length(trim(last_error_code)) BETWEEN 1 AND 120
      AND length(trim(last_error_summary)) BETWEEN 1 AND 500
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_targets_job_status
  ON account_deletion_job_targets (job_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_deletion_targets_status_updated
  ON account_deletion_job_targets (status, updated_at DESC);
