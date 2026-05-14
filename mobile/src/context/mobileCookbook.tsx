import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  buildCookbookSummary,
  cacheCookbookSummaries,
  deleteCookbookRecipe,
  EMPTY_COOKBOOK_STATS,
  fetchCookbookRecipe,
  fetchCookbookSummaries,
  readCachedCookbookRecipe,
  readCachedCookbookSummaries,
  saveCookbookRecipe,
  updateCookbookRecipeFlags,
} from "../services/cookbook";
import { getMobileAuthToken } from "../services/auth";
import type { CookbookRecipeRecord, CookbookRecipeSummary, CookbookStats, GeneratedRecipeRecord } from "../types/recipe";
import type { MobileCookbookContextValue } from "../navigation/types";

const MobileCookbookContext = createContext<MobileCookbookContextValue | null>(null);

function mergeCookbookSummaries(
  current: CookbookRecipeSummary[],
  incoming: CookbookRecipeSummary[],
) {
  const byId = new Map<string, CookbookRecipeSummary>();
  for (const summary of current) {
    byId.set(summary.recipeId, summary);
  }
  for (const summary of incoming) {
    byId.set(summary.recipeId, summary);
  }

  return [...byId.values()].sort(
    (left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt),
  );
}

export function useMobileCookbook() {
  const context = useContext(MobileCookbookContext);
  if (!context) {
    throw new Error("Mobile cookbook context is not available.");
  }

  return context;
}

