/**
 * Monetization runtime config storage.
 * Backed by Turso so we can safely change behavior without app redeploys.
 */
import { executeTurso } from "@/lib/turso";

const GLOBAL_CONFIG_KEY = "global";
const DEFAULT_MAX_FREE_DAILY_ACTIONS = 20;
const DEFAULT_MAX_ACTION_CREDIT_COST = 100;
const DEFAULT_MAX_SEASONAL_OFFERS = 20;
const PACKAGE_KEYS = ["pack_1", "pack_2", "pack_3"] as const;
const CONFIG_CACHE_TTL_MS = 10_000;

let schemaReady: Promise<void> | null = null;
let configCache: {
  value: MonetizationRuntimeConfig;
  expiresAtMs: number;
} | null = null;

export type MonetizationEnforcementMode = "off" | "observe" | "enforce";
export type MonetizationPackageKey = (typeof PACKAGE_KEYS)[number];

export type MonetizationPricingPackage = {
  packageKey: MonetizationPackageKey;
  label: string;
  credits: number;
  displayPriceUsd: number;
  appleProductId: string;
  googleProductId: string;
  active: boolean;
};

export type MonetizationSeasonalOffer = {
  offerId: string;
  name: string;
  startDate: string;
  endDate: string;
  discountPercentByPackage: Record<MonetizationPackageKey, number>;
  active: boolean;
};

export type MonetizationRuntimeConfig = {
  enabled: boolean;
  enforcementMode: MonetizationEnforcementMode;
  freeDailyFuseActions: number;
  freeDailyRerollActions: number;
  fuseCreditCost: number;
  rerollCreditCost: number;
  allowCompActions: boolean;
  pricingPackages: MonetizationPricingPackage[];
  seasonalOffers: MonetizationSeasonalOffer[];
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
    | "fuseCreditCost"
    | "rerollCreditCost"
    | "allowCompActions"
    | "pricingPackages"
    | "seasonalOffers"
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

function toIntegerInRange(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized < min || normalized > max) {
    return fallback;
  }
  return normalized;
}

