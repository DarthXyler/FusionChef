import { createClient } from "@libsql/client";

const SAMPLE_LIMIT = 5;
const PREFIXES = {
  fusionImages: "fusion-images/",
  recipeImages: "recipe-images/",
  profilePhotos: "profile-photos/",
};

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

function makeAuditBuckets() {
  return {
    blank: makeBucket(),
    dataImage: makeBucket(),
    fusionImages: makeBucket(),
    recipeImages: makeBucket(),
    profilePhotos: makeBucket(),
    unknownR2Prefix: makeBucket(),
    externalOrUnknown: makeBucket(),
  };
}

function getPathFromUrl(value) {
  try {
    return new URL(value).pathname.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function startsWithConfiguredR2Base(value, r2PublicBaseUrl) {
  if (!r2PublicBaseUrl) {
    return false;
  }
  const normalizedBase = r2PublicBaseUrl.replace(/\/+$/, "");
  return value === normalizedBase || value.startsWith(`${normalizedBase}/`);
}

function classifyImageValue(value, r2PublicBaseUrl) {
  const imageValue = typeof value === "string" ? value.trim() : "";
  if (!imageValue) {
    return "blank";
  }
  if (imageValue.startsWith("data:image/")) {
    return "dataImage";
  }

  const path = getPathFromUrl(imageValue);
  if (path.startsWith(PREFIXES.fusionImages)) {
    return "fusionImages";
  }
  if (path.startsWith(PREFIXES.recipeImages)) {
    return "recipeImages";
  }
  if (path.startsWith(PREFIXES.profilePhotos)) {
    return "profilePhotos";
  }
  if (startsWithConfiguredR2Base(imageValue, r2PublicBaseUrl)) {
    return "unknownR2Prefix";
  }
  return "externalOrUnknown";
}

function summarizeRows(rows, idField, imageField, r2PublicBaseUrl) {
  const buckets = makeAuditBuckets();
  for (const row of rows) {
    const bucketName = classifyImageValue(row[imageField], r2PublicBaseUrl);
    addSample(buckets[bucketName], row[idField]);
  }
  return {
    total: rows.length,
    buckets,
  };
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

function printAuditSection(title, audit, expectedPrefix) {
  const wrongPrefixLabels =
    expectedPrefix === "recipe-images/"
      ? {
          profilePhotos: "profile-photos/ wrong-prefix",
        }
      : {
          recipeImages: "recipe-images/ wrong-prefix",
        };

  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
  console.log(`Total rows: ${audit.total}`);
  printBucket("Null/blank", audit.buckets.blank);
  printBucket("data:image/...", audit.buckets.dataImage);
  printBucket("fusion-images/", audit.buckets.fusionImages);
  printBucket("recipe-images/", audit.buckets.recipeImages);
  printBucket("profile-photos/", audit.buckets.profilePhotos);
  printBucket("Unknown R2 prefix", audit.buckets.unknownR2Prefix);
  printBucket("External/unknown URL", audit.buckets.externalOrUnknown);

  console.log("");
  console.log("Sample IDs");
  console.log("----------");
  printSample("Null/blank", audit.buckets.blank);
  printSample("data:image/...", audit.buckets.dataImage);
  printSample("fusion-images/", audit.buckets.fusionImages);
  printSample("recipe-images/", audit.buckets.recipeImages);
  printSample("profile-photos/", audit.buckets.profilePhotos);
  printSample("Unknown R2 prefix", audit.buckets.unknownR2Prefix);
  printSample("External/unknown URL", audit.buckets.externalOrUnknown);

  const wrongPrefixKey = expectedPrefix === "recipe-images/" ? "profilePhotos" : "recipeImages";
  const wrongPrefixLabel =
    wrongPrefixLabels[wrongPrefixKey] ?? `${wrongPrefixKey} wrong-prefix`;
  if (audit.buckets[wrongPrefixKey].count > 0) {
    console.log(`${wrongPrefixLabel} samples: ${formatSamples(audit.buckets[wrongPrefixKey].samples)}`);
  }
}

function collectFindings(cookbookAudit, avatarAudit) {
  const findings = [];
  if (cookbookAudit.buckets.dataImage.count > 0) {
    findings.push(`${cookbookAudit.buckets.dataImage.count} cookbook image value(s) are data:image/...`);
  }
  if (avatarAudit.buckets.dataImage.count > 0) {
    findings.push(`${avatarAudit.buckets.dataImage.count} auth avatar value(s) are data:image/...`);
  }
  if (cookbookAudit.buckets.profilePhotos.count > 0) {
    findings.push(
      `${cookbookAudit.buckets.profilePhotos.count} cookbook image value(s) use profile-photos/.`,
    );
  }
  if (avatarAudit.buckets.recipeImages.count > 0) {
    findings.push(`${avatarAudit.buckets.recipeImages.count} auth avatar value(s) use recipe-images/.`);
  }
  if (cookbookAudit.buckets.fusionImages.count > 0) {
    findings.push(`${cookbookAudit.buckets.fusionImages.count} cookbook image value(s) use legacy fusion-images/.`);
  }
  if (avatarAudit.buckets.fusionImages.count > 0) {
    findings.push(`${avatarAudit.buckets.fusionImages.count} auth avatar value(s) use legacy fusion-images/.`);
  }
  if (cookbookAudit.buckets.unknownR2Prefix.count > 0) {
    findings.push(`${cookbookAudit.buckets.unknownR2Prefix.count} cookbook image value(s) use an unknown R2 prefix.`);
  }
  if (avatarAudit.buckets.unknownR2Prefix.count > 0) {
    findings.push(`${avatarAudit.buckets.unknownR2Prefix.count} auth avatar value(s) use an unknown R2 prefix.`);
  }
  return findings;
}

async function main() {
  const tursoUrl = normalizeEnv("TURSO_DATABASE_URL");
  const tursoAuthToken = normalizeEnv("TURSO_AUTH_TOKEN");
  const r2PublicBaseUrl = normalizeEnv("R2_PUBLIC_BASE_URL");

  console.log("============================================================");
  console.log("READ ONLY IMAGE STORAGE AUDIT");
  console.log("============================================================");
  console.log("No writes. No R2 mutations. SELECT queries only.");
  console.log("");

  if (!tursoUrl || !tursoAuthToken) {
    throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.");
  }

  const client = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken,
  });

  try {
    const [cookbookResult, avatarResult] = await Promise.all([
      client.execute({
        sql: `SELECT recipe_id, image_url
              FROM cookbook_recipes`,
      }),
      client.execute({
        sql: `SELECT id, avatar_url
              FROM auth_users`,
      }),
    ]);

    const cookbookAudit = summarizeRows(
      cookbookResult.rows,
      "recipe_id",
      "image_url",
      r2PublicBaseUrl,
    );
    const avatarAudit = summarizeRows(avatarResult.rows, "id", "avatar_url", r2PublicBaseUrl);

    console.log("Environment");
    console.log("-----------");
    console.log("Database: Turso");
    console.log(`R2 public base configured: ${r2PublicBaseUrl ? "yes" : "no"}`);

    printAuditSection("Cookbook Images", cookbookAudit, PREFIXES.recipeImages);
    printAuditSection("Auth Avatars", avatarAudit, PREFIXES.profilePhotos);

    const findings = collectFindings(cookbookAudit, avatarAudit);
    console.log("");
    console.log("Summary");
    console.log("-------");
    if (findings.length === 0) {
      console.log("No image storage issues detected by this audit.");
    } else {
      for (const finding of findings) {
        console.log(`- ${finding}`);
      }
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("[audit-image-storage] Failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
