import { createHash } from "crypto";
import type { Client, InStatement } from "@libsql/client";
import type { AccountDeletionGraphPlan } from "./account-deletion-planner.ts";
import {
  deleteR2ObjectByKey,
  getR2ObjectKeyFromPublicUrl,
} from "./r2-storage.ts";
import { getTursoClient } from "./turso.ts";

type StorageClient = Pick<Client, "execute" | "batch">;

export type AccountDeletionStorageCategory =
  | "recipe_image"
  | "profile_avatar"
  | "generated_image";

export type AccountDeletionStorageObject = {
  key: string;
  category: AccountDeletionStorageCategory;
};

export class AccountDeletionStorageError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function classifyStorageReference(
  category: "cookbook_image" | "profile_avatar",
  key: string,
): AccountDeletionStorageCategory | null {
  if (category === "profile_avatar") {
    return key.startsWith("profile-photos/") ? "profile_avatar" : null;
  }
  if (key.startsWith("recipe-images/")) {
    return "recipe_image";
  }
  if (key.startsWith("fusion-images/")) {
    return "generated_image";
  }
  return null;
}

function containsUnsafeOperationalDetail(key: string) {
  return (
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(key) ||
    /(?:bearer|oauth|provider[-_]?payload|purchase[-_]?token|receipt[-_]?token)/i.test(
      key,
    ) ||
    /[a-z0-9_-]{49,}/i.test(key)
  );
}

export function resolveAccountDeletionStorageReference(options: {
  reference: { category: "cookbook_image" | "profile_avatar"; value: string };
  publicBaseUrl: string;
}) {
  const publicBaseUrl = options.publicBaseUrl.replace(/\/$/, "");
  if (!options.reference.value.startsWith(`${publicBaseUrl}/`)) {
    return null;
  }
  const key = getR2ObjectKeyFromPublicUrl(
    options.reference.value,
    options.publicBaseUrl,
  );
  if (!key) {
    throw new AccountDeletionStorageError(
      "storage_reference_invalid",
      "An account deletion storage reference is invalid.",
    );
  }
  if (containsUnsafeOperationalDetail(key)) {
    throw new AccountDeletionStorageError(
      "storage_reference_sensitive",
      "An account deletion storage reference requires manual review.",
    );
  }
  const category = classifyStorageReference(options.reference.category, key);
  if (!category) {
    throw new AccountDeletionStorageError(
      "storage_reference_unsupported",
      "An account deletion storage reference cannot be attributed safely.",
    );
  }
  return {
    key,
    category,
    source: options.reference.category,
  };
}

