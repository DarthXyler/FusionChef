/**
 * Shared Cloudflare R2 helpers.
 * Contains URL-to-object-key mapping and delete helper used by API routes.
 */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

export function getR2StorageClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  // Creates S3-compatible client for R2.
  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

export function isValidR2ObjectKey(key: string) {
  return (
    key.length >= 1 &&
    key.length <= 1024 &&
    key === key.trim() &&
    !key.startsWith("/") &&
    !key.includes("://") &&
    !key.includes("\0") &&
    key !== ".." &&
    !key.startsWith("../") &&
    !key.includes("/../") &&
    !key.endsWith("/..")
  );
}

export function getR2ObjectKeyFromPublicUrl(
  imageUrl: string,
  publicBaseUrl = process.env.R2_PUBLIC_BASE_URL ?? "",
) {
  // Ensures only this app's R2 public URLs are accepted.
  if (!publicBaseUrl) {
    return null;
  }

  const baseUrl = publicBaseUrl.replace(/\/$/, "");
  if (!imageUrl.startsWith(`${baseUrl}/`)) {
    return null;
  }

  const rawKey = imageUrl.slice(baseUrl.length + 1).split(/[?#]/)[0] ?? "";
  try {
    const key = decodeURIComponent(rawKey).trim();
    return isValidR2ObjectKey(key) ? key : null;
  } catch {
    return null;
  }
}

export async function deleteR2ObjectByKey(
  key: string,
  options: {
    bucket?: string;
    client?: Pick<S3Client, "send"> | null;
  } = {},
) {
  if (!isValidR2ObjectKey(key)) {
    throw new Error("R2 object key is invalid.");
  }
  const bucket = options.bucket ?? process.env.R2_BUCKET;
  if (!bucket) {
    throw new Error("R2 bucket config missing.");
  }
  const client = options.client ?? getR2StorageClient();
  if (!client) {
    throw new Error("R2 credentials missing.");
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function deleteR2ImageByPublicUrl(imageUrl: string) {
  // Converts public URL to key and removes object from R2 bucket.
  const key = getR2ObjectKeyFromPublicUrl(imageUrl);
  if (!key) {
    throw new Error("Image URL is not a valid R2 URL for this app.");
  }

  await deleteR2ObjectByKey(key);
}
