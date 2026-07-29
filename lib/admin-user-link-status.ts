export type AdminUserLinkStatus = "all" | "linked" | "unlinked";
export type AdminUserRowLinkStatus = Exclude<AdminUserLinkStatus, "all">;

export type AdminUserLinkSelection = {
  linked: boolean;
  unlinked: boolean;
};

export type AdminUsersQueryFilters = {
  cursor?: string | null;
  limit?: number;
  includeSummary?: boolean;
  search: string;
  role: string;
  payment: string;
  cookbook: string;
  userType: string;
  activityStatus: string;
  accountSetup?: string;
  issueReason?: string;
  linkSelection?: AdminUserLinkSelection;
  minCredits: string;
  maxCredits: string;
  lastLoginSince: string;
};

export const DEFAULT_ADMIN_USER_LINK_SELECTION: AdminUserLinkSelection = {
  linked: true,
  unlinked: true,
};

export function parseAdminUserLinkStatus(value: string | null): AdminUserLinkStatus {
  return value === "linked" || value === "unlinked" ? value : "all";
}

export function getAdminUserLinkStatus(
  canonicalAnonUserId: string,
): AdminUserRowLinkStatus {
  return canonicalAnonUserId.trim() ? "linked" : "unlinked";
}

export function getAdminUserLinkFilter(
  selection: AdminUserLinkSelection,
): AdminUserLinkStatus {
  if (selection.linked && !selection.unlinked) {
    return "linked";
  }
  if (selection.unlinked && !selection.linked) {
    return "unlinked";
  }
  return "all";
}

export function toggleAdminUserLinkSelection(
  selection: AdminUserLinkSelection,
  status: AdminUserRowLinkStatus,
): AdminUserLinkSelection {
  const next = {
    ...selection,
    [status]: !selection[status],
  };
  return next.linked || next.unlinked ? next : selection;
}

export function buildAdminUsersQuery({
  cursor,
  limit = 100,
  includeSummary = false,
  search,
  role,
  payment,
  cookbook,
  userType,
  activityStatus,
  accountSetup,
  issueReason,
  linkSelection,
  minCredits,
  maxCredits,
  lastLoginSince,
}: AdminUsersQueryFilters) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (includeSummary) {
    params.set("includeSummary", "true");
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (search.trim()) {
    params.set("search", search.trim());
  }
  params.set("role", role);
  params.set("payment", payment);
  params.set("cookbook", cookbook);
  params.set("userType", userType);
  params.set("activityStatus", activityStatus);
  if (accountSetup) {
    params.set("accountSetup", accountSetup);
    params.set("issueReason", issueReason || "all");
  } else if (linkSelection) {
    // Backward-compatible technical filter for older callers. The normal
    // admin UI uses accountSetup and issueReason instead.
    params.set("linkStatus", getAdminUserLinkFilter(linkSelection));
  }
  if (minCredits.trim()) {
    params.set("minCredits", minCredits.trim());
  }
  if (maxCredits.trim()) {
    params.set("maxCredits", maxCredits.trim());
  }
  if (lastLoginSince.trim()) {
    params.set("lastLoginSince", lastLoginSince.trim());
  }
  return params.toString();
}
