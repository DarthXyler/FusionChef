"use client";

import { useEffect, useState } from "react";

type EnforcementMode = "off" | "observe" | "enforce";

type RuntimeConfig = {
  enabled: boolean;
  enforcementMode: EnforcementMode;
  freeDailyFuseActions: number;
  freeDailyRerollActions: number;
  allowCompActions: boolean;
  updatedAt: string;
  updatedBy: string;
};

type ReconciliationPreviewItem = {
  reservationId: string;
  anonUserId: string;
  actionKind: "fuse" | "reroll";
  amount: number;
  expiresAt: string;
};

type ReconciliationSummary = {
  scanned: number;
  released: number;
  alreadyFinalized: number;
  failed: number;
};

const TOKEN_STORAGE_KEY = "flavor-fusion-admin-token:v1";
const ACTOR_STORAGE_KEY = "flavor-fusion-admin-actor:v1";

const DEFAULT_FORM: RuntimeConfig = {
  enabled: false,
  enforcementMode: "off",
  freeDailyFuseActions: 0,
  freeDailyRerollActions: 0,
  allowCompActions: true,
  updatedAt: "",
  updatedBy: "",
};

function generateIdempotencyKey(scope: string) {
  return `${scope}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    (candidate.enforcementMode === "off" ||
      candidate.enforcementMode === "observe" ||
      candidate.enforcementMode === "enforce") &&
    typeof candidate.freeDailyFuseActions === "number" &&
    Number.isFinite(candidate.freeDailyFuseActions) &&
    typeof candidate.freeDailyRerollActions === "number" &&
    Number.isFinite(candidate.freeDailyRerollActions) &&
    typeof candidate.allowCompActions === "boolean" &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.updatedBy === "string"
  );
}

function isReconciliationPreviewItem(value: unknown): value is ReconciliationPreviewItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.reservationId === "string" &&
    typeof candidate.anonUserId === "string" &&
    (candidate.actionKind === "fuse" || candidate.actionKind === "reroll") &&
    typeof candidate.amount === "number" &&
    Number.isFinite(candidate.amount) &&
    typeof candidate.expiresAt === "string"
  );
}

function isReconciliationSummary(value: unknown): value is ReconciliationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.scanned === "number" &&
    Number.isFinite(candidate.scanned) &&
    typeof candidate.released === "number" &&
    Number.isFinite(candidate.released) &&
    typeof candidate.alreadyFinalized === "number" &&
    Number.isFinite(candidate.alreadyFinalized) &&
    typeof candidate.failed === "number" &&
    Number.isFinite(candidate.failed)
  );
}

function clampDailyLimit(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 20) {
    return 20;
  }
  return normalized;
}

function clampReconciliationLimit(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 1000) {
    return 1000;
  }
  return normalized;
}

function toIsoLabel(value: string) {
  if (!value) {
    return "N/A";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

type Preset = {
  label: string;
  description: string;
  config: Pick<
    RuntimeConfig,
    | "enabled"
    | "enforcementMode"
    | "freeDailyFuseActions"
    | "freeDailyRerollActions"
    | "allowCompActions"
  >;
};

const PRESETS: Preset[] = [
  {
    label: "Off",
    description: "Credits fully disabled for all users.",
    config: {
      enabled: false,
      enforcementMode: "off",
      freeDailyFuseActions: 0,
      freeDailyRerollActions: 0,
      allowCompActions: true,
    },
  },
  {
    label: "Observe",
    description: "Track usage only, no blocking.",
    config: {
      enabled: true,
      enforcementMode: "observe",
      freeDailyFuseActions: 3,
      freeDailyRerollActions: 2,
      allowCompActions: true,
    },
  },
  {
    label: "Enforce",
    description: "Use free daily limits then require credits.",
    config: {
      enabled: true,
      enforcementMode: "enforce",
      freeDailyFuseActions: 3,
      freeDailyRerollActions: 2,
      allowCompActions: true,
    },
  },
];

export function AdminMonetizationConfigPanel() {
  const [adminToken, setAdminToken] = useState("");
  const [adminActor, setAdminActor] = useState("kevin");
  const [form, setForm] = useState<RuntimeConfig>(DEFAULT_FORM);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingReconciliationPreview, setIsLoadingReconciliationPreview] = useState(false);
  const [isRunningReconciliation, setIsRunningReconciliation] = useState(false);
  const [reconciliationMaxCandidates, setReconciliationMaxCandidates] = useState(200);
  const [reconciliationPreview, setReconciliationPreview] = useState<ReconciliationPreviewItem[]>(
    [],
  );
  const [reconciliationSummary, setReconciliationSummary] = useState<ReconciliationSummary | null>(
    null,
  );
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedToken = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    const storedActor = window.sessionStorage.getItem(ACTOR_STORAGE_KEY);
    if (storedToken) {
      setAdminToken(storedToken);
    }
    if (storedActor) {
      setAdminActor(storedActor);
    }
  }, []);

  async function readConfig() {
    const token = adminToken.trim();
    if (!token) {
      setError("Enter your admin token first.");
      return;
    }

    setIsLoading(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/admin/monetization/config", {
        method: "GET",
        headers: {
          "x-admin-token": token,
        },
        cache: "no-store",
      });
      const payload = (await response.json()) as { config?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not load config.",
        );
      }
      if (!isRuntimeConfig(payload.config)) {
        throw new Error("Config response format was invalid.");
      }

      setForm(payload.config);
      setSuccess("Loaded current runtime config.");
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load config.");
    } finally {
      setIsLoading(false);
    }
  }

  async function saveConfig() {
    const token = adminToken.trim();
    const actor = adminActor.trim();
    if (!token) {
      setError("Enter your admin token first.");
      return;
    }
    if (!actor) {
      setError("Enter an actor name (who is making the change).");
      return;
    }

    setIsSaving(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/admin/monetization/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token,
          "x-admin-actor": actor,
          "idempotency-key": generateIdempotencyKey("cfg"),
        },
        body: JSON.stringify({
          enabled: form.enabled,
          enforcementMode: form.enforcementMode,
          freeDailyFuseActions: clampDailyLimit(form.freeDailyFuseActions),
          freeDailyRerollActions: clampDailyLimit(form.freeDailyRerollActions),
          allowCompActions: form.allowCompActions,
        }),
      });

      const payload = (await response.json()) as { config?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not save config.",
        );
      }
      if (!isRuntimeConfig(payload.config)) {
        throw new Error("Config response format was invalid.");
      }

      setForm(payload.config);
      setSuccess("Monetization runtime config saved.");
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        window.sessionStorage.setItem(ACTOR_STORAGE_KEY, actor);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save config.");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadReconciliationPreview(options?: { silent?: boolean }) {
    const token = adminToken.trim();
    if (!token) {
      setError("Enter your admin token first.");
      return;
    }

    const previewLimit = clampReconciliationLimit(reconciliationMaxCandidates);
    setIsLoadingReconciliationPreview(true);
    if (!options?.silent) {
      setError("");
      setSuccess("");
    }

    try {
      const response = await fetch(
        `/api/admin/monetization/reconciliation?previewLimit=${previewLimit}`,
        {
          method: "GET",
          headers: {
            "x-admin-token": token,
          },
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as {
        preview?: unknown;
        expiredCount?: unknown;
        error?: unknown;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not load reconciliation preview.",
        );
      }

      const previewRows = Array.isArray(payload.preview) ? payload.preview : [];
      const validRows = previewRows.filter(isReconciliationPreviewItem);
      setReconciliationPreview(validRows);
      setReconciliationSummary(null);
      if (!options?.silent) {
        setSuccess(`Loaded preview: ${validRows.length} expired reservation(s).`);
      }
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not load preview.");
    } finally {
      setIsLoadingReconciliationPreview(false);
    }
  }

  async function runReconciliationNow() {
    const token = adminToken.trim();
    const actor = adminActor.trim();
    if (!token) {
      setError("Enter your admin token first.");
      return;
    }
    if (!actor) {
      setError("Enter an actor name (who is making the change).");
      return;
    }

    const maxCandidates = clampReconciliationLimit(reconciliationMaxCandidates);
    setIsRunningReconciliation(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(
        `/api/admin/monetization/reconciliation?maxCandidates=${maxCandidates}`,
        {
          method: "POST",
          headers: {
            "x-admin-token": token,
            "x-admin-actor": actor,
            "idempotency-key": generateIdempotencyKey("recon"),
          },
        },
      );
      const payload = (await response.json()) as { summary?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not run reconciliation.",
        );
      }
      if (!isReconciliationSummary(payload.summary)) {
        throw new Error("Reconciliation response format was invalid.");
      }

      setReconciliationSummary(payload.summary);
      setSuccess(
        `Reconciliation complete. Released ${payload.summary.released} of ${payload.summary.scanned} scanned reservation(s).`,
      );
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        window.sessionStorage.setItem(ACTOR_STORAGE_KEY, actor);
      }

      await loadReconciliationPreview({ silent: true });
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Could not run reconciliation.");
    } finally {
      setIsRunningReconciliation(false);
    }
  }

  function applyPreset(preset: Preset) {
    setForm((current) => ({
      ...current,
      ...preset.config,
    }));
    setError("");
    setSuccess(`Preset applied: ${preset.label}`);
  }

  return (
    <div className="mx-auto w-full max-w-3xl animate-rise-in space-y-6">
      <section className="space-y-2 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          Developer
        </p>
        <h1 className="font-serif text-3xl leading-tight text-zinc-900 md:text-4xl">
          Monetization Runtime Control
        </h1>
        <p className="text-zinc-700">
          Configure credits behavior without SQL. This updates runtime values in Turso through the
          secured admin API.
        </p>
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Admin Access</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Admin Token
            <input
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="MONETIZATION_ADMIN_TOKEN"
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Actor
            <input
              type="text"
              value={adminActor}
              onChange={(event) => setAdminActor(event.target.value)}
              placeholder="kevin"
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={readConfig}
            disabled={isLoading}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Loading..." : "Load Current Config"}
          </button>
        </div>
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Quick Presets</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset)}
              className="rounded-2xl border border-zinc-300 bg-zinc-50 p-4 text-left transition hover:border-emerald-400 hover:bg-emerald-50"
            >
              <p className="font-semibold text-zinc-900">{preset.label}</p>
              <p className="mt-1 text-sm text-zinc-600">{preset.description}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Credit Reconciliation</h2>
        <p className="text-sm text-zinc-700">
          Run this manually when users report stuck credits. It releases expired reservations
          immediately, without waiting for scheduled cron.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Max Candidates
            <input
              type="number"
              min={1}
              max={1000}
              value={reconciliationMaxCandidates}
              onChange={(event) =>
                setReconciliationMaxCandidates(
                  clampReconciliationLimit(Number(event.target.value)),
                )
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadReconciliationPreview();
            }}
            disabled={isLoadingReconciliationPreview}
            className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingReconciliationPreview ? "Loading Preview..." : "Preview Expired Reservations"}
          </button>
          <button
            type="button"
            onClick={runReconciliationNow}
            disabled={isRunningReconciliation}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunningReconciliation ? "Running..." : "Run Reconciliation Now"}
          </button>
        </div>

        {reconciliationSummary ? (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
            <p className="font-semibold text-zinc-900">Last Run Summary</p>
            <p>Scanned: {reconciliationSummary.scanned}</p>
            <p>Released: {reconciliationSummary.released}</p>
            <p>Already Finalized: {reconciliationSummary.alreadyFinalized}</p>
            <p>Failed: {reconciliationSummary.failed}</p>
          </div>
        ) : null}

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-zinc-900">
            Expired Reservation Preview ({reconciliationPreview.length})
          </p>
          {reconciliationPreview.length === 0 ? (
            <p className="text-sm text-zinc-700">No expired reservations found in the current preview.</p>
          ) : (
            <div className="max-h-56 overflow-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Reservation</th>
                    <th className="px-3 py-2 font-semibold">User</th>
                    <th className="px-3 py-2 font-semibold">Action</th>
                    <th className="px-3 py-2 font-semibold">Amount</th>
                    <th className="px-3 py-2 font-semibold">Expired At</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliationPreview.map((item) => (
                    <tr key={item.reservationId} className="border-t border-zinc-100 text-zinc-800">
                      <td className="px-3 py-2 font-mono text-xs">{item.reservationId}</td>
                      <td className="px-3 py-2 font-mono text-xs">{item.anonUserId}</td>
                      <td className="px-3 py-2">{item.actionKind}</td>
                      <td className="px-3 py-2">{item.amount}</td>
                      <td className="px-3 py-2">{toIsoLabel(item.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Runtime Settings</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="flex items-center gap-3 rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-900">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              className="h-4 w-4 accent-emerald-600"
            />
            Credits Enabled
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Enforcement Mode
            <select
              value={form.enforcementMode}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  enforcementMode: event.target.value as EnforcementMode,
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            >
              <option value="off">off (disabled)</option>
              <option value="observe">observe (track only)</option>
              <option value="enforce">enforce (block when no credits)</option>
            </select>
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Free Daily Fuse Actions
            <input
              type="number"
              min={0}
              max={20}
              value={form.freeDailyFuseActions}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  freeDailyFuseActions: clampDailyLimit(Number(event.target.value)),
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Free Daily Reroll Actions
            <input
              type="number"
              min={0}
              max={20}
              value={form.freeDailyRerollActions}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  freeDailyRerollActions: clampDailyLimit(Number(event.target.value)),
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>

          <label className="flex items-center gap-3 rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-900 md:col-span-2">
            <input
              type="checkbox"
              checked={form.allowCompActions}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowCompActions: event.target.checked }))
              }
              className="h-4 w-4 accent-emerald-600"
            />
            Allow compensation actions (manual credit grants)
          </label>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <p>
            Last updated: <span className="font-semibold text-zinc-900">{toIsoLabel(form.updatedAt)}</span>
          </p>
          <p>
            Updated by: <span className="font-semibold text-zinc-900">{form.updatedBy || "N/A"}</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={saveConfig}
            disabled={isSaving}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Save Config"}
          </button>
          <button
            type="button"
            onClick={readConfig}
            disabled={isLoading}
            className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh
          </button>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {success}
          </p>
        ) : null}
      </section>
    </div>
  );
}
