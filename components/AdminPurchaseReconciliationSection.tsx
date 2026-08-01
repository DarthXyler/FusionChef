"use client";

import { useEffect, useState } from "react";
import {
  PURCHASE_RECONCILIATION_ISSUE_TYPES,
  type PurchaseReconciliationIssue,
  type PurchaseReconciliationIssueType,
  type PurchaseReconciliationReport,
} from "@/lib/monetization-purchase-reconciliation";
import type {
  PurchaseResolutionPreview,
  PurchaseResolutionResult,
} from "@/lib/monetization-purchase-reconciliation-actions";

const ISSUE_LABELS: Record<PurchaseReconciliationIssueType, string> = {
  purchase_missing_grant: "Purchase missing grant",
  grant_missing_purchase: "Grant missing purchase",
  missing_purchase_ledger_link: "Missing purchase-ledger link",
  credit_amount_mismatch: "Credit amount mismatch",
  owner_mismatch: "Owner mismatch",
  duplicate_grant: "Duplicate grant",
  product_or_transaction_conflict: "Product or transaction conflict",
};

const AUTOMATIC_ISSUES = new Set<PurchaseReconciliationIssueType>([
  "purchase_missing_grant",
  "grant_missing_purchase",
  "missing_purchase_ledger_link",
  "credit_amount_mismatch",
]);

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

