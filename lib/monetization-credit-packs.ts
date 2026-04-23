/**
 * Credit pack catalog loader for IAP products.
 * Maps store product ids to credit amounts.
 */
export type PurchaseProvider = "apple_app_store" | "google_play";

type CreditPackCatalog = Record<PurchaseProvider, Record<string, number>>;

const DEFAULT_CATALOG: CreditPackCatalog = {
  apple_app_store: {},
  google_play: {},
};

let catalogCache: CreditPackCatalog | null = null;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProductId(value: string) {
  return value.trim();
}

function parsePackMap(raw: unknown): Record<string, number> {
  if (!isObjectRecord(raw)) {
    return {};
  }

  const parsed: Record<string, number> = {};
  for (const [productId, credits] of Object.entries(raw)) {
    if (typeof credits !== "number" || !Number.isFinite(credits)) {
      continue;
    }
    const normalizedProductId = normalizeProductId(productId);
    const normalizedCredits = Math.trunc(credits);
    if (!normalizedProductId || normalizedCredits < 1 || normalizedCredits > 10_000) {
      continue;
    }
    parsed[normalizedProductId] = normalizedCredits;
  }
  return parsed;
}

function parseCatalogFromEnv(raw: string | undefined): CreditPackCatalog {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_CATALOG;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      return DEFAULT_CATALOG;
    }

    return {
      apple_app_store: parsePackMap(parsed.apple_app_store),
      google_play: parsePackMap(parsed.google_play),
    };
  } catch {
    return DEFAULT_CATALOG;
  }
}

function loadCatalog() {
  if (catalogCache) {
    return catalogCache;
  }
  catalogCache = parseCatalogFromEnv(process.env.MONETIZATION_CREDIT_PACKS_JSON);
  return catalogCache;
}

export function getCreditsForProduct(provider: PurchaseProvider, productId: string) {
  const catalog = loadCatalog();
  return catalog[provider][normalizeProductId(productId)] ?? null;
}

export function getMonetizationCreditCatalog() {
  return loadCatalog();
}
