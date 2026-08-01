"use client";

import { useEffect, useState } from "react";
import {
  PURCHASE_RECONCILIATION_ISSUE_TYPES,
  type PurchaseReconciliationIssue,
  type PurchaseReconciliationIssueType,
  type PurchaseReconciliationReport,
} from "@/lib/monetization-purchase-reconciliation";

const ISSUE_LABELS: Record<PurchaseReconciliationIssueType, string> = {
  purchase_missing_grant: "Purchase missing grant",
  grant_missing_purchase: "Grant missing purchase",
  missing_purchase_ledger_link: "Missing purchase-ledger link",
  credit_amount_mismatch: "Credit amount mismatch",
  owner_mismatch: "Owner mismatch",
  duplicate_grant: "Duplicate grant",
  product_or_transaction_conflict: "Product or transaction conflict",
};

function asInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNullableInteger(value: unknown) {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseIssue(value: unknown): PurchaseReconciliationIssue | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const issueType = value.issueType as PurchaseReconciliationIssueType;
  if (
    typeof value.id !== "string" ||
    !PURCHASE_RECONCILIATION_ISSUE_TYPES.includes(issueType) ||
    typeof value.userId !== "string" ||
    (value.relatedUserId !== null && typeof value.relatedUserId !== "string") ||
    (value.provider !== "apple_app_store" &&
      value.provider !== "google_play" &&
      value.provider !== "unknown") ||
    typeof value.maskedProviderTransactionId !== "string" ||
    typeof value.productId !== "string" ||
    (value.purchaseDate !== null && typeof value.purchaseDate !== "string") ||
    typeof value.explanation !== "string" ||
    typeof value.recommendedStep !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    issueType,
    userId: value.userId,
    relatedUserId: value.relatedUserId,
    provider: value.provider,
    maskedProviderTransactionId: value.maskedProviderTransactionId,
    productId: value.productId,
    purchaseDate: value.purchaseDate,
    purchaseAmount: asNullableInteger(value.purchaseAmount),
    ledgerAmount: asNullableInteger(value.ledgerAmount),
    currentBalance: asInteger(value.currentBalance),
    explanation: value.explanation,
    recommendedStep: value.recommendedStep,
  };
}

function parseReport(value: unknown): PurchaseReconciliationReport | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (value.status !== "healthy" && value.status !== "needs_attention") {
    return null;
  }
  if (typeof value.checkedAt !== "string" || !isObjectRecord(value.counts)) {
    return null;
  }
  const issues = Array.isArray(value.issues)
    ? value.issues
        .map(parseIssue)
        .filter((issue): issue is PurchaseReconciliationIssue => issue !== null)
    : [];
  const rawCounts = value.counts as Record<string, unknown>;
  const counts = Object.fromEntries(
    PURCHASE_RECONCILIATION_ISSUE_TYPES.map((issueType) => [
      issueType,
      asInteger(rawCounts[issueType]),
    ]),
  ) as PurchaseReconciliationReport["counts"];
  return {
    status: value.status,
    checkedAt: value.checkedAt,
    totalIssues: asInteger(value.totalIssues),
    counts,
    issues,
  };
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Unavailable";
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function formatCredits(value: number | null) {
  return value === null ? "—" : value.toLocaleString();
}

function providerLabel(value: PurchaseReconciliationIssue["provider"]) {
  if (value === "google_play") {
    return "Google Play";
  }
  if (value === "apple_app_store") {
    return "Apple App Store";
  }
  return "Unknown";
}

