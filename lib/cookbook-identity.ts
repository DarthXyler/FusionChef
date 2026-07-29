import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { getAnonymousIdentity } from "@/lib/anon-user";
import { mergeCookbookAnonymousUsers } from "@/lib/cookbook-db";
import {
  asIdentityResolutionError,
  createRetryableIdentityInitializer,
  failClosedIdentityResolution,
  resolveCookbookIdentityCore,
  type CookbookIdentity,
} from "@/lib/cookbook-identity-core";
import { executeTurso } from "@/lib/turso";

const MOBILE_DEVICE_KEY_HEADER = "x-flavor-fusion-device-key";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CookbookIdentityResolutionContext = {
  authUserId: string | null;
  requestId?: string;
};

function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

const ensureIdentitySchema = createRetryableIdentityInitializer(async () => {
  await executeTurso({
    sql: `CREATE TABLE IF NOT EXISTS mobile_identity_links (
              device_key TEXT PRIMARY KEY,
              canonical_anon_user_id TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )`,
  });
  await executeTurso({
    sql: `CREATE INDEX IF NOT EXISTS idx_mobile_identity_links_canonical
            ON mobile_identity_links (canonical_anon_user_id)`,
  });
  await executeTurso({
    sql: `CREATE TABLE IF NOT EXISTS mobile_identity_aliases (
              anon_user_id TEXT PRIMARY KEY,
              canonical_anon_user_id TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )`,
  });
  await executeTurso({
    sql: `CREATE INDEX IF NOT EXISTS idx_mobile_identity_aliases_canonical
            ON mobile_identity_aliases (canonical_anon_user_id)`,
  });
  await executeTurso({
    sql: `CREATE TABLE IF NOT EXISTS auth_identity_links (
              auth_user_id TEXT PRIMARY KEY,
              canonical_anon_user_id TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )`,
  });
  await executeTurso({
    sql: `CREATE INDEX IF NOT EXISTS idx_auth_identity_links_canonical
            ON auth_identity_links (canonical_anon_user_id)`,
  });
});

async function readCanonicalIdForDevice(deviceKey: string) {
  const result = await executeTurso({
    sql: `SELECT canonical_anon_user_id
          FROM mobile_identity_links
          WHERE device_key = ?
          LIMIT 1`,
    args: [deviceKey],
  });

  const value = result.rows[0]?.canonical_anon_user_id;
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return isValidUuid(normalized) ? normalized : null;
}

async function readCanonicalIdForAuthUser(authUserId: string) {
  const result = await executeTurso({
    sql: `SELECT canonical_anon_user_id
          FROM auth_identity_links
          WHERE auth_user_id = ?
          LIMIT 1`,
    args: [authUserId],
  });

  const value = result.rows[0]?.canonical_anon_user_id;
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return isValidUuid(normalized) ? normalized : null;
}

async function readAuthUserIdsForCanonical(canonicalAnonUserId: string) {
  const result = await executeTurso({
    sql: `SELECT auth_user_id
          FROM auth_identity_links
          WHERE canonical_anon_user_id = ?`,
    args: [canonicalAnonUserId],
  });

  return result.rows
    .map((row) => (typeof row.auth_user_id === "string" ? row.auth_user_id.trim() : ""))
    .filter((value) => value.length > 0);
}

async function belongsToDifferentAuthUser(canonicalAnonUserId: string, authUserId: string) {
  const ownerIds = await readAuthUserIdsForCanonical(canonicalAnonUserId);
  return ownerIds.length > 0 && !ownerIds.includes(authUserId);
}

async function belongsToAnyAuthUser(canonicalAnonUserId: string) {
  const ownerIds = await readAuthUserIdsForCanonical(canonicalAnonUserId);
  return ownerIds.length > 0;
}

async function upsertCanonicalIdForDevice(deviceKey: string, canonicalAnonUserId: string) {
  await executeTurso({
    sql: `INSERT INTO mobile_identity_links (
            device_key,
            canonical_anon_user_id,
            updated_at
          ) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(device_key) DO UPDATE SET
            canonical_anon_user_id = excluded.canonical_anon_user_id,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [deviceKey, canonicalAnonUserId],
  });
}

async function upsertCanonicalIdForAuthUser(authUserId: string, canonicalAnonUserId: string) {
  await executeTurso({
    sql: `INSERT INTO auth_identity_links (
            auth_user_id,
            canonical_anon_user_id,
            updated_at
          ) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(auth_user_id) DO UPDATE SET
            canonical_anon_user_id = excluded.canonical_anon_user_id,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [authUserId, canonicalAnonUserId],
  });
}