export function collectAccountDeletionStorageObjects(options: {
  graph: AccountDeletionGraphPlan;
  publicBaseUrl?: string;
}) {
  if (options.graph.storageReferences.length === 0) {
    return [] as AccountDeletionStorageObject[];
  }
  const publicBaseUrl =
    options.publicBaseUrl ?? process.env.R2_PUBLIC_BASE_URL ?? "";
  if (!publicBaseUrl.trim()) {
    throw new AccountDeletionStorageError(
      "storage_configuration_unavailable",
      "Account deletion storage configuration is unavailable.",
    );
  }
  const objects = new Map<string, AccountDeletionStorageObject>();
  for (const reference of options.graph.storageReferences) {
    const resolved = resolveAccountDeletionStorageReference({
      reference,
      publicBaseUrl,
    });
    if (!resolved) continue;
    const existing = objects.get(resolved.key);
    if (existing && existing.category !== resolved.category) {
      throw new AccountDeletionStorageError(
        "storage_reference_ambiguous",
        "An account deletion storage reference has ambiguous ownership.",
      );
    }
    objects.set(resolved.key, {
      key: resolved.key,
      category: resolved.category,
    });
  }
  return [...objects.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

export function buildAccountDeletionStorageOutboxStatements(options: {
  graph: AccountDeletionGraphPlan;
  jobId: string;
  targetId: string;
  publicBaseUrl?: string;
}): InStatement[] {
  return collectAccountDeletionStorageObjects(options).map((object) => ({
    sql: `INSERT INTO account_deletion_storage_outbox (
            outbox_id, job_id, target_id, object_key, object_category,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending',
                    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(job_id, object_key) DO NOTHING`,
    args: [
      `storage:${createHash("sha256")
        .update(`${options.jobId}\u0000${object.key}`)
        .digest("hex")}`,
      options.jobId,
      options.targetId,
      object.key,
      object.category,
    ],
  }));
}

function isMissingObjectError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  const code = asString(candidate.name || candidate.Code || candidate.code);
  return /^(NoSuchKey|NotFound|404)$/i.test(code);
}

const ACTIVE_STORAGE_REFERENCE_SQL = `EXISTS (
  SELECT 1
  FROM cookbook_recipes
  WHERE trim(image_url) = ?
     OR trim(image_url) LIKE ? ESCAPE '\\'
     OR trim(image_url) LIKE ? ESCAPE '\\'
  UNION ALL
  SELECT 1
  FROM auth_users
  WHERE trim(avatar_url) = ?
     OR trim(avatar_url) LIKE ? ESCAPE '\\'
     OR trim(avatar_url) LIKE ? ESCAPE '\\'
)`;

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function activeStorageReferenceArgs(publicUrl: string) {
  const escaped = escapeLike(publicUrl);
  return [
    publicUrl,
    `${escaped}?%`,
    `${escaped}#%`,
    publicUrl,
    `${escaped}?%`,
    `${escaped}#%`,
  ];
}

async function completeStorageClaim(options: {
  client: StorageClient;
  outboxId: string;
  nowIso: string;
  referenceArgs: string[];
}) {
  const completed = await options.client.execute({
    sql: `UPDATE account_deletion_storage_outbox
          SET status = 'completed', completed_at = ?, updated_at = ?,
              last_safe_error = NULL
          WHERE outbox_id = ? AND status = 'processing'
            AND NOT ${ACTIVE_STORAGE_REFERENCE_SQL}`,
    args: [
      options.nowIso,
      options.nowIso,
      options.outboxId,
      ...options.referenceArgs,
    ],
  });
  if ((completed.rowsAffected ?? 0) === 1) return true;
  await options.client.execute({
    sql: `UPDATE account_deletion_storage_outbox
          SET status = 'manual_review',
              last_safe_error = 'Object became referenced during storage deletion.',
              updated_at = ?
          WHERE outbox_id = ? AND status = 'processing'
            AND ${ACTIVE_STORAGE_REFERENCE_SQL}`,
    args: [options.nowIso, options.outboxId, ...options.referenceArgs],
  });
  return false;
}

async function updateJobFromStorageState(
  client: StorageClient,
  jobId: string,
  nowIso: string,
) {
  const statusRows = await client.execute({
    sql: `SELECT status, COUNT(*) AS count
          FROM account_deletion_storage_outbox
          WHERE job_id = ?
          GROUP BY status`,
    args: [jobId],
  });
  const counts = new Map(
    statusRows.rows.map((row) => [asString(row.status), Number(row.count ?? 0)]),
  );
  const manualReview = counts.get("manual_review") ?? 0;
  const unresolved =
    (counts.get("pending") ?? 0) +
    (counts.get("processing") ?? 0) +
    (counts.get("failed_retryable") ?? 0);
  if (manualReview > 0) {
    await client.batch(
      [
        {
          sql: `UPDATE account_deletion_job_targets
                SET status = 'manual_review',
                    last_error_code = 'storage_reference_still_active',
                    last_error_summary = 'A storage object remains referenced by active application data.',
                    updated_at = ?
                WHERE job_id = ? AND target_id IN (
                  SELECT target_id FROM account_deletion_storage_outbox
                  WHERE job_id = ? AND status = 'manual_review'
                )`,
          args: [nowIso, jobId, jobId],
        },
        {
          sql: `UPDATE account_deletion_jobs
                SET status = 'manual_review',
                    last_error_code = 'storage_reference_still_active',
                    last_error_summary = 'A storage object remains referenced by active application data.',
                    updated_at = ?
                WHERE job_id = ? AND status <> 'completed'`,
          args: [nowIso, jobId],
        },
      ],
      "write",
    );
    return "manual_review" as const;
  }
  if (unresolved > 0) {
    await client.batch(
      [
        {
          sql: `UPDATE account_deletion_job_targets
                SET status = 'storage_pending', updated_at = ?
                WHERE job_id = ? AND status IN (
                  'database_completed', 'storage_pending'
                )`,
          args: [nowIso, jobId],
        },
        {
          sql: `UPDATE account_deletion_jobs
                SET status = 'storage_pending', updated_at = ?
                WHERE job_id = ? AND status <> 'completed'`,
          args: [nowIso, jobId],
        },
      ],
      "write",
    );
    return "storage_pending" as const;
  }
  await client.batch(
    [
      {
        sql: `UPDATE account_deletion_job_targets
              SET status = 'completed', completed_at = COALESCE(completed_at, ?),
                  last_error_code = NULL, last_error_summary = NULL,
                  updated_at = ?
              WHERE job_id = ? AND status IN (
                'database_completed', 'storage_pending'
              )`,
        args: [nowIso, nowIso, jobId],
      },
      {
        sql: `UPDATE account_deletion_jobs
              SET status = 'completed', completed_at = COALESCE(completed_at, ?),
                  last_error_code = NULL, last_error_summary = NULL,
                  updated_at = ?
              WHERE job_id = ? AND status IN (
                'database_completed', 'storage_pending'
              )`,
        args: [nowIso, nowIso, jobId],
      },
    ],
    "write",
  );
  return "completed" as const;
}

export async function processAccountDeletionStorageOutbox(options: {
  jobId: string;
  client?: StorageClient;
  publicBaseUrl?: string;
  now?: () => Date;
  processingLeaseMs?: number;
  deleteObject?: (key: string) => Promise<void>;
}) {
  const client = options.client ?? getTursoClient();
  const publicBaseUrl =
    options.publicBaseUrl ?? process.env.R2_PUBLIC_BASE_URL ?? "";
  if (!publicBaseUrl.trim()) {
    throw new AccountDeletionStorageError(
      "storage_configuration_unavailable",
      "Account deletion storage configuration is unavailable.",
    );
  }
  const now = (options.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - (options.processingLeaseMs ?? 5 * 60 * 1000),
  ).toISOString();
  const rows = await client.execute({
    sql: `SELECT outbox_id, object_key, status, attempted_at
          FROM account_deletion_storage_outbox
          WHERE job_id = ?
            AND status IN ('pending', 'processing', 'failed_retryable')
          ORDER BY created_at, outbox_id`,
    args: [options.jobId],
  });
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let protectedCount = 0;
  const deleteObject =
    options.deleteObject ?? ((key: string) => deleteR2ObjectByKey(key));

  for (const row of rows.rows) {
    const outboxId = asString(row.outbox_id);
    const key = asString(row.object_key);
    const publicUrl = `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
    const referenceArgs = activeStorageReferenceArgs(publicUrl);
    const claimed = await client.execute({
      sql: `UPDATE account_deletion_storage_outbox
            SET status = 'processing', attempt_count = attempt_count + 1,
                attempted_at = ?, updated_at = ?, last_safe_error = NULL
            WHERE outbox_id = ?
              AND (
                status IN ('pending', 'failed_retryable')
                OR (status = 'processing' AND attempted_at < ?)
              )
              AND NOT ${ACTIVE_STORAGE_REFERENCE_SQL}`,
      args: [nowIso, nowIso, outboxId, staleBefore, ...referenceArgs],
    });
    if ((claimed.rowsAffected ?? 0) !== 1) {
      const conflicted = await client.execute({
        sql: `UPDATE account_deletion_storage_outbox
              SET status = 'manual_review',
                  last_safe_error = 'Object remains referenced by active application data.',
                  updated_at = ?
              WHERE outbox_id = ?
                AND (
                  status IN ('pending', 'failed_retryable')
                  OR (status = 'processing' AND attempted_at < ?)
                )
                AND ${ACTIVE_STORAGE_REFERENCE_SQL}`,
        args: [nowIso, outboxId, staleBefore, ...referenceArgs],
      });
      if ((conflicted.rowsAffected ?? 0) === 1) {
        protectedCount += 1;
      }
      continue;
    }
    attempted += 1;
    try {
      await deleteObject(key);
      if (
        await completeStorageClaim({
          client,
          outboxId,
          nowIso,
          referenceArgs,
        })
      ) {
        completed += 1;
      } else {
        protectedCount += 1;
      }
    } catch (error) {
      if (isMissingObjectError(error)) {
        if (
          await completeStorageClaim({
            client,
            outboxId,
            nowIso,
            referenceArgs,
          })
        ) {
          completed += 1;
        } else {
          protectedCount += 1;
        }
      } else {
        await client.execute({
          sql: `UPDATE account_deletion_storage_outbox
                SET status = 'failed_retryable',
                    last_safe_error = 'R2 deletion failed and can be retried.',
                    updated_at = ?
                WHERE outbox_id = ? AND status = 'processing'`,
          args: [nowIso, outboxId],
        });
        failed += 1;
      }
    }
  }

  const status = await updateJobFromStorageState(
    client,
    options.jobId,
    nowIso,
  );
  return {
    jobId: options.jobId,
    status,
    attempted,
    completed,
    failed,
    protected: protectedCount,
  };
}
