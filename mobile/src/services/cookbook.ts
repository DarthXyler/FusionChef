import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBaseUrl } from "../config/api";
import type {
  CookbookRecipeRecord,
  CookbookRecipeSummary,
  CookbookStats,
  GeneratedRecipeRecord,
  RecipeFusion,
} from "../types/recipe";
import { getMobileAnonymousId, getMobileDeviceKey, setMobileAnonymousId } from "./mobileIdentity";
import { getMobileAuthRequestContext } from "./auth";
import { buildAccountStorageKey } from "./accountOwnership";
import {
  isMobileSessionIdentityCurrent,
  type MobileSessionIdentity,
} from "./authSession";
import { clearInvalidMobileSession, isInvalidAuthPayload } from "./sessionInvalidation";

const COOKBOOK_SUMMARY_CACHE_VERSION = "v2";
const COOKBOOK_DETAIL_CACHE_VERSION = "v2";
const COOKBOOK_PAGE_SIZE = 15;

export const EMPTY_COOKBOOK_STATS: CookbookStats = {
  totalRecipes: 0,
  favoriteRecipes: 0,
  toTryRecipes: 0,
};

export type CookbookSummaryPage = {
  recipes: CookbookRecipeSummary[];
  stats: CookbookStats;
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

type CookbookAccountScope = {
  userId: string;
  identity: MobileSessionIdentity;
};

type CookbookRequestContext = {
  headers: Record<string, string>;
  accountScope: CookbookAccountScope | null;
  identity: MobileSessionIdentity;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hashForIdempotency(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

function parseCookbookStats(value: unknown): CookbookStats {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY_COOKBOOK_STATS;
  }
  const candidate = value as Record<string, unknown>;
  const totalRecipes =
    typeof candidate.totalRecipes === "number" && Number.isFinite(candidate.totalRecipes)
      ? Math.max(0, Math.trunc(candidate.totalRecipes))
      : 0;
  const favoriteRecipes =
    typeof candidate.favoriteRecipes === "number" && Number.isFinite(candidate.favoriteRecipes)
      ? Math.max(0, Math.trunc(candidate.favoriteRecipes))
      : 0;
  const toTryRecipes =
    typeof candidate.toTryRecipes === "number" && Number.isFinite(candidate.toTryRecipes)
      ? Math.max(0, Math.trunc(candidate.toTryRecipes))
      : 0;
  return { totalRecipes, favoriteRecipes, toTryRecipes };
}

function isCookbookDetailCachePayload(value: unknown): value is CookbookDetailCachePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return isNonEmptyString(candidate.fetchedAt) && isCookbookRecipeRecord(candidate.record);
}

async function buildCookbookRequestContext(
  extraHeaders?: Record<string, string>,
  expectedIdentity?: MobileSessionIdentity,
): Promise<CookbookRequestContext> {
  const authContext = await getMobileAuthRequestContext();
  const [mobileAnonId, mobileDeviceKey] = await Promise.all([
    getMobileAnonymousId(),
    getMobileDeviceKey(),
  ]);
  if (
    !isMobileSessionIdentityCurrent(authContext.identity) ||
    (expectedIdentity &&
      (expectedIdentity.revision !== authContext.identity.revision ||
        expectedIdentity.userId !== authContext.identity.userId))
  ) {
    throw new Error("Mobile account changed while the cookbook request was starting.");
  }

  // Every cookbook request sends both account auth and device identity.
  // The server uses them to attach old anonymous records to the signed-in user.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-flavor-fusion-anon-id": mobileAnonId,
    "x-flavor-fusion-device-key": mobileDeviceKey,
    ...extraHeaders,
  };
  if (authContext.token) {
    headers.authorization = `Bearer ${authContext.token}`;
  }
  return {
    headers,
    identity: authContext.identity,
    accountScope: authContext.session
      ? {
          userId: authContext.session.userId,
          identity: authContext.identity,
        }
      : null,
  };
}

async function syncAnonymousIdFromResponse(
  response: Response,
  identity: MobileSessionIdentity,
) {
  if (!isMobileSessionIdentityCurrent(identity)) {
    return;
  }
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (!canonicalAnonId) {
    return;
  }
  // If the server merged old records under a better canonical ID, keep using
  // that ID on this device from now on.
  await setMobileAnonymousId(canonicalAnonId);
}

function getCookbookSummariesCacheKey(userId: string) {
  return buildAccountStorageKey(
    `flavor_fusion_mobile_cookbook_summaries_${COOKBOOK_SUMMARY_CACHE_VERSION}`,
    userId,
  );
}