function toNumberInRange(value: unknown, fallback: number, min: number, max: number, decimals = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < min || value > max) {
    return fallback;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeLabel(value: unknown, fallback: string) {
  const label = asString(value).trim();
  if (!label) {
    return fallback;
  }
  return label.slice(0, 80);
}

function normalizeProductId(value: unknown) {
  return asString(value).trim().slice(0, 160);
}

function normalizePackageKey(value: unknown): MonetizationPackageKey | null {
  if (value === "pack_1" || value === "pack_2" || value === "pack_3") {
    return value;
  }
  return null;
}

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toDateOnly(value: unknown) {
  const raw = asString(value).trim();
  return isDateOnly(raw) ? raw : "";
}

const DEFAULT_PRICING_PACKAGES: MonetizationPricingPackage[] = [
  {
    packageKey: "pack_1",
    label: "Starter Pack",
    credits: 20,
    displayPriceUsd: 3.99,
    appleProductId: "com.flavorfusion.credits.20",
    googleProductId: "credits_20_android",
    active: true,
  },
  {
    packageKey: "pack_2",
    label: "Chef Pack",
    credits: 50,
    displayPriceUsd: 8.99,
    appleProductId: "com.flavorfusion.credits.50",
    googleProductId: "credits_50_android",
    active: true,
  },
  {
    packageKey: "pack_3",
    label: "Pro Pack",
    credits: 120,
    displayPriceUsd: 17.99,
    appleProductId: "com.flavorfusion.credits.120",
    googleProductId: "credits_120_android",
    active: true,
  },
];

const DEPRECATED_GOOGLE_PRODUCT_ID_REPLACEMENTS: Record<string, string> = {
  credits_20: "credits_20_android",
  credits_50: "credits_50_android",
  credits_120: "credits_120_android",
};

function normalizeGoogleProductId(value: unknown, fallback: string) {
  const productId = normalizeProductId(value) || fallback;
  return DEPRECATED_GOOGLE_PRODUCT_ID_REPLACEMENTS[productId] ?? productId;
}

function isDeprecatedGoogleProductId(value: string) {
  return Object.prototype.hasOwnProperty.call(
    DEPRECATED_GOOGLE_PRODUCT_ID_REPLACEMENTS,
    value.trim(),
  );
}

function normalizePricingPackages(raw: unknown) {
  // Admins can edit package labels, prices, and product IDs. These guards keep
  // bad admin input from breaking the mobile/web pricing screens.
  if (!Array.isArray(raw)) {
    return DEFAULT_PRICING_PACKAGES;
  }

  const byKey = new Map<MonetizationPackageKey, MonetizationPricingPackage>();
  for (const base of DEFAULT_PRICING_PACKAGES) {
    byKey.set(base.packageKey, base);
  }

  for (const entry of raw) {
    if (!isObjectRecord(entry)) {
      continue;
    }
    const packageKey = normalizePackageKey(entry.packageKey);
    if (!packageKey) {
      continue;
    }
    const fallback = byKey.get(packageKey) ?? DEFAULT_PRICING_PACKAGES[0];
    byKey.set(packageKey, {
      packageKey,
      label: normalizeLabel(entry.label, fallback.label),
      credits: toIntegerInRange(entry.credits, fallback.credits, 1, 100_000),
      displayPriceUsd: toNumberInRange(entry.displayPriceUsd, fallback.displayPriceUsd, 0.49, 999.99),
      appleProductId: normalizeProductId(entry.appleProductId) || fallback.appleProductId,
      googleProductId: normalizeGoogleProductId(entry.googleProductId, fallback.googleProductId),
      active: entry.active !== false,
    });
  }

  return PACKAGE_KEYS.map((key) => byKey.get(key) ?? DEFAULT_PRICING_PACKAGES[0]);
}

function normalizeOfferId(raw: unknown) {
  const trimmed = asString(raw).trim();
  return trimmed.slice(0, 120);
}

function normalizeSeasonalOffers(raw: unknown) {
  if (!Array.isArray(raw)) {
    return [] as MonetizationSeasonalOffer[];
  }

  const offers: MonetizationSeasonalOffer[] = [];
  for (const entry of raw) {
    if (!isObjectRecord(entry)) {
      continue;
    }
    const name = normalizeLabel(entry.name, "");
    const startDate = toDateOnly(entry.startDate);
    const endDate = toDateOnly(entry.endDate);
    if (!name || !startDate || !endDate) {
      continue;
    }

    const rawDiscountMap = isObjectRecord(entry.discountPercentByPackage)
      ? entry.discountPercentByPackage
      : {};
    const discountPercentByPackage: Record<MonetizationPackageKey, number> = {
      pack_1: toIntegerInRange(rawDiscountMap.pack_1, 0, 0, 90),
      pack_2: toIntegerInRange(rawDiscountMap.pack_2, 0, 0, 90),
      pack_3: toIntegerInRange(rawDiscountMap.pack_3, 0, 0, 90),
    };

    const offerId = normalizeOfferId(entry.offerId) || `offer-${startDate}-${name.toLowerCase().replace(/\s+/g, "-")}`.slice(0, 120);
    offers.push({
      offerId,
      name,
      startDate,
      endDate,
      discountPercentByPackage,
      active: entry.active !== false,
    });

    if (offers.length >= DEFAULT_MAX_SEASONAL_OFFERS) {
      break;
    }
  }

  return offers;
}

function normalizeConfig(raw: unknown, updatedAt: string, updatedBy: string): MonetizationRuntimeConfig {
  if (!isObjectRecord(raw)) {
    return {
      enabled: false,
      enforcementMode: "off",
      freeDailyFuseActions: 0,
      freeDailyRerollActions: 0,
      fuseCreditCost: 2,
      rerollCreditCost: 1,
      allowCompActions: true,
      pricingPackages: DEFAULT_PRICING_PACKAGES,
      seasonalOffers: [],
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
    fuseCreditCost: toIntegerInRange(raw.fuseCreditCost, 2, 1, DEFAULT_MAX_ACTION_CREDIT_COST),
    rerollCreditCost: toIntegerInRange(raw.rerollCreditCost, 1, 1, DEFAULT_MAX_ACTION_CREDIT_COST),
    allowCompActions: raw.allowCompActions !== false,
    pricingPackages: normalizePricingPackages(raw.pricingPackages),
    seasonalOffers: normalizeSeasonalOffers(raw.seasonalOffers),
    updatedAt,
    updatedBy,
  };
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
  const now = Date.now();
  if (configCache && now < configCache.expiresAtMs) {
    return configCache.value;
  }

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
    const fallback = normalizeConfig(
      null,
      new Date(0).toISOString(),
      "system_default",
    );
    configCache = {
      value: fallback,
      expiresAtMs: Date.now() + CONFIG_CACHE_TTL_MS,
    };
    return fallback;
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

  const normalized = normalizeConfig(parsed, rowData.updated_at, rowData.updated_by);
  configCache = {
    value: normalized,
    expiresAtMs: Date.now() + CONFIG_CACHE_TTL_MS,
  };
  return normalized;
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

  if (
    !Number.isFinite(next.fuseCreditCost) ||
    Math.trunc(next.fuseCreditCost) !== next.fuseCreditCost ||
    next.fuseCreditCost < 1 ||
    next.fuseCreditCost > DEFAULT_MAX_ACTION_CREDIT_COST
  ) {
    throw new MonetizationConfigValidationError(
      `fuseCreditCost must be an integer between 1 and ${DEFAULT_MAX_ACTION_CREDIT_COST}.`,
    );
  }

  if (
    !Number.isFinite(next.rerollCreditCost) ||
    Math.trunc(next.rerollCreditCost) !== next.rerollCreditCost ||
    next.rerollCreditCost < 1 ||
    next.rerollCreditCost > DEFAULT_MAX_ACTION_CREDIT_COST
  ) {
    throw new MonetizationConfigValidationError(
      `rerollCreditCost must be an integer between 1 and ${DEFAULT_MAX_ACTION_CREDIT_COST}.`,
    );
  }

  const seenPackageKeys = new Set<MonetizationPackageKey>();
  if (next.pricingPackages.length !== PACKAGE_KEYS.length) {
    throw new MonetizationConfigValidationError("pricingPackages must contain exactly 3 packages.");
  }
  for (const pack of next.pricingPackages) {
    if (!normalizePackageKey(pack.packageKey)) {
      throw new MonetizationConfigValidationError("Invalid pricing package key.");
    }
    if (seenPackageKeys.has(pack.packageKey)) {
      throw new MonetizationConfigValidationError("pricingPackages must have unique package keys.");
    }
    seenPackageKeys.add(pack.packageKey);
    if (!pack.label.trim()) {
      throw new MonetizationConfigValidationError("Each pricing package needs a label.");
    }
    if (pack.credits < 1 || pack.credits > 100_000) {
      throw new MonetizationConfigValidationError("Package credits must be between 1 and 100000.");
    }
    if (pack.displayPriceUsd < 0.49 || pack.displayPriceUsd > 999.99) {
      throw new MonetizationConfigValidationError("Package displayPriceUsd must be between 0.49 and 999.99.");
    }
    if (!pack.appleProductId.trim()) {
      throw new MonetizationConfigValidationError("Each package needs an Apple product id.");
    }
    if (isDeprecatedGoogleProductId(pack.googleProductId)) {
      throw new MonetizationConfigValidationError(
        "Deleted Google Play product ids cannot be used as googleProductId.",
      );
    }
  }

  if (next.seasonalOffers.length > DEFAULT_MAX_SEASONAL_OFFERS) {
    throw new MonetizationConfigValidationError(`seasonalOffers cannot exceed ${DEFAULT_MAX_SEASONAL_OFFERS}.`);
  }
  const seenOfferIds = new Set<string>();
  for (const offer of next.seasonalOffers) {
    if (!offer.offerId.trim()) {
      throw new MonetizationConfigValidationError("Each seasonal offer needs an offerId.");
    }
    if (seenOfferIds.has(offer.offerId)) {
      throw new MonetizationConfigValidationError("seasonalOffers offerId must be unique.");
    }
    seenOfferIds.add(offer.offerId);
    if (!offer.name.trim()) {
      throw new MonetizationConfigValidationError("Each seasonal offer needs a name.");
    }
    if (!isDateOnly(offer.startDate) || !isDateOnly(offer.endDate)) {
      throw new MonetizationConfigValidationError("Seasonal offer dates must use YYYY-MM-DD.");
    }
    if (offer.startDate > offer.endDate) {
      throw new MonetizationConfigValidationError("Seasonal offer startDate must be <= endDate.");
    }
    for (const key of PACKAGE_KEYS) {
      const discount = offer.discountPercentByPackage[key];
      if (!Number.isFinite(discount) || Math.trunc(discount) !== discount || discount < 0 || discount > 90) {
        throw new MonetizationConfigValidationError("Seasonal offer discount must be an integer between 0 and 90.");
      }
    }
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
    fuseCreditCost: next.fuseCreditCost,
    rerollCreditCost: next.rerollCreditCost,
    allowCompActions: next.allowCompActions,
    pricingPackages: next.pricingPackages,
    seasonalOffers: next.seasonalOffers,
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

  const updatedConfig = {
    ...persisted,
    updatedAt,
    updatedBy,
  } satisfies MonetizationRuntimeConfig;

  configCache = {
    value: updatedConfig,
    expiresAtMs: Date.now() + CONFIG_CACHE_TTL_MS,
  };

  return updatedConfig;
}
