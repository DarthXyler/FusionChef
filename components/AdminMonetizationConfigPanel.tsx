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

type ObserveRuntime = {
  enabled: boolean;
  enforcementMode: EnforcementMode;
  freeDailyFuseActions: number;
  freeDailyRerollActions: number;
};

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

type PanelKey =
  | "adminAccess"
  | "quickPresets"
  | "observeAnalytics"
  | "reconciliation"
  | "runtimeSettings";

type PanelNoticeState = {
  error: string;
  success: string;
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

const DEFAULT_OBSERVE_RUNTIME: ObserveRuntime = {
  enabled: false,
  enforcementMode: "off",
  freeDailyFuseActions: 0,
  freeDailyRerollActions: 0,
};

const DEFAULT_OBSERVE_SNAPSHOT: ObserveSnapshot24h = {
  fuseActions: 0,
  rerollActions: 0,
  totalActions: 0,
  uniqueUsers: 0,
};

const DEFAULT_OBSERVE_TODAY: ObserveTodayEstimate = {
  overQuotaActions: 0,
  estimatedBlockedActions: 0,
  wouldBlockPercentage: 0,
};

const DEFAULT_PANEL_NOTICES: Record<PanelKey, PanelNoticeState> = {
  adminAccess: { error: "", success: "" },
  quickPresets: { error: "", success: "" },
  observeAnalytics: { error: "", success: "" },
  reconciliation: { error: "", success: "" },
  runtimeSettings: { error: "", success: "" },
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

function toNumber(value: unknown, fallback = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function toInteger(value: unknown, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

function maskAnonUserId(value: string) {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
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

function isObserveRuntime(value: unknown): value is ObserveRuntime {
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
    Number.isFinite(candidate.freeDailyRerollActions)
  );
}

function isObserveSnapshot24h(value: unknown): value is ObserveSnapshot24h {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fuseActions === "number" &&
    typeof candidate.rerollActions === "number" &&
    typeof candidate.totalActions === "number" &&
    typeof candidate.uniqueUsers === "number"
  );
}

function isObserveTodayEstimate(value: unknown): value is ObserveTodayEstimate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.overQuotaActions === "number" &&
    typeof candidate.estimatedBlockedActions === "number" &&
    typeof candidate.wouldBlockPercentage === "number"
  );
}

function isObserveTrendRow(value: unknown): value is ObserveTrendRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.dayKey === "string" &&
    typeof candidate.fuseActions === "number" &&
    typeof candidate.rerollActions === "number" &&
    typeof candidate.totalActions === "number" &&
    typeof candidate.uniqueUsers === "number" &&
    typeof candidate.overQuotaActions === "number" &&
    typeof candidate.estimatedBlockedActions === "number" &&
    typeof candidate.wouldBlockPercentage === "number"
  );
}

function isObserveTopUserRow(value: unknown): value is ObserveTopUserRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.anonUserId === "string" &&
    typeof candidate.fuseCount === "number" &&
    typeof candidate.rerollCount === "number" &&
    typeof candidate.totalActions === "number" &&
    typeof candidate.availableCredits === "number" &&
    typeof candidate.overQuotaActions === "number" &&
    typeof candidate.estimatedBlockedActions === "number" &&
    typeof candidate.wouldBlockNow === "boolean"
  );
}

