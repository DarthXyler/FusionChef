import { NextRequest, NextResponse } from "next/server";
import { buildGoogleOauthUrl } from "@/lib/auth-google";
import {
  AUTH_OAUTH_STATE_COOKIE,
  createOAuthStatePayload,
  encodeOAuthStatePayload,
  getOauthStateMaxAgeSeconds,
  normalizeMobileRedirectUri,
  normalizeReturnToPath,
} from "@/lib/auth-oauth-state";

function getCallbackUrl(request: NextRequest) {
  return `${request.nextUrl.origin}/api/auth/google/callback`;
}

export async function GET(request: NextRequest) {
  try {
    const returnTo = normalizeReturnToPath(request.nextUrl.searchParams.get("returnTo"));
    const platform = request.nextUrl.searchParams.get("platform") === "mobile" ? "mobile" : "web";
    const redirectUri =
      platform === "mobile"
        ? normalizeMobileRedirectUri(request.nextUrl.searchParams.get("redirectUri"))
        : "";

    if (platform === "mobile" && !redirectUri) {
      return NextResponse.json({ error: "A valid mobile redirectUri is required." }, { status: 400 });
    }

    const statePayload = createOAuthStatePayload({
      returnTo,
      platform,
      redirectUri,
    });
    const authorizationUrl = buildGoogleOauthUrl({
      redirectUri: getCallbackUrl(request),
      state: statePayload.state,
    });

    const response = NextResponse.redirect(authorizationUrl, { status: 302 });
    response.cookies.set({
      name: AUTH_OAUTH_STATE_COOKIE,
      value: encodeOAuthStatePayload(statePayload),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: getOauthStateMaxAgeSeconds(),
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start login.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

