import type { NextRequest } from "next/server";
import { getAnonymousIdentity } from "@/lib/anon-user";
import { getAuthSessionFromRequest } from "@/lib/auth-session";
import { mergeCookbookAnonymousUsers } from "@/lib/cookbook-db";
import { executeTurso } from "@/lib/turso";

const MOBILE_DEVICE_KEY_HEADER = "x-flavor-fusion-device-key";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CookbookIdentity = {
  anonUserId: string;
  shouldSetCookie: boolean;
};

let identitySchemaReady: Promise<void> | null = null;

function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

async function ensureIdentitySchema() {
  if (identitySchemaReady) {
    return identitySchemaReady;
  }

  identitySchemaReady = (async () => {
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
  })();

  return identitySchemaReady;
}

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

function uniqueValidIds(ids: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isValidUuid(id)) {
      continue;
    }
    seen.add(id.trim());
  }
  return [...seen];
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

export async function resolveCookbookIdentity(request: NextRequest): Promise<CookbookIdentity> {
  const baseIdentity = getAnonymousIdentity(request);
  const rawDeviceKey = request.headers.get(MOBILE_DEVICE_KEY_HEADER)?.trim();
  const deviceKey = isValidUuid(rawDeviceKey) ? rawDeviceKey : null;
  const authSession = getAuthSessionFromRequest(request);
  const authUserId = authSession?.userId?.trim() ?? "";
  if (!deviceKey && !authUserId) {
    return baseIdentity;
  }

  try {
    await ensureIdentitySchema();
    const linkedCanonical = deviceKey ? await readCanonicalIdForDevice(deviceKey) : null;
    const authCanonical = authUserId ? await readCanonicalIdForAuthUser(authUserId) : null;
    const aliasCanonical = await resolveAliasCanonicalId(baseIdentity.anonUserId);
    const candidateIds = uniqueValidIds([
      linkedCanonical,
      authCanonical,
      aliasCanonical,
      baseIdentity.anonUserId,
    ]);
    const canonicalAnonUserId = await pickCanonicalAnonId(
      candidateIds,
      authCanonical ?? linkedCanonical,
    );

    for (const candidateId of candidateIds) {
      if (candidateId === canonicalAnonUserId) {
        continue;
      }
      await mergeCookbookAnonymousUsers(candidateId, canonicalAnonUserId);
      await upsertAliasForAnonId(candidateId, canonicalAnonUserId);
    }

    await upsertAliasForAnonId(canonicalAnonUserId, canonicalAnonUserId);
    if (deviceKey) {
      await upsertCanonicalIdForDevice(deviceKey, canonicalAnonUserId);
    }
    if (authUserId) {
      await upsertCanonicalIdForAuthUser(authUserId, canonicalAnonUserId);
    }
    return {
      anonUserId: canonicalAnonUserId,
      shouldSetCookie: baseIdentity.shouldSetCookie,
    };
  } catch {
    return baseIdentity;
  }
}
