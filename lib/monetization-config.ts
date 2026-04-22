/**
 * Monetization runtime config storage.
 * Backed by Turso so we can safely change behavior without app redeploys.
 */
import { executeTurso } from "@/lib/turso";

const GLOBAL_CONFIG_KEY = "global";
const DEFAULT_MAX_FREE_DAILY_ACTIONS = 20;

let schemaReady: Promise<void> | null = null;

export type MonetizationEnforcementMode = "off" | "observe" | "enforce";

export type MonetizationRuntimeConfig = {
  enabled: boolean;
  enforcementMode: MonetizationEnforcementMode;
  freeDailyFuseActions: number;
  freeDailyRerollActions: number;
  allowCompActions: boolean;
  updatedAt: string;
  updatedBy: string;
};

export type MonetizationRuntimeConfigPatch = Partial<
  Pick<
    MonetizationRuntimeConfig,
    | "enabled"
    | "enforcementMode"
    | "freeDailyFuseActions"
    | "freeDailyRerollActions"
    | "allowCompActions"
  >
>;

export class MonetizationConfigValidationError extends Error {}

type MonetizationConfigRow = {
  config_json: string;
  updated_at: string;
  updated_by: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPositiveInteger(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return fallback;
  }
  return Math.min(normalized, DEFAULT_MAX_FREE_DAILY_ACTIONS);
}

function normalizeConfig(raw: unknown, updatedAt: string, updatedBy: string): MonetizationRuntimeConfig {
  if (!isObjectRecord(raw)) {
    return {
      enabled: false,
      enforcementMode: "off",
      freeDailyFuseActions: 0,
      freeDailyRerollActions: 0,
      allowCompActions: true,
      updatedAt,
      updatedBy,
    };
  }

  const enforcementMode =
    raw.enforcementMode === "off" ||
    raw.enforcementMode === "observe" ||
    raw.enforcementMode === "enforce"
      ? raw.enforcementMode
      : "off";

  return {
    enabled: raw.enabled === true,
    enforcementMode,
    freeDailyFuseActions: toPositiveInteger(raw.freeDailyFuseActions, 0),
    freeDailyRerollActions: toPositiveInteger(raw.freeDailyRerollActions, 0),
    allowCompActions: raw.allowCompActions !== false,
    updatedAt,
    updatedBy,
  };
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function ensureSchema() {
  if (schemaReady) {
    return schemaReady;
  }

  schemaReady = (async () => {
    await executeTurso(
      `CREATE TABLE IF NOT EXISTS monetization_runtime_config (
        config_key TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
    );
  })();

  return schemaReady;
}

export async function getMonetizationRuntimeConfig() {
  await ensureSchema();
  const result = await executeTurso({
    sql: `SELECT config_json, updated_at, updated_by
          FROM monetization_runtime_config
          WHERE config_key = ?
          LIMIT 1`,
    args: [GLOBAL_CONFIG_KEY],
  });

  const row = result.rows[0];
  if (!row) {
    return normalizeConfig(
      null,
      new Date(0).toISOString(),
      "system_default",
    );
  }

  const rowData: MonetizationConfigRow = {
    config_json: asString(row.config_json),
    updated_at: asString(row.updated_at),
    updated_by: asString(row.updated_by),
  };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rowData.config_json);
  } catch {
    parsed = null;
  }

  return normalizeConfig(parsed, rowData.updated_at, rowData.updated_by);
}

function applyPatch(
  current: MonetizationRuntimeConfig,
  patch: MonetizationRuntimeConfigPatch,
) {
  const next: MonetizationRuntimeConfig = {
    ...current,
    ...patch,
  };

  if (
    next.enforcementMode !== "off" &&
    next.enforcementMode !== "observe" &&
    next.enforcementMode !== "enforce"
  ) {
    throw new MonetizationConfigValidationError("Invalid enforcement mode.");
  }

  if (
    next.freeDailyFuseActions < 0 ||
    next.freeDailyFuseActions > DEFAULT_MAX_FREE_DAILY_ACTIONS
  ) {
    throw new MonetizationConfigValidationError(
      `freeDailyFuseActions must be between 0 and ${DEFAULT_MAX_FREE_DAILY_ACTIONS}.`,
    );
  }

  if (
    next.freeDailyRerollActions < 0 ||
    next.freeDailyRerollActions > DEFAULT_MAX_FREE_DAILY_ACTIONS
  ) {
    throw new MonetizationConfigValidationError(
      `freeDailyRerollActions must be between 0 and ${DEFAULT_MAX_FREE_DAILY_ACTIONS}.`,
    );
  }

  return next;
}

export async function updateMonetizationRuntimeConfig(
  patch: MonetizationRuntimeConfigPatch,
  updatedBy: string,
) {
  await ensureSchema();
  const current = await getMonetizationRuntimeConfig();
  const next = applyPatch(current, patch);
  const updatedAt = new Date().toISOString();

  const persisted: Omit<MonetizationRuntimeConfig, "updatedAt" | "updatedBy"> = {
    enabled: next.enabled,
    enforcementMode: next.enforcementMode,
    freeDailyFuseActions: next.freeDailyFuseActions,
    freeDailyRerollActions: next.freeDailyRerollActions,
    allowCompActions: next.allowCompActions,
  };

  await executeTurso({
    sql: `INSERT INTO monetization_runtime_config (
            config_key,
            config_json,
            updated_at,
            updated_by
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(config_key) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
    args: [GLOBAL_CONFIG_KEY, JSON.stringify(persisted), updatedAt, updatedBy],
  });

  return {
    ...persisted,
    updatedAt,
    updatedBy,
  } satisfies MonetizationRuntimeConfig;
}
