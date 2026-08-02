import { createHmac } from "crypto";
import type { Client, InStatement } from "@libsql/client";
import { getTursoClient } from "./turso.ts";

type TombstoneClient = Pick<Client, "execute">;

export class DeletedIdentityTombstoneConfigurationError extends Error {
  constructor() {
    super("Deleted identity containment is unavailable.");
  }
}

function getTombstoneSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.ACCOUNT_DELETION_JOB_SECRET?.trim() ||
    process.env.ACCOUNT_DELETION_PSEUDONYM_SECRET?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    "";
  if (secret.length < 32) {
    throw new DeletedIdentityTombstoneConfigurationError();
  }
  return secret;
}

export function createDeletedIdentityReference(
  identityId: string,
  options: { secret?: string } = {},
) {
  const normalized = identityId.trim();
  if (!normalized) {
    throw new DeletedIdentityTombstoneConfigurationError();
  }
  return `identity:v1:${createHmac("sha256", getTombstoneSecret(options.secret))
    .update("flavor-fusion-chef:deleted-identity:graph-node:v1\u0000")
    .update(normalized)
    .digest("hex")}`;
}

export function buildDeletedIdentityTombstoneStatements(options: {
  identityNodes: string[];
  deletionJobId: string;
  secret?: string;
}): InStatement[] {
  return [...new Set(options.identityNodes.map((value) => value.trim()))]
    .filter(Boolean)
    .sort()
    .map((identityId) => ({
      sql: `INSERT INTO deleted_identity_tombstones (
              identity_ref,
              identity_kind,
              deletion_job_id
            ) VALUES (?, 'graph_node', ?)
            ON CONFLICT(identity_ref) DO NOTHING`,
      args: [
        createDeletedIdentityReference(identityId, { secret: options.secret }),
        options.deletionJobId,
      ],
    }));
}

export async function filterDeletedIdentityCandidates(
  candidateIds: string[],
  options: { client?: TombstoneClient; secret?: string } = {},
) {
  const candidates = [...new Set(candidateIds.map((value) => value.trim()))]
    .filter(Boolean);
  if (candidates.length === 0) return [];
  const refs = candidates.map((candidate) =>
    createDeletedIdentityReference(candidate, { secret: options.secret }),
  );
  const client = options.client ?? getTursoClient();
  const result = await client.execute({
    sql: `SELECT identity_ref
          FROM deleted_identity_tombstones
          WHERE identity_ref IN (${refs.map(() => "?").join(", ")})`,
    args: refs,
  });
  const deletedRefs = new Set(
    result.rows.map((row) =>
      typeof row.identity_ref === "string" ? row.identity_ref : "",
    ),
  );
  return candidates.filter((_, index) => !deletedRefs.has(refs[index]));
}

export function getDeletedIdentityWriteGuard(
  identityIds: string[],
  options: { secret?: string } = {},
) {
  const refs = [...new Set(identityIds.map((identityId) =>
    createDeletedIdentityReference(identityId, { secret: options.secret }),
  ))];
  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM deleted_identity_tombstones deleted_identity
      WHERE deleted_identity.identity_ref IN (${refs.map(() => "?").join(", ")})
    )`,
    args: refs,
  };
}
