import { NextRequest, NextResponse } from "next/server";
import { getAdminWebSessionMaxAgeSeconds, isAdminEmail } from "@/lib/auth-config";
import { exchangeGoogleAuthorizationCode } from "@/lib/auth-google";
import {
  AUTH_OAUTH_STATE_COOKIE,
  decodeOAuthStatePayload,
} from "@/lib/auth-oauth-state";
import {
  clearAuthSessionCookie,
  createAuthSessionToken,
  setAuthSessionCookie,
} from "@/lib/auth-session";
import { upsertOAuthUser } from "@/lib/auth-users";

function getCallbackUrl(request: NextRequest) {
  return `${request.nextUrl.origin}/api/auth/google/callback`;
}

function withClearedOauthStateCookie(response: NextResponse) {
  response.cookies.set({
    name: AUTH_OAUTH_STATE_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const state = request.nextUrl.searchParams.get("state")?.trim() ?? "";
  if (!code || !state) {
    return NextResponse.redirect(`${request.nextUrl.origin}/admin/monetization?authError=missing_code`, {
      status: 302,
    });
  }

  const rawStateCookie = request.cookies.get(AUTH_OAUTH_STATE_COOKIE)?.value?.trim() ?? "";
  const statePayload = decodeOAuthStatePayload(rawStateCookie);
  if (!statePayload || statePayload.state !== state) {
    return withClearedOauthStateCookie(
      NextResponse.redirect(
        `${request.nextUrl.origin}/admin/monetization?authError=invalid_state`,
        { status: 302 },
      ),
    );
  }

  try {
    const profile = await exchangeGoogleAuthorizationCode({
      code,
      redirectUri: getCallbackUrl(request),
    });
    const role = isAdminEmail(profile.email) ? "admin" : "user";
    const user = await upsertOAuthUser({
      provider: "google",
      providerSubject: profile.subject,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      role,
    });
    const token = createAuthSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      channel: statePayload.platform === "mobile" ? "mobile" : "web",
    });

    if (statePayload.platform === "mobile") {
      const redirectTarget = new URL(statePayload.redirectUri);
      redirectTarget.searchParams.set("token", token);
      redirectTarget.searchParams.set("role", user.role);
      redirectTarget.searchParams.set("email", user.email);
      const response = NextResponse.redirect(redirectTarget, { status: 302 });
      return withClearedOauthStateCookie(response);
    }

    const webTarget =
      user.role === "admin"
        ? statePayload.returnTo
        : "/admin/monetization?authError=This+account+is+not+an+admin";
    const response = NextResponse.redirect(`${request.nextUrl.origin}${webTarget}`, {
      status: 302,
    });
    setAuthSessionCookie(response, token, {
      maxAgeSeconds: getAdminWebSessionMaxAgeSeconds(),
    });
    return withClearedOauthStateCookie(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "login_failed";
    const response = NextResponse.redirect(
      `${request.nextUrl.origin}/admin/monetization?authError=${encodeURIComponent(message)}`,
      { status: 302 },
    );
    clearAuthSessionCookie(response);
    return withClearedOauthStateCookie(response);
  }
}
