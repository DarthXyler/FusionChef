import {
  ADMIN_USER_ENGAGEMENT_CTES_SQL,
  ADMIN_USER_ENGAGEMENT_JOINS_SQL,
  ADMIN_USER_HAS_PURCHASE_SQL,
  ADMIN_USER_LAST_ACTIVITY_SQL,
} from "./admin-user-engagement.ts";

export type AdminUserAccountSetupFilter =
  | "all"
  | "complete"
  | "needs_attention";
export type AdminUserAccountSetup = Exclude<AdminUserAccountSetupFilter, "all">;

export type AdminUserIdentityIssue =
  | "setup_missing"
  | "shared_identity"
  | "split_data"
  | "invalid_identity"
  | "unknown_issue";
export type AdminUserIdentityIssueFilter =
  | "all"
  | Exclude<AdminUserIdentityIssue, "unknown_issue">;

export type AdminUserSummary = {
  totalUsers: number;
  payingUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  needsAttention: number;
  completeAccounts: number;
  setupMissing: number;
  sharedIdentity: number;
  splitData: number;
  invalidIdentity: number;
};

const VALID_CANONICAL_ID_SQL = `(
  length(als.canonical_anon_user_id) = 36
  AND substr(als.canonical_anon_user_id, 9, 1) = '-'
  AND substr(als.canonical_anon_user_id, 14, 1) = '-'
  AND substr(als.canonical_anon_user_id, 19, 1) = '-'
  AND substr(als.canonical_anon_user_id, 24, 1) = '-'
  AND lower(replace(als.canonical_anon_user_id, '-', ''))
    NOT GLOB '*[^0-9a-f]*'
  AND lower(substr(als.canonical_anon_user_id, 15, 1)) GLOB '[1-5]'
  AND lower(substr(als.canonical_anon_user_id, 20, 1)) GLOB '[89ab]'
)`;

/**
 * Read-only identity-health CTEs.
 *
 * Split data requires an explicit alias-to-canonical mapping plus durable
 * product ownership under the alias (or a device mapping still targeting it).
 * Email, login timestamps, and OAuth provider data are deliberately excluded.
 */
export const ADMIN_USER_IDENTITY_HEALTH_CTES_SQL = `,
  auth_link_summary AS (
    SELECT
      auth_user_id,
      COUNT(*) AS link_count,
      COUNT(DISTINCT trim(canonical_anon_user_id)) AS distinct_canonical_count,
      MIN(trim(canonical_anon_user_id)) AS canonical_anon_user_id
    FROM auth_identity_links
    GROUP BY auth_user_id
  ),
  canonical_owner_counts AS (
    SELECT
      trim(ail.canonical_anon_user_id) AS canonical_anon_user_id,
      COUNT(DISTINCT ail.auth_user_id) AS owner_count
    FROM auth_identity_links ail
    JOIN auth_users owner ON owner.id = ail.auth_user_id
    WHERE trim(ail.canonical_anon_user_id) <> ''
    GROUP BY trim(ail.canonical_anon_user_id)
  ),
  identity_alias_closure (
    auth_user_id,
    alias_id,
    canonical_anon_user_id,
    depth,
    visited_path
  ) AS (
    SELECT
      als.auth_user_id,
      mia.anon_user_id,
      als.canonical_anon_user_id,
      1,
      '|' || mia.anon_user_id || '|'
    FROM auth_link_summary als
    JOIN mobile_identity_aliases mia
      ON mia.canonical_anon_user_id = als.canonical_anon_user_id
      AND mia.anon_user_id <> als.canonical_anon_user_id
    WHERE als.link_count = 1
    UNION ALL
    SELECT
      iac.auth_user_id,
      mia.anon_user_id,
      iac.canonical_anon_user_id,
      iac.depth + 1,
      iac.visited_path || mia.anon_user_id || '|'
    FROM identity_alias_closure iac
    JOIN mobile_identity_aliases mia
      ON mia.canonical_anon_user_id = iac.alias_id
      AND mia.anon_user_id <> iac.canonical_anon_user_id
    WHERE iac.depth < 6
      AND instr(iac.visited_path, '|' || mia.anon_user_id || '|') = 0
  ),
  split_identity_users AS (
    SELECT DISTINCT iac.auth_user_id
    FROM identity_alias_closure iac
    WHERE EXISTS (
      SELECT 1 FROM credit_balances cb
      WHERE cb.anon_user_id = iac.alias_id
    )
      OR EXISTS (
        SELECT 1 FROM credit_daily_usage cdu
        WHERE cdu.anon_user_id = iac.alias_id
      )
      OR EXISTS (
        SELECT 1 FROM credit_reservations cr
        WHERE cr.anon_user_id = iac.alias_id
      )
      OR EXISTS (
        SELECT 1 FROM credit_ledger_entries cle
        WHERE cle.anon_user_id = iac.alias_id
      )
      OR EXISTS (
        SELECT 1 FROM credit_purchase_transactions cpt
        WHERE cpt.anon_user_id = iac.alias_id
      )
      OR EXISTS (
        SELECT 1 FROM cookbook_recipes recipe
        WHERE recipe.anon_user_id = iac.alias_id
      )
    UNION
    SELECT DISTINCT iac.auth_user_id
    FROM identity_alias_closure iac
    JOIN mobile_identity_links mil
      ON mil.canonical_anon_user_id = iac.alias_id
  ),
  identity_health AS (
    SELECT
      u.id AS auth_user_id,
      als.canonical_anon_user_id,
      CASE
        WHEN COALESCE(als.link_count, 0) = 0 THEN 'setup_missing'
        WHEN als.link_count <> 1
          OR als.distinct_canonical_count <> 1
          OR NOT ${VALID_CANONICAL_ID_SQL}
          OR EXISTS (
            SELECT 1
            FROM mobile_identity_aliases outgoing_alias
            WHERE outgoing_alias.anon_user_id = als.canonical_anon_user_id
              AND trim(outgoing_alias.canonical_anon_user_id)
                <> als.canonical_anon_user_id
          )
          THEN 'invalid_identity'
        WHEN COALESCE(coc.owner_count, 0) > 1 THEN 'shared_identity'
        WHEN siu.auth_user_id IS NOT NULL THEN 'split_data'
        ELSE NULL
      END AS issue_reason
    FROM auth_users u
    LEFT JOIN auth_link_summary als ON als.auth_user_id = u.id
    LEFT JOIN canonical_owner_counts coc
      ON coc.canonical_anon_user_id = als.canonical_anon_user_id
    LEFT JOIN split_identity_users siu ON siu.auth_user_id = u.id
  )`;

