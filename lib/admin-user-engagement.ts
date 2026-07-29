export const ADMIN_USER_INACTIVITY_DAYS = 7;

export type AdminUserTypeFilter = "all" | "free_only" | "paying" | "no_activity";
export type AdminUserType = Exclude<AdminUserTypeFilter, "all">;

export type AdminUserActivityStatusFilter =
  | "all"
  | "active"
  | "inactive"
  | "never_active";
export type AdminUserActivityStatus = Exclude<AdminUserActivityStatusFilter, "all">;

export const ADMIN_USER_LAST_ACTIVITY_SQL = `CASE
  WHEN pas.last_durable_activity_at IS NULL THEN vps.last_verified_purchase_at
  WHEN vps.last_verified_purchase_at IS NULL THEN pas.last_durable_activity_at
  WHEN pas.last_durable_activity_at >= vps.last_verified_purchase_at
    THEN pas.last_durable_activity_at
  ELSE vps.last_verified_purchase_at
END`;

export const ADMIN_USER_HAS_PURCHASE_SQL = `(
  COALESCE(pas.purchase_activity_count, 0) > 0
  OR COALESCE(vps.verified_purchase_count, 0) > 0
)`;

export const ADMIN_USER_HAS_ACTIVITY_SQL = `(
  COALESCE(pas.durable_activity_count, 0) > 0
  OR COALESCE(vps.verified_purchase_count, 0) > 0
)`;

export const ADMIN_USER_TYPE_SQL = `CASE
  WHEN ${ADMIN_USER_HAS_PURCHASE_SQL} THEN 'paying'
  WHEN ${ADMIN_USER_HAS_ACTIVITY_SQL} THEN 'free_only'
  ELSE 'no_activity'
END`;

export const ADMIN_USER_ACTIVITY_STATUS_SQL = `CASE
  WHEN (${ADMIN_USER_LAST_ACTIVITY_SQL}) IS NULL THEN 'never_active'
  WHEN (${ADMIN_USER_LAST_ACTIVITY_SQL}) > ec.activity_cutoff THEN 'active'
  ELSE 'inactive'
END`;

export const ADMIN_USER_ENGAGEMENT_CTES_SQL = `WITH
  engagement_config(activity_cutoff) AS (VALUES (?)),
  product_activity_summary AS (
    SELECT
      auth_user_id,
      COUNT(*) AS durable_activity_count,
      SUM(CASE WHEN activity_type = 'credit_purchase' THEN 1 ELSE 0 END)
        AS purchase_activity_count,
      MAX(occurred_at) AS last_durable_activity_at
    FROM product_activity_events
    GROUP BY auth_user_id
  ),
  verified_purchase_summary AS (
    SELECT
      anon_user_id,
      COUNT(*) AS verified_purchase_count,
      MAX(verified_at) AS last_verified_purchase_at
    FROM credit_purchase_transactions
    WHERE verified_at IS NOT NULL
      AND trim(verified_at) <> ''
    GROUP BY anon_user_id
  )`;

export const ADMIN_USER_ENGAGEMENT_JOINS_SQL = `CROSS JOIN engagement_config ec
  LEFT JOIN product_activity_summary pas ON pas.auth_user_id = u.id
  LEFT JOIN verified_purchase_summary vps
    ON vps.anon_user_id = ail.canonical_anon_user_id`;

export function parseAdminUserTypeFilter(value: string | null): AdminUserTypeFilter {
  return value === "free_only" || value === "paying" || value === "no_activity"
    ? value
    : "all";
}

export function parseAdminUserActivityStatusFilter(
  value: string | null,
): AdminUserActivityStatusFilter {
  return value === "active" || value === "inactive" || value === "never_active"
    ? value
    : "all";
}

export function getAdminUserTypeWhereClause(userType: AdminUserTypeFilter) {
  if (userType === "paying") {
    return ADMIN_USER_HAS_PURCHASE_SQL;
  }
  if (userType === "free_only") {
    return `${ADMIN_USER_HAS_ACTIVITY_SQL} AND NOT ${ADMIN_USER_HAS_PURCHASE_SQL}`;
  }
  if (userType === "no_activity") {
    return `NOT ${ADMIN_USER_HAS_ACTIVITY_SQL}`;
  }
  return "";
}

export function getAdminUserActivityStatusWhereClause(
  activityStatus: AdminUserActivityStatusFilter,
) {
  if (activityStatus === "active") {
    return `(${ADMIN_USER_LAST_ACTIVITY_SQL}) IS NOT NULL
      AND (${ADMIN_USER_LAST_ACTIVITY_SQL}) > ec.activity_cutoff`;
  }
  if (activityStatus === "inactive") {
    return `(${ADMIN_USER_LAST_ACTIVITY_SQL}) IS NOT NULL
      AND (${ADMIN_USER_LAST_ACTIVITY_SQL}) <= ec.activity_cutoff`;
  }
  if (activityStatus === "never_active") {
    return `(${ADMIN_USER_LAST_ACTIVITY_SQL}) IS NULL`;
  }
  return "";
}

export function getAdminUserActivityCutoffIso(
  now: Date = new Date(),
  inactivityDays = ADMIN_USER_INACTIVITY_DAYS,
) {
  return new Date(now.getTime() - inactivityDays * 24 * 60 * 60 * 1000).toISOString();
}

export function getAdminUserTypeLabel(userType: AdminUserType) {
  if (userType === "free_only") {
    return "Free-only";
  }
  if (userType === "paying") {
    return "Paying";
  }
  return "No activity";
}

export function getAdminUserActivityStatusLabel(activityStatus: AdminUserActivityStatus) {
  if (activityStatus === "never_active") {
    return "Never active";
  }
  return activityStatus === "active" ? "Active" : "Inactive";
}
