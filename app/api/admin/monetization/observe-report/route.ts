/**
 * /api/admin/monetization/observe-report
 * Admin-only analytics for observe/enforce rollout readiness.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { getMonetizationRuntimeConfig } from "@/lib/monetization-config";
import { getMonetizationDayKey, getMonetizationTimezone } from "@/lib/monetization-operations";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";
import { executeTurso } from "@/lib/turso";

type ObserveSnapshot24h = {
  fuseActions: number;
  rerollActions: number;
  totalActions: number;
  uniqueUsers: number;
};

type ObserveTodayEstimate = {
  overQuotaActions: number;
  estimatedBlockedActions: number;
  wouldBlockPercentage: number;
};

type ObserveTrendRow = {
  dayKey: string;
  fuseActions: number;
  rerollActions: number;
  totalActions: number;
  uniqueUsers: number;
  overQuotaActions: number;
  estimatedBlockedActions: number;
  wouldBlockPercentage: number;
};

type ObserveTopUserRow = {
  anonUserId: string;
  fuseCount: number;
  rerollCount: number;
  totalActions: number;
  availableCredits: number;
  overQuotaActions: number;
  estimatedBlockedActions: number;
  wouldBlockNow: boolean;
};

function asInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function clampLimit(value: string | null, fallback: number, min: number, max: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function toPercent(numerator: number, denominator: number) {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

export async function GET(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-monetization-observe-report-read",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  const trendDays = clampLimit(request.nextUrl.searchParams.get("trendDays"), 7, 1, 30);
  const topUsersLimit = clampLimit(request.nextUrl.searchParams.get("topUsersLimit"), 10, 1, 50);

  try {
    const runtimeConfig = await getMonetizationRuntimeConfig();
    const timezone = getMonetizationTimezone();
    const todayDayKey = getMonetizationDayKey({ timezone });
    const nowIso = new Date().toISOString();
    const cutoff24hIso = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const trendStartDayKey = getMonetizationDayKey({
      timezone,
      now: new Date(Date.now() - (trendDays - 1) * 24 * 60 * 60 * 1_000),
    });

    const freeFuse = runtimeConfig.freeDailyFuseActions;
    const freeReroll = runtimeConfig.freeDailyRerollActions;

    const [snapshot24hRaw, todayEstimateRaw, trendRaw, topUsersRaw] = await Promise.all([
      executeTurso({
        sql: `SELECT
                SUM(CASE WHEN event_type = 'observe_fuse' THEN 1 ELSE 0 END) AS fuse_actions,
                SUM(CASE WHEN event_type = 'observe_reroll' THEN 1 ELSE 0 END) AS reroll_actions,
                COUNT(DISTINCT anon_user_id) AS unique_users
              FROM credit_ledger_entries
              WHERE created_at >= ?
                AND event_type IN ('observe_fuse', 'observe_reroll')`,
        args: [cutoff24hIso],
      }),
      executeTurso({
        sql: `SELECT
                SUM(MAX(0, fuse_count - ?) + MAX(0, reroll_count - ?)) AS over_quota_actions,
                SUM(
                  MAX(
                    0,
                    (MAX(0, fuse_count - ?) + MAX(0, reroll_count - ?)) - COALESCE(b.available_credits, 0)
                  )
                ) AS estimated_blocked_actions,
                SUM(fuse_count + reroll_count) AS total_actions
              FROM credit_daily_usage u
              LEFT JOIN credit_balances b
                ON b.anon_user_id = u.anon_user_id
              WHERE u.day_key = ?`,
        args: [freeFuse, freeReroll, freeFuse, freeReroll, todayDayKey],
      }),
      executeTurso({
        sql: `SELECT
                u.day_key,
                SUM(u.fuse_count) AS fuse_actions,
                SUM(u.reroll_count) AS reroll_actions,
                COUNT(DISTINCT u.anon_user_id) AS unique_users,
                SUM(MAX(0, u.fuse_count - ?) + MAX(0, u.reroll_count - ?)) AS over_quota_actions,
                SUM(
                  MAX(
                    0,
                    (MAX(0, u.fuse_count - ?) + MAX(0, u.reroll_count - ?)) - COALESCE(b.available_credits, 0)
                  )
                ) AS estimated_blocked_actions
              FROM credit_daily_usage u
              LEFT JOIN credit_balances b
                ON b.anon_user_id = u.anon_user_id
              WHERE u.day_key >= ?
              GROUP BY u.day_key
              ORDER BY u.day_key DESC
              LIMIT ?`,
        args: [freeFuse, freeReroll, freeFuse, freeReroll, trendStartDayKey, trendDays],
      }),
      executeTurso({
        sql: `SELECT
                u.anon_user_id,
                u.fuse_count,
                u.reroll_count,
                COALESCE(b.available_credits, 0) AS available_credits,
                (MAX(0, u.fuse_count - ?) + MAX(0, u.reroll_count - ?)) AS over_quota_actions,
                MAX(
                  0,
                  (MAX(0, u.fuse_count - ?) + MAX(0, u.reroll_count - ?)) - COALESCE(b.available_credits, 0)
                ) AS estimated_blocked_actions
              FROM credit_daily_usage u
              LEFT JOIN credit_balances b
                ON b.anon_user_id = u.anon_user_id
              WHERE u.day_key = ?
              ORDER BY estimated_blocked_actions DESC, over_quota_actions DESC, (u.fuse_count + u.reroll_count) DESC
              LIMIT ?`,
        args: [freeFuse, freeReroll, freeFuse, freeReroll, todayDayKey, topUsersLimit],
      }),
    ]);

    const snapshotRow = (snapshot24hRaw.rows[0] as Record<string, unknown> | undefined) ?? {};
    const snapshot24h: ObserveSnapshot24h = {
      fuseActions: asInteger(snapshotRow.fuse_actions),
      rerollActions: asInteger(snapshotRow.reroll_actions),
      totalActions: asInteger(snapshotRow.fuse_actions) + asInteger(snapshotRow.reroll_actions),
      uniqueUsers: asInteger(snapshotRow.unique_users),
    };

    const todayEstimateRow = (todayEstimateRaw.rows[0] as Record<string, unknown> | undefined) ?? {};
    const todayTotalActions = asInteger(todayEstimateRow.total_actions);
    const todayEstimate: ObserveTodayEstimate = {
      overQuotaActions: asInteger(todayEstimateRow.over_quota_actions),
      estimatedBlockedActions: asInteger(todayEstimateRow.estimated_blocked_actions),
      wouldBlockPercentage: toPercent(
        asInteger(todayEstimateRow.estimated_blocked_actions),
        todayTotalActions,
      ),
    };

    const trend: ObserveTrendRow[] = trendRaw.rows
      .map((row) => {
        const record = row as Record<string, unknown>;
        const fuseActions = asInteger(record.fuse_actions);
        const rerollActions = asInteger(record.reroll_actions);
        const totalActions = fuseActions + rerollActions;
        const estimatedBlockedActions = asInteger(record.estimated_blocked_actions);
        return {
          dayKey: asString(record.day_key),
          fuseActions,
          rerollActions,
          totalActions,
          uniqueUsers: asInteger(record.unique_users),
          overQuotaActions: asInteger(record.over_quota_actions),
          estimatedBlockedActions,
          wouldBlockPercentage: toPercent(estimatedBlockedActions, totalActions),
        } satisfies ObserveTrendRow;
      })
      .filter((row) => row.dayKey.length > 0);

    const topUsers: ObserveTopUserRow[] = topUsersRaw.rows
      .map((row) => {
        const record = row as Record<string, unknown>;
        const fuseCount = asInteger(record.fuse_count);
        const rerollCount = asInteger(record.reroll_count);
        const estimatedBlockedActions = asInteger(record.estimated_blocked_actions);
        return {
          anonUserId: asString(record.anon_user_id),
          fuseCount,
          rerollCount,
          totalActions: fuseCount + rerollCount,
          availableCredits: asInteger(record.available_credits),
          overQuotaActions: asInteger(record.over_quota_actions),
          estimatedBlockedActions,
          wouldBlockNow: estimatedBlockedActions > 0,
        } satisfies ObserveTopUserRow;
      })
      .filter((row) => row.anonUserId.length > 0);

    const response = NextResponse.json({
      runtime: {
        enabled: runtimeConfig.enabled,
        enforcementMode: runtimeConfig.enforcementMode,
        freeDailyFuseActions: runtimeConfig.freeDailyFuseActions,
        freeDailyRerollActions: runtimeConfig.freeDailyRerollActions,
        fuseCreditCost: runtimeConfig.fuseCreditCost,
        rerollCreditCost: runtimeConfig.rerollCreditCost,
      },
      generatedAt: nowIso,
      timezone,
      todayDayKey,
      snapshot24h,
      todayEstimate,
      trend,
      topUsers,
    });
    withNoStore(response);

    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "observe_report_read_succeeded",
      actor: admin.context.actor,
      ip: admin.context.ip,
      trendDays,
      topUsersLimit,
    });

    return response;
  } catch {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "observe_report_read_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
    });
    return NextResponse.json({ error: "Could not load observe analytics report." }, { status: 500 });
  }
}