export const ADMIN_USER_IDENTITY_HEALTH_JOIN_SQL =
  "LEFT JOIN identity_health ail ON ail.auth_user_id = u.id";

export const ADMIN_USER_ACCOUNT_SETUP_SQL = `CASE
  WHEN ail.issue_reason IS NULL THEN 'complete'
  ELSE 'needs_attention'
END`;

export const ADMIN_USER_ACCOUNT_SETUP_ISSUE_SQL =
  "COALESCE(ail.issue_reason, '')";

export const ADMIN_USER_SUMMARY_SQL = `${ADMIN_USER_ENGAGEMENT_CTES_SQL}
  ${ADMIN_USER_IDENTITY_HEALTH_CTES_SQL}
  SELECT
    COUNT(DISTINCT u.id) AS total_users,
    COUNT(DISTINCT CASE
      WHEN ${ADMIN_USER_HAS_PURCHASE_SQL} THEN u.id
    END) AS paying_users,
    COUNT(DISTINCT CASE
      WHEN (${ADMIN_USER_LAST_ACTIVITY_SQL}) > ec.activity_cutoff THEN u.id
    END) AS active_users,
    COUNT(DISTINCT CASE
      WHEN (${ADMIN_USER_LAST_ACTIVITY_SQL}) IS NOT NULL
        AND (${ADMIN_USER_LAST_ACTIVITY_SQL}) <= ec.activity_cutoff THEN u.id
    END) AS inactive_users,
    COUNT(DISTINCT CASE
      WHEN ail.issue_reason IS NOT NULL THEN u.id
    END) AS needs_attention,
    COUNT(DISTINCT CASE
      WHEN ail.issue_reason IS NULL THEN u.id
    END) AS complete_accounts,
    COUNT(DISTINCT CASE
      WHEN ail.issue_reason = 'setup_missing' THEN u.id
    END) AS setup_missing,
    COUNT(DISTINCT CASE
      WHEN ail.issue_reason = 'shared_identity' THEN u.id
    END) AS shared_identity,
    COUNT(DISTINCT CASE
      WHEN ail.issue_reason = 'split_data' THEN u.id
    END) AS split_data,
    COUNT(DISTINCT CASE
      WHEN ail.issue_reason = 'invalid_identity' THEN u.id
    END) AS invalid_identity
  FROM auth_users u
  ${ADMIN_USER_IDENTITY_HEALTH_JOIN_SQL}
  ${ADMIN_USER_ENGAGEMENT_JOINS_SQL}`;

export function parseAdminUserAccountSetupFilter(
  value: string | null,
): AdminUserAccountSetupFilter {
  return value === "complete" || value === "needs_attention" ? value : "all";
}

export function parseAdminUserIdentityIssueFilter(
  value: string | null,
): AdminUserIdentityIssueFilter {
  return value === "setup_missing" ||
    value === "shared_identity" ||
    value === "split_data" ||
    value === "invalid_identity"
    ? value
    : "all";
}

export function getAdminUserAccountSetupWhereClause(
  accountSetup: AdminUserAccountSetupFilter,
) {
  if (accountSetup === "complete") {
    return "ail.issue_reason IS NULL";
  }
  if (accountSetup === "needs_attention") {
    return "ail.issue_reason IS NOT NULL";
  }
  return "";
}

export function getAdminUserIdentityIssueWhereClause(
  issueReason: AdminUserIdentityIssueFilter,
) {
  return issueReason === "all" ? "" : `ail.issue_reason = '${issueReason}'`;
}

export function parseAdminUserAccountSetup(
  value: string,
): AdminUserAccountSetup {
  return value === "complete" ? "complete" : "needs_attention";
}

export function parseAdminUserIdentityIssue(
  value: string,
): AdminUserIdentityIssue | null {
  if (!value) {
    return null;
  }
  return value === "setup_missing" ||
    value === "shared_identity" ||
    value === "split_data" ||
    value === "invalid_identity"
    ? value
    : "unknown_issue";
}

export function getAdminUserAccountSetupLabel(
  status: AdminUserAccountSetup,
) {
  return status === "complete" ? "Complete" : "Needs attention";
}

export function getAdminUserIdentityIssueLabel(
  issue: AdminUserIdentityIssue | null,
) {
  if (issue === "setup_missing") {
    return "Setup missing";
  }
  if (issue === "shared_identity") {
    return "Shared identity";
  }
  if (issue === "split_data") {
    return "Split data";
  }
  if (issue === "invalid_identity") {
    return "Invalid identity";
  }
  return issue === "unknown_issue" ? "Unknown issue" : "";
}
