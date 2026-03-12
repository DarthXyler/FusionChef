/**
 * R2 orphan cleanup logic.
 * Scans objects, compares against DB-referenced image URLs, and deletes old unreferenced files.
 */
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { listCookbookImageUrls } from "@/lib/cookbook-db";
import { getR2ObjectKeyFromPublicUrl, getR2StorageClient } from "@/lib/r2-storage";

const DEFAULT_R2_IMAGE_PREFIX = "fusion-images/";

type R2OrphanCleanupOptions = {
  maxAgeMinutes: number;
  maxDeletes: number;
  prefix?: string;
};

export type R2OrphanCleanupResult = {
  scanned: number;
  referenced: number;
  orphanCandidates: number;
  skippedRecent: number;
  deleted: number;
  stoppedByDeleteLimit: boolean;
  errors: string[];
};

export async function runR2OrphanCleanup(
  options: R2OrphanCleanupOptions,
): Promise<R2OrphanCleanupResult> {
  // Validates required R2 configuration before scanning.
  const bucket = process.env.R2_BUCKET;
  const client = getR2StorageClient();

  if (!bucket) {
    throw new Error("R2_BUCKET missing.");
  }
  if (!client) {
    throw new Error("R2 credentials missing.");
  }

  const prefix = options.prefix?.trim() || DEFAULT_R2_IMAGE_PREFIX;
  const cutoff = Date.now() - options.maxAgeMinutes * 60_000;

  // Build lookup set of keys that are still referenced by cookbook entries.
  const imageUrls = await listCookbookImageUrls();
  const referencedKeys = new Set(
    imageUrls
      .map((imageUrl) => getR2ObjectKeyFromPublicUrl(imageUrl))
      .filter((key): key is string => typeof key === "string" && key.length > 0),
  );

  let continuationToken: string | undefined;
  let scanned = 0;
  let orphanCandidates = 0;
  let skippedRecent = 0;
  let deleted = 0;
  let stoppedByDeleteLimit = false;
  const errors: string[] = [];

  do {
    // Paginate through R2 object listing.
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    for (const object of page.Contents ?? []) {
      const key = typeof object.Key === "string" ? object.Key.trim() : "";
      if (!key) {
        continue;
      }

      scanned += 1;
      // Keep files still linked by DB records.
      if (referencedKeys.has(key)) {
        continue;
      }

      const lastModifiedMs = object.LastModified?.getTime();
      // Skip fresh uploads to avoid races with in-progress saves.
      if (typeof lastModifiedMs === "number" && lastModifiedMs > cutoff) {
        skippedRecent += 1;
        continue;
      }

      orphanCandidates += 1;
      if (deleted >= options.maxDeletes) {
        stoppedByDeleteLimit = true;
        continue;
      }

      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        deleted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown delete failure";
        errors.push(`${key}: ${message}`);
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (stoppedByDeleteLimit) {
      break;
    }
  } while (continuationToken);

  return {
    scanned,
    referenced: referencedKeys.size,
    orphanCandidates,
    skippedRecent,
    deleted,
    stoppedByDeleteLimit,
    errors,
  };
}
