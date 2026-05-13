import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBaseUrl } from "../config/api";
import type {
  CookbookRecipeRecord,
  CookbookRecipeSummary,
  GeneratedRecipeRecord,
  RecipeFusion,
} from "../types/recipe";
import { getMobileAnonymousId, getMobileDeviceKey, setMobileAnonymousId } from "./mobileIdentity";
import { getMobileAuthToken } from "./auth";

const COOKBOOK_SUMMARY_CACHE_VERSION = "v1";
const COOKBOOK_DETAIL_CACHE_VERSION = "v1";
const COOKBOOK_PAGE_SIZE = 15;

export type CookbookSummaryPage = {
  recipes: CookbookRecipeSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  pageSize: number;
};

type CookbookSummaryCachePayload = {
  fetchedAt: string;
  recipes: CookbookRecipeSummary[];
};

type CookbookDetailCachePayload = {
  fetchedAt: string;
  record: CookbookRecipeRecord;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecipeFusion(value: unknown): value is RecipeFusion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.title) &&
    isNonEmptyString(candidate.baseCuisine) &&
    isNonEmptyString(candidate.fusionCuisine) &&
    typeof candidate.servings === "number" &&
    typeof candidate.timeMinutes === "number" &&
    Array.isArray(candidate.ingredients) &&
    Array.isArray(candidate.steps) &&
    Array.isArray(candidate.swaps) &&
    Array.isArray(candidate.shoppingList) &&
    typeof candidate.nutritionNotes === "string"
  );
}

function isCookbookRecipeSummary(value: unknown): value is CookbookRecipeSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.recipeId) &&
    isNonEmptyString(candidate.title) &&
    isNonEmptyString(candidate.baseCuisine) &&
    isNonEmptyString(candidate.fusionCuisine) &&
    isNonEmptyString(candidate.savedAt) &&
    (typeof candidate.isFavorite === "undefined" || typeof candidate.isFavorite === "boolean") &&
    (typeof candidate.isToTry === "undefined" || typeof candidate.isToTry === "boolean")
  );
}

function isCookbookRecipeRecord(value: unknown): value is CookbookRecipeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isRecipeFusion(candidate.recipe) &&
    typeof candidate.sourceInput === "object" &&
    candidate.sourceInput !== null &&
    isNonEmptyString(candidate.savedAt) &&
    (typeof candidate.isFavorite === "undefined" || typeof candidate.isFavorite === "boolean") &&
    (typeof candidate.isToTry === "undefined" || typeof candidate.isToTry === "boolean")
  );
}

function isCookbookSummaryCachePayload(value: unknown): value is CookbookSummaryCachePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.fetchedAt) &&
    Array.isArray(candidate.recipes) &&
    candidate.recipes.every(isCookbookRecipeSummary)
  );
}

function isCookbookDetailCachePayload(value: unknown): value is CookbookDetailCachePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return isNonEmptyString(candidate.fetchedAt) && isCookbookRecipeRecord(candidate.record);
}

async function buildCookbookHeaders(extraHeaders?: Record<string, string>) {
  const mobileAnonId = await getMobileAnonymousId();
  const mobileDeviceKey = await getMobileDeviceKey();
  // Every cookbook request sends both account auth and device identity.
  // The server uses them to attach old anonymous records to the signed-in user.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-flavor-fusion-anon-id": mobileAnonId,
    "x-flavor-fusion-device-key": mobileDeviceKey,
    ...extraHeaders,
  };
  const authToken = await getMobileAuthToken();
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  return headers;
}

async function syncAnonymousIdFromResponse(response: Response) {
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (!canonicalAnonId) {
    return;
  }
  // If the server merged old records under a better canonical ID, keep using
  // that ID on this device from now on.
  await setMobileAnonymousId(canonicalAnonId);
}

async function getCookbookSummariesCacheKey() {
  const mobileAnonId = await getMobileAnonymousId();
  return `flavor_fusion_mobile_cookbook_summaries_${COOKBOOK_SUMMARY_CACHE_VERSION}:${mobileAnonId}`;
}

async function getCookbookDetailCacheKey(recipeId: string) {
  const mobileAnonId = await getMobileAnonymousId();
  return `flavor_fusion_mobile_cookbook_detail_${COOKBOOK_DETAIL_CACHE_VERSION}:${mobileAnonId}:${recipeId}`;
}

function sortCookbookSummaries(summaries: CookbookRecipeSummary[]) {
  return [...summaries].sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
}

