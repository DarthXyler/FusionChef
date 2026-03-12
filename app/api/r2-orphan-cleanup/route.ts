/**
 * /api/r2-orphan-cleanup
 * Internal maintenance endpoint to remove unreferenced images from R2.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, requireInternalToken } from "@/lib/api-security";
import { runR2OrphanCleanup } from "@/lib/r2-orphan-cleanup";

const DEFAULT_MAX_AGE_MINUTES = 180;
const MIN_MAX_AGE_MINUTES = 10;
const MAX_MAX_AGE_MINUTES = 10_080; // 7 days
const DEFAULT_MAX_DELETES = 200;
const MAX_MAX_DELETES = 2_000;

function parseBoundedInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  // Reads query params safely while enforcing allowed range.
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

async function handleCleanup(request: NextRequest) {
  // Restricted to internal token + low request rate.
  const tokenFailure = requireInternalToken(request);
  if (tokenFailure) {
    return tokenFailure;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-r2-orphan-cleanup",
    limit: 6,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const maxAgeMinutes = parseBoundedInt(
    request.nextUrl.searchParams.get("maxAgeMinutes"),
    DEFAULT_MAX_AGE_MINUTES,
    MIN_MAX_AGE_MINUTES,
    MAX_MAX_AGE_MINUTES,
  );
  const maxDeletes = parseBoundedInt(
    request.nextUrl.searchParams.get("maxDeletes"),
    DEFAULT_MAX_DELETES,
    1,
    MAX_MAX_DELETES,
  );

  try {
    // Core cleanup logic lives in lib/r2-orphan-cleanup.ts.
    const result = await runR2OrphanCleanup({
      maxAgeMinutes,
      maxDeletes,
    });

    return NextResponse.json({
      ok: true,
      maxAgeMinutes,
      maxDeletes,
      ...result,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not complete orphan cleanup." },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleCleanup(request);
}

export async function POST(request: NextRequest) {
  return handleCleanup(request);
}

