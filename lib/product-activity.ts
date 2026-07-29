/**
 * Durable product activity for authenticated users.
 *
 * This is deliberately independent of anonymous identity, credit accounting,
 * and monetization mode. Callers pass only a user ID from a verified auth
 * session and invoke the semantic helpers after their product action succeeds.
 */
import { createHash, randomUUID } from "crypto";
import { executeTurso } from "./turso.ts";

export type ProductActivityType =
  | "fusion_generation"
  | "reroll"
  | "cookbook_save"
  | "credit_purchase";

export type ProductActivityEvent = {
  eventId: string;
  authUserId: string;
  activityType: ProductActivityType;
  sourceReferenceId: string | null;
  occurredAt: string;
};

export type ProductActivityWriteResult =
  | { status: "recorded"; event: ProductActivityEvent }
  | { status: "duplicate"; event: ProductActivityEvent }
  | { status: "skipped"; reason: "guest" | "unsuccessful" | "unverified" | "user_not_found" }
  | { status: "failed" };

let productActivitySchemaReady: Promise<void> | null = null;

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeSourceReference(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized.slice(0, 240) : null;
}

function hashSourceReference(namespace: string, value: string) {
  const digest = createHash("sha256").update(value).digest("base64url");
  return `${namespace}:${digest}`;
}

function rowToProductActivityEvent(
  row: Record<string, unknown>,
): ProductActivityEvent {
  const activityType = asString(row.activity_type);
  if (
    activityType !== "fusion_generation" &&
    activityType !== "reroll" &&
    activityType !== "cookbook_save" &&
    activityType !== "credit_purchase"
  ) {
    throw new Error("Invalid product activity type returned by storage.");
  }
  return {
    eventId: asString(row.event_id),
    authUserId: asString(row.auth_user_id),
    activityType,
    sourceReferenceId:
      typeof row.source_reference_id === "string"
        ? row.source_reference_id
        : null,
    occurredAt: asString(row.occurred_at),
  };
}

