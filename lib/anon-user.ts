/**
 * Anonymous browser identity utilities.
 * The app uses a durable cookie id instead of login for per-browser cookbook data.
 */
import { randomUUID } from "crypto";
import type { NextRequest, NextResponse } from "next/server";

const ANON_USER_COOKIE = "flavor_fusion_anon_id";
const ANON_USER_HEADER = "x-flavor-fusion-anon-id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnonymousIdentity = {
  anonUserId: string;
  shouldSetCookie: boolean;
};

export function getAnonymousIdentity(request: NextRequest): AnonymousIdentity {
  // Reuse a valid mobile header id or browser cookie id; otherwise generate a new anonymous id.
  const headerValue = request.headers.get(ANON_USER_HEADER)?.trim();
  if (headerValue && UUID_PATTERN.test(headerValue)) {
    return { anonUserId: headerValue, shouldSetCookie: false };
  }

  const existing = request.cookies.get(ANON_USER_COOKIE)?.value?.trim();
  if (existing && UUID_PATTERN.test(existing)) {
    return { anonUserId: existing, shouldSetCookie: false };
  }

  return { anonUserId: randomUUID(), shouldSetCookie: true };
}

export function applyAnonymousIdentityCookie(
  response: NextResponse,
  identity: AnonymousIdentity,
) {
  // Set cookie only when a new anonymous id was created.
  if (!identity.shouldSetCookie) {
    return;
  }

  response.cookies.set({
    name: ANON_USER_COOKIE,
    value: identity.anonUserId,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}
