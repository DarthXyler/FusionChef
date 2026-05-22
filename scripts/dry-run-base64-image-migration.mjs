import { createClient } from "@libsql/client";

const SAMPLE_LIMIT = 5;
const MAX_DECODED_IMAGE_BYTES = 2_800_000;
const TARGET_PREFIX = "recipe-images/";

function normalizeEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
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

function estimateDecodedDataUrl(value) {
  const imageValue = typeof value === "string" ? value.trim() : "";
  if (!imageValue.startsWith("data:image/")) {
    return {
      valid: false,
      decodedBytes: 0,
      reason: "not_data_image",
    };
  }

  const commaIndex = imageValue.indexOf(",");
  if (commaIndex < 0) {
    return {
      valid: false,
      decodedBytes: 0,
      reason: "invalid_data_url",
    };
  }

  const metadata = imageValue.slice(0, commaIndex).toLowerCase();
  const payload = imageValue.slice(commaIndex + 1).replace(/\s/g, "");
  if (!metadata.includes(";base64") || payload.length === 0) {
    return {
      valid: false,
      decodedBytes: 0,
      reason: "invalid_data_url",
    };
  }

  if (!/^[a-z0-9+/]*={0,2}$/i.test(payload) || payload.length % 4 === 1) {
    return {
      valid: false,
      decodedBytes: 0,
      reason: "invalid_base64",
    };
  }

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  if (decodedBytes > MAX_DECODED_IMAGE_BYTES) {
    return {
      valid: false,
      decodedBytes,
      reason: "oversized",
    };
  }

  return {
    valid: true,
    decodedBytes,
    reason: "",
  };
}

function readRecipeJsonImageUrl(recipeJson) {
  if (typeof recipeJson !== "string" || recipeJson.trim().length === 0) {
    return {
      imageUrl: "",
      parseFailed: false,
    };
  }

  try {
    const parsed = JSON.parse(recipeJson);
    const imageUrl =
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof parsed.imageUrl === "string"
        ? parsed.imageUrl
        : "";
    return {
      imageUrl,
      parseFailed: false,
    };
  } catch {
    return {
      imageUrl: "",
      parseFailed: true,
    };
  }
}

function incrementReason(map, reason) {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

function formatSamples(samples) {
  return samples.length > 0 ? samples.join(", ") : "-";
}

function printBucket(label, bucket) {
  console.log(`${label}: ${bucket.count}`);
}

function printSample(label, bucket) {
  if (bucket.count > 0) {
    console.log(`${label}: ${formatSamples(bucket.samples)}`);
  }
}

async function main() {
  const tursoUrl = normalizeEnv("TURSO_DATABASE_URL");
  const tursoAuthToken = normalizeEnv("TURSO_AUTH_TOKEN");

  console.log("============================================================");
  console.log("DRY RUN BASE64 COOKBOOK IMAGE MIGRATION");
  console.log("============================================================");
  console.log("READ ONLY. No DB writes. No R2 uploads/deletes. SELECT queries only.");
  console.log("");

  if (!tursoUrl || !tursoAuthToken) {
    throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.");
  }

  const client = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken,
  });

  try {
    const result = await client.execute({
      sql: `SELECT recipe_id, image_url, recipe_json
            FROM cookbook_recipes`,
    });

    const buckets = {
      imageUrlOnly: makeBucket(),
      recipeJsonOnly: makeBucket(),
      both: makeBucket(),
      invalidOrSkipped: makeBucket(),
    };
    const skippedReasons = new Map();
    let affectedRows = 0;
    let validCandidates = 0;
    let totalDecodedBytes = 0;
    let largestDecodedBytes = 0;
    let oversizedCandidates = 0;
    let invalidCandidates = 0;

    for (const row of result.rows) {
      const recipeId = typeof row.recipe_id === "string" ? row.recipe_id.trim() : "";
      const imageUrl = typeof row.image_url === "string" ? row.image_url.trim() : "";
      const recipeJsonInfo = readRecipeJsonImageUrl(row.recipe_json);
      const recipeJsonImageUrl = recipeJsonInfo.imageUrl.trim();
      const imageUrlHasBase64 = isDataImage(imageUrl);
      const recipeJsonHasBase64 = isDataImage(recipeJsonImageUrl);

      if (!imageUrlHasBase64 && !recipeJsonHasBase64) {
        if (recipeJsonInfo.parseFailed) {
          incrementReason(skippedReasons, "recipe_json_parse_failed_without_base64_signal");
        }
        continue;
      }

      affectedRows += 1;
      if (imageUrlHasBase64 && recipeJsonHasBase64) {
        addSample(buckets.both, recipeId);
      } else if (imageUrlHasBase64) {
        addSample(buckets.imageUrlOnly, recipeId);
      } else {
        addSample(buckets.recipeJsonOnly, recipeId);
      }

      const estimates = [
        imageUrlHasBase64 ? estimateDecodedDataUrl(imageUrl) : null,
        recipeJsonHasBase64 ? estimateDecodedDataUrl(recipeJsonImageUrl) : null,
      ].filter(Boolean);

      let rowIsValid = true;
      for (const estimate of estimates) {
        if (!estimate.valid) {
          rowIsValid = false;
          if (estimate.reason === "oversized") {
            oversizedCandidates += 1;
          } else {
            invalidCandidates += 1;
          }
          incrementReason(skippedReasons, estimate.reason);
          continue;
        }
        totalDecodedBytes += estimate.decodedBytes;
        largestDecodedBytes = Math.max(largestDecodedBytes, estimate.decodedBytes);
      }

      if (rowIsValid) {
        validCandidates += 1;
      } else {
        addSample(buckets.invalidOrSkipped, recipeId);
      }
    }

    console.log("Overview");
    console.log("--------");
    console.log(`Rows scanned: ${result.rows.length}`);
    console.log(`Affected rows: ${affectedRows}`);
    console.log(`Candidate target prefix: ${TARGET_PREFIX}`);

    console.log("");
    console.log("Location Breakdown");
    console.log("------------------");
    printBucket("image_url only", buckets.imageUrlOnly);
    printBucket("recipe_json.imageUrl only", buckets.recipeJsonOnly);
    printBucket("both", buckets.both);

    console.log("");
    console.log("Decoded Size Estimate");
    console.log("---------------------");
    console.log(`Valid candidate rows: ${validCandidates}`);
    console.log(`Total estimated decoded bytes: ${totalDecodedBytes}`);
    console.log(`Largest estimated decoded bytes: ${largestDecodedBytes}`);
    console.log(`Oversized candidates: ${oversizedCandidates}`);
    console.log(`Invalid/skipped candidates: ${invalidCandidates}`);
    console.log(`Oversized threshold bytes: ${MAX_DECODED_IMAGE_BYTES}`);

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
    printSample("image_url only", buckets.imageUrlOnly);
    printSample("recipe_json.imageUrl only", buckets.recipeJsonOnly);
    printSample("both", buckets.both);
    printSample("invalid/skipped", buckets.invalidOrSkipped);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(
    "[dry-run-base64-image-migration] Failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