async function writeCookbookSummariesCache(summaries: CookbookRecipeSummary[]) {
  const key = await getCookbookSummariesCacheKey();
  const payload: CookbookSummaryCachePayload = {
    fetchedAt: new Date().toISOString(),
    recipes: sortCookbookSummaries(summaries),
  };
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

export async function cacheCookbookSummaries(summaries: CookbookRecipeSummary[]) {
  await writeCookbookSummariesCache(summaries);
}

async function upsertCookbookSummaryCache(summary: CookbookRecipeSummary) {
  const current = await readCachedCookbookSummaries();
  const next = sortCookbookSummaries([
    summary,
    ...current.filter((entry) => entry.recipeId !== summary.recipeId),
  ]);
  await writeCookbookSummariesCache(next);
}

async function removeCookbookSummaryCache(recipeId: string) {
  const current = await readCachedCookbookSummaries();
  await writeCookbookSummariesCache(current.filter((entry) => entry.recipeId !== recipeId));
}

async function writeCookbookDetailCache(record: CookbookRecipeRecord) {
  const key = await getCookbookDetailCacheKey(record.recipe.id);
  const payload: CookbookDetailCachePayload = {
    fetchedAt: new Date().toISOString(),
    record,
  };
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

async function removeCookbookDetailCache(recipeId: string) {
  const key = await getCookbookDetailCacheKey(recipeId);
  await AsyncStorage.removeItem(key);
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : fallback;
  } catch {
    return fallback;
  }
}

export function buildCookbookSummary(record: CookbookRecipeRecord): CookbookRecipeSummary {
  return {
    recipeId: record.recipe.id,
    title: record.recipe.title,
    baseCuisine: record.recipe.baseCuisine,
    fusionCuisine: record.recipe.fusionCuisine,
    savedAt: record.savedAt,
    imageUrl: record.recipe.imageUrl,
    isFavorite: record.isFavorite === true,
    isToTry: record.isToTry === true,
  };
}

export async function readCachedCookbookSummaries(): Promise<CookbookRecipeSummary[]> {
  try {
    const key = await getCookbookSummariesCacheKey();
    const raw = await AsyncStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const payload = JSON.parse(raw) as unknown;
    if (!isCookbookSummaryCachePayload(payload)) {
      return [];
    }

    return sortCookbookSummaries(payload.recipes);
  } catch {
    return [];
  }
}

export async function readCachedCookbookRecipe(
  recipeId: string,
): Promise<CookbookRecipeRecord | null> {
  try {
    const key = await getCookbookDetailCacheKey(recipeId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const payload = JSON.parse(raw) as unknown;
    if (!isCookbookDetailCachePayload(payload)) {
      return null;
    }

    return payload.record;
  } catch {
    return null;
  }
}

export async function saveCookbookRecipe(
  record: GeneratedRecipeRecord | CookbookRecipeRecord,
): Promise<CookbookRecipeRecord> {
  // Saving is idempotent by recipe ID, so tapping Save twice should not create
  // duplicate cookbook rows.
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook`, {
    method: "POST",
    headers: await buildCookbookHeaders({
      "x-idempotency-key": `mobile-cookbook-save-${record.recipe.id}`,
    }),
    body: JSON.stringify({
      recipe: record.recipe,
      sourceInput: record.sourceInput,
      savedAt: "savedAt" in record ? record.savedAt : new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Could not save recipe."));
  }
  await syncAnonymousIdFromResponse(response);

  const payload = (await response.json()) as { record?: unknown };
  if (!isCookbookRecipeRecord(payload.record)) {
    throw new Error("The saved recipe response was not in the expected format.");
  }

  await writeCookbookDetailCache(payload.record);
  await upsertCookbookSummaryCache(buildCookbookSummary(payload.record));
  return payload.record;
}

export async function fetchCookbookSummaries(cursor?: string | null): Promise<CookbookSummaryPage> {
  const params = new URLSearchParams({
    pageSize: String(COOKBOOK_PAGE_SIZE),
  });
  if (cursor && cursor.trim().length > 0) {
    params.set("cursor", cursor);
  }

  const response = await fetch(`${getApiBaseUrl()}/api/cookbook?${params.toString()}`, {
    method: "GET",
    headers: await buildCookbookHeaders(),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Could not load cookbook."));
  }
  await syncAnonymousIdFromResponse(response);

  const payload = (await response.json()) as {
    recipes?: unknown;
    hasMore?: unknown;
    nextCursor?: unknown;
    pageSize?: unknown;
  };
  if (!Array.isArray(payload.recipes)) {
    throw new Error("The cookbook list response was not in the expected format.");
  }

  const summaries = sortCookbookSummaries(payload.recipes.filter(isCookbookRecipeSummary));
  if (!cursor) {
    await writeCookbookSummariesCache(summaries);
  }
  return {
    recipes: summaries,
    hasMore: payload.hasMore === true,
    nextCursor: typeof payload.nextCursor === "string" && payload.nextCursor.trim().length > 0
      ? payload.nextCursor
      : null,
    pageSize:
      typeof payload.pageSize === "number" && Number.isFinite(payload.pageSize)
        ? payload.pageSize
        : COOKBOOK_PAGE_SIZE,
  };
}

export async function fetchCookbookRecipe(recipeId: string): Promise<CookbookRecipeRecord> {
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "GET",
    headers: await buildCookbookHeaders(),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Could not load recipe."));
  }
  await syncAnonymousIdFromResponse(response);

  const payload = (await response.json()) as { record?: unknown };
  if (!isCookbookRecipeRecord(payload.record)) {
    throw new Error("The cookbook detail response was not in the expected format.");
  }

  await writeCookbookDetailCache(payload.record);
  await upsertCookbookSummaryCache(buildCookbookSummary(payload.record));
  return payload.record;
}

export async function deleteCookbookRecipe(recipeId: string): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "DELETE",
    headers: await buildCookbookHeaders(),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Could not delete recipe."));
  }
  await syncAnonymousIdFromResponse(response);

  await Promise.all([
    removeCookbookDetailCache(recipeId),
    removeCookbookSummaryCache(recipeId),
  ]);
}

export async function updateCookbookRecipeFlags(
  recipeId: string,
  flags: { isFavorite?: boolean; isToTry?: boolean },
): Promise<CookbookRecipeRecord> {
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "PATCH",
    headers: await buildCookbookHeaders(),
    body: JSON.stringify(flags),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Could not update recipe."));
  }
  await syncAnonymousIdFromResponse(response);

  const payload = (await response.json()) as { record?: unknown };
  if (!isCookbookRecipeRecord(payload.record)) {
    throw new Error("The updated recipe response was not in the expected format.");
  }

  await writeCookbookDetailCache(payload.record);
  await upsertCookbookSummaryCache(buildCookbookSummary(payload.record));
  return payload.record;
}
