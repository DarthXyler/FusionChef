/**
 * /api/admin/monetization/transactions
 * Admin-only credit ledger operations and account inspection endpoint.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import {
  commitReservedCredits,
  getCreditAccountSnapshot,
  grantCredits,
  releaseReservedCredits,
  reserveCredits,
  type MonetizationActionKind,
} from "@/lib/monetization-ledger";
import { listRecentPurchasesForUser } from "@/lib/monetization-purchases";
import {
  getTodayDailyMonetizationUsage,
  listDailyMonetizationUsage,
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 30_000;

class RequestValidationError extends Error {}

type GrantPayload = {
  action: "grant";
  anonUserId: string;
  amount: number;
  reason?: string;
  metadata?: Record<string, unknown>;
};

type ReservePayload = {
  action: "reserve";
  anonUserId: string;
  amount: number;
  actionKind: MonetizationActionKind;
  reason?: string;
  expiresAt?: string | null;
  reservationId?: string;
  metadata?: Record<string, unknown>;
};

type FinalizePayload = {
  action: "commit" | "release";
  anonUserId: string;
  reservationId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

type TransactionPayload = GrantPayload | ReservePayload | FinalizePayload;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUuid(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  return UUID_PATTERN.test(normalized) ? normalized : "";
}

function parseOptionalReason(value: unknown) {
  if (typeof value === "undefined") {
    return "";
  }
  if (typeof value !== "string") {
    throw new RequestValidationError("reason must be a string.");
  }
  return value.trim().slice(0, 500);
}

function parseOptionalMetadata(value: unknown) {
  if (typeof value === "undefined") {
    return {};
  }
  if (!isObjectRecord(value)) {
    throw new RequestValidationError("metadata must be an object.");
  }
  return value;
}

function parsePositiveInteger(value: unknown, fieldName: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${fieldName} must be a number.`);
  }
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    throw new RequestValidationError(`${fieldName} must be >= 1.`);
  }
  return normalized;
}

function parseTransactionPayload(body: unknown): TransactionPayload {
  if (!isObjectRecord(body)) {
    throw new RequestValidationError("Invalid request body.");
  }

  const action =
    body.action === "grant" ||
    body.action === "reserve" ||
    body.action === "commit" ||
    body.action === "release"
      ? body.action
      : "";
  if (!action) {
    throw new RequestValidationError("action must be grant, reserve, commit, or release.");
  }

  const anonUserId = normalizeUuid(body.anonUserId);
  if (!anonUserId) {
    throw new RequestValidationError("anonUserId must be a valid UUID.");
  }

  if (action === "grant") {
    return {
      action,
      anonUserId,
      amount: parsePositiveInteger(body.amount, "amount"),
      reason: parseOptionalReason(body.reason),
      metadata: parseOptionalMetadata(body.metadata),
    };
  }

  if (action === "reserve") {
    const actionKind = body.actionKind === "reroll" ? "reroll" : body.actionKind === "fuse" ? "fuse" : "";
    if (!actionKind) {
      throw new RequestValidationError("actionKind must be fuse or reroll.");
    }

    const expiresAt =
      typeof body.expiresAt === "undefined" || body.expiresAt === null
        ? null
        : typeof body.expiresAt === "string"
          ? body.expiresAt.trim()
          : (() => {
              throw new RequestValidationError("expiresAt must be a string or null.");
            })();

    const reservationId =
      typeof body.reservationId === "undefined"
        ? ""
        : normalizeUuid(body.reservationId);
    if (typeof body.reservationId !== "undefined" && !reservationId) {
      throw new RequestValidationError("reservationId must be a valid UUID when provided.");
    }

    return {
      action,
      anonUserId,
      amount: parsePositiveInteger(body.amount, "amount"),
      actionKind,
      reason: parseOptionalReason(body.reason),
      expiresAt,
      reservationId,
      metadata: parseOptionalMetadata(body.metadata),
    };
  }

  const reservationId = normalizeUuid(body.reservationId);
  if (!reservationId) {
    throw new RequestValidationError("reservationId must be a valid UUID.");
  }

  return {
    action,
    anonUserId,
    reservationId,
    reason: parseOptionalReason(body.reason),
    metadata: parseOptionalMetadata(body.metadata),
  };
}

export async function GET(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-transactions-read",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const anonUserId = normalizeUuid(request.nextUrl.searchParams.get("anonUserId"));
  if (!anonUserId) {
    return NextResponse.json({ error: "anonUserId is required." }, { status: 400 });
  }

  const reservationsLimit = Number.parseInt(
    request.nextUrl.searchParams.get("reservationsLimit") ?? "50",
    10,
  );
  const ledgerLimit = Number.parseInt(
    request.nextUrl.searchParams.get("ledgerLimit") ?? "50",
    10,
  );

  try {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "transactions_read_started",
      actor: admin.context.actor,
      ip: admin.context.ip,
      anonUserId,
    });

    const [snapshot, dailyUsage, todayUsage, purchases] = await Promise.all([
      getCreditAccountSnapshot(anonUserId, {
        reservationsLimit: Number.isFinite(reservationsLimit) ? reservationsLimit : 50,
        ledgerLimit: Number.isFinite(ledgerLimit) ? ledgerLimit : 50,
      }),
      listDailyMonetizationUsage(anonUserId, 30),
      getTodayDailyMonetizationUsage(anonUserId),
      listRecentPurchasesForUser(anonUserId, 30),
    ]);
    const response = NextResponse.json({
      ...snapshot,
      todayUsage,
      dailyUsage,
      purchases,
    });
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "transactions_read_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
      anonUserId,
    });

    return response;
  } catch {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "transactions_read_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      anonUserId,
    });
    return NextResponse.json({ error: "Could not load credit account." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const admin = requireMonetizationAdmin(request, { requireActor: true });
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-transactions-write",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let idempotencyContext: IdempotencyContext | null = null;
  try {
    if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const idempotencyKey = getIdempotencyKeyFromHeaders(request.headers);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "idempotency-key header is required." }, { status: 400 });
    }

    const payload = parseTransactionPayload((await request.json()) as unknown);
    const idempotency = await beginIdempotentRequest({
      key: idempotencyKey,
      scope: `admin-monetization-transactions:${payload.action}:${payload.anonUserId}`,
      requestPayload: {
        actor: admin.context.actor,
        payload,
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

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "transaction_started",
      actor: admin.context.actor,
      ip: admin.context.ip,
      action: payload.action,
      anonUserId: payload.anonUserId,
    });

    if (payload.action === "grant") {
      const result = await grantCredits({
        anonUserId: payload.anonUserId,
        amount: payload.amount,
        actor: admin.context.actor,
        reason: payload.reason,
        idempotencyScope: idempotencyContext?.scope ?? null,
        idempotencyKey: idempotencyContext?.key ?? null,
        metadata: payload.metadata,
      });
      const responseBody = {
        action: payload.action,
        balance: result.balance,
        ledgerEntry: result.ledgerEntry,
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
        event: "transaction_succeeded",
        actor: admin.context.actor,
        ip: admin.context.ip,
        action: payload.action,
        anonUserId: payload.anonUserId,
      });
      return response;
    }

    if (payload.action === "reserve") {
      const result = await reserveCredits({
        anonUserId: payload.anonUserId,
        amount: payload.amount,
        actionKind: payload.actionKind,
        reason: payload.reason,
        expiresAt: payload.expiresAt ?? null,
        actor: admin.context.actor,
        reservationId: payload.reservationId || undefined,
        idempotencyScope: idempotencyContext?.scope ?? null,
        idempotencyKey: idempotencyContext?.key ?? null,
        metadata: payload.metadata,
      });

      if (!result.ok) {
        const responseBody = { error: "Insufficient credits.", reason: result.reason };
        if (idempotencyContext) {
          await completeIdempotentRequest(idempotencyContext, 409, responseBody);
        }
        const response = NextResponse.json(responseBody, { status: 409 });
        if (idempotencyContext) {
          response.headers.set("Idempotency-Status", "stored");
        }
        withNoStore(response);
        return response;
      }

      const responseBody = {
        action: payload.action,
        balance: result.balance,
        reservation: result.reservation,
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
        event: "transaction_succeeded",
        actor: admin.context.actor,
        ip: admin.context.ip,
        action: payload.action,
        anonUserId: payload.anonUserId,
      });
      return response;
    }

    if (payload.action === "commit") {
      const result = await commitReservedCredits({
        anonUserId: payload.anonUserId,
        reservationId: payload.reservationId,
        reason: payload.reason,
        actor: admin.context.actor,
        idempotencyScope: idempotencyContext?.scope ?? null,
        idempotencyKey: idempotencyContext?.key ?? null,
        metadata: payload.metadata,
      });

      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 409;
        const responseBody = { error: "Could not finalize reservation.", reason: result.reason };
        if (idempotencyContext) {
          await completeIdempotentRequest(idempotencyContext, status, responseBody);
        }
        const response = NextResponse.json(responseBody, { status });
        if (idempotencyContext) {
          response.headers.set("Idempotency-Status", "stored");
        }
        withNoStore(response);
        return response;
      }

      const responseBody = {
        action: payload.action,
        balance: result.balance,
        reservation: result.reservation,
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
        event: "transaction_succeeded",
        actor: admin.context.actor,
        ip: admin.context.ip,
        action: payload.action,
        anonUserId: payload.anonUserId,
      });
      return response;
    }

    const result = await releaseReservedCredits({
      anonUserId: payload.anonUserId,
      reservationId: payload.reservationId,
      reason: payload.reason,
      actor: admin.context.actor,
      idempotencyScope: idempotencyContext?.scope ?? null,
      idempotencyKey: idempotencyContext?.key ?? null,
      metadata: payload.metadata,
    });

    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409;
      const responseBody = { error: "Could not finalize reservation.", reason: result.reason };
      if (idempotencyContext) {
        await completeIdempotentRequest(idempotencyContext, status, responseBody);
      }
      const response = NextResponse.json(responseBody, { status });
      if (idempotencyContext) {
        response.headers.set("Idempotency-Status", "stored");
      }
      withNoStore(response);
      return response;
    }

    const responseBody = {
      action: payload.action,
      balance: result.balance,
      reservation: result.reservation,
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
      event: "transaction_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
      action: payload.action,
      anonUserId: payload.anonUserId,
    });

    return response;
  } catch (error) {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    const isValidationError = error instanceof RequestValidationError;
    const message = error instanceof Error ? error.message : "Could not complete transaction.";
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "transaction_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      reason: message,
    });
    return NextResponse.json(
      { error: isValidationError ? message : "Could not complete transaction." },
      { status: isValidationError ? 400 : 500 },
    );
  }
}