function isPresetActive(preset: Preset, current: RuntimeConfig) {
  return (
    current.enabled === preset.config.enabled &&
    current.enforcementMode === preset.config.enforcementMode &&
    current.freeDailyFuseActions === preset.config.freeDailyFuseActions &&
    current.freeDailyRerollActions === preset.config.freeDailyRerollActions &&
    current.allowCompActions === preset.config.allowCompActions
  );
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
  const [isLoadingObserveReport, setIsLoadingObserveReport] = useState(false);
  const [observeGeneratedAt, setObserveGeneratedAt] = useState("");
  const [observeTimezone, setObserveTimezone] = useState("UTC");
  const [observeTodayDayKey, setObserveTodayDayKey] = useState("");
  const [observeRuntime, setObserveRuntime] = useState<ObserveRuntime>(DEFAULT_OBSERVE_RUNTIME);
  const [observeSnapshot24h, setObserveSnapshot24h] =
    useState<ObserveSnapshot24h>(DEFAULT_OBSERVE_SNAPSHOT);
  const [observeTodayEstimate, setObserveTodayEstimate] =
    useState<ObserveTodayEstimate>(DEFAULT_OBSERVE_TODAY);
  const [observeTrend, setObserveTrend] = useState<ObserveTrendRow[]>([]);
  const [observeTopUsers, setObserveTopUsers] = useState<ObserveTopUserRow[]>([]);
  const [panelNotices, setPanelNotices] =
    useState<Record<PanelKey, PanelNoticeState>>(DEFAULT_PANEL_NOTICES);

  function clearPanelNotice(panelKey: PanelKey) {
    setPanelNotices((current) => ({
      ...current,
      [panelKey]: { error: "", success: "" },
    }));
  }

  function setPanelError(panelKey: PanelKey, message: string) {
    setPanelNotices((current) => ({
      ...current,
      [panelKey]: { error: message, success: "" },
    }));
  }

  function setPanelSuccess(panelKey: PanelKey, message: string) {
    setPanelNotices((current) => ({
      ...current,
      [panelKey]: { error: "", success: message },
    }));
  }

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

  async function readConfig(origin: "adminAccess" | "runtimeSettings" = "adminAccess") {
    const token = adminToken.trim();
    if (!token) {
      setPanelError(origin, "Enter your admin token first.");
      return;
    }

    setIsLoading(true);
    clearPanelNotice(origin);

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
      setPanelSuccess(origin, "Loaded current runtime config.");
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
      await loadObserveReport({ silent: true });
    } catch (loadError) {
      setPanelError(origin, loadError instanceof Error ? loadError.message : "Could not load config.");
    } finally {
      setIsLoading(false);
    }
  }

  async function saveConfig() {
    const token = adminToken.trim();
    const actor = adminActor.trim();
    if (!token) {
      setPanelError("runtimeSettings", "Enter your admin token first.");
      return;
    }
    if (!actor) {
      setPanelError("runtimeSettings", "Enter an actor name (who is making the change).");
      return;
    }

    setIsSaving(true);
    clearPanelNotice("runtimeSettings");

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
      setPanelSuccess("runtimeSettings", "Monetization runtime config saved.");
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        window.sessionStorage.setItem(ACTOR_STORAGE_KEY, actor);
      }
      await loadObserveReport({ silent: true });
    } catch (saveError) {
      setPanelError(
        "runtimeSettings",
        saveError instanceof Error ? saveError.message : "Could not save config.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function loadObserveReport(options?: { silent?: boolean }) {
    const token = adminToken.trim();
    if (!token) {
      if (!options?.silent) {
        setPanelError("observeAnalytics", "Enter your admin token first.");
      }
      return;
    }

    setIsLoadingObserveReport(true);
    if (!options?.silent) {
      clearPanelNotice("observeAnalytics");
    }

    try {
      const response = await fetch(
        "/api/admin/monetization/observe-report?trendDays=7&topUsersLimit=10",
        {
          method: "GET",
          headers: {
            "x-admin-token": token,
          },
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as {
        runtime?: unknown;
        generatedAt?: unknown;
        timezone?: unknown;
        todayDayKey?: unknown;
        snapshot24h?: unknown;
        todayEstimate?: unknown;
        trend?: unknown;
        topUsers?: unknown;
        error?: unknown;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : "Could not load observe analytics.",
        );
      }
      if (
        !isObserveRuntime(payload.runtime) ||
        !isObserveSnapshot24h(payload.snapshot24h) ||
        !isObserveTodayEstimate(payload.todayEstimate)
      ) {
        throw new Error("Observe analytics response format was invalid.");
      }

      const trendRows = Array.isArray(payload.trend) ? payload.trend.filter(isObserveTrendRow) : [];
      const topUserRows = Array.isArray(payload.topUsers)
        ? payload.topUsers.filter(isObserveTopUserRow)
        : [];

      setObserveRuntime(payload.runtime);
      setObserveSnapshot24h(payload.snapshot24h);
      setObserveTodayEstimate(payload.todayEstimate);
      setObserveTrend(trendRows);
      setObserveTopUsers(topUserRows);
      setObserveGeneratedAt(typeof payload.generatedAt === "string" ? payload.generatedAt : "");
      setObserveTimezone(typeof payload.timezone === "string" ? payload.timezone : "UTC");
      setObserveTodayDayKey(typeof payload.todayDayKey === "string" ? payload.todayDayKey : "");

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
      if (!options?.silent) {
        setPanelSuccess("observeAnalytics", "Observe analytics loaded.");
      }
    } catch (observeError) {
      if (!options?.silent) {
        setPanelError(
          "observeAnalytics",
          observeError instanceof Error
            ? observeError.message
            : "Could not load observe analytics.",
        );
      }
    } finally {
      setIsLoadingObserveReport(false);
    }
  }

  async function loadReconciliationPreview(options?: { silent?: boolean }) {
    const token = adminToken.trim();
    if (!token) {
      if (!options?.silent) {
        setPanelError("reconciliation", "Enter your admin token first.");
      }
      return;
    }

    const previewLimit = clampReconciliationLimit(reconciliationMaxCandidates);
    setIsLoadingReconciliationPreview(true);
    if (!options?.silent) {
      clearPanelNotice("reconciliation");
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
        setPanelSuccess("reconciliation", `Loaded preview: ${validRows.length} expired reservation(s).`);
      }
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
    } catch (previewError) {
      if (!options?.silent) {
        setPanelError(
          "reconciliation",
          previewError instanceof Error ? previewError.message : "Could not load preview.",
        );
      }
    } finally {
      setIsLoadingReconciliationPreview(false);
    }
  }

  async function runReconciliationNow() {
    const token = adminToken.trim();
    const actor = adminActor.trim();
    if (!token) {
      setPanelError("reconciliation", "Enter your admin token first.");
      return;
    }
    if (!actor) {
      setPanelError("reconciliation", "Enter an actor name (who is making the change).");
      return;
    }

    const maxCandidates = clampReconciliationLimit(reconciliationMaxCandidates);
    setIsRunningReconciliation(true);
    clearPanelNotice("reconciliation");

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
      setPanelSuccess(
        "reconciliation",
        `Reconciliation complete. Released ${payload.summary.released} of ${payload.summary.scanned} scanned reservation(s).`,
      );
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        window.sessionStorage.setItem(ACTOR_STORAGE_KEY, actor);
      }

      await loadReconciliationPreview({ silent: true });
    } catch (runError) {
      setPanelError(
        "reconciliation",
        runError instanceof Error ? runError.message : "Could not run reconciliation.",
      );
    } finally {
      setIsRunningReconciliation(false);
    }
  }

  function applyPreset(preset: Preset) {
    setForm((current) => ({
      ...current,
      ...preset.config,
    }));
    setPanelSuccess("quickPresets", `Preset applied: ${preset.label}`);
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
            onClick={() => {
              void readConfig("adminAccess");
            }}
            disabled={isLoading}
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Loading..." : "Load Current Config"}
          </button>
        </div>
        {panelNotices.adminAccess.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.adminAccess.error}
          </p>
        ) : null}
        {panelNotices.adminAccess.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.adminAccess.success}
          </p>
        ) : null}
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Quick Presets</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {PRESETS.map((preset) => {
            const active = isPresetActive(preset, form);
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                className={[
                  "cursor-pointer rounded-2xl border p-4 text-left transition",
                  active
                    ? "border-emerald-700 bg-emerald-600"
                    : "border-zinc-300 bg-zinc-50 hover:border-emerald-400 hover:bg-emerald-50",
                ].join(" ")}
              >
                <p className={active ? "font-semibold text-white" : "font-semibold text-zinc-900"}>
                  {preset.label}
                </p>
                <p className={active ? "mt-1 text-sm text-emerald-50" : "mt-1 text-sm text-zinc-600"}>
                  {preset.description}
                </p>
              </button>
            );
          })}
        </div>
        {panelNotices.quickPresets.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.quickPresets.error}
          </p>
        ) : null}
        {panelNotices.quickPresets.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.quickPresets.success}
          </p>
        ) : null}
      </section>

      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-emerald-900">Observe Analytics</h2>
            <p className="text-sm text-zinc-700">
              Readiness report for credits enforcement. In observe mode this does not block users.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadObserveReport();
            }}
            disabled={isLoadingObserveReport}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingObserveReport ? "Refreshing..." : "Refresh Analytics"}
          </button>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <p>
            Runtime Mode:{" "}
            <span className="font-semibold text-zinc-900">{observeRuntime.enforcementMode}</span>
            {" | "}Enabled:{" "}
            <span className="font-semibold text-zinc-900">
              {observeRuntime.enabled ? "true" : "false"}
            </span>
          </p>
          <p>
            Free Daily Limits:{" "}
            <span className="font-semibold text-zinc-900">
              Fuse {toInteger(observeRuntime.freeDailyFuseActions)} / Reroll{" "}
              {toInteger(observeRuntime.freeDailyRerollActions)}
            </span>
          </p>
          <p>
            Last Updated:{" "}
            <span className="font-semibold text-zinc-900">{toIsoLabel(observeGeneratedAt)}</span>
            {" | "}Timezone: <span className="font-semibold text-zinc-900">{observeTimezone}</span>
            {" | "}Day Key: <span className="font-semibold text-zinc-900">{observeTodayDayKey || "N/A"}</span>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Fuse (24h)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeSnapshot24h.fuseActions}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Reroll (24h)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeSnapshot24h.rerollActions}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Unique Users (24h)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeSnapshot24h.uniqueUsers}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Estimated Paywall Hits % (Today)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeTodayEstimate.wouldBlockPercentage}%</p>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <p>
            Over-Quota Actions (Today):{" "}
            <span className="font-semibold text-zinc-900">{observeTodayEstimate.overQuotaActions}</span>
          </p>
          <p>
            Estimated Paywall Hits (Today):{" "}
            <span className="font-semibold text-zinc-900">{observeTodayEstimate.estimatedBlockedActions}</span>
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">
            Daily Trend
          </h3>
          <p className="text-sm text-zinc-700">
            Day-by-day action volume and estimated paywall pressure based on current free limits.
          </p>
          {observeTrend.length === 0 ? (
            <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              No trend data yet.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Day</th>
                    <th className="px-3 py-2 font-semibold">Fuse</th>
                    <th className="px-3 py-2 font-semibold">Reroll</th>
                    <th className="px-3 py-2 font-semibold">Total</th>
                    <th className="px-3 py-2 font-semibold">Users</th>
                    <th className="px-3 py-2 font-semibold">Over Quota</th>
                    <th className="px-3 py-2 font-semibold">Estimated Paywall Hits</th>
                    <th className="px-3 py-2 font-semibold">Paywall Hit %</th>
                  </tr>
                </thead>
                <tbody>
                  {observeTrend.map((row) => (
                    <tr key={row.dayKey} className="border-t border-zinc-100 text-zinc-800">
                      <td className="px-3 py-2 font-semibold">{row.dayKey}</td>
                      <td className="px-3 py-2">{row.fuseActions}</td>
                      <td className="px-3 py-2">{row.rerollActions}</td>
                      <td className="px-3 py-2">{row.totalActions}</td>
                      <td className="px-3 py-2">{row.uniqueUsers}</td>
                      <td className="px-3 py-2">{row.overQuotaActions}</td>
                      <td className="px-3 py-2">{row.estimatedBlockedActions}</td>
                      <td className="px-3 py-2">{row.wouldBlockPercentage}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">
            Top Pressure Users (Today)
          </h3>
          <p className="text-sm text-zinc-700">
            Users most likely to hit credit limits today, useful for tuning free limits and support actions.
          </p>
          {observeTopUsers.length === 0 ? (
            <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              No user pressure data yet.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    <th className="px-3 py-2 font-semibold">User</th>
                    <th className="px-3 py-2 font-semibold">Fuse</th>
                    <th className="px-3 py-2 font-semibold">Reroll</th>
                    <th className="px-3 py-2 font-semibold">Total</th>
                    <th className="px-3 py-2 font-semibold">Available Credits</th>
                    <th className="px-3 py-2 font-semibold">Over Quota</th>
                    <th className="px-3 py-2 font-semibold">Est. Paywall Hits</th>
                    <th className="px-3 py-2 font-semibold">Paywall Hit Now</th>
                  </tr>
                </thead>
                <tbody>
                  {observeTopUsers.map((row) => (
                    <tr key={row.anonUserId} className="border-t border-zinc-100 text-zinc-800">
                      <td className="px-3 py-2 font-mono text-xs">{maskAnonUserId(row.anonUserId)}</td>
                      <td className="px-3 py-2">{row.fuseCount}</td>
                      <td className="px-3 py-2">{row.rerollCount}</td>
                      <td className="px-3 py-2">{row.totalActions}</td>
                      <td className="px-3 py-2">{row.availableCredits}</td>
                      <td className="px-3 py-2">{row.overQuotaActions}</td>
                      <td className="px-3 py-2">{row.estimatedBlockedActions}</td>
                      <td className="px-3 py-2">
                        {row.wouldBlockNow ? (
                          <span className="rounded-lg bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
                            Yes
                          </span>
                        ) : (
                          <span className="rounded-lg bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-700">
                            No
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {panelNotices.observeAnalytics.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.observeAnalytics.error}
          </p>
        ) : null}
        {panelNotices.observeAnalytics.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.observeAnalytics.success}
          </p>
        ) : null}
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
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingReconciliationPreview ? "Loading Preview..." : "Preview Expired Reservations"}
          </button>
          <button
            type="button"
            onClick={runReconciliationNow}
            disabled={isRunningReconciliation}
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
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
        {panelNotices.reconciliation.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.reconciliation.error}
          </p>
        ) : null}
        {panelNotices.reconciliation.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.reconciliation.success}
          </p>
        ) : null}
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
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Save Config"}
          </button>
          <button
            type="button"
            onClick={() => {
              void readConfig("runtimeSettings");
            }}
            disabled={isLoading}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh
          </button>
        </div>
        {panelNotices.runtimeSettings.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.runtimeSettings.error}
          </p>
        ) : null}
        {panelNotices.runtimeSettings.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.runtimeSettings.success}
          </p>
        ) : null}
      </section>
    </div>
  );
}
