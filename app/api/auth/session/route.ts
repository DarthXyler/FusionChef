import { NextRequest, NextResponse } from "next/server";
import { getAuthSessionFromRequest } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  const session = getAuthSessionFromRequest(request);
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

