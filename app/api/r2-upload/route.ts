/**
 * /api/r2-upload
 * Accepts a base64 image data URL, optimizes it, and uploads to Cloudflare R2.
 */
import { NextResponse } from "next/server";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { enforceRateLimit, getClientIp, isRequestBodyTooLarge } from "@/lib/api-security";
import {
  beginIdempotentRequest,
  clearIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKeyFromHeaders,
  type IdempotencyContext,
} from "@/lib/idempotency";

type UploadRequest = {
  imageDataUrl: string;
  title: string;
};

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const MAX_UPLOAD_BODY_BYTES = 4_000_000;
const MAX_DATA_URL_LENGTH = 3_500_000;
const MAX_DECODED_IMAGE_BYTES = 2_800_000;
const MAX_TITLE_CHARS = 140;

function getR2Client() {
  // Builds the S3-compatible R2 client only when credentials are present.
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

function buildImageKey(title: string) {
  // Stable readable path + unique suffix to avoid collisions.
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
  return `fusion-images/${slug || "fusion-dish"}-${Date.now()}-${randomUUID().slice(0, 8)}.webp`;
}

function isUploadRequest(value: unknown): value is UploadRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.imageDataUrl === "string" &&
    candidate.imageDataUrl.startsWith("data:image/") &&
    typeof candidate.title === "string" &&
    candidate.title.trim().length > 0
  );
}

export async function POST(request: Request) {
  let idempotencyContext: IdempotencyContext | null = null;
  try {
    // Upload limits + request validation.
    const limited = await enforceRateLimit(request, {
      bucket: "api-r2-upload",
      limit: 20,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_UPLOAD_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const body = (await request.json()) as unknown;
    if (!isUploadRequest(body)) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    if (body.title.trim().length > MAX_TITLE_CHARS) {
      return NextResponse.json({ error: "Title is too long." }, { status: 400 });
    }
    if (body.imageDataUrl.length > MAX_DATA_URL_LENGTH) {
      return NextResponse.json({ error: "Image payload is too large." }, { status: 413 });
    }

    const idempotency = await beginIdempotentRequest({
      key: getIdempotencyKeyFromHeaders(request.headers),
      scope: `r2-upload:${getClientIp(request)}`,
      requestPayload: body,
    });
    if (idempotency.state === "in_progress") {
      return NextResponse.json(
        { error: "This upload is already being processed. Please wait and retry." },
        { status: 409, headers: { "Idempotency-Status": "in-progress" } },
      );
    }
    if (idempotency.state === "conflict") {
      return NextResponse.json(
        { error: "Idempotency key was reused with a different upload payload." },
        { status: 409, headers: { "Idempotency-Status": "conflict" } },
      );
    }
    if (idempotency.state === "replay") {
      return NextResponse.json(idempotency.responseBody, {
        status: idempotency.responseStatus,
        headers: { "Idempotency-Status": "replayed" },
      });
    }
    if (idempotency.state === "started") {
      idempotencyContext = idempotency.context;
    }

    if (!R2_BUCKET || !R2_PUBLIC_BASE_URL) {
      return NextResponse.json({ error: "R2 bucket config missing." }, { status: 500 });
    }

    const client = getR2Client();
    if (!client) {
      return NextResponse.json({ error: "R2 credentials missing." }, { status: 500 });
    }

    const base64 = body.imageDataUrl.split(",")[1];
    if (!base64) {
      return NextResponse.json({ error: "Invalid image payload." }, { status: 400 });
    }

    const decoded = Buffer.from(base64, "base64");
    if (decoded.length > MAX_DECODED_IMAGE_BYTES) {
      return NextResponse.json({ error: "Image is too large." }, { status: 413 });
    }
    // Re-encode as compact WebP to reduce storage and bandwidth cost.
    const optimized = await sharp(decoded)
      .resize(512, 512, { fit: "cover" })
      .webp({ quality: 60 })
      .toBuffer();

    const key = buildImageKey(body.title);
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: optimized,
        ContentType: "image/webp",
      }),
    );

    const responseBody = {
      imageUrl: `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`,
    };
    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }
    return NextResponse.json(responseBody, {
      headers: idempotencyContext ? { "Idempotency-Status": "stored" } : undefined,
    });
  } catch {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    return NextResponse.json({ error: "Image upload failed." }, { status: 502 });
  }
}

