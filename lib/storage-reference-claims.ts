import { getR2ObjectKeyFromPublicUrl } from "./r2-storage.ts";
import type { Client } from "@libsql/client";
import { getTursoClient } from "./turso.ts";

export class StorageReferenceClaimError extends Error {
  code = "storage_reference_unavailable";
  statusCode = 409;

  constructor() {
    super("This image is being removed. Upload it again before retrying.");
  }
}

export function getPersistedStorageReferenceKey(
  value: string | null | undefined,
  publicBaseUrl = process.env.R2_PUBLIC_BASE_URL ?? "",
) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized
    ? getR2ObjectKeyFromPublicUrl(normalized, publicBaseUrl)
    : null;
}

export function getStorageReferenceWriteGuard(objectKey: string) {
  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM account_deletion_storage_outbox storage_claim
      WHERE storage_claim.object_key = ?
        AND storage_claim.status IN (
          'processing', 'completed', 'failed_retryable'
        )
    )`,
    args: [objectKey],
  };
}

export async function listStorageKeysOwnedByDeletionOutbox(
  options: { client?: Pick<Client, "execute"> } = {},
) {
  const client = options.client ?? getTursoClient();
  const result = await client.execute(
    `SELECT DISTINCT object_key
     FROM account_deletion_storage_outbox
     WHERE status IN (
       'pending', 'processing', 'completed', 'failed_retryable'
     )`,
  );
  return result.rows
    .map((row) =>
      typeof row.object_key === "string" ? row.object_key.trim() : "",
    )
    .filter(Boolean);
}
