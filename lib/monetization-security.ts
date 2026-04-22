/**
 * Monetization admin security helpers.
 * Keeps authentication, audit logging, and no-store response headers centralized.
 */
import { randomUUID, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-security";

const ADMIN_TOKEN_HEADER = "x-admin-token";
const ADMIN_ACTOR_HEADER = "x-admin-actor";

export type MonetizationAdminContext = {
  requestId: string;
  actor: string;
  ip: string;
};

function safeCompareToken(provided: string, expected: string) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function normalizeActor(actorHeader: string | null) {
  if (!actorHeader) {
    return "";
  }
  return actorHeader.trim().slice(0, 120);
}

export function logMonetizationAudit(event: Record<string, unknown>) {
  console.info("[api/admin/monetization]", JSON.stringify(event));
}

export function withNoStore(response: NextResponse) {
  // Admin config should never be cached by browser/CDN.
  response.headers.set("Cache-Control", "no-store");
}

export function requireMonetizationAdmin(
  request: NextRequest,
  options?: { requireActor?: boolean },
) {
  const expectedToken = process.env.MONETIZATION_ADMIN_TOKEN;
  if (!expectedToken) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "MONETIZATION_ADMIN_TOKEN is not configured." },
        { status: 500 },
      ),
    };
  }

  const providedToken = request.headers.get(ADMIN_TOKEN_HEADER)?.trim() ?? "";
  if (!providedToken || !safeCompareToken(providedToken, expectedToken)) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Not found." }, { status: 404 }),
    };
  }

  const actor = normalizeActor(request.headers.get(ADMIN_ACTOR_HEADER));
  if (options?.requireActor && !actor) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: `${ADMIN_ACTOR_HEADER} is required.` },
        { status: 400 },
      ),
    };
  }

  return {
    ok: true as const,
    context: {
      requestId: randomUUID(),
      actor: actor || "admin",
      ip: getClientIp(request),
    } satisfies MonetizationAdminContext,
  };
}