export function AdminPurchaseReconciliationSection({
  adminToken,
}: {
  adminToken: string;
}) {
  const [report, setReport] = useState<PurchaseReconciliationReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadPurchaseReconciliation() {
    setIsLoading(true);
    setError("");
    try {
      const headers: Record<string, string> = {};
      if (adminToken.trim()) {
        headers["x-admin-token"] = adminToken.trim();
      }
      const response = await fetch(
        "/api/admin/monetization/reconciliation/purchases",
        {
          method: "GET",
          headers,
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const message = isObjectRecord(payload) ? payload.error : null;
        throw new Error(
          typeof message === "string"
            ? message
            : "Could not load purchase reconciliation monitoring.",
        );
      }
      const parsed = parseReport(payload);
      if (!parsed) {
        throw new Error("Purchase reconciliation response format was invalid.");
      }
      setReport(parsed);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load purchase reconciliation monitoring.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadPurchaseReconciliation();
    // Load once when the Reconciliation tab mounts. Manual Refresh uses the
    // current token value if token-based fallback authentication is in use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const healthy = report?.status === "healthy";

  return (
    <section className="space-y-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1">
          <h3 className="text-base font-semibold text-emerald-950">
            Purchase Reconciliation
          </h3>
          <p className="text-sm leading-6 text-zinc-700">
            Use this when a user reports being charged without receiving the correct credits, or
            when purchase and credit records do not match. This section checks purchase, ledger,
            and balance records for mismatches that may require investigation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadPurchaseReconciliation();
          }}
          disabled={isLoading}
          className="cursor-pointer rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? "Checking..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div
        className={`rounded-2xl border px-4 py-3 ${
          healthy
            ? "border-emerald-200 bg-emerald-50"
            : report
              ? "border-amber-200 bg-amber-50"
              : "border-zinc-200 bg-white"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p
              className={`text-sm font-semibold ${
                healthy
                  ? "text-emerald-800"
                  : report
                    ? "text-amber-900"
                    : "text-zinc-700"
              }`}
            >
              {report ? (healthy ? "Healthy" : "Needs attention") : "Not checked"}
            </p>
            <p className="mt-1 text-2xl font-semibold text-zinc-950">
              {report?.totalIssues ?? 0}
              <span className="ml-2 text-sm font-medium text-zinc-600">
                total issue{report?.totalIssues === 1 ? "" : "s"}
              </span>
            </p>
          </div>
          <p className="text-xs text-zinc-600">
            Last checked: {formatTimestamp(report?.checkedAt ?? null)}
          </p>
        </div>
      </div>

      {report ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-7">
          {PURCHASE_RECONCILIATION_ISSUE_TYPES.map((issueType) => (
            <div
              key={issueType}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2"
            >
              <p className="text-xs font-medium leading-4 text-zinc-600">
                {ISSUE_LABELS[issueType]}
              </p>
              <p className="mt-1 text-lg font-semibold text-zinc-950">
                {report.counts[issueType]}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {report?.status === "healthy" ? (
        <p className="rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">
          No purchase or credit mismatches were detected.
        </p>
      ) : null}

      {report?.status === "needs_attention" ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-zinc-100 text-zinc-700">
              <tr>
                <th className="px-3 py-2 font-semibold">User</th>
                <th className="px-3 py-2 font-semibold">Provider</th>
                <th className="px-3 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 font-semibold">Purchase date</th>
                <th className="px-3 py-2 font-semibold">Issue</th>
                <th className="px-3 py-2 text-right font-semibold">Expected credits</th>
                <th className="px-3 py-2 text-right font-semibold">Recorded credits</th>
                <th className="px-3 py-2 text-right font-semibold">Current balance</th>
                <th className="px-3 py-2 font-semibold">Recommended next step</th>
              </tr>
            </thead>
            <tbody>
              {report.issues.map((issue) => (
                <tr key={issue.id} className="border-t border-zinc-100 align-top text-zinc-800">
                  <td className="px-3 py-3">
                    <p className="font-mono text-xs">{issue.userId}</p>
                    {issue.relatedUserId ? (
                      <p className="mt-1 font-mono text-xs text-amber-700">
                        Ledger: {issue.relatedUserId}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-zinc-500">
                      {issue.maskedProviderTransactionId}
                    </p>
                  </td>
                  <td className="px-3 py-3">{providerLabel(issue.provider)}</td>
                  <td className="px-3 py-3 font-mono text-xs">{issue.productId}</td>
                  <td className="px-3 py-3">{formatTimestamp(issue.purchaseDate)}</td>
                  <td className="px-3 py-3">
                    <p className="font-semibold text-zinc-900">
                      {ISSUE_LABELS[issue.issueType]}
                    </p>
                    <p className="mt-1 max-w-xs text-xs leading-5 text-zinc-600">
                      {issue.explanation}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-right font-medium">
                    {formatCredits(issue.purchaseAmount)}
                  </td>
                  <td className="px-3 py-3 text-right font-medium">
                    {formatCredits(issue.ledgerAmount)}
                  </td>
                  <td className="px-3 py-3 text-right font-medium">
                    {issue.currentBalance.toLocaleString()}
                  </td>
                  <td className="px-3 py-3 text-xs leading-5 text-zinc-700">
                    {issue.recommendedStep}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