function parsePreview(value: unknown): PurchaseResolutionPreview | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const issueType = value.issueType as PurchaseReconciliationIssueType;
  const provider = value.provider;
  const verificationStatus = value.providerVerificationStatus;
  if (
    typeof value.issueId !== "string" ||
    !PURCHASE_RECONCILIATION_ISSUE_TYPES.includes(issueType) ||
    typeof value.maskedProviderTransactionId !== "string" ||
    typeof value.userId !== "string" ||
    (provider !== "apple_app_store" &&
      provider !== "google_play" &&
      provider !== "unknown") ||
    typeof value.productId !== "string" ||
    typeof value.currentBalance !== "number" ||
    typeof value.proposedCreditDelta !== "number" ||
    typeof value.resultingBalance !== "number" ||
    (verificationStatus !== "verified" &&
      verificationStatus !== "not_required" &&
      verificationStatus !== "failed") ||
    typeof value.automaticResolutionSupported !== "boolean" ||
    (value.manualInvestigationReason !== null &&
      typeof value.manualInvestigationReason !== "string") ||
    typeof value.requiredConfirmationPhrase !== "string" ||
    typeof value.previewFingerprint !== "string" ||
    typeof value.previewExpiresAt !== "string"
  ) {
    return null;
  }
  return {
    issueId: value.issueId,
    issueType,
    maskedProviderTransactionId: value.maskedProviderTransactionId,
    userId: value.userId,
    provider,
    productId: value.productId,
    currentBalance: Math.trunc(value.currentBalance),
    expectedCredits: asNullableInteger(value.expectedCredits),
    recordedCredits: asNullableInteger(value.recordedCredits),
    proposedCreditDelta: Math.trunc(value.proposedCreditDelta),
    resultingBalance: Math.trunc(value.resultingBalance),
    providerVerificationStatus: verificationStatus,
    automaticResolutionSupported: value.automaticResolutionSupported,
    manualInvestigationReason: value.manualInvestigationReason,
    requiredConfirmationPhrase: value.requiredConfirmationPhrase,
    previewFingerprint: value.previewFingerprint,
    previewExpiresAt: value.previewExpiresAt,
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

function formatDelta(value: number) {
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
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

function responseError(value: unknown, fallback: string) {
  return isObjectRecord(value) && typeof value.error === "string"
    ? value.error
    : fallback;
}

export function AdminPurchaseReconciliationSection({
  adminToken,
  adminActor,
}: {
  adminToken: string;
  adminActor: string;
}) {
  const [report, setReport] = useState<PurchaseReconciliationReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedIssue, setSelectedIssue] =
    useState<PurchaseReconciliationIssue | null>(null);
  const [preview, setPreview] = useState<PurchaseResolutionPreview | null>(null);
  const [googlePurchaseToken, setGooglePurchaseToken] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [resolutionError, setResolutionError] = useState("");
  const [resolutionSuccess, setResolutionSuccess] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isResolving, setIsResolving] = useState(false);

  function adminHeaders(includeActor = false) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (adminToken.trim()) {
      headers["x-admin-token"] = adminToken.trim();
    }
    if (includeActor && adminActor.trim()) {
      headers["x-admin-actor"] = adminActor.trim();
    }
    return headers;
  }

  async function loadPurchaseReconciliation() {
    setIsLoading(true);
    setError("");
    try {
      const headers = adminHeaders();
      delete headers["content-type"];
      const response = await fetch(
        "/api/admin/monetization/reconciliation/purchases",
        { method: "GET", headers, cache: "no-store" },
      );
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(
          responseError(payload, "Could not load purchase reconciliation monitoring."),
        );
      }
      const parsed = parseReport(payload);
      if (!parsed) {
        throw new Error("Purchase reconciliation response format was invalid.");
      }
      setReport(parsed);
      if (
        selectedIssue &&
        !parsed.issues.some((issue) => issue.id === selectedIssue.id)
      ) {
        setSelectedIssue(null);
        setPreview(null);
      }
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

  function reviewIssue(issue: PurchaseReconciliationIssue) {
    setSelectedIssue(issue);
    setPreview(null);
    setGooglePurchaseToken("");
    setReason("");
    setConfirmation("");
    setResolutionError("");
    setResolutionSuccess("");
  }

  async function generatePreview() {
    if (!selectedIssue) {
      return;
    }
    setIsPreviewing(true);
    setPreview(null);
    setReason("");
    setConfirmation("");
    setResolutionError("");
    setResolutionSuccess("");
    try {
      const response = await fetch(
        "/api/admin/monetization/reconciliation/purchases/preview",
        {
          method: "POST",
          headers: adminHeaders(),
          cache: "no-store",
          body: JSON.stringify({
            issueId: selectedIssue.id,
            googlePurchaseToken: googlePurchaseToken.trim() || undefined,
          }),
        },
      );
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(responseError(payload, "Could not generate the resolution preview."));
      }
      const parsed = parsePreview(payload);
      if (!parsed) {
        throw new Error("Purchase resolution preview response format was invalid.");
      }
      setPreview(parsed);
    } catch (previewError) {
      setResolutionError(
        previewError instanceof Error
          ? previewError.message
          : "Could not generate the resolution preview.",
      );
    } finally {
      // Provider credentials remain transient and must not linger in component state.
      setGooglePurchaseToken("");
      setIsPreviewing(false);
    }
  }

  async function commitResolution() {
    if (!selectedIssue || !preview || !preview.automaticResolutionSupported) {
      return;
    }
    setIsResolving(true);
    setResolutionError("");
    setResolutionSuccess("");
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch(
        "/api/admin/monetization/reconciliation/purchases/resolve",
        {
          method: "POST",
          headers: {
            ...adminHeaders(true),
            "idempotency-key": idempotencyKey,
          },
          cache: "no-store",
          body: JSON.stringify({
            issueId: selectedIssue.id,
            previewFingerprint: preview.previewFingerprint,
            confirmation,
            reason,
            googlePurchaseToken: googlePurchaseToken.trim() || undefined,
          }),
        },
      );
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(responseError(payload, "Could not complete the resolution."));
      }
      const result = payload as PurchaseResolutionResult;
      setResolutionSuccess(
        `${result.status === "replayed" ? "Confirmed" : "Completed"} action ${
          result.actionId
        }; credit delta ${formatDelta(result.creditDelta)}.`,
      );
      setPreview(null);
      setConfirmation("");
      setReason("");
      await loadPurchaseReconciliation();
    } catch (resolveError) {
      setResolutionError(
        resolveError instanceof Error
          ? resolveError.message
          : "Could not complete the resolution.",
      );
    } finally {
      // Require a fresh Google token for every provider verification attempt.
      setGooglePurchaseToken("");
      setIsResolving(false);
    }
  }

  useEffect(() => {
    void loadPurchaseReconciliation();
    // Load once when the Reconciliation tab mounts. Manual Refresh uses the
    // current fallback credentials when token authentication is in use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const healthy = report?.status === "healthy";
  const needsGoogleToken =
    selectedIssue?.provider === "google_play" &&
    selectedIssue.issueType !== "missing_purchase_ledger_link";
  const canCommit = Boolean(
    preview?.automaticResolutionSupported &&
      reason.trim().length >= 10 &&
      confirmation === preview.requiredConfirmationPhrase &&
      (!needsGoogleToken || googlePurchaseToken.trim()),
  );

  return (
    <section className="space-y-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1">
          <h3 className="text-base font-semibold text-emerald-950">
            Purchase Reconciliation
          </h3>
          <p className="text-sm leading-6 text-zinc-700">
            Use this when a user reports being charged without receiving the correct credits, or
            when purchase and credit records do not match. Every supported correction requires a
            fresh server preview, explicit confirmation, and a permanent audit record.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadPurchaseReconciliation()}
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
            <p className={`text-sm font-semibold ${healthy ? "text-emerald-800" : report ? "text-amber-900" : "text-zinc-700"}`}>
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
            <div key={issueType} className="rounded-xl border border-zinc-200 bg-white px-3 py-2">
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

      {selectedIssue ? (
        <div className="space-y-4 rounded-2xl border border-emerald-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-emerald-950">Review resolution</p>
              <p className="mt-1 text-xs text-zinc-600">
                {ISSUE_LABELS[selectedIssue.issueType]} · {selectedIssue.maskedProviderTransactionId}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedIssue(null);
                setPreview(null);
                setGooglePurchaseToken("");
              }}
              className="cursor-pointer text-sm font-semibold text-zinc-600 hover:text-zinc-900"
            >
              Close
            </button>
          </div>

          {needsGoogleToken ? (
            <label className="block space-y-1 text-sm font-medium text-zinc-800">
              Google purchase token (required for each verification)
              <input
                type="password"
                autoComplete="off"
                value={googlePurchaseToken}
                onChange={(event) => setGooglePurchaseToken(event.target.value)}
                className="w-full rounded-xl border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
              />
              <span className="block text-xs font-normal text-zinc-500">
                The token is sent only for provider verification and is cleared after the request.
              </span>
            </label>
          ) : null}

          <button
            type="button"
            onClick={() => void generatePreview()}
            disabled={isPreviewing || (needsGoogleToken && !googlePurchaseToken.trim())}
            className="cursor-pointer rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPreviewing ? "Verifying..." : "Generate server preview"}
          </button>

          {preview ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ["Current balance", preview.currentBalance],
                  ["Expected credits", preview.expectedCredits],
                  ["Recorded credits", preview.recordedCredits],
                  ["Credit delta", formatDelta(preview.proposedCreditDelta)],
                  ["Resulting balance", preview.resultingBalance],
                  ["Provider check", preview.providerVerificationStatus.replace("_", " ")],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
                    <p className="text-xs text-zinc-600">{label}</p>
                    <p className="mt-1 font-semibold text-zinc-950">
                      {value === null ? "—" : String(value)}
                    </p>
                  </div>
                ))}
              </div>

              {!preview.automaticResolutionSupported ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                  {preview.manualInvestigationReason ?? "Manual investigation required"}
                </p>
              ) : (
                <div className="space-y-3 rounded-xl border border-zinc-200 p-3">
                  <p className="text-xs text-zinc-600">
                    Preview expires {formatTimestamp(preview.previewExpiresAt)}. The database and provider facts are checked again before commit.
                  </p>
                  <label className="block space-y-1 text-sm font-medium text-zinc-800">
                    Admin reason (10–500 characters)
                    <textarea
                      value={reason}
                      maxLength={500}
                      onChange={(event) => setReason(event.target.value)}
                      className="min-h-20 w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                    />
                  </label>
                  <label className="block space-y-1 text-sm font-medium text-zinc-800">
                    Type <span className="font-mono text-xs">{preview.requiredConfirmationPhrase}</span>
                    <input
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      className="w-full rounded-xl border border-zinc-300 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
                    />
                  </label>
                  {needsGoogleToken ? (
                    <p className="text-xs text-zinc-600">
                      Re-enter the Google purchase token above for the commit-time provider check.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void commitResolution()}
                    disabled={!canCommit || isResolving}
                    className="cursor-pointer rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isResolving ? "Committing..." : "Commit audited resolution"}
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {resolutionError ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {resolutionError}
            </p>
          ) : null}
          {resolutionSuccess ? (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {resolutionSuccess}
            </p>
          ) : null}
        </div>
      ) : null}

      {report?.status === "healthy" ? (
        <p className="rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-800">
          No purchase or credit mismatches were detected.
        </p>
      ) : null}

      {report?.status === "needs_attention" ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[1240px] text-left text-sm">
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
                <th className="px-3 py-2 font-semibold">Resolution</th>
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
                    <p className="font-semibold text-zinc-900">{ISSUE_LABELS[issue.issueType]}</p>
                    <p className="mt-1 max-w-xs text-xs leading-5 text-zinc-600">{issue.explanation}</p>
                  </td>
                  <td className="px-3 py-3 text-right font-medium">{formatCredits(issue.purchaseAmount)}</td>
                  <td className="px-3 py-3 text-right font-medium">{formatCredits(issue.ledgerAmount)}</td>
                  <td className="px-3 py-3 text-right font-medium">{issue.currentBalance.toLocaleString()}</td>
                  <td className="px-3 py-3 text-xs leading-5 text-zinc-700">
                    {AUTOMATIC_ISSUES.has(issue.issueType) ? (
                      <button
                        type="button"
                        onClick={() => reviewIssue(issue)}
                        className="cursor-pointer rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-900 hover:bg-emerald-100"
                      >
                        Review resolution
                      </button>
                    ) : (
                      <span className="font-semibold text-amber-800">Manual investigation required</span>
                    )}
                    <p className="mt-2 max-w-xs">{issue.recommendedStep}</p>
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
