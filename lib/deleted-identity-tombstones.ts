import { createHmac, timingSafeEqual } from "crypto";
import type { Client, InStatement } from "@libsql/client";
import { getTursoClient } from "./turso.ts";

type TombstoneClient = Pick<Client, "execute">;

export class DeletedIdentityTombstoneConfigurationError extends Error {
  code = "identity_unavailable";
  statusCode = 503;

  constructor() {
    super("Deleted identity containment is unavailable.");
  }
}

function getTombstoneSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.ACCOUNT_DELETION_TOMBSTONE_SECRET?.trim() ||
    "";
  if (secret.length < 32) {
    throw new DeletedIdentityTombstoneConfigurationError();
  }
  return secret;
}

const TOMBSTONE_KEY_VERSION = 1;
const TOMBSTONE_HMAC_ALGORITHM = "HMAC-SHA256";
const TOMBSTONE_SCHEMA_VERSION = 1;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createDeletedIdentityTombstoneKeyReference(
  options: { secret?: string } = {},
) {
  return `key:v1:${createHmac("sha256", getTombstoneSecret(options.secret))
    .update("ffc:deleted-identity-tombstone:key-reference:v1")
    .digest("hex")}`;
}

export async function ensureDeletedIdentityTombstoneKey(
  options: { client?: TombstoneClient; secret?: string } = {},
) {
  const secret = getTombstoneSecret(options.secret);
  const keyReference = createDeletedIdentityTombstoneKeyReference({ secret });
  const client = options.client ?? getTursoClient();
  try {
    let metadata = await client.execute(`
      SELECT singleton_id, key_version, key_reference, hmac_algorithm, schema_version
      FROM deleted_identity_tombstone_key_metadata
      ORDER BY singleton_id
    `);
    if (metadata.rows.length === 0) {
      const tombstones = await client.execute(
        "SELECT COUNT(*) AS count FROM deleted_identity_tombstones",
      );
      if (Number(tombstones.rows[0]?.count ?? 0) !== 0) {
        throw new DeletedIdentityTombstoneConfigurationError();
      }
      await client.execute({
        sql: `INSERT INTO deleted_identity_tombstone_key_metadata (
                singleton_id, key_version, key_reference,
                hmac_algorithm, schema_version
              ) VALUES (1, ?, ?, ?, ?)
              ON CONFLICT(singleton_id) DO NOTHING`,
        args: [
          TOMBSTONE_KEY_VERSION,
          keyReference,
          TOMBSTONE_HMAC_ALGORITHM,
          TOMBSTONE_SCHEMA_VERSION,
        ],
      });
      metadata = await client.execute(`
        SELECT singleton_id, key_version, key_reference, hmac_algorithm, schema_version
        FROM deleted_identity_tombstone_key_metadata
        ORDER BY singleton_id
      `);
    }
    const row = metadata.rows[0];
    if (
      metadata.rows.length !== 1 ||
      Number(row?.singleton_id) !== 1 ||
      Number(row?.key_version) !== TOMBSTONE_KEY_VERSION ||
      Number(row?.schema_version) !== TOMBSTONE_SCHEMA_VERSION ||
      row?.hmac_algorithm !== TOMBSTONE_HMAC_ALGORITHM ||
      typeof row?.key_reference !== "string" ||
      !safeEqual(row.key_reference, keyReference)
    ) {
      throw new DeletedIdentityTombstoneConfigurationError();
    }
    return {
      keyVersion: TOMBSTONE_KEY_VERSION,
      keyReference,
      hmacAlgorithm: TOMBSTONE_HMAC_ALGORITHM,
      schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    };
  } catch (error) {
    if (error instanceof DeletedIdentityTombstoneConfigurationError) {
      throw error;
    }
    throw new DeletedIdentityTombstoneConfigurationError();
  }
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
  const keyReference = createDeletedIdentityTombstoneKeyReference({
    secret: options.secret,
  });
  return [...new Set(options.identityNodes.map((value) => value.trim()))]
    .filter(Boolean)
    .sort()
    .map((identityId) => ({
      sql: `INSERT INTO deleted_identity_tombstones (
              identity_ref,
              identity_kind,
              deletion_job_id,
              key_version,
              key_reference
            ) VALUES (?, 'graph_node', ?, ?, ?)
            ON CONFLICT(identity_ref) DO NOTHING`,
      args: [
        createDeletedIdentityReference(identityId, { secret: options.secret }),
        options.deletionJobId,
        TOMBSTONE_KEY_VERSION,
        keyReference,
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
  const key = await ensureDeletedIdentityTombstoneKey(options);
  const refs = candidates.map((candidate) =>
    createDeletedIdentityReference(candidate, { secret: options.secret }),
  );
  const client = options.client ?? getTursoClient();
  const result = await client.execute({
    sql: `SELECT identity_ref
          FROM deleted_identity_tombstones
          WHERE key_version = ?
            AND key_reference = ?
            AND identity_ref IN (${refs.map(() => "?").join(", ")})`,
    args: [key.keyVersion, key.keyReference, ...refs],
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
  const keyReference = createDeletedIdentityTombstoneKeyReference({
    secret: options.secret,
  });
  const refs = [...new Set(identityIds.map((identityId) =>
    createDeletedIdentityReference(identityId, { secret: options.secret }),
  ))];
  return {
    sql: `EXISTS (
      SELECT 1
      FROM deleted_identity_tombstone_key_metadata tombstone_key
      WHERE tombstone_key.singleton_id = 1
        AND tombstone_key.key_version = ?
        AND tombstone_key.key_reference = ?
        AND tombstone_key.hmac_algorithm = ?
        AND tombstone_key.schema_version = ?
    ) AND NOT EXISTS (
      SELECT 1
      FROM deleted_identity_tombstones deleted_identity
      WHERE deleted_identity.identity_ref IN (${refs.map(() => "?").join(", ")})
    )`,
    args: [
      TOMBSTONE_KEY_VERSION,
      keyReference,
      TOMBSTONE_HMAC_ALGORITHM,
      TOMBSTONE_SCHEMA_VERSION,
      ...refs,
    ],
  };
}
