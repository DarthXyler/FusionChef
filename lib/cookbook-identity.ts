import type { NextRequest } from "next/server";
import { getAnonymousIdentity } from "@/lib/anon-user";
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

export async function resolveCookbookIdentity(request: NextRequest): Promise<CookbookIdentity> {
  const baseIdentity = getAnonymousIdentity(request);
  const rawDeviceKey = request.headers.get(MOBILE_DEVICE_KEY_HEADER)?.trim();
  if (!isValidUuid(rawDeviceKey)) {
    return baseIdentity;
  }

  try {
    await ensureIdentitySchema();
    const linkedCanonical = await readCanonicalIdForDevice(rawDeviceKey);

    const canonicalAnonUserId = linkedCanonical ?? baseIdentity.anonUserId;
    if (linkedCanonical && linkedCanonical !== baseIdentity.anonUserId) {
      await mergeCookbookAnonymousUsers(baseIdentity.anonUserId, linkedCanonical);
    }

    await upsertCanonicalIdForDevice(rawDeviceKey, canonicalAnonUserId);
    return {
      anonUserId: canonicalAnonUserId,
      shouldSetCookie: baseIdentity.shouldSetCookie,
    };
  } catch {
    return baseIdentity;
  }
}
