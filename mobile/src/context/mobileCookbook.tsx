import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  buildCookbookSummary,
  cacheCookbookSummaries,
  deleteCookbookRecipe,
  fetchCookbookRecipe,
  fetchCookbookSummaries,
  readCachedCookbookRecipe,
  readCachedCookbookSummaries,
  saveCookbookRecipe,
} from "../services/cookbook";
import type { CookbookRecipeRecord, CookbookRecipeSummary, GeneratedRecipeRecord } from "../types/recipe";
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
  const [cookbookSummaries, setCookbookSummaries] = useState<CookbookRecipeSummary[]>([]);
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
    const nextSummary = buildCookbookSummary(record);
    setCookbookRecordCache((current) => ({
      ...current,
      [record.recipe.id]: record,
    }));
    setCookbookSummaries((current) => {
      const next = [nextSummary, ...current.filter((entry) => entry.recipeId !== nextSummary.recipeId)];
      void cacheCookbookSummaries(next);
      return next.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    void readCachedCookbookSummaries().then((cachedSummaries) => {
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
      const page = await fetchCookbookSummaries();
      setCookbookSummaries(page.recipes);
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
  }, []);

  const refreshSummaries = useCallback(async () => {
    setIsCookbookRefreshing(true);
    try {
      const page = await fetchCookbookSummaries();
      setCookbookSummaries(page.recipes);
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
  }, []);

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
      const next = current.filter((entry) => entry.recipeId !== recipeId);
      void cacheCookbookSummaries(next);
      return next;
    });
    setSummarySyncError("");
  }, []);

  const value = useMemo<MobileCookbookContextValue>(
    () => ({
      summaries: cookbookSummaries,
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
      deleteRecord,
    }),
    [
      cookbookRecordCache,
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
      saveRecord,
      summarySyncError,
    ],
  );

  return (
    <MobileCookbookContext.Provider value={value}>{children}</MobileCookbookContext.Provider>
  );
}
