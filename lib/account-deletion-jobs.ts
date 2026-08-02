import { createHmac, randomUUID } from "crypto";
import type { Client, InStatement } from "@libsql/client";
import {
  type AccountDeletionGraphPlan,
  type AccountDeletionPlan,
} from "./account-deletion-planner.ts";
import { getTursoClient } from "./turso.ts";

type JobClient = Pick<Client, "execute" | "batch">;

const DEFAULT_PREVIEW_TTL_SECONDS = 15 * 60;

export type AccountDeletionJobStatus =
  | "previewed"
  | "approved"
  | "executing"
  | "database_completed"
  | "storage_pending"
  | "completed"
  | "failed_retryable"
  | "manual_review";

export class AccountDeletionJobError extends Error {
  code: string;
  statusCode: number;

  constructor(
    code: string,
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function jobUnavailable(message = "Account deletion job persistence is unavailable.") {
  return new AccountDeletionJobError(
    "account_deletion_job_unavailable",
    message,
    503,
  );
}

type PersistedJob = {
  jobId: string;
  actingAdminRef: string;
  previewFingerprint: string;
  previewExpiresAt: string;
  status: AccountDeletionJobStatus;
};

type PersistedTarget = {
  targetId: string;
  targetRef: string;
  status: AccountDeletionJobStatus;
};

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getJobSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.ACCOUNT_DELETION_JOB_SECRET?.trim() ||
    process.env.ACCOUNT_DELETION_PSEUDONYM_SECRET?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    "";
  if (secret.length < 32) {
    throw new AccountDeletionJobError(
      "account_deletion_job_unavailable",
      "Account deletion job persistence is unavailable.",
      503,
    );
  }
  return secret;
}

function hmacReference(kind: string, value: string, secret: string) {
  return `${kind}:v1:${createHmac("sha256", secret)
    .update(`flavor-fusion-chef:account-deletion:${kind}:v1\u0000`)
    .update(value)
    .digest("hex")}`;
}

function getPreviewTtlSeconds() {
  const configured = Number.parseInt(
    process.env.ACCOUNT_DELETION_PREVIEW_TTL_SECONDS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured >= 60 && configured <= 3600
    ? configured
    : DEFAULT_PREVIEW_TTL_SECONDS;
}

function stableGraphScope(graph: AccountDeletionGraphPlan) {
  return {
    graphId: graph.graphId,
    status: graph.status,
    blockers: [...graph.blockers].sort(),
    selectedAuthUserIds: [...graph.selectedAuthUserIds].sort(),
    ownerAuthUserIds: [...graph.ownerAuthUserIds].sort(),
    unselectedOwnerAuthUserIds: [...graph.unselectedOwnerAuthUserIds].sort(),
    identityNodes: [...graph.identityNodes].sort(),
    canonicalIdentityIds: [...graph.canonicalIdentityIds].sort(),
    aliasEdges: [...graph.aliasEdges].sort((left, right) =>
      `${left.anonUserId}:${left.canonicalAnonUserId}`.localeCompare(
        `${right.anonUserId}:${right.canonicalAnonUserId}`,
      ),
    ),
    deviceKeys: [...graph.deviceKeys].sort(),
    storageReferences: [...graph.storageReferences].sort((left, right) =>
      `${left.category}:${left.value}`.localeCompare(
        `${right.category}:${right.value}`,
      ),
    ),
    inventory: graph.inventory,
  };
}

function stablePlanScope(plan: AccountDeletionPlan, reason: string) {
  return {
    version: 1,
    reason: reason.trim(),
    selectedAuthUserIds: [...plan.selectedAuthUserIds].sort(),
    missingAuthUserIds: [...plan.missingAuthUserIds].sort(),
    graphs: [...plan.graphs]
      .map(stableGraphScope)
      .sort((left, right) => left.graphId.localeCompare(right.graphId)),
  };
}

function fingerprintValue(value: unknown, secret: string) {
  return createHmac("sha256", secret)
    .update("flavor-fusion-chef:account-deletion-plan:v1\u0000")
    .update(JSON.stringify(value))
    .digest("hex");
}

function minimizedGraphSnapshot(graph: AccountDeletionGraphPlan, secret: string) {
  return {
    graphRef: hmacReference("graph", graph.graphId, secret),
    status: graph.status,
    blockers: [...graph.blockers].sort(),
    selectedAuthRefs: graph.selectedAuthUserIds
      .map((value) => hmacReference("auth", value, secret))
      .sort(),
    ownerAuthRefs: graph.ownerAuthUserIds
      .map((value) => hmacReference("auth", value, secret))
      .sort(),
    identityNodeRefs: graph.identityNodes
      .map((value) => hmacReference("identity", value, secret))
      .sort(),
    aliasEdgeRefs: graph.aliasEdges
      .map((edge) =>
        hmacReference(
          "alias-edge",
          `${edge.anonUserId}\u0000${edge.canonicalAnonUserId}`,
          secret,
        ),
      )
      .sort(),
    deviceMappingRefs: graph.deviceKeys
      .map((value) => hmacReference("device", value, secret))
      .sort(),
    storageRefs: graph.storageReferences
      .map((reference) => ({
        category: reference.category,
        ref: hmacReference("storage", reference.value, secret),
      }))
      .sort((left, right) =>
        `${left.category}:${left.ref}`.localeCompare(
          `${right.category}:${right.ref}`,
        ),
      ),
    inventory: graph.inventory,
  };
}

function minimizedPlanSnapshot(plan: AccountDeletionPlan, secret: string) {
  return {
    version: 1,
    selectedAuthRefs: plan.selectedAuthUserIds
      .map((value) => hmacReference("auth", value, secret))
      .sort(),
    missingAuthRefs: plan.missingAuthUserIds
      .map((value) => hmacReference("auth", value, secret))
      .sort(),
    graphs: plan.graphs
      .map((graph) => minimizedGraphSnapshot(graph, secret))
      .sort((left, right) => left.graphRef.localeCompare(right.graphRef)),
  };
}

export function fingerprintAccountDeletionPlan(options: {
  plan: AccountDeletionPlan;
  reason: string;
  secret?: string;
}) {
  const secret = getJobSecret(options.secret);
  return fingerprintValue(stablePlanScope(options.plan, options.reason), secret);
}

async function readJobByIdempotency(
  client: JobClient,
  requestSource: string,
  idempotencyKey: string,
): Promise<PersistedJob | null> {
  const result = await client.execute({
    sql: `SELECT job_id, acting_admin_ref, preview_fingerprint,
                 preview_expires_at, status
          FROM account_deletion_jobs
          WHERE request_source = ? AND idempotency_key = ?
          LIMIT 1`,
    args: [requestSource, idempotencyKey],
  });
  const row = result.rows[0];
  return row
    ? {
        jobId: asString(row.job_id),
        actingAdminRef: asString(row.acting_admin_ref),
        previewFingerprint: asString(row.preview_fingerprint),
        previewExpiresAt: asString(row.preview_expires_at),
        status: asString(row.status) as AccountDeletionJobStatus,
      }
    : null;
}

async function readJobById(
  client: JobClient,
  jobId: string,
): Promise<PersistedJob | null> {
  const result = await client.execute({
    sql: `SELECT job_id, acting_admin_ref, preview_fingerprint,
                 preview_expires_at, status
          FROM account_deletion_jobs
          WHERE job_id = ?
          LIMIT 1`,
    args: [jobId],
  });
  const row = result.rows[0];
  return row
    ? {
        jobId: asString(row.job_id),
        actingAdminRef: asString(row.acting_admin_ref),
        previewFingerprint: asString(row.preview_fingerprint),
        previewExpiresAt: asString(row.preview_expires_at),
        status: asString(row.status) as AccountDeletionJobStatus,
      }
    : null;
}

async function readTargets(client: JobClient, jobId: string) {
  const result = await client.execute({
    sql: `SELECT target_id, target_ref, status
          FROM account_deletion_job_targets
          WHERE job_id = ?
          ORDER BY target_id`,
    args: [jobId],
  });
  return result.rows.map(
    (row): PersistedTarget => ({
      targetId: asString(row.target_id),
      targetRef: asString(row.target_ref),
      status: asString(row.status) as AccountDeletionJobStatus,
    }),
  );
}

export async function createAccountDeletionPreview(options: {
  plan: AccountDeletionPlan;
  reason: string;
  actingAdminAuthUserId: string;
  requestId: string;
  requestSource?: string;
  idempotencyKey?: string;
  now?: () => Date;
  previewTtlSeconds?: number;
  client?: JobClient;
  secret?: string;
}) {
  const client = options.client ?? getTursoClient();
  const secret = getJobSecret(options.secret);
  const requestSource = options.requestSource ?? "admin_console";
  const idempotencyKey =
    options.idempotencyKey?.trim() || `preview:${options.requestId}`;
  const now = (options.now ?? (() => new Date()))();
  const expiresAt = new Date(
    now.getTime() +
      (options.previewTtlSeconds ?? getPreviewTtlSeconds()) * 1000,
  ).toISOString();
  const fingerprint = fingerprintValue(
    stablePlanScope(options.plan, options.reason),
    secret,
  );
  const actingAdminRef = hmacReference(
    "admin",
    options.actingAdminAuthUserId,
    secret,
  );
  let existing: PersistedJob | null;
  try {
    existing = await readJobByIdempotency(
      client,
      requestSource,
      idempotencyKey,
    );
  } catch {
    throw jobUnavailable();
  }
  if (existing) {
    if (
      existing.previewFingerprint !== fingerprint ||
      existing.actingAdminRef !== actingAdminRef
    ) {
      throw new AccountDeletionJobError(
        "account_deletion_idempotency_conflict",
        "The preview idempotency key was already used for another request.",
        409,
      );
    }
    return {
      jobId: existing.jobId,
      fingerprint: existing.previewFingerprint,
      expiresAt: existing.previewExpiresAt,
      status: existing.status,
      replayed: true,
    };
  }

  const jobId = randomUUID();
  const requiresReview =
    options.plan.graphs.length === 0 ||
    options.plan.missingAuthUserIds.length > 0 ||
    options.plan.graphs.some((graph) => graph.status === "manual_review");
  const status: AccountDeletionJobStatus = requiresReview
    ? "manual_review"
    : "previewed";
  const jobSnapshot = minimizedPlanSnapshot(options.plan, secret);
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO account_deletion_jobs (
              job_id, request_id, request_source, acting_admin_ref, reason,
              plan_version, plan_json, preview_fingerprint,
              preview_expires_at, status, idempotency_key,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        jobId,
        options.requestId,
        requestSource,
        actingAdminRef,
        options.reason.trim(),
        JSON.stringify(jobSnapshot),
        fingerprint,
        expiresAt,
        status,
        idempotencyKey,
        now.toISOString(),
        now.toISOString(),
      ],
    },
    ...options.plan.graphs.map((graph) => {
      const graphSnapshot = minimizedGraphSnapshot(graph, secret);
      return {
        sql: `INSERT INTO account_deletion_job_targets (
                target_id, job_id, target_ref, graph_fingerprint,
                plan_json, status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          hmacReference("target", `${jobId}\u0000${graph.graphId}`, secret),
          jobId,
          graphSnapshot.graphRef,
          fingerprintValue(stableGraphScope(graph), secret),
          JSON.stringify(graphSnapshot),
          graph.status === "manual_review" ? "manual_review" : "previewed",
          now.toISOString(),
          now.toISOString(),
        ],
      } satisfies InStatement;
    }),
  ];

  try {
    await client.batch(statements, "write");
  } catch {
    const raced = await readJobByIdempotency(
      client,
      requestSource,
      idempotencyKey,
    ).catch(() => null);
    if (
      raced?.previewFingerprint === fingerprint &&
      raced.actingAdminRef === actingAdminRef
    ) {
      return {
        jobId: raced.jobId,
        fingerprint: raced.previewFingerprint,
        expiresAt: raced.previewExpiresAt,
        status: raced.status,
        replayed: true,
      };
    }
    throw new AccountDeletionJobError(
      "account_deletion_job_unavailable",
      "Account deletion job persistence is unavailable.",
      503,
    );
  }

  return {
    jobId,
    fingerprint,
    expiresAt,
    status,
    replayed: false,
  };
}

function safeFailureCode(error: unknown) {
  if (error instanceof AccountDeletionJobError) {
    return error.code.slice(0, 120);
  }
  return "database_stage_failed";
}

async function markRetryableFailure(options: {
  client: JobClient;
  jobId: string;
  targetId: string;
  error: unknown;
  nowIso: string;
}) {
  const code = safeFailureCode(options.error);
  const summary = "A database deletion stage failed and can be retried.";
  await options.client.batch(
    [
      {
        sql: `UPDATE account_deletion_job_targets
              SET status = 'failed_retryable',
                  attempt_count = attempt_count + 1,
                  last_error_code = ?, last_error_summary = ?,
                  updated_at = ?
              WHERE target_id = ? AND status <> 'database_completed'
                AND status <> 'completed'`,
        args: [code, summary, options.nowIso, options.targetId],
      },
      {
        sql: `UPDATE account_deletion_jobs
              SET status = 'failed_retryable',
                  last_error_code = ?, last_error_summary = ?,
                  updated_at = ?
              WHERE job_id = ? AND status <> 'completed'`,
        args: [code, summary, options.nowIso, options.jobId],
      },
    ],
    "write",
  );
}

export async function executeAccountDeletionJob(options: {
  jobId: string;
  fingerprint: string;
  currentPlan: AccountDeletionPlan;
  reason: string;
  actingAdminAuthUserId: string;
  buildGraphStatements: (context: {
    graph: AccountDeletionGraphPlan;
    jobId: string;
    targetId: string;
  }) => InStatement[];
  now?: () => Date;
  client?: JobClient;
  secret?: string;
}) {
  const client = options.client ?? getTursoClient();
  const secret = getJobSecret(options.secret);
  let job: PersistedJob | null;
  try {
    job = await readJobById(client, options.jobId);
  } catch {
    throw jobUnavailable();
  }
  if (!job) {
    throw new AccountDeletionJobError(
      "account_deletion_job_not_found",
      "The account deletion job was not found.",
      404,
    );
  }
  const actorRef = hmacReference(
    "admin",
    options.actingAdminAuthUserId,
    secret,
  );
  if (job.actingAdminRef !== actorRef) {
    throw new AccountDeletionJobError(
      "account_deletion_job_forbidden",
      "This account deletion job belongs to another administrator.",
      403,
    );
  }
  if (
    !options.fingerprint ||
    options.fingerprint !== job.previewFingerprint
  ) {
    throw new AccountDeletionJobError(
      "stale_preview",
      "The account deletion preview no longer matches this request.",
      409,
    );
  }
  if (job.status === "completed") {
    return {
      jobId: job.jobId,
      status: "completed" as const,
      expiresAt: job.previewExpiresAt,
      replayed: true,
    };
  }
  if (job.status === "manual_review") {
    throw new AccountDeletionJobError(
      "account_deletion_manual_review",
      "The account deletion job requires manual review.",
      409,
    );
  }
  const now = (options.now ?? (() => new Date()))();
  if (now.getTime() >= Date.parse(job.previewExpiresAt)) {
    try {
      await client.execute({
        sql: `UPDATE account_deletion_jobs
              SET status = 'manual_review', last_error_code = 'expired_preview',
                  last_error_summary = 'The approved deletion preview expired.',
                  updated_at = ?
              WHERE job_id = ? AND status <> 'completed'`,
        args: [now.toISOString(), job.jobId],
      });
    } catch {
      throw jobUnavailable();
    }
    throw new AccountDeletionJobError(
      "expired_preview",
      "The account deletion preview expired. Create a new preview.",
      409,
    );
  }
  const currentFingerprint = fingerprintValue(
    stablePlanScope(options.currentPlan, options.reason),
    secret,
  );
  if (currentFingerprint !== job.previewFingerprint) {
    try {
      await client.execute({
        sql: `UPDATE account_deletion_jobs
              SET status = 'manual_review', last_error_code = 'stale_preview',
                  last_error_summary = 'The current deletion scope changed.',
                  updated_at = ?
              WHERE job_id = ? AND status <> 'completed'`,
        args: [now.toISOString(), job.jobId],
      });
    } catch {
      throw jobUnavailable();
    }
    throw new AccountDeletionJobError(
      "stale_preview",
      "The account deletion scope changed. Create and approve a new preview.",
      409,
    );
  }

  let started;
  try {
    started = await client.execute({
      sql: `UPDATE account_deletion_jobs
            SET status = 'executing',
                approved_at = COALESCE(approved_at, ?),
                started_at = COALESCE(started_at, ?),
                attempt_count = attempt_count + 1,
                last_error_code = NULL,
                last_error_summary = NULL,
                updated_at = ?
            WHERE job_id = ?
              AND status IN (
                'previewed', 'approved', 'executing', 'database_completed',
                'failed_retryable'
              )`,
      args: [now.toISOString(), now.toISOString(), now.toISOString(), job.jobId],
    });
  } catch {
    throw jobUnavailable("Account deletion execution could not start safely.");
  }
  if ((started.rowsAffected ?? 0) !== 1) {
    throw new AccountDeletionJobError(
      "account_deletion_job_unavailable",
      "Account deletion execution could not start safely.",
      503,
    );
  }

  const graphsByRef = new Map(
    options.currentPlan.graphs.map((graph) => [
      hmacReference("graph", graph.graphId, secret),
      graph,
    ]),
  );
  let targets: PersistedTarget[];
  try {
    targets = await readTargets(client, job.jobId);
  } catch {
    throw jobUnavailable();
  }
  for (const target of targets) {
    if (target.status === "completed" || target.status === "database_completed") {
      continue;
    }
    if (target.status === "manual_review") {
      throw new AccountDeletionJobError(
        "account_deletion_manual_review",
        "An account deletion target requires manual review.",
        409,
      );
    }
    const graph = graphsByRef.get(target.targetRef);
    if (!graph || graph.status !== "ready") {
      throw new AccountDeletionJobError(
        "stale_preview",
        "The account deletion graph no longer matches the approved preview.",
        409,
      );
    }
    try {
      await client.batch(
        [
          ...options.buildGraphStatements({
            graph,
            jobId: job.jobId,
            targetId: target.targetId,
          }),
          {
            sql: `UPDATE account_deletion_job_targets
                  SET status = 'database_completed',
                      attempt_count = attempt_count + 1,
                      started_at = COALESCE(started_at, ?),
                      last_error_code = NULL,
                      last_error_summary = NULL,
                      updated_at = ?
                  WHERE target_id = ?
                    AND status NOT IN ('database_completed', 'completed')`,
            args: [now.toISOString(), now.toISOString(), target.targetId],
          },
        ],
        "write",
      );
    } catch (error) {
      const concurrent = (
        await readTargets(client, job.jobId).catch(() => [])
      ).find((candidate) => candidate.targetId === target.targetId);
      if (
        concurrent?.status === "database_completed" ||
        concurrent?.status === "completed"
      ) {
        continue;
      }
      try {
        await markRetryableFailure({
          client,
          jobId: job.jobId,
          targetId: target.targetId,
          error,
          nowIso: now.toISOString(),
        });
      } catch {
        throw new AccountDeletionJobError(
          "account_deletion_job_unavailable",
          "Account deletion failure state could not be persisted safely.",
          503,
        );
      }
      throw new AccountDeletionJobError(
        "account_deletion_retryable_failure",
        "Account deletion stopped after a retryable database failure.",
        503,
      );
    }
  }

  let remaining: PersistedTarget[];
  try {
    remaining = (await readTargets(client, job.jobId)).filter(
      (target) =>
        target.status !== "database_completed" &&
        target.status !== "completed",
    );
  } catch {
    throw jobUnavailable();
  }
  if (remaining.length > 0) {
    throw new AccountDeletionJobError(
      "account_deletion_retryable_failure",
      "Account deletion has unfinished retryable targets.",
      503,
    );
  }
  try {
    await client.batch(
      [
      {
        sql: `UPDATE account_deletion_jobs
              SET status = 'database_completed', updated_at = ?
              WHERE job_id = ? AND status <> 'completed'`,
        args: [now.toISOString(), job.jobId],
      },
      {
        sql: `UPDATE account_deletion_job_targets
              SET status = 'completed', completed_at = ?, updated_at = ?
              WHERE job_id = ? AND status = 'database_completed'`,
        args: [now.toISOString(), now.toISOString(), job.jobId],
      },
      {
        sql: `UPDATE account_deletion_jobs
              SET status = 'completed', completed_at = ?, updated_at = ?
              WHERE job_id = ? AND status = 'database_completed'`,
        args: [now.toISOString(), now.toISOString(), job.jobId],
      },
      ],
      "write",
    );
  } catch {
    throw jobUnavailable(
      "Account deletion completion could not be persisted safely.",
    );
  }
  let completed: PersistedJob | null;
  try {
    completed = await readJobById(client, job.jobId);
  } catch {
    throw jobUnavailable();
  }
  if (completed?.status !== "completed") {
    throw new AccountDeletionJobError(
      "account_deletion_job_unavailable",
      "Account deletion completion could not be persisted safely.",
      503,
    );
  }
  return {
    jobId: job.jobId,
    status: "completed" as const,
    expiresAt: job.previewExpiresAt,
    replayed: false,
  };
}