export async function ensureProductActivitySchema() {
  if (productActivitySchemaReady) {
    return productActivitySchemaReady;
  }

  productActivitySchemaReady = (async () => {
    await executeTurso(
      `CREATE TABLE IF NOT EXISTS product_activity_events (
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
      )`,
    );
    await executeTurso(
      `CREATE INDEX IF NOT EXISTS idx_product_activity_user_occurred
       ON product_activity_events (auth_user_id, occurred_at DESC)`,
    );
    await executeTurso(
      `CREATE INDEX IF NOT EXISTS idx_product_activity_type_occurred
       ON product_activity_events (activity_type, occurred_at DESC)`,
    );
    await executeTurso(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_activity_source_reference
       ON product_activity_events (
         auth_user_id,
         activity_type,
         source_reference_id
       )
       WHERE source_reference_id IS NOT NULL`,
    );
  })().catch((error) => {
    productActivitySchemaReady = null;
    throw error;
  });

  return productActivitySchemaReady;
}

async function findEventBySource(params: {
  authUserId: string;
  activityType: ProductActivityType;
  sourceReferenceId: string;
}) {
  const result = await executeTurso({
    sql: `SELECT
            event_id,
            auth_user_id,
            activity_type,
            source_reference_id,
            occurred_at
          FROM product_activity_events
          WHERE auth_user_id = ?
            AND activity_type = ?
            AND source_reference_id = ?
          LIMIT 1`,
    args: [
      params.authUserId,
      params.activityType,
      params.sourceReferenceId,
    ],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToProductActivityEvent(row) : null;
}

async function recordAuthenticatedProductActivity(params: {
  authUserId: string;
  activityType: ProductActivityType;
  sourceReferenceId?: string | null;
}): Promise<ProductActivityWriteResult> {
  const authUserId = params.authUserId.trim();
  if (!authUserId) {
    return { status: "skipped", reason: "guest" };
  }

  await ensureProductActivitySchema();
  const sourceReferenceId = normalizeSourceReference(
    params.sourceReferenceId,
  );
  const result = await executeTurso({
    sql: `INSERT INTO product_activity_events (
            event_id,
            auth_user_id,
            activity_type,
            source_reference_id
          )
          SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM auth_users
            WHERE id = ?
          )
          ON CONFLICT DO NOTHING
          RETURNING
            event_id,
            auth_user_id,
            activity_type,
            source_reference_id,
            occurred_at`,
    args: [
      randomUUID(),
      authUserId,
      params.activityType,
      sourceReferenceId,
      authUserId,
    ],
  });

  const inserted = result.rows[0] as Record<string, unknown> | undefined;
  if (inserted) {
    return {
      status: "recorded",
      event: rowToProductActivityEvent(inserted),
    };
  }

  if (sourceReferenceId) {
    const duplicate = await findEventBySource({
      authUserId,
      activityType: params.activityType,
      sourceReferenceId,
    });
    if (duplicate) {
      return { status: "duplicate", event: duplicate };
    }
  }

  return { status: "skipped", reason: "user_not_found" };
}

function logProductActivityWriteFailure(
  activityType: ProductActivityType,
  error: unknown,
) {
  console.warn(
    "[product-activity]",
    JSON.stringify({
      event: "activity_write_failed",
      activityType,
      errorName: error instanceof Error ? error.name : "unknown",
    }),
  );
}

export async function recordProductActivitySafely(params: {
  authUserId: string | null | undefined;
  activityType: ProductActivityType;
  sourceReferenceId?: string | null;
}): Promise<ProductActivityWriteResult> {
  if (!params.authUserId?.trim()) {
    return { status: "skipped", reason: "guest" };
  }

  try {
    return await recordAuthenticatedProductActivity({
      authUserId: params.authUserId,
      activityType: params.activityType,
      sourceReferenceId: params.sourceReferenceId,
    });
  } catch (error) {
    logProductActivityWriteFailure(params.activityType, error);
    return { status: "failed" };
  }
}

export async function recordSuccessfulGenerationActivitySafely(params: {
  authUserId: string | null | undefined;
  actionKind: "fuse" | "reroll";
  requestId: string;
  succeeded?: boolean;
}) {
  if (params.succeeded === false) {
    return {
      status: "skipped",
      reason: "unsuccessful",
    } satisfies ProductActivityWriteResult;
  }
  return recordProductActivitySafely({
    authUserId: params.authUserId,
    activityType:
      params.actionKind === "reroll" ? "reroll" : "fusion_generation",
    sourceReferenceId: normalizeSourceReference(params.requestId),
  });
}

export async function recordCookbookSaveActivitySafely(params: {
  authUserId: string | null | undefined;
  idempotencyKey?: string | null;
  succeeded?: boolean;
}) {
  if (params.succeeded === false) {
    return {
      status: "skipped",
      reason: "unsuccessful",
    } satisfies ProductActivityWriteResult;
  }
  const idempotencyKey = normalizeSourceReference(params.idempotencyKey);
  return recordProductActivitySafely({
    authUserId: params.authUserId,
    activityType: "cookbook_save",
    sourceReferenceId: idempotencyKey
      ? hashSourceReference("idempotency", idempotencyKey)
      : null,
  });
}

export async function recordVerifiedPurchaseActivitySafely(params: {
  authUserId: string | null | undefined;
  provider: "apple_app_store" | "google_play";
  providerTransactionId: string;
  verifiedAt: string | null | undefined;
}) {
  if (!params.verifiedAt?.trim()) {
    return {
      status: "skipped",
      reason: "unverified",
    } satisfies ProductActivityWriteResult;
  }
  return recordProductActivitySafely({
    authUserId: params.authUserId,
    activityType: "credit_purchase",
    sourceReferenceId: hashSourceReference(
      params.provider,
      params.providerTransactionId.trim(),
    ),
  });
}

export async function getLatestProductActivityForUser(authUserId: string) {
  await ensureProductActivitySchema();
  const result = await executeTurso({
    sql: `SELECT
            event_id,
            auth_user_id,
            activity_type,
            source_reference_id,
            occurred_at
          FROM product_activity_events
          WHERE auth_user_id = ?
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT 1`,
    args: [authUserId.trim()],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToProductActivityEvent(row) : null;
}

export async function listProductActivityForUser(
  authUserId: string,
  limit = 100,
) {
  await ensureProductActivitySchema();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const result = await executeTurso({
    sql: `SELECT
            event_id,
            auth_user_id,
            activity_type,
            source_reference_id,
            occurred_at
          FROM product_activity_events
          WHERE auth_user_id = ?
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT ?`,
    args: [authUserId.trim(), safeLimit],
  });
  return result.rows.map((row) =>
    rowToProductActivityEvent(row as Record<string, unknown>),
  );
}
