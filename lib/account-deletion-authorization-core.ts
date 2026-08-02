import type { AuthSession } from "./auth-session.ts";
import type { AuthUserRecord } from "./auth-users.ts";

export class AccountDeletionAuthorizationError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type AuthorizationFacts = {
  session: AuthSession | null;
  currentUser: AuthUserRecord | null;
  allowedAdminEmails: readonly string[];
  nowEpochSeconds: number;
  recentAuthMaxAgeSeconds: number;
  bearerPresented: boolean;
};

export function evaluateAccountDeletionAuthorization(
  facts: AuthorizationFacts,
) {
  if (facts.bearerPresented) {
    throw new AccountDeletionAuthorizationError(
      "web_admin_session_required",
      "Account deletion requires an active web administrator session.",
      403,
    );
  }
  if (!facts.session || facts.session.channel !== "web") {
    throw new AccountDeletionAuthorizationError(
      "web_admin_session_required",
      "Account deletion requires an active web administrator session.",
      401,
    );
  }
  if (
    facts.session.exp <= facts.nowEpochSeconds ||
    facts.session.iat > facts.nowEpochSeconds + 60
  ) {
    throw new AccountDeletionAuthorizationError(
      "admin_session_invalid",
      "The administrator session is invalid or expired.",
      401,
    );
  }
  if (
    facts.nowEpochSeconds - facts.session.iat >
    facts.recentAuthMaxAgeSeconds
  ) {
    throw new AccountDeletionAuthorizationError(
      "recent_authentication_required",
      "Sign in again before deleting an account.",
      401,
    );
  }
  const user = facts.currentUser;
  if (!user || user.id !== facts.session.userId) {
    throw new AccountDeletionAuthorizationError(
      "admin_account_unavailable",
      "The administrator account is unavailable.",
      401,
    );
  }
  const allowlist = new Set(
    facts.allowedAdminEmails.map((email) => email.trim().toLowerCase()),
  );
  if (user.role !== "admin" || !allowlist.has(user.email.trim().toLowerCase())) {
    throw new AccountDeletionAuthorizationError(
      "account_deletion_forbidden",
      "The current administrator is not authorized to delete accounts.",
      403,
    );
  }
  return {
    actor: `auth_user:${user.id}`,
    actorAuthUserId: user.id,
    actorEmail: user.email,
  };
}

export function assertAccountDeletionDoesNotIncludeActor(
  actorAuthUserId: string,
  targetAuthUserIds: readonly string[],
) {
  if (targetAuthUserIds.includes(actorAuthUserId)) {
    throw new AccountDeletionAuthorizationError(
      "self_deletion_forbidden",
      "Administrators cannot delete their own account.",
      403,
    );
  }
}
