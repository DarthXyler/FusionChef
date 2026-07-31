-- Purchase settlement traceability foundation.
-- This migration is additive: it creates links/audit records and never changes
-- credit balances, ledger amounts, or purchase amounts.
CREATE TABLE IF NOT EXISTS credit_purchase_ledger_links (
  id TEXT PRIMARY KEY,
  purchase_transaction_id TEXT NOT NULL
    REFERENCES credit_purchase_transactions(row_id) ON DELETE CASCADE,
  ledger_entry_id TEXT NOT NULL
    REFERENCES credit_ledger_entries(entry_id) ON DELETE CASCADE,
  link_kind TEXT NOT NULL
    CHECK(link_kind IN ('base_grant', 'repair_adjustment', 'reversal')),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(ledger_entry_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_purchase_ledger_links_purchase
  ON credit_purchase_ledger_links (purchase_transaction_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_purchase_ledger_links_base_grant
  ON credit_purchase_ledger_links (purchase_transaction_id)
  WHERE link_kind = 'base_grant';

CREATE TABLE IF NOT EXISTS purchase_reconciliation_actions (
  id TEXT PRIMARY KEY,
  issue_type TEXT NOT NULL CHECK(length(trim(issue_type)) > 0),
  purchase_transaction_id TEXT
    REFERENCES credit_purchase_transactions(row_id) ON DELETE SET NULL,
  ledger_entry_id TEXT
    REFERENCES credit_ledger_entries(entry_id) ON DELETE SET NULL,
  admin_actor TEXT NOT NULL CHECK(length(trim(admin_actor)) > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  preview_fingerprint TEXT NOT NULL CHECK(length(trim(preview_fingerprint)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(trim(idempotency_key)) > 0),
  balance_before INTEGER NOT NULL CHECK(balance_before >= 0),
  balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
  credit_delta INTEGER NOT NULL,
  provider_verification_hash TEXT NOT NULL
    CHECK(length(trim(provider_verification_hash)) > 0),
  status TEXT NOT NULL
    CHECK(status IN ('pending', 'completed', 'failed')),
  created_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  failure_code TEXT,
  metadata_json TEXT,
  CHECK(
    (status = 'pending' AND completed_at IS NULL AND failure_code IS NULL)
    OR
    (status = 'completed' AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR
    (status = 'failed' AND completed_at IS NOT NULL AND length(trim(failure_code)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_purchase_reconciliation_actions_purchase
  ON purchase_reconciliation_actions (purchase_transaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_reconciliation_actions_ledger
  ON purchase_reconciliation_actions (ledger_entry_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_reconciliation_actions_status
  ON purchase_reconciliation_actions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_reconciliation_actions_created
  ON purchase_reconciliation_actions (created_at DESC);

-- Completed financial/audit facts cannot be edited. The only permitted changes
-- are one-way FK nullification and a fixed privacy-redaction marker, which keep
-- retention-compatible account deletion from exposing personal metadata.
CREATE TRIGGER IF NOT EXISTS trg_purchase_reconciliation_completed_update
BEFORE UPDATE ON purchase_reconciliation_actions
WHEN OLD.status = 'completed'
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.issue_type IS NOT OLD.issue_type
    OR (
      NEW.purchase_transaction_id IS NOT OLD.purchase_transaction_id
      AND NEW.purchase_transaction_id IS NOT NULL
    )
    OR (
      NEW.ledger_entry_id IS NOT OLD.ledger_entry_id
      AND NEW.ledger_entry_id IS NOT NULL
    )
    OR NEW.admin_actor IS NOT OLD.admin_actor
    OR NEW.reason IS NOT OLD.reason
    OR NEW.preview_fingerprint IS NOT OLD.preview_fingerprint
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.balance_before IS NOT OLD.balance_before
    OR NEW.balance_after IS NOT OLD.balance_after
    OR NEW.credit_delta IS NOT OLD.credit_delta
    OR NEW.provider_verification_hash IS NOT OLD.provider_verification_hash
    OR NEW.status IS NOT OLD.status
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.completed_at IS NOT OLD.completed_at
    OR NEW.failure_code IS NOT OLD.failure_code
    OR (
      NEW.metadata_json IS NOT OLD.metadata_json
      AND NEW.metadata_json IS NOT NULL
      AND NEW.metadata_json <> '{"redacted_for_account_deletion":true}'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'completed reconciliation actions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_purchase_reconciliation_completed_delete
BEFORE DELETE ON purchase_reconciliation_actions
WHEN OLD.status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed reconciliation actions are immutable');
END;

-- Backfill only deterministic 1:1 key groups. Both directions are counted so
-- duplicate purchase candidates and duplicate ledger candidates are ambiguous.
WITH
purchase_keys AS (
  SELECT
    row_id AS purchase_transaction_id,
    provider || ':' || provider_transaction_id AS match_key
  FROM credit_purchase_transactions
),
ledger_keys AS (
  SELECT
    entry_id AS ledger_entry_id,
    idempotency_key AS match_key
  FROM credit_ledger_entries
  WHERE idempotency_scope = 'purchase-credit-grant'
    AND idempotency_key IS NOT NULL
),
match_groups AS (
  SELECT
    match_key,
    SUM(source_kind = 'purchase') AS purchase_count,
    SUM(source_kind = 'ledger') AS ledger_count
  FROM (
    SELECT match_key, 'purchase' AS source_kind FROM purchase_keys
    UNION ALL
    SELECT match_key, 'ledger' AS source_kind FROM ledger_keys
  )
  GROUP BY match_key
),
exact_matches AS (
  SELECT
    pk.purchase_transaction_id,
    lk.ledger_entry_id
  FROM match_groups mg
  JOIN purchase_keys pk ON pk.match_key = mg.match_key
  JOIN ledger_keys lk ON lk.match_key = mg.match_key
  WHERE mg.purchase_count = 1
    AND mg.ledger_count = 1
)
INSERT OR IGNORE INTO credit_purchase_ledger_links (
  id,
  purchase_transaction_id,
  ledger_entry_id,
  link_kind
)
SELECT
  'pur01:base_grant:' || purchase_transaction_id,
  purchase_transaction_id,
  ledger_entry_id,
  'base_grant'
FROM exact_matches;

-- Read-only, one-row report. Counts are deterministic key groups:
-- exact 1:1 groups, one-sided skipped groups, and non-1:1 ambiguous groups.
CREATE VIEW IF NOT EXISTS purchase_ledger_backfill_report AS
WITH
purchase_keys AS (
  SELECT
    row_id AS purchase_transaction_id,
    provider || ':' || provider_transaction_id AS match_key
  FROM credit_purchase_transactions
),
ledger_keys AS (
  SELECT
    entry_id AS ledger_entry_id,
    idempotency_key AS match_key
  FROM credit_ledger_entries
  WHERE idempotency_scope = 'purchase-credit-grant'
    AND idempotency_key IS NOT NULL
),
match_groups AS (
  SELECT
    match_key,
    SUM(source_kind = 'purchase') AS purchase_count,
    SUM(source_kind = 'ledger') AS ledger_count
  FROM (
    SELECT match_key, 'purchase' AS source_kind FROM purchase_keys
    UNION ALL
    SELECT match_key, 'ledger' AS source_kind FROM ledger_keys
  )
  GROUP BY match_key
),
exact_matches AS (
  SELECT
    pk.purchase_transaction_id,
    lk.ledger_entry_id
  FROM match_groups mg
  JOIN purchase_keys pk ON pk.match_key = mg.match_key
  JOIN ledger_keys lk ON lk.match_key = mg.match_key
  WHERE mg.purchase_count = 1
    AND mg.ledger_count = 1
)
SELECT
  (SELECT COUNT(*) FROM exact_matches) AS expected_linked_count,
  (
    SELECT COUNT(*)
    FROM exact_matches em
    JOIN credit_purchase_ledger_links link
      ON link.purchase_transaction_id = em.purchase_transaction_id
     AND link.ledger_entry_id = em.ledger_entry_id
     AND link.link_kind = 'base_grant'
  ) AS linked_count,
  (
    SELECT COUNT(*)
    FROM match_groups
    WHERE (purchase_count = 0 AND ledger_count = 1)
       OR (purchase_count = 1 AND ledger_count = 0)
  ) AS skipped_count,
  (
    SELECT COUNT(*)
    FROM match_groups
    WHERE purchase_count > 1 OR ledger_count > 1
  ) AS ambiguous_count;
