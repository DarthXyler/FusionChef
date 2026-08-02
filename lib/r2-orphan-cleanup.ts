/**
 * R2 orphan cleanup logic.
 * Scans objects, compares against DB-referenced image URLs, and deletes old unreferenced files.
 */
import { DeleteObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { listAuthUserAvatarUrls } from "@/lib/auth-users";
import { listCookbookImageUrls } from "@/lib/cookbook-db";
import { getR2ObjectKeyFromPublicUrl, getR2StorageClient } from "@/lib/r2-storage";
import { listStorageKeysOwnedByDeletionOutbox } from "@/lib/storage-reference-claims";

const DEFAULT_R2_IMAGE_PREFIXES = ["fusion-images/", "recipe-images/", "profile-photos/"];

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
  prefixes: string[];
  prefixStats: Record<
    string,
    {
      scanned: number;
      orphanCandidates: number;
      skippedRecent: number;
      deleted: number;
    }
  >;
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

  const prefixes = options.prefix?.trim()
    ? [options.prefix.trim()]
    : DEFAULT_R2_IMAGE_PREFIXES;
  const cutoff = Date.now() - options.maxAgeMinutes * 60_000;

  // Build lookup set of keys that are still referenced by cookbook entries or active profiles.
  const [cookbookImageUrls, authUserAvatarUrls, deletionOwnedKeys] = await Promise.all([
    listCookbookImageUrls(),
    listAuthUserAvatarUrls(),
    listStorageKeysOwnedByDeletionOutbox(),
  ]);
  const imageUrls = [...cookbookImageUrls, ...authUserAvatarUrls];
  const referencedKeys = new Set(
    imageUrls
      .map((imageUrl) => getR2ObjectKeyFromPublicUrl(imageUrl))
      .filter((key): key is string => typeof key === "string" && key.length > 0),
  );
  deletionOwnedKeys.forEach((key) => referencedKeys.add(key));

  let continuationToken: string | undefined;
  let scanned = 0;
  let orphanCandidates = 0;
  let skippedRecent = 0;
  let deleted = 0;
  let stoppedByDeleteLimit = false;
  const errors: string[] = [];
  const prefixStats: R2OrphanCleanupResult["prefixStats"] = {};

  for (const prefix of prefixes) {
    prefixStats[prefix] = {
      scanned: 0,
      orphanCandidates: 0,
      skippedRecent: 0,
      deleted: 0,
    };
    continuationToken = undefined;

    do {
      // Paginate through R2 object listing.
      const page: ListObjectsV2CommandOutput = await client.send(
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
        prefixStats[prefix].scanned += 1;
        // Keep files still linked by DB records.
        if (referencedKeys.has(key)) {
          continue;
        }

        const lastModifiedMs = object.LastModified?.getTime();
        // Skip fresh uploads to avoid races with in-progress saves.
        if (typeof lastModifiedMs === "number" && lastModifiedMs > cutoff) {
          skippedRecent += 1;
          prefixStats[prefix].skippedRecent += 1;
          continue;
        }

        orphanCandidates += 1;
        prefixStats[prefix].orphanCandidates += 1;
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
          prefixStats[prefix].deleted += 1;
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

    if (stoppedByDeleteLimit) {
      break;
    }
  }

  return {
    scanned,
    referenced: referencedKeys.size,
    orphanCandidates,
    skippedRecent,
    deleted,
    stoppedByDeleteLimit,
    prefixes,
    prefixStats,
    errors,
  };
}
