import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

const SAMPLE_LIMIT = 5;
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 25;
const DEFAULT_LIMIT = 500;
const MAX_DECODED_IMAGE_BYTES = 2_800_000;
const TARGET_PREFIX = "recipe-images/";

function normalizeEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    execute: false,
    batchSize: DEFAULT_BATCH_SIZE,
    limit: DEFAULT_LIMIT,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (arg === "--batch-size") {
      const next = Number.parseInt(args[index + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) {
        parsed.batchSize = Math.min(next, MAX_BATCH_SIZE);
      }
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const next = Number.parseInt(args[index + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) {
        parsed.limit = next;
      }
      index += 1;
    }
  }

  return parsed;
}

function makeBucket() {
  return {
    count: 0,
    samples: [],
  };
}

function addSample(bucket, id) {
  bucket.count += 1;
  const normalized = typeof id === "string" ? id.trim() : "";
  if (normalized && bucket.samples.length < SAMPLE_LIMIT) {
    bucket.samples.push(normalized);
  }
}

function isDataImage(value) {
  return typeof value === "string" && value.trim().startsWith("data:image/");
}

function parseDataImage(value) {
  const imageValue = typeof value === "string" ? value.trim() : "";
  if (!imageValue.startsWith("data:image/")) {
    return {
      ok: false,
      reason: "not_data_image",
    };
  }

  const commaIndex = imageValue.indexOf(",");
  if (commaIndex < 0) {
    return {
      ok: false,
      reason: "invalid_data_url",
    };
  }

  const metadata = imageValue.slice(0, commaIndex).toLowerCase();
  const payload = imageValue.slice(commaIndex + 1).replace(/\s/g, "");
  if (!metadata.includes(";base64") || payload.length === 0) {
    return {
      ok: false,
      reason: "invalid_data_url",
    };
  }

  const mimeMatch = metadata.match(/^data:(image\/[a-z0-9.+-]+);/);
  const contentType = mimeMatch?.[1] ?? "";
  if (!contentType) {
    return {
      ok: false,
      reason: "missing_image_mime",
    };
  }

  if (!/^[a-z0-9+/]*={0,2}$/i.test(payload) || payload.length % 4 === 1) {
    return {
      ok: false,
      reason: "invalid_base64",
    };
  }

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  if (decodedBytes > MAX_DECODED_IMAGE_BYTES) {
    return {
      ok: false,
      reason: "oversized",
      decodedBytes,
    };
  }

  return {
    ok: true,
    contentType,
    decodedBytes,
    payload,
  };
}

function readRecipeJson(recipeJson) {
  if (typeof recipeJson !== "string" || recipeJson.trim().length === 0) {
    return {
      ok: false,
      reason: "blank_recipe_json",
    };
  }

  try {
    const parsed = JSON.parse(recipeJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: "invalid_recipe_json_shape",
      };
    }
    return {
      ok: true,
      parsed,
    };
  } catch {
    return {
      ok: false,
      reason: "recipe_json_parse_failed",
    };
  }
}

