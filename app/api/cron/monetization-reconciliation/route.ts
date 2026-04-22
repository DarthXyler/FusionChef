/**
 * /api/cron/monetization-reconciliation
 * Scheduled release of expired credit reservations.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, requireInternalToken } from "@/lib/api-security";
import { reconcileExpiredReservations } from "@/lib/monetization-operations";

const DEFAULT_MAX_CANDIDATES = 300;

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function requireCronAccess(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = request.headers.has("x-vercel-cron");

  if (isVercelCron) {
    if (!cronSecret) {
      return null;
    }

    const authorization = request.headers.get("authorization") ?? "";
    const providedSecretFromHeader = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const providedSecretFromQuery = request.nextUrl.searchParams.get("secret") ?? "";
    if (providedSecretFromHeader !== cronSecret && providedSecretFromQuery !== cronSecret) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return null;
  }

  return requireInternalToken(request);
}

export async function GET(request: NextRequest) {
  const accessFailure = requireCronAccess(request);
  if (accessFailure) {
    return accessFailure;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-cron-monetization-reconciliation",
    limit: 12,
    windowMs: 60 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }

  const maxCandidates = parsePositiveInt(
    request.nextUrl.searchParams.get("maxCandidates"),
    DEFAULT_MAX_CANDIDATES,
    1000,
  );

  try {
    const summary = await reconcileExpiredReservations({
      maxCandidates,
      actor: "cron_reconciliation",
    });
    return NextResponse.json({
      ok: true,
      source: "cron",
      maxCandidates,
      summary,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not complete monetization reconciliation." },
      { status: 502 },
    );
  }
}
