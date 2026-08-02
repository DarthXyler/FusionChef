import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { AUTH_SESSION_COOKIE, verifyAuthSessionToken } from "./auth-session.ts";
import {
  getAccountDeletionRecentAuthMaxAgeSeconds,
  getAllowedAdminEmails,
} from "./auth-config.ts";
import { getAuthUserByIdReadOnly } from "./auth-users.ts";
import { getClientIp } from "./api-security.ts";
import {
  AccountDeletionAuthorizationError,
  evaluateAccountDeletionAuthorization,
} from "./account-deletion-authorization-core.ts";

export {
  AccountDeletionAuthorizationError,
  assertAccountDeletionDoesNotIncludeActor,
  evaluateAccountDeletionAuthorization,
} from "./account-deletion-authorization-core.ts";

export type AccountDeletionAdminContext = {
  requestId: string;
  actor: string;
  actorAuthUserId: string;
  actorEmail: string;
  ip: string;
};

export async function requireAccountDeletionAdmin(
  request: NextRequest,
) {
  try {
    const bearerPresented = Boolean(
      request.headers.get("authorization")?.trim(),
    );
    const cookieToken =
      request.cookies.get(AUTH_SESSION_COOKIE)?.value?.trim() ?? "";
    const session = cookieToken
      ? verifyAuthSessionToken(cookieToken)
      : null;
    const currentUser = session
      ? await getAuthUserByIdReadOnly(session.userId)
      : null;
    const principal = evaluateAccountDeletionAuthorization({
      session,
      currentUser,
      allowedAdminEmails: getAllowedAdminEmails(),
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      recentAuthMaxAgeSeconds:
        getAccountDeletionRecentAuthMaxAgeSeconds(),
      bearerPresented,
    });
    return {
      ok: true as const,
      context: {
        requestId: randomUUID(),
        ...principal,
        ip: getClientIp(request),
      } satisfies AccountDeletionAdminContext,
    };
  } catch (error) {
    const authorizationError =
      error instanceof AccountDeletionAuthorizationError
        ? error
        : new AccountDeletionAuthorizationError(
            "account_deletion_authorization_unavailable",
            "Account deletion authorization is unavailable.",
            503,
          );
    const response = NextResponse.json(
      {
        error: authorizationError.message,
        code: authorizationError.code,
      },
      { status: authorizationError.statusCode },
    );
    response.headers.set("Cache-Control", "no-store");
    return { ok: false as const, response };
  }
}