function makeObjectKey(recipeId, contentType) {
  const extension = contentType === "image/png"
    ? "png"
    : contentType === "image/gif"
      ? "gif"
      : contentType === "image/webp"
        ? "webp"
        : "jpg";
  const safeId = recipeId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
  return `${TARGET_PREFIX}${safeId || "recipe"}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
}

function publicUrlForKey(baseUrl, key) {
  return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

function buildCandidate(row) {
  const recipeId = typeof row.recipe_id === "string" ? row.recipe_id.trim() : "";
  const imageUrl = typeof row.image_url === "string" ? row.image_url.trim() : "";
  const recipeJsonRaw = typeof row.recipe_json === "string" ? row.recipe_json : "";
  const recipeJson = readRecipeJson(recipeJsonRaw);
  if (!recipeJson.ok) {
    return {
      ok: false,
      recipeId,
      reason: recipeJson.reason,
    };
  }

  const recipeJsonImageUrl =
    typeof recipeJson.parsed.imageUrl === "string" ? recipeJson.parsed.imageUrl.trim() : "";
  const imageUrlHasBase64 = isDataImage(imageUrl);
  const recipeJsonHasBase64 = isDataImage(recipeJsonImageUrl);
  if (!imageUrlHasBase64 && !recipeJsonHasBase64) {
    return {
      ok: false,
      recipeId,
      reason: "not_candidate",
    };
  }

  const location = imageUrlHasBase64 && recipeJsonHasBase64
    ? "both"
    : imageUrlHasBase64
      ? "image_url_only"
      : "recipe_json_imageUrl_only";
  const sourceDataUrl = imageUrlHasBase64 ? imageUrl : recipeJsonImageUrl;
  const source = parseDataImage(sourceDataUrl);
  if (!source.ok) {
    return {
      ok: false,
      recipeId,
      reason: source.reason,
      location,
      decodedBytes: source.decodedBytes ?? 0,
    };
  }

  return {
    ok: true,
    recipeId,
    location,
    decodedBytes: source.decodedBytes,
    contentType: source.contentType,
    payload: source.payload,
    originalImageUrl: imageUrl,
    originalRecipeJson: recipeJsonRaw,
    recipeJson: recipeJson.parsed,
  };
}

function formatSamples(samples) {
  return samples.length > 0 ? samples.join(", ") : "-";
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printSamples(label, bucket) {
  if (bucket.count > 0) {
    console.log(`${label}: ${formatSamples(bucket.samples)}`);
  }
}

async function uploadImage(client, bucket, publicBaseUrl, candidate) {
  const body = Buffer.from(candidate.payload, "base64");
  const key = makeObjectKey(candidate.recipeId, candidate.contentType);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: candidate.contentType,
    }),
  );
  return publicUrlForKey(publicBaseUrl, key);
}

async function guardedUpdateCookbookImage(client, candidate, nextImageUrl) {
  const nextRecipeJson = JSON.stringify({
    ...candidate.recipeJson,
    imageUrl: nextImageUrl,
  });
  const result = await client.execute({
    sql: `UPDATE cookbook_recipes
          SET image_url = ?,
              recipe_json = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE recipe_id = ?
            AND image_url = ?
            AND recipe_json = ?`,
    args: [
      nextImageUrl,
      nextRecipeJson,
      candidate.recipeId,
      candidate.originalImageUrl,
      candidate.originalRecipeJson,
    ],
  });
  return result.rowsAffected ?? 0;
}

function validateEnv(execute) {
  const env = {
    tursoUrl: normalizeEnv("TURSO_DATABASE_URL"),
    tursoAuthToken: normalizeEnv("TURSO_AUTH_TOKEN"),
    r2AccountId: normalizeEnv("R2_ACCOUNT_ID"),
    r2AccessKeyId: normalizeEnv("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: normalizeEnv("R2_SECRET_ACCESS_KEY"),
    r2Bucket: normalizeEnv("R2_BUCKET"),
    r2PublicBaseUrl: normalizeEnv("R2_PUBLIC_BASE_URL"),
  };

  if (!env.tursoUrl || !env.tursoAuthToken) {
    throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.");
  }
  if (
    execute &&
    (!env.r2AccountId ||
      !env.r2AccessKeyId ||
      !env.r2SecretAccessKey ||
      !env.r2Bucket ||
      !env.r2PublicBaseUrl)
  ) {
    throw new Error("Execute mode requires all R2 env vars.");
  }
  return env;
}

async function main() {
  const options = parseArgs();
  const env = validateEnv(options.execute);
  const mode = options.execute ? "EXECUTE" : "DRY RUN";

  console.log("============================================================");
  console.log("BASE64 COOKBOOK IMAGE MIGRATION");
  console.log("============================================================");
  console.log(`Mode: ${mode}`);
  console.log(
    options.execute
      ? "Uploads and guarded DB updates enabled. No R2 deletes."
      : "No DB writes. No R2 uploads/deletes.",
  );
  console.log("");

  const db = createClient({
    url: env.tursoUrl,
    authToken: env.tursoAuthToken,
  });
  const r2 = options.execute
    ? new S3Client({
        region: "auto",
        endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.r2AccessKeyId,
          secretAccessKey: env.r2SecretAccessKey,
        },
      })
    : null;

  try {
    const result = await db.execute({
      sql: `SELECT recipe_id, image_url, recipe_json
            FROM cookbook_recipes
            WHERE image_url LIKE 'data:image/%'
               OR recipe_json LIKE '%"imageUrl":"data:image/%'
               OR recipe_json LIKE '%"imageUrl": "data:image/%'
            LIMIT ?`,
      args: [options.limit],
    });

    const locationBuckets = {
      imageUrlOnly: makeBucket(),
      recipeJsonOnly: makeBucket(),
      both: makeBucket(),
      skipped: makeBucket(),
    };
    const skippedReasons = new Map();
    const candidates = [];
    let totalDecodedBytes = 0;
    let largestDecodedBytes = 0;

    for (const row of result.rows) {
      const candidate = buildCandidate(row);
      if (!candidate.ok) {
        if (candidate.reason !== "not_candidate") {
          addSample(locationBuckets.skipped, candidate.recipeId);
          increment(skippedReasons, candidate.reason);
        }
        continue;
      }

      candidates.push(candidate);
      totalDecodedBytes += candidate.decodedBytes;
      largestDecodedBytes = Math.max(largestDecodedBytes, candidate.decodedBytes);
      if (candidate.location === "both") {
        addSample(locationBuckets.both, candidate.recipeId);
      } else if (candidate.location === "image_url_only") {
        addSample(locationBuckets.imageUrlOnly, candidate.recipeId);
      } else {
        addSample(locationBuckets.recipeJsonOnly, candidate.recipeId);
      }
    }

    const batches = Math.ceil(candidates.length / options.batchSize);
    console.log("Plan");
    console.log("----");
    console.log(`Rows scanned: ${result.rows.length}`);
    console.log(`Candidates: ${candidates.length}`);
    console.log(`Candidate target prefix: ${TARGET_PREFIX}`);
    console.log(`Batch size: ${options.batchSize}`);
    console.log(`Planned batches: ${batches}`);
    console.log(`Total estimated decoded bytes: ${totalDecodedBytes}`);
    console.log(`Largest estimated decoded bytes: ${largestDecodedBytes}`);

    console.log("");
    console.log("Location Breakdown");
    console.log("------------------");
    console.log(`image_url only: ${locationBuckets.imageUrlOnly.count}`);
    console.log(`recipe_json.imageUrl only: ${locationBuckets.recipeJsonOnly.count}`);
    console.log(`both: ${locationBuckets.both.count}`);
    console.log(`invalid/skipped: ${locationBuckets.skipped.count}`);

    console.log("");
    console.log("Skipped Reasons");
    console.log("---------------");
    if (skippedReasons.size === 0) {
      console.log("-");
    } else {
      for (const [reason, count] of [...skippedReasons.entries()].sort()) {
        console.log(`${reason}: ${count}`);
      }
    }

    console.log("");
    console.log("Sample Recipe IDs");
    console.log("-----------------");
    printSamples("image_url only", locationBuckets.imageUrlOnly);
    printSamples("recipe_json.imageUrl only", locationBuckets.recipeJsonOnly);
    printSamples("both", locationBuckets.both);
    printSamples("invalid/skipped", locationBuckets.skipped);

    if (!options.execute) {
      console.log("");
      console.log("Dry run complete. Re-run with --execute only after approval.");
      return;
    }

    let uploaded = 0;
    let updated = 0;
    let guardedUpdateSkipped = 0;
    for (let start = 0; start < candidates.length; start += options.batchSize) {
      const batch = candidates.slice(start, start + options.batchSize);
      const batchNumber = Math.floor(start / options.batchSize) + 1;
      console.log("");
      console.log(`Batch ${batchNumber}/${batches}`);
      let batchUploaded = 0;
      let batchUpdated = 0;
      let batchSkipped = 0;

      for (const candidate of batch) {
        const nextImageUrl = await uploadImage(r2, env.r2Bucket, env.r2PublicBaseUrl, candidate);
        uploaded += 1;
        batchUploaded += 1;

        const rowsAffected = await guardedUpdateCookbookImage(db, candidate, nextImageUrl);
        if (rowsAffected === 1) {
          updated += 1;
          batchUpdated += 1;
        } else {
          guardedUpdateSkipped += 1;
          batchSkipped += 1;
        }
      }

      console.log(`Uploaded: ${batchUploaded}`);
      console.log(`Updated DB rows: ${batchUpdated}`);
      console.log(`Guarded update skipped: ${batchSkipped}`);
    }

    console.log("");
    console.log("Summary");
    console.log("-------");
    console.log(`Candidates: ${candidates.length}`);
    console.log(`Uploaded: ${uploaded}`);
    console.log(`Updated: ${updated}`);
    console.log(`Guarded update skipped: ${guardedUpdateSkipped}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(
    "[migrate-base64-cookbook-images-to-r2] Failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
