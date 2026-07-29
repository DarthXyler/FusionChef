-- Immutable, authenticated product-use history.
-- Events are owned directly by auth_users; anonymous and credit identities are
-- intentionally excluded. Account deletion removes the user's activity history.
CREATE TABLE IF NOT EXISTS product_activity_events (
  event_id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL
    REFERENCES auth_users(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL
    CHECK(activity_type IN ('fusion_generation', 'reroll', 'cookbook_save', 'credit_purchase')),
  source_reference_id TEXT,
  occurred_at TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(
    source_reference_id IS NULL
    OR length(source_reference_id) BETWEEN 1 AND 240
  )
);

CREATE INDEX IF NOT EXISTS idx_product_activity_user_occurred
  ON product_activity_events (auth_user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_activity_type_occurred
  ON product_activity_events (activity_type, occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_product_activity_source_reference
  ON product_activity_events (
    auth_user_id,
    activity_type,
    source_reference_id
  )
  WHERE source_reference_id IS NOT NULL;