export function MobileCookbookProvider({ children }: { children: ReactNode }) {
  // This provider is the mobile app's single source of truth for saved recipes.
  // It keeps the UI responsive with local cache, but Turso remains the real storage.
  const [cookbookSummaries, setCookbookSummaries] = useState<CookbookRecipeSummary[]>([]);
  const [cookbookStats, setCookbookStats] = useState<CookbookStats>(EMPTY_COOKBOOK_STATS);
  const [cookbookRecordCache, setCookbookRecordCache] = useState<Record<string, CookbookRecipeRecord>>(
    {},
  );
  const [isCookbookLoading, setIsCookbookLoading] = useState(false);
  const [isCookbookRefreshing, setIsCookbookRefreshing] = useState(false);
  const [isCookbookLoadingMore, setIsCookbookLoadingMore] = useState(false);
  const [hasLoadedCookbook, setHasLoadedCookbook] = useState(false);
  const [hasMoreCookbook, setHasMoreCookbook] = useState(false);
  const [nextCookbookCursor, setNextCookbookCursor] = useState<string | null>(null);
  const [isShowingCachedSummaries, setIsShowingCachedSummaries] = useState(false);
  const [summarySyncError, setSummarySyncError] = useState("");

  const upsertCookbookRecordState = useCallback((record: CookbookRecipeRecord) => {
    // Any save, refresh, flag update, or detail load eventually comes through here,
    // so list cards and detail screens stay in sync.
    const nextSummary = buildCookbookSummary(record);
    setCookbookRecordCache((current) => ({
      ...current,
      [record.recipe.id]: record,
    }));
    setCookbookSummaries((current) => {
      const didExist = current.some((entry) => entry.recipeId === nextSummary.recipeId);
      const previousSummary = current.find((entry) => entry.recipeId === nextSummary.recipeId);
      const next = [nextSummary, ...current.filter((entry) => entry.recipeId !== nextSummary.recipeId)];
      setCookbookStats((stats) => ({
        totalRecipes: stats.totalRecipes + (didExist ? 0 : 1),
        favoriteRecipes:
          stats.favoriteRecipes +
          (nextSummary.isFavorite && !(previousSummary?.isFavorite === true) ? 1 : 0) -
          (!nextSummary.isFavorite && previousSummary?.isFavorite === true ? 1 : 0),
        toTryRecipes:
          stats.toTryRecipes +
          (nextSummary.isToTry && !(previousSummary?.isToTry === true) ? 1 : 0) -
          (!nextSummary.isToTry && previousSummary?.isToTry === true ? 1 : 0),
      }));
      void cacheCookbookSummaries(next);
      return next.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
    });
  }, []);

  const replaceSummariesWithFirstPage = useCallback((incoming: CookbookRecipeSummary[]) => {
    setCookbookSummaries(() => {
      void cacheCookbookSummaries(incoming);
      return incoming;
    });
  }, []);

  const resetLocalState = useCallback(() => {
    setCookbookSummaries([]);
    setCookbookStats(EMPTY_COOKBOOK_STATS);
    setCookbookRecordCache({});
    setIsCookbookLoading(false);
    setIsCookbookRefreshing(false);
    setIsCookbookLoadingMore(false);
    setHasLoadedCookbook(false);
    setHasMoreCookbook(false);
    setNextCookbookCursor(null);
    setIsShowingCachedSummaries(false);
    setSummarySyncError("");
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Show cached cookbook entries quickly while the network request catches up.
    void (async () => {
      const authToken = await getMobileAuthToken();
      if (!authToken) {
        return [];
      }
      return readCachedCookbookSummaries();
    })().then((cachedSummaries) => {
      if (cancelled || cachedSummaries.length === 0) {
        return;
      }

      setCookbookSummaries((current) => {
        if (current.length === 0) {
          setIsShowingCachedSummaries(true);
          return cachedSummaries;
        }

        const merged = [
          ...current,
          ...cachedSummaries.filter(
            (cachedEntry) =>
              !current.some((currentEntry) => currentEntry.recipeId === cachedEntry.recipeId),
          ),
        ];

        setIsShowingCachedSummaries(true);
        return merged.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadSummaries = useCallback(async () => {
    setIsCookbookLoading(true);
    try {
      const authToken = await getMobileAuthToken();
      if (!authToken) {
        resetLocalState();
        setHasLoadedCookbook(true);
        return;
      }
      const page = await fetchCookbookSummaries();
      replaceSummariesWithFirstPage(page.recipes);
      setCookbookStats(page.stats);
      setHasLoadedCookbook(true);
      setHasMoreCookbook(page.hasMore);
      setNextCookbookCursor(page.nextCursor);
      setIsShowingCachedSummaries(false);
      setSummarySyncError("");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not load cookbook.";
      setSummarySyncError(message);
      throw error;
    } finally {
      setIsCookbookLoading(false);
    }
  }, [replaceSummariesWithFirstPage, resetLocalState]);

  const refreshSummaries = useCallback(async () => {
    setIsCookbookRefreshing(true);
    try {
      const authToken = await getMobileAuthToken();
      if (!authToken) {
        resetLocalState();
        setHasLoadedCookbook(true);
        return;
      }
      const page = await fetchCookbookSummaries();
      replaceSummariesWithFirstPage(page.recipes);
      setCookbookStats(page.stats);
      setHasLoadedCookbook(true);
      setHasMoreCookbook(page.hasMore);
      setNextCookbookCursor(page.nextCursor);
      setIsShowingCachedSummaries(false);
      setSummarySyncError("");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not refresh cookbook.";
      setSummarySyncError(message);
      throw error;
    } finally {
      setIsCookbookRefreshing(false);
    }
  }, [replaceSummariesWithFirstPage, resetLocalState]);

  const loadMoreSummaries = useCallback(async () => {
    if (!hasLoadedCookbook || !hasMoreCookbook || !nextCookbookCursor || isCookbookLoadingMore) {
      return;
    }

    setIsCookbookLoadingMore(true);
    try {
      const page = await fetchCookbookSummaries(nextCookbookCursor);
      setCookbookSummaries((current) => {
        const next = mergeCookbookSummaries(current, page.recipes);
        void cacheCookbookSummaries(next);
        return next;
      });
      setCookbookStats(page.stats);
      setHasMoreCookbook(page.hasMore);
      setNextCookbookCursor(page.nextCursor);
      setSummarySyncError("");
    } finally {
      setIsCookbookLoadingMore(false);
    }
  }, [hasLoadedCookbook, hasMoreCookbook, isCookbookLoadingMore, nextCookbookCursor]);

  const loadRecord = useCallback(
    async (recipeId: string) => {
      const cached = cookbookRecordCache[recipeId];
      if (cached) {
        return cached;
      }

      const cachedDetail = await readCachedCookbookRecipe(recipeId);
      if (cachedDetail) {
        upsertCookbookRecordState(cachedDetail);
        return cachedDetail;
      }

      const record = await fetchCookbookRecipe(recipeId);
      upsertCookbookRecordState(record);
      return record;
    },
    [cookbookRecordCache, upsertCookbookRecordState],
  );

  const refreshRecord = useCallback(
    async (recipeId: string) => {
      const record = await fetchCookbookRecipe(recipeId);
      upsertCookbookRecordState(record);
      return record;
    },
    [upsertCookbookRecordState],
  );

  const saveRecord = useCallback(
    async (record: GeneratedRecipeRecord) => {
      const savedRecord = await saveCookbookRecipe(record);
      upsertCookbookRecordState(savedRecord);
      setSummarySyncError("");
      return savedRecord;
    },
    [upsertCookbookRecordState],
  );

  const deleteRecord = useCallback(async (recipeId: string) => {
    await deleteCookbookRecipe(recipeId);
    setCookbookRecordCache((current) => {
      const next = { ...current };
      delete next[recipeId];
      return next;
    });
    setCookbookSummaries((current) => {
      const removed = current.find((entry) => entry.recipeId === recipeId);
      const next = current.filter((entry) => entry.recipeId !== recipeId);
      if (removed) {
        setCookbookStats((stats) => ({
          totalRecipes: Math.max(0, stats.totalRecipes - 1),
          favoriteRecipes: Math.max(0, stats.favoriteRecipes - (removed.isFavorite ? 1 : 0)),
          toTryRecipes: Math.max(0, stats.toTryRecipes - (removed.isToTry ? 1 : 0)),
        }));
      }
      void cacheCookbookSummaries(next);
      return next;
    });
    setSummarySyncError("");
  }, []);

  const updateRecipeFlags = useCallback(
    async (recipeId: string, flags: { isFavorite?: boolean; isToTry?: boolean }) => {
      const currentRecord = cookbookRecordCache[recipeId];
      // Update the button state immediately, then roll back if the API call fails.
      if (currentRecord) {
        upsertCookbookRecordState({
          ...currentRecord,
          isFavorite: flags.isFavorite ?? currentRecord.isFavorite,
          isToTry: flags.isToTry ?? currentRecord.isToTry,
        });
      } else {
        setCookbookSummaries((current) => {
          const next = current.map((summary) =>
            summary.recipeId === recipeId
              ? {
                  ...summary,
                  isFavorite: flags.isFavorite ?? summary.isFavorite,
                  isToTry: flags.isToTry ?? summary.isToTry,
                }
              : summary,
          );
          void cacheCookbookSummaries(next);
          return next;
        });
      }

      try {
        const updated = await updateCookbookRecipeFlags(recipeId, flags);
        upsertCookbookRecordState(updated);
        setSummarySyncError("");
        return updated;
      } catch (error) {
        if (currentRecord) {
          upsertCookbookRecordState(currentRecord);
        } else {
          await refreshSummaries().catch(() => {});
        }
        throw error;
      }
    },
    [cookbookRecordCache, refreshSummaries, upsertCookbookRecordState],
  );

  const value = useMemo<MobileCookbookContextValue>(
    () => ({
      summaries: cookbookSummaries,
      stats: cookbookStats,
      isLoading: isCookbookLoading,
      isRefreshing: isCookbookRefreshing,
      isLoadingMore: isCookbookLoadingMore,
      hasLoaded: hasLoadedCookbook,
      hasMore: hasMoreCookbook,
      isShowingCachedSummaries,
      summarySyncError,
      loadSummaries,
      refreshSummaries,
      loadMoreSummaries,
      saveRecord,
      getRecord: (recipeId: string) => cookbookRecordCache[recipeId],
      loadRecord,
      refreshRecord,
      updateRecipeFlags,
      deleteRecord,
      resetLocalState,
    }),
    [
      cookbookRecordCache,
      cookbookStats,
      cookbookSummaries,
      deleteRecord,
      hasMoreCookbook,
      hasLoadedCookbook,
      isShowingCachedSummaries,
      isCookbookLoading,
      isCookbookLoadingMore,
      isCookbookRefreshing,
      loadRecord,
      loadMoreSummaries,
      loadSummaries,
      refreshRecord,
      refreshSummaries,
      resetLocalState,
      saveRecord,
      summarySyncError,
      updateRecipeFlags,
    ],
  );

  return (
    <MobileCookbookContext.Provider value={value}>{children}</MobileCookbookContext.Provider>
  );
}
