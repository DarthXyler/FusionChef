/**
 * Shared Cloudflare R2 helpers.
 * Contains URL-to-object-key mapping and delete helper used by API routes.
 */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

export function getR2StorageClient() {
  // Creates S3-compatible client for R2.
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

export function getR2ObjectKeyFromPublicUrl(imageUrl: string) {
  // Ensures only this app's R2 public URLs are accepted.
  if (!R2_PUBLIC_BASE_URL) {
    return null;
  }

  const baseUrl = R2_PUBLIC_BASE_URL.replace(/\/$/, "");
  if (!imageUrl.startsWith(`${baseUrl}/`)) {
    return null;
  }

  const rawKey = imageUrl.slice(baseUrl.length + 1).split(/[?#]/)[0] ?? "";
  const key = decodeURIComponent(rawKey).trim();
  return key.length > 0 ? key : null;
}

export async function deleteR2ImageByPublicUrl(imageUrl: string) {
  // Converts public URL to key and removes object from R2 bucket.
  if (!R2_BUCKET) {
    throw new Error("R2 bucket config missing.");
  }

  const client = getR2StorageClient();
  if (!client) {
    throw new Error("R2 credentials missing.");
  }

  const key = getR2ObjectKeyFromPublicUrl(imageUrl);
  if (!key) {
    throw new Error("Image URL is not a valid R2 URL for this app.");
  }

  await client.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }),
  );
}
