/**
 * /api/r2-health
 * Internal-only endpoint to verify R2 write/delete permissions.
 */
import { NextResponse } from "next/server";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { enforceRateLimit, requireInternalToken } from "@/lib/api-security";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

function getR2Client() {
  // Shared R2 client creation (S3-compatible).
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

export async function GET(request: Request) {
  // Only internal callers with token can use this diagnostic route.
  const tokenFailure = requireInternalToken(request);
  if (tokenFailure) {
    return tokenFailure;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-r2-health",
    limit: 5,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  if (!R2_BUCKET) {
    return NextResponse.json({ ok: false, error: "R2_BUCKET missing." }, { status: 500 });
  }

  const client = getR2Client();
  if (!client) {
    return NextResponse.json({ ok: false, error: "R2 credentials missing." }, { status: 500 });
  }

  const key = `healthchecks/${randomUUID()}.txt`;
  try {
    // Write tiny object to prove upload access.
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: "ok",
        ContentType: "text/plain",
      }),
    );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "R2 write failed." }, { status: 502 });
  } finally {
    try {
      // Best-effort delete to avoid leaving test files behind.
      await client.send(
        new DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
        }),
      );
    } catch {
      // Best-effort cleanup only.
    }
  }
}

