import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { buildInactiveAuthResponse } from "@/lib/auth-api";
import { getActiveAuthSessionFromRequest } from "@/lib/auth-session";
import { updateAuthUserProfile } from "@/lib/auth-users";
import { StorageReferenceClaimError } from "@/lib/storage-reference-claims";

const MAX_PROFILE_BODY_BYTES = 4_000;
const MAX_NAME_CHARS = 120;
const MAX_AVATAR_URL_CHARS = 500;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown, maxLength: number) {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().slice(0, maxLength);
}

function buildProfileResponse(session: NonNullable<Awaited<ReturnType<typeof getActiveAuthSessionFromRequest>>["session"]>) {
  return NextResponse.json({
    profile: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      avatarUrl: session.avatarUrl ?? "",
      role: session.role,
    },
  });
}

export async function GET(request: NextRequest) {
  const limited = await enforceRateLimit(request, {
    bucket: "api-auth-profile",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const authValidation = await getActiveAuthSessionFromRequest(request);
  const inactiveAuthResponse = buildInactiveAuthResponse(authValidation);
  if (inactiveAuthResponse) {
    return inactiveAuthResponse;
  }
  if (!authValidation.session) {
    return NextResponse.json({ error: "Login is required.", reason: "login_required" }, { status: 401 });
  }

  return buildProfileResponse(authValidation.session);
}

export async function PATCH(request: NextRequest) {
  const limited = await enforceRateLimit(request, {
    bucket: "api-auth-profile-update",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }
  if (isRequestBodyTooLarge(request, MAX_PROFILE_BODY_BYTES)) {
    return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  }

  const authValidation = await getActiveAuthSessionFromRequest(request);
  const inactiveAuthResponse = buildInactiveAuthResponse(authValidation);
  if (inactiveAuthResponse) {
    return inactiveAuthResponse;
  }
  const session = authValidation.session;
  if (!session) {
    return NextResponse.json({ error: "Login is required.", reason: "login_required" }, { status: 401 });
  }

  const body = (await request.json()) as unknown;
  if (!isObjectRecord(body)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const name = normalizeOptionalString(body.name, MAX_NAME_CHARS);
  const avatarUrl = normalizeOptionalString(body.avatarUrl, MAX_AVATAR_URL_CHARS);
  if (name === null || avatarUrl === null) {
    return NextResponse.json({ error: "Invalid profile fields." }, { status: 400 });
  }
  if (typeof name === "undefined" && typeof avatarUrl === "undefined") {
    return NextResponse.json({ error: "No profile fields were provided." }, { status: 400 });
  }

  let updated;
  try {
    updated = await updateAuthUserProfile({
      userId: session.userId,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof avatarUrl === "string" ? { avatarUrl } : {}),
    });
  } catch (error) {
    if (error instanceof StorageReferenceClaimError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.statusCode },
      );
    }
    throw error;
  }
  if (!updated) {
    return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  }

  return NextResponse.json({
    profile: {
      userId: updated.id,
      email: updated.email,
      name: updated.name,
      avatarUrl: updated.avatarUrl,
      role: updated.role,
    },
  });
}