function getCookbookDetailCacheKey(userId: string, recipeId: string) {
  return buildAccountStorageKey(
    `flavor_fusion_mobile_cookbook_detail_${COOKBOOK_DETAIL_CACHE_VERSION}`,
    userId,
    recipeId,
  );
}

async function getCurrentCookbookAccountScope(): Promise<CookbookAccountScope | null> {
  const authContext = await getMobileAuthRequestContext();
  if (!authContext.session || !isMobileSessionIdentityCurrent(authContext.identity)) {
    return null;
  }
  return {
    userId: authContext.session.userId,
    identity: authContext.identity,
  };
}

function sortCookbookSummaries(summaries: CookbookRecipeSummary[]) {
  return [...summaries].sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
}

async function writeCookbookSummariesCache(
  summaries: CookbookRecipeSummary[],
  scope: CookbookAccountScope,
) {
  if (!isMobileSessionIdentityCurrent(scope.identity)) {
    return;
  }
  const key = getCookbookSummariesCacheKey(scope.userId);
  const payload: CookbookSummaryCachePayload = {
    fetchedAt: new Date().toISOString(),
    recipes: sortCookbookSummaries(summaries),
  };
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

async function upsertCookbookSummaryCache(
  summary: CookbookRecipeSummary,
  scope: CookbookAccountScope,
) {
  const current = await readCachedCookbookSummariesForScope(scope);
  const next = sortCookbookSummaries([
    summary,
    ...current.filter((entry) => entry.recipeId !== summary.recipeId),
  ]);
  await writeCookbookSummariesCache(next, scope);
}

async function removeCookbookSummaryCache(recipeId: string, scope: CookbookAccountScope) {
  const current = await readCachedCookbookSummariesForScope(scope);
  await writeCookbookSummariesCache(
    current.filter((entry) => entry.recipeId !== recipeId),
    scope,
  );
}

async function writeCookbookDetailCache(
  record: CookbookRecipeRecord,
  scope: CookbookAccountScope,
) {
  if (!isMobileSessionIdentityCurrent(scope.identity)) {
    return;
  }
  const key = getCookbookDetailCacheKey(scope.userId, record.recipe.id);
  const payload: CookbookDetailCachePayload = {
    fetchedAt: new Date().toISOString(),
    record,
  };
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

async function removeCookbookDetailCache(recipeId: string, scope: CookbookAccountScope) {
  if (!isMobileSessionIdentityCurrent(scope.identity)) {
    return;
  }
  const key = getCookbookDetailCacheKey(scope.userId, recipeId);
  await AsyncStorage.removeItem(key);
}

async function readErrorMessage(
  response: Response,
  fallback: string,
  identity?: MobileSessionIdentity,
) {
  try {
    const payload = (await response.json()) as { error?: unknown; reason?: unknown };
    if (
      response.status === 401 &&
      isInvalidAuthPayload(payload) &&
      (!identity || isMobileSessionIdentityCurrent(identity))
    ) {
      await clearInvalidMobileSession(identity);
    }
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : fallback;
  } catch {
    return fallback;
  }
}

async function uploadRecipeImageDataUrl(
  imageDataUrl: string,
  title: string,
  recipeId: string,
  saveAttemptId: string,
  authToken: string,
  identity: MobileSessionIdentity,
) {
  const idempotencyKey = `mobile-recipe-image-upload-${recipeId}-${hashForIdempotency(
    `${hashForIdempotency(imageDataUrl)}:${saveAttemptId}`,
  )}`;
  const response = await fetch(`${getApiBaseUrl()}/api/r2-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "idempotency-key": idempotencyKey,
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({
      imageDataUrl,
      title,
      purpose: "recipe_image",
    }),
  });

  if (!isMobileSessionIdentityCurrent(identity)) {
    throw new Error("Mobile account changed while the recipe image was uploading.");
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Could not upload recipe image.", identity),
    );
  }

  const payload = (await response.json()) as { imageUrl?: unknown };
  if (typeof payload.imageUrl !== "string" || payload.imageUrl.trim().length === 0) {
    throw new Error("Recipe image upload response was not in the expected format.");
  }
  return payload.imageUrl.trim();
}

async function cleanupUploadedRecipeImage(imageUrl: string, authToken: string) {
  try {
    await fetch(`${getApiBaseUrl()}/api/r2-delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ imageUrl }),
    });
  } catch {
    // Best-effort cleanup after a failed cookbook save.
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

async function readCachedCookbookSummariesForScope(
  scope: CookbookAccountScope,
): Promise<CookbookRecipeSummary[]> {
  try {
    if (!isMobileSessionIdentityCurrent(scope.identity)) {
      return [];
    }
    const key = getCookbookSummariesCacheKey(scope.userId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw || !isMobileSessionIdentityCurrent(scope.identity)) {
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

export async function readCachedCookbookSummaries(): Promise<CookbookRecipeSummary[]> {
  const scope = await getCurrentCookbookAccountScope();
  return scope ? readCachedCookbookSummariesForScope(scope) : [];
}

async function readCachedCookbookRecipeForScope(
  recipeId: string,
  scope: CookbookAccountScope,
): Promise<CookbookRecipeRecord | null> {
  try {
    if (!isMobileSessionIdentityCurrent(scope.identity)) {
      return null;
    }
    const key = getCookbookDetailCacheKey(scope.userId, recipeId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw || !isMobileSessionIdentityCurrent(scope.identity)) {
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

export async function readCachedCookbookRecipe(
  recipeId: string,
): Promise<CookbookRecipeRecord | null> {
  const scope = await getCurrentCookbookAccountScope();
  return scope ? readCachedCookbookRecipeForScope(recipeId, scope) : null;
}

export async function saveCookbookRecipe(
  record: GeneratedRecipeRecord | CookbookRecipeRecord,
): Promise<CookbookRecipeRecord> {
  const authContext = await getMobileAuthRequestContext();
  const operationIdentity = authContext.identity;
  const originalImageUrl = record.recipe.imageUrl?.trim() ?? "";
  const savedAt = "savedAt" in record ? record.savedAt : new Date().toISOString();
  let uploadedImageUrl: string | null = null;
  const imageUrl = originalImageUrl.startsWith("data:image/")
    ? await uploadRecipeImageDataUrl(
        originalImageUrl,
        record.recipe.title,
        record.recipe.id,
        savedAt,
        authContext.token,
        operationIdentity,
      )
    : originalImageUrl;
  if (originalImageUrl.startsWith("data:image/")) {
    uploadedImageUrl = imageUrl;
  }
  const recipe = {
    ...record.recipe,
    imageUrl: imageUrl || undefined,
  };
  const savePayload = {
    recipe,
    sourceInput: record.sourceInput,
    savedAt,
  };
  const saveIdempotencyKey = `mobile-cookbook-save-${record.recipe.id}-${hashForIdempotency(
    JSON.stringify(savePayload),
  )}`;

  let savedRecord: CookbookRecipeRecord;
  let requestContext: CookbookRequestContext | null = null;
  try {
    requestContext = await buildCookbookRequestContext(
      {
        "idempotency-key": saveIdempotencyKey,
      },
      operationIdentity,
    );
    // Saving is idempotent by recipe ID, so tapping Save twice should not create
    // duplicate cookbook rows.
    const response = await fetch(`${getApiBaseUrl()}/api/cookbook`, {
      method: "POST",
      headers: requestContext.headers,
      body: JSON.stringify(savePayload),
    });

    if (!isMobileSessionIdentityCurrent(operationIdentity)) {
      if (response.ok) {
        // The server may already have committed the recipe. Leave its image for
        // that account instead of deleting a potentially active R2 reference.
        uploadedImageUrl = null;
      }
      throw new Error("Mobile account changed while the recipe was saving.");
    }
    if (!response.ok) {
      throw new Error(
        await readErrorMessage(response, "Could not save recipe.", operationIdentity),
      );
    }

    const payload = (await response.json()) as { record?: unknown };
    if (!isCookbookRecipeRecord(payload.record)) {
      throw new Error("The saved recipe response was not in the expected format.");
    }

    await syncAnonymousIdFromResponse(response, operationIdentity);
    savedRecord = payload.record;
  } catch (error) {
    if (uploadedImageUrl) {
      void cleanupUploadedRecipeImage(uploadedImageUrl, authContext.token);
    }
    throw error;
  }

  if (requestContext.accountScope) {
    await writeCookbookDetailCache(savedRecord, requestContext.accountScope);
    await upsertCookbookSummaryCache(
      buildCookbookSummary(savedRecord),
      requestContext.accountScope,
    );
  }
  return savedRecord;
}

export async function fetchCookbookSummaries(cursor?: string | null): Promise<CookbookSummaryPage> {
  const params = new URLSearchParams({
    pageSize: String(COOKBOOK_PAGE_SIZE),
  });
  if (cursor && cursor.trim().length > 0) {
    params.set("cursor", cursor);
  }

  const requestContext = await buildCookbookRequestContext();
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook?${params.toString()}`, {
    method: "GET",
    headers: requestContext.headers,
  });

  if (!isMobileSessionIdentityCurrent(requestContext.identity)) {
    throw new Error("Mobile account changed while the cookbook was loading.");
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Could not load cookbook.", requestContext.identity),
    );
  }
  await syncAnonymousIdFromResponse(response, requestContext.identity);

  const payload = (await response.json()) as {
    recipes?: unknown;
    stats?: unknown;
    hasMore?: unknown;
    nextCursor?: unknown;
    pageSize?: unknown;
  };
  if (!Array.isArray(payload.recipes)) {
    throw new Error("The cookbook list response was not in the expected format.");
  }

  const summaries = sortCookbookSummaries(payload.recipes.filter(isCookbookRecipeSummary));
  if (!cursor && requestContext.accountScope) {
    await writeCookbookSummariesCache(summaries, requestContext.accountScope);
  }
  return {
    recipes: summaries,
    stats: parseCookbookStats(payload.stats),
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
  const requestContext = await buildCookbookRequestContext();
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "GET",
    headers: requestContext.headers,
  });

  if (!isMobileSessionIdentityCurrent(requestContext.identity)) {
    throw new Error("Mobile account changed while the recipe was loading.");
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Could not load recipe.", requestContext.identity),
    );
  }
  await syncAnonymousIdFromResponse(response, requestContext.identity);

  const payload = (await response.json()) as { record?: unknown };
  if (!isCookbookRecipeRecord(payload.record)) {
    throw new Error("The cookbook detail response was not in the expected format.");
  }

  if (requestContext.accountScope) {
    await writeCookbookDetailCache(payload.record, requestContext.accountScope);
    await upsertCookbookSummaryCache(
      buildCookbookSummary(payload.record),
      requestContext.accountScope,
    );
  }
  return payload.record;
}

export async function checkCookbookRecipeSaved(
  recipeId: string,
  expectedIdentity: MobileSessionIdentity,
): Promise<boolean> {
  const requestContext = await buildCookbookRequestContext(undefined, expectedIdentity);
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "GET",
    headers: requestContext.headers,
  });

  if (!isMobileSessionIdentityCurrent(requestContext.identity)) {
    throw new Error("Mobile account changed while saved recipe membership was loading.");
  }
  if (response.status === 404) {
    await syncAnonymousIdFromResponse(response, requestContext.identity);
    return false;
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        "Could not confirm whether this recipe is saved.",
        requestContext.identity,
      ),
    );
  }
  await syncAnonymousIdFromResponse(response, requestContext.identity);

  const payload = (await response.json()) as { record?: unknown };
  if (
    !isCookbookRecipeRecord(payload.record) ||
    payload.record.recipe.id !== recipeId
  ) {
    throw new Error("The saved recipe membership response was not in the expected format.");
  }
  return true;
}

export async function deleteCookbookRecipe(recipeId: string): Promise<void> {
  const requestContext = await buildCookbookRequestContext();
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "DELETE",
    headers: requestContext.headers,
  });

  if (!isMobileSessionIdentityCurrent(requestContext.identity)) {
    throw new Error("Mobile account changed while the recipe was deleting.");
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Could not delete recipe.", requestContext.identity),
    );
  }
  await syncAnonymousIdFromResponse(response, requestContext.identity);

  if (requestContext.accountScope) {
    await Promise.all([
      removeCookbookDetailCache(recipeId, requestContext.accountScope),
      removeCookbookSummaryCache(recipeId, requestContext.accountScope),
    ]);
  }
}

export async function updateCookbookRecipeFlags(
  recipeId: string,
  flags: { isFavorite?: boolean; isToTry?: boolean },
): Promise<CookbookRecipeRecord> {
  const requestContext = await buildCookbookRequestContext();
  const response = await fetch(`${getApiBaseUrl()}/api/cookbook/${encodeURIComponent(recipeId)}`, {
    method: "PATCH",
    headers: requestContext.headers,
    body: JSON.stringify(flags),
  });

  if (!isMobileSessionIdentityCurrent(requestContext.identity)) {
    throw new Error("Mobile account changed while the recipe was updating.");
  }
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Could not update recipe.", requestContext.identity),
    );
  }
  await syncAnonymousIdFromResponse(response, requestContext.identity);

  const payload = (await response.json()) as { record?: unknown };
  if (!isCookbookRecipeRecord(payload.record)) {
    throw new Error("The updated recipe response was not in the expected format.");
  }

  if (requestContext.accountScope) {
    await writeCookbookDetailCache(payload.record, requestContext.accountScope);
    await upsertCookbookSummaryCache(
      buildCookbookSummary(payload.record),
      requestContext.accountScope,
    );
  }
  return payload.record;
}