async function readAliasForAnonId(anonUserId: string) {
  const result = await executeTurso({
    sql: `SELECT canonical_anon_user_id
          FROM mobile_identity_aliases
          WHERE anon_user_id = ?
          LIMIT 1`,
    args: [anonUserId],
  });

  const value = result.rows[0]?.canonical_anon_user_id;
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return isValidUuid(normalized) ? normalized : null;
}

async function upsertAliasForAnonId(anonUserId: string, canonicalAnonUserId: string) {
  await executeTurso({
    sql: `INSERT INTO mobile_identity_aliases (
            anon_user_id,
            canonical_anon_user_id,
            updated_at
          ) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(anon_user_id) DO UPDATE SET
            canonical_anon_user_id = excluded.canonical_anon_user_id,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [anonUserId, canonicalAnonUserId],
  });
}

async function resolveAliasCanonicalId(anonUserId: string) {
  let current = anonUserId;
  const visited = new Set<string>([anonUserId]);

  for (let index = 0; index < 6; index += 1) {
    const next = await readAliasForAnonId(current);
    if (!next || next === current) {
      return current;
    }

    if (visited.has(next)) {
      return current;
    }

    visited.add(next);
    current = next;
  }

  return current;
}

async function getCookbookRecordCount(anonUserId: string) {
  const result = await executeTurso({
    sql: `SELECT COUNT(*) AS count
          FROM cookbook_recipes
          WHERE anon_user_id = ?`,
    args: [anonUserId],
  });

  const value = result.rows[0]?.count;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function pickCanonicalAnonId(candidateIds: string[], preferredId: string | null) {
  if (candidateIds.length === 1) {
    return candidateIds[0];
  }

  const counts = new Map<string, number>();
  for (const candidateId of candidateIds) {
    counts.set(candidateId, await getCookbookRecordCount(candidateId));
  }

  const sorted = [...candidateIds].sort((left, right) => {
    const leftCount = counts.get(left) ?? 0;
    const rightCount = counts.get(right) ?? 0;
    if (rightCount !== leftCount) {
      return rightCount - leftCount;
    }

    if (preferredId && left === preferredId) {
      return -1;
    }
    if (preferredId && right === preferredId) {
      return 1;
    }

    return left.localeCompare(right);
  });

  return sorted[0];
}

async function filterCandidatesForAuthUser(candidateIds: string[], authUserId: string) {
  const safeCandidates: string[] = [];
  for (const candidateId of candidateIds) {
    if (await belongsToDifferentAuthUser(candidateId, authUserId)) {
      continue;
    }
    safeCandidates.push(candidateId);
  }
  return safeCandidates;
}

async function filterCandidatesForSignedOutUser(candidateIds: string[]) {
  const safeCandidates: string[] = [];
  for (const candidateId of candidateIds) {
    if (await belongsToAnyAuthUser(candidateId)) {
      continue;
    }
    safeCandidates.push(candidateId);
  }
  return safeCandidates;
}

function logIdentityResolutionFailure(
  error: ReturnType<typeof asIdentityResolutionError>,
  requestId: string | undefined,
) {
  const safeRequestId = requestId?.trim().slice(0, 128);
  const cause = error.cause;
  console.warn(
    "[cookbook-identity]",
    JSON.stringify({
      event: "identity_resolution_failed",
      stage: error.stage,
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
      errorName: cause instanceof Error ? cause.name : "unknown",
    }),
  );
}

export async function resolveCookbookIdentity(
  request: NextRequest,
  context: CookbookIdentityResolutionContext,
): Promise<CookbookIdentity> {
  try {
    const rawDeviceKey = request.headers.get(MOBILE_DEVICE_KEY_HEADER)?.trim();
    const deviceKey = isValidUuid(rawDeviceKey) ? rawDeviceKey : null;
    return await resolveCookbookIdentityCore(
      {
        authUserId: context.authUserId,
        deviceKey,
      },
      {
        getBaseIdentity: () => getAnonymousIdentity(request),
        ensureSchema: ensureIdentitySchema,
        readCanonicalIdForDevice,
        readCanonicalIdForAuthUser,
        resolveAliasCanonicalId,
        filterCandidatesForAuthUser,
        filterCandidatesForSignedOutUser,
        pickCanonicalAnonId,
        mergeCookbookAnonymousUsers,
        upsertAliasForAnonId,
        upsertCanonicalIdForDevice,
        upsertCanonicalIdForAuthUser,
        createAnonymousId: randomUUID,
      },
    );
  } catch (error) {
    const resolutionError = asIdentityResolutionError(error);
    logIdentityResolutionFailure(resolutionError, context.requestId);
    throw resolutionError;
  }
}

export async function resolveCookbookIdentityForProductRequest(
  request: NextRequest,
  context: CookbookIdentityResolutionContext,
) {
  return failClosedIdentityResolution(() =>
    resolveCookbookIdentity(request, context),
  );
}
