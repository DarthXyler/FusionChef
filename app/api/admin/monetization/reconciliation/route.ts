/**
 * /api/admin/monetization/reconciliation
 * Admin-only preview/run endpoint for releasing expired credit reservations.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import {
  getExpiredReservationPreview,
  reconcileExpiredReservations,
} from "@/lib/monetization-operations";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";
import {
  beginIdempotentRequest,
  clearIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKeyFromHeaders,
  type IdempotencyContext,
} from "@/lib/idempotency";

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

export async function GET(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-reconciliation-read",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const previewLimit = parsePositiveInt(
    request.nextUrl.searchParams.get("previewLimit"),
    25,
    500,
  );

  try {
    const preview = await getExpiredReservationPreview(previewLimit);
    const response = NextResponse.json({
      preview,
      expiredCount: preview.length,
    });
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "reconciliation_preview_read",
      actor: admin.context.actor,
      ip: admin.context.ip,
      previewCount: preview.length,
    });

    return response;
  } catch {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "reconciliation_preview_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
    });
    return NextResponse.json({ error: "Could not load reconciliation preview." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = requireMonetizationAdmin(request, { requireActor: true });
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-reconciliation-write",
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
  if (!idempotencyKey) {
    return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
  }

  let idempotencyContext: IdempotencyContext | null = null;
  try {
    const maxCandidates = parsePositiveInt(
      request.nextUrl.searchParams.get("maxCandidates"),
      200,
      1000,
    );

    const idempotency = await beginIdempotentRequest({
      key: idempotencyKey,
      scope: "admin-monetization-reconciliation:run",
      requestPayload: {
        actor: admin.context.actor,
        maxCandidates,
      },
    });

    if (idempotency.state === "in_progress") {
      return NextResponse.json(
        { error: "This request is already being processed. Please retry shortly." },
        { status: 409, headers: { "Idempotency-Status": "in-progress" } },
      );
    }

    if (idempotency.state === "conflict") {
      return NextResponse.json(
        { error: "Idempotency key was reused with a different payload." },
        { status: 409, headers: { "Idempotency-Status": "conflict" } },
      );
    }

    if (idempotency.state === "replay") {
      const response = NextResponse.json(
        idempotency.responseBody,
        { status: idempotency.responseStatus },
      );
      response.headers.set("Idempotency-Status", "replayed");
      withNoStore(response);
      return response;
    }

    if (idempotency.state === "started") {
      idempotencyContext = idempotency.context;
    }

    const summary = await reconcileExpiredReservations({
      maxCandidates,
      actor: `admin:${admin.context.actor}`,
    });
    const responseBody = {
      ok: true,
      maxCandidates,
      summary,
    };

    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }

    const response = NextResponse.json(responseBody);
    if (idempotencyContext) {
      response.headers.set("Idempotency-Status", "stored");
    }
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "reconciliation_run_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
      maxCandidates,
      ...summary,
    });

    return response;
  } catch {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "reconciliation_run_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
    });
    return NextResponse.json({ error: "Could not run reconciliation." }, { status: 500 });
  }
}
