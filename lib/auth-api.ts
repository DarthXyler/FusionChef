import { NextResponse } from "next/server";
import type { ActiveAuthSessionResult } from "@/lib/auth-session";

export function buildLoginRequiredResponse() {
  return NextResponse.json(
    {
      error: "Sign in to create or reroll recipes.",
      reason: "login_required",
      code: "login_required",
    },
    { status: 401 },
  );
}

export function buildInactiveAuthResponse(validation: ActiveAuthSessionResult) {
  if (!validation.hadToken || !validation.invalidReason) {
    return null;
  }

  if (validation.invalidReason === "deleted") {
    return NextResponse.json(
      {
        error: "This account is no longer available. Please sign in again.",
        reason: "account_deleted",
      },
      { status: 401 },
    );
  }

  return NextResponse.json(
    {
      error: "Your sign-in session has expired. Please sign in again.",
      reason: "auth_invalid",
    },
    { status: 401 },
  );
}
