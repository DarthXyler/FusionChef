import { NextRequest, NextResponse } from "next/server";
import { buildInactiveAuthResponse } from "@/lib/auth-api";
import { getActiveAuthSessionFromRequest } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  const authValidation = await getActiveAuthSessionFromRequest(request);
  const inactiveAuthResponse = buildInactiveAuthResponse(authValidation);
  if (inactiveAuthResponse) {
    return inactiveAuthResponse;
  }
  const session = authValidation.session;
  if (!session) {
    return NextResponse.json({
      authenticated: false,
    });
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      expiresAt: new Date(session.exp * 1000).toISOString(),
    },
  });
}
