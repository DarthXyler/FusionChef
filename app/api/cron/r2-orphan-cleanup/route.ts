/**
 * /api/cron/r2-orphan-cleanup
 * Scheduled cleanup endpoint for Vercel Cron (or internal token fallback).
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, requireInternalToken } from "@/lib/api-security";
import { runR2OrphanCleanup } from "@/lib/r2-orphan-cleanup";

const DEFAULT_MAX_AGE_MINUTES = 180;
const DEFAULT_MAX_DELETES = 200;

function parsePositiveInt(value: string | null, fallback: number) {
  // Parses positive integer query params with fallback.
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function requireCronAccess(request: NextRequest) {
  // Allows Vercel Cron calls and optional secret validation.
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = request.headers.has("x-vercel-cron");

  if (isVercelCron) {
    if (!cronSecret) {
      return null;
    }
    const providedSecret = request.nextUrl.searchParams.get("secret");
    if (providedSecret !== cronSecret) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return null;
  }

  return requireInternalToken(request);
}

export async function GET(request: NextRequest) {
  // Runs periodic orphan cleanup with conservative defaults.
  const accessFailure = requireCronAccess(request);
  if (accessFailure) {
    return accessFailure;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-cron-r2-orphan-cleanup",
    limit: 12,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const maxAgeMinutes = parsePositiveInt(
    request.nextUrl.searchParams.get("maxAgeMinutes"),
    DEFAULT_MAX_AGE_MINUTES,
  );
  const maxDeletes = parsePositiveInt(
    request.nextUrl.searchParams.get("maxDeletes"),
    DEFAULT_MAX_DELETES,
  );

  try {
    const result = await runR2OrphanCleanup({
      maxAgeMinutes,
      maxDeletes,
    });
    return NextResponse.json({
      ok: true,
      source: "cron",
      maxAgeMinutes,
      maxDeletes,
      ...result,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not complete scheduled orphan cleanup." },
      { status: 502 },
    );
  }
}

