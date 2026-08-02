-- Durable R2 deletion queue for account-deletion jobs.
-- This migration is additive and creates no rows or ownership claims.
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_deletion_targets_job_target
  ON account_deletion_job_targets (job_id, target_id);

CREATE TABLE IF NOT EXISTS account_deletion_storage_outbox (
  outbox_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL
    REFERENCES account_deletion_jobs(job_id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  object_key TEXT NOT NULL
    CHECK(
      length(object_key) BETWEEN 1 AND 1024
      AND object_key = trim(object_key)
      AND substr(object_key, 1, 1) <> '/'
      AND instr(object_key, '://') = 0
      AND instr(object_key, char(0)) = 0
      AND object_key <> '..'
      AND object_key NOT LIKE '../%'
      AND object_key NOT LIKE '%/../%'
      AND object_key NOT LIKE '%/..'
    ),
  object_category TEXT NOT NULL
    CHECK(object_category IN (
      'recipe_image',
      'profile_avatar',
      'generated_image'
    )),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN (
      'pending',
      'processing',
      'completed',
      'failed_retryable',
      'manual_review'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(attempt_count >= 0),
  last_safe_error TEXT,
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempted_at TEXT,
  completed_at TEXT,
  UNIQUE(job_id, object_key),
  FOREIGN KEY(job_id, target_id)
    REFERENCES account_deletion_job_targets(job_id, target_id)
    ON DELETE CASCADE,
  CHECK(
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CHECK(
    last_safe_error IS NULL
    OR length(trim(last_safe_error)) BETWEEN 1 AND 500
  )
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_outbox_job_status
  ON account_deletion_storage_outbox (job_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_deletion_outbox_target_status
  ON account_deletion_storage_outbox (target_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_deletion_outbox_status_updated
  ON account_deletion_storage_outbox (status, updated_at ASC);

CREATE INDEX IF NOT EXISTS idx_account_deletion_outbox_created
  ON account_deletion_storage_outbox (created_at DESC);
