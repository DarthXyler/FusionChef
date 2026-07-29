import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { isAdminEmail } from "@/lib/auth-config";
import { verifyAppleIdentityToken } from "@/lib/auth-apple";
import { createAuthSessionToken } from "@/lib/auth-session";
import { getOAuthUserByProviderSubject, upsertOAuthUser } from "@/lib/auth-users";

const MAX_BODY_BYTES = 24_000;

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAppleFullName(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const candidate = value as Record<string, unknown>;
  return [
    readString(candidate.givenName),
    readString(candidate.middleName),
    readString(candidate.familyName),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 120);
}

export async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, {
    bucket: "auth-apple-mobile",
    limit: 20,
    windowMs: 5 * 60 * 1000,
  });
  if (limited) {
    return limited;
  }
  if (isRequestBodyTooLarge(request, MAX_BODY_BYTES)) {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const identityToken = readString(body.identityToken);
    if (!identityToken) {
      return NextResponse.json({ error: "Apple identityToken is required." }, { status: 400 });
    }

    const appleProfile = await verifyAppleIdentityToken(identityToken);
    const existingUser = await getOAuthUserByProviderSubject({
      provider: "apple",
      providerSubject: appleProfile.subject,
    });
    const email = appleProfile.email || existingUser?.email || "";
    if (!email) {
      return NextResponse.json(
        { error: "Apple did not provide an email for this account. Try Google login or contact support." },
        { status: 400 },
      );
    }
    if (appleProfile.email && !appleProfile.emailVerified) {
      return NextResponse.json(
        { error: "Apple account email is not verified." },
        { status: 400 },
      );
    }

    const fullName = normalizeAppleFullName(body.fullName);
    const role = isAdminEmail(email) ? "admin" : "user";
    const persistedUser = await upsertOAuthUser({
      provider: "apple",
      providerSubject: appleProfile.subject,
      email,
      name: fullName || existingUser?.name || email,
      avatarUrl: existingUser?.avatarUrl ?? "",
      role,
    });
    const token = createAuthSessionToken({
      userId: persistedUser.id,
      email: persistedUser.email,
      name: persistedUser.name,
      avatarUrl: persistedUser.avatarUrl,
      role: persistedUser.role,
      channel: "mobile",
    });

    return NextResponse.json({
      token,
      role: persistedUser.role,
      email: persistedUser.email,
      name: persistedUser.name,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Could not complete Apple login.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

