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

function generateIdempotencyKey() {
  return `cfg-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
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
          "idempotency-key": generateIdempotencyKey(),
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

