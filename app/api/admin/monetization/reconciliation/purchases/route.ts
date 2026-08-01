/**
 * Read-only admin purchase reconciliation monitoring.
 */
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { scanPurchaseReconciliation } from "@/lib/monetization-purchase-reconciliation";
import {
  logMonetizationAudit,
  requireMonetizationAdmin,
  withNoStore,
} from "@/lib/monetization-security";

export const dynamic = "force-dynamic";

function noStoreJson(payload: unknown, status = 200) {
  const response = NextResponse.json(payload, { status });
  withNoStore(response);
  return response;
}

export async function GET(request: NextRequest) {
  const admin = requireMonetizationAdmin(request);
  if (!admin.ok) {
    withNoStore(admin.response);
    return admin.response;
  }

  const limited = await enforceRateLimit(request, {
    bucket: "api-admin-purchase-reconciliation-read",
    limit: 20,
    windowMs: 60_000,
    // This endpoint is strictly read-only, including its rate-limit path.
    strategy: "memory",
  });
  if (limited) {
    withNoStore(limited);
    return limited;
  }

  try {
    const report = await scanPurchaseReconciliation();
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reconciliation_read",
      actor: admin.context.actor,
      ip: admin.context.ip,
      status: report.status,
      totalIssues: report.totalIssues,
      counts: report.counts,
    });
    return noStoreJson(report);
  } catch (error) {
    logMonetizationAudit({
      requestId: admin.context.requestId,
      event: "purchase_reconciliation_read_failed",
      actor: admin.context.actor,
      ip: admin.context.ip,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return noStoreJson(
      { error: "Could not load purchase reconciliation monitoring." },
      500,
    );
  }
}
