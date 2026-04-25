/**
 * Stateless auth session token + cookie utilities.
 * Token is also used as bearer for mobile auth.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import type { NextRequest, NextResponse } from "next/server";
import { getSessionMaxAgeSeconds, getSessionSecret } from "@/lib/auth-config";

export type AuthRole = "user" | "admin";

export type AuthSession = {
  userId: string;
  email: string;
  name: string;
  role: AuthRole;
  iat: number;
  exp: number;
};

export const AUTH_SESSION_COOKIE = "ffc_auth_session";

function toBase64Url(input: string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function safeEqualText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseTokenPayload(payload: unknown): AuthSession | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  const userId = typeof candidate.userId === "string" ? candidate.userId.trim() : "";
  const email = typeof candidate.email === "string" ? candidate.email.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const role = candidate.role === "admin" ? "admin" : candidate.role === "user" ? "user" : null;
  const iat = typeof candidate.iat === "number" && Number.isFinite(candidate.iat) ? Math.trunc(candidate.iat) : 0;
  const exp = typeof candidate.exp === "number" && Number.isFinite(candidate.exp) ? Math.trunc(candidate.exp) : 0;
  if (!userId || !email || !name || !role || iat <= 0 || exp <= 0) {
    return null;
  }
  return {
    userId,
    email,
    name,
    role,
    iat,
    exp,
  };
}

function getBearerToken(request: NextRequest) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return authorization.slice(7).trim();
}

function signJwtToken(headerBase64: string, payloadBase64: string, secret: string) {
  return createHmac("sha256", secret).update(`${headerBase64}.${payloadBase64}`).digest("base64url");
}

export function createAuthSessionToken(claims: {
  userId: string;
  email: string;
  name: string;
  role: AuthRole;
}) {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("AUTH_SESSION_SECRET is not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  const headerBase64 = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadBase64 = toBase64Url(
    JSON.stringify({
      userId: claims.userId,
      email: claims.email,
      name: claims.name,
      role: claims.role,
      iat: now,
      exp: now + getSessionMaxAgeSeconds(),
    }),
  );
  const signature = signJwtToken(headerBase64, payloadBase64, secret);
  return `${headerBase64}.${payloadBase64}.${signature}`;
}

export function verifyAuthSessionToken(token: string) {
  const secret = getSessionSecret();
  if (!secret) {
    return null;
  }
  const [headerBase64, payloadBase64, signature] = token.trim().split(".");
  if (!headerBase64 || !payloadBase64 || !signature) {
    return null;
  }
  const expectedSignature = signJwtToken(headerBase64, payloadBase64, secret);
  if (!safeEqualText(signature, expectedSignature)) {
    return null;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(fromBase64Url(payloadBase64));
  } catch {
    payload = null;
  }
  const session = parseTokenPayload(payload);
  if (!session) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (session.exp <= now) {
    return null;
  }
  return session;
}

export function setAuthSessionCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: AUTH_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: getSessionMaxAgeSeconds(),
  });
}

export function clearAuthSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: AUTH_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function getAuthSessionFromCookies(cookies: ReadonlyRequestCookies) {
  const raw = cookies.get(AUTH_SESSION_COOKIE)?.value?.trim() ?? "";
  if (!raw) {
    return null;
  }
  return verifyAuthSessionToken(raw);
}

export function getAuthSessionFromRequest(request: NextRequest) {
  const bearerToken = getBearerToken(request);
  if (bearerToken) {
    const parsedFromBearer = verifyAuthSessionToken(bearerToken);
    if (parsedFromBearer) {
      return parsedFromBearer;
    }
  }

  const cookieToken = request.cookies.get(AUTH_SESSION_COOKIE)?.value?.trim() ?? "";
  if (!cookieToken) {
    return null;
  }
  return verifyAuthSessionToken(cookieToken);
}

