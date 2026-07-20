import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  buildCookbookSummary,
  checkCookbookRecipeSaved,
  deleteCookbookRecipe,
  EMPTY_COOKBOOK_STATS,
  fetchCookbookRecipe,
  fetchCookbookSummaries,
  readCachedCookbookRecipe,
  readCachedCookbookSummaries,
  saveCookbookRecipe,
  updateCookbookRecipeFlags,
} from "../services/cookbook";
import {
  createCookbookMembershipLookupCoordinator,
  createCookbookMembershipRevisionTracker,
  getCookbookSavedMembershipStatus,
  mergeSavedCookbookRecipeIds,
  setCookbookSavedMembership,
  type CookbookSavedMembershipIndex,
} from "../services/cookbookSavedMembership";
import { getMobileAuthRequestContext, getMobileAuthSession } from "../services/auth";
import {
  captureMobileSessionIdentity,
  isMobileSessionIdentityCurrent,
  type MobileSessionIdentity,
} from "../services/authSession";
import { upsertDashboardFusionHistory } from "../services/dashboardHistory";
import { useMobileSessionIdentity } from "../hooks/useMobileSessionIdentity";
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
  const [savedRecipeMembership, setSavedRecipeMembership] =
    useState<CookbookSavedMembershipIndex>({});
  const [checkingSavedRecipeIds, setCheckingSavedRecipeIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [unavailableSavedRecipeIds, setUnavailableSavedRecipeIds] =
    useState<ReadonlySet<string>>(new Set());
  const membershipLookupCoordinator = useRef(
    createCookbookMembershipLookupCoordinator(),
  ).current;
  const membershipRevisionTracker = useRef(
    createCookbookMembershipRevisionTracker(),
  ).current;
  const sessionIdentity = useMobileSessionIdentity();
  const [stateOwnerRevision, setStateOwnerRevision] = useState(sessionIdentity.revision);
  const isStateOwnedByCurrentSession = stateOwnerRevision === sessionIdentity.revision;

  const canCommitForIdentity = useCallback(
    (identity: MobileSessionIdentity) => isMobileSessionIdentityCurrent(identity),
    [],
  );

  const markSavedMembership = useCallback((recipeId: string, isSaved: boolean) => {
    membershipRevisionTracker.advance(recipeId);
    setSavedRecipeMembership((current) =>
      setCookbookSavedMembership(current, recipeId, isSaved),
    );
    setUnavailableSavedRecipeIds((current) => {
      if (!current.has(recipeId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(recipeId);
      return next;
    });
  }, [membershipRevisionTracker]);

  const markSummariesSaved = useCallback((summaries: CookbookRecipeSummary[]) => {
    summaries.forEach((summary) => {
      membershipRevisionTracker.advance(summary.recipeId);
    });
    setSavedRecipeMembership((current) =>
      mergeSavedCookbookRecipeIds(
        current,
        summaries.map((summary) => summary.recipeId),
      ),
    );
  }, [membershipRevisionTracker]);

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
      return next.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
    });
    markSavedMembership(record.recipe.id, true);
  }, [markSavedMembership]);

  const replaceSummariesWithFirstPage = useCallback((incoming: CookbookRecipeSummary[]) => {
    setCookbookSummaries(incoming);
    markSummariesSaved(incoming);
  }, [markSummariesSaved]);

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
    setSavedRecipeMembership({});
    setCheckingSavedRecipeIds(new Set());
    setUnavailableSavedRecipeIds(new Set());
    membershipLookupCoordinator.reset();
    membershipRevisionTracker.reset();
    setStateOwnerRevision(captureMobileSessionIdentity().revision);
  }, [membershipLookupCoordinator, membershipRevisionTracker]);

  useEffect(() => {
    const expectedIdentity = sessionIdentity;
    resetLocalState();
    if (!expectedIdentity.initialized || !expectedIdentity.userId) {
      if (!expectedIdentity.initialized) {
        void getMobileAuthSession();
      }
      return;
    }

    void readCachedCookbookSummaries().then((cachedSummaries) => {
      if (!canCommitForIdentity(expectedIdentity) || cachedSummaries.length === 0) {
        return;
      }
      setCookbookSummaries(cachedSummaries);
      markSummariesSaved(cachedSummaries);
      setIsShowingCachedSummaries(true);
      setStateOwnerRevision(expectedIdentity.revision);
    });
  }, [
    canCommitForIdentity,
    markSummariesSaved,
    resetLocalState,
    sessionIdentity,
  ]);

  const loadSummaries = useCallback(async () => {
    const authContext = await getMobileAuthRequestContext();
    const requestIdentity = authContext.identity;
    if (!canCommitForIdentity(requestIdentity)) {
      return;
    }
    setIsCookbookLoading(true);
    try {
      if (!authContext.session) {
        resetLocalState();
        setHasLoadedCookbook(true);
        return;
      }
      const page = await fetchCookbookSummaries();
      if (!canCommitForIdentity(requestIdentity)) {
        return;
      }
      replaceSummariesWithFirstPage(page.recipes);
      setCookbookStats(page.stats);
      setHasLoadedCookbook(true);
      setHasMoreCookbook(page.hasMore);
      setNextCookbookCursor(page.nextCursor);
      setIsShowingCachedSummaries(false);
      setSummarySyncError("");
    } catch (error) {
      if (!canCommitForIdentity(requestIdentity)) {
        return;
      }
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not load cookbook.";
      setSummarySyncError(message);
      throw error;
    } finally {
      if (canCommitForIdentity(requestIdentity)) {
        setIsCookbookLoading(false);
      }
    }
  }, [canCommitForIdentity, replaceSummariesWithFirstPage, resetLocalState]);

  const refreshSummaries = useCallback(async () => {
    const authContext = await getMobileAuthRequestContext();
    const requestIdentity = authContext.identity;
    if (!canCommitForIdentity(requestIdentity)) {
      return;
    }
    setIsCookbookRefreshing(true);
    try {
      if (!authContext.session) {
        resetLocalState();
        setHasLoadedCookbook(true);
        return;
      }
      const page = await fetchCookbookSummaries();
      if (!canCommitForIdentity(requestIdentity)) {
        return;
      }
      replaceSummariesWithFirstPage(page.recipes);
      setCookbookStats(page.stats);
      setHasLoadedCookbook(true);
      setHasMoreCookbook(page.hasMore);
      setNextCookbookCursor(page.nextCursor);
      setIsShowingCachedSummaries(false);
      setSummarySyncError("");
    } catch (error) {
      if (!canCommitForIdentity(requestIdentity)) {
        return;
      }
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not refresh cookbook.";
      setSummarySyncError(message);
      throw error;
    } finally {
      if (canCommitForIdentity(requestIdentity)) {
        setIsCookbookRefreshing(false);
      }
    }
  }, [canCommitForIdentity, replaceSummariesWithFirstPage, resetLocalState]);

  const loadMoreSummaries = useCallback(async () => {
    if (!hasLoadedCookbook || !hasMoreCookbook || !nextCookbookCursor || isCookbookLoadingMore) {
      return;
    }

    const requestIdentity = captureMobileSessionIdentity();
    setIsCookbookLoadingMore(true);
    try {
      const page = await fetchCookbookSummaries(nextCookbookCursor);
      if (!canCommitForIdentity(requestIdentity)) {
        return;
      }
      setCookbookSummaries((current) => {
        return mergeCookbookSummaries(current, page.recipes);
      });
      markSummariesSaved(page.recipes);
      setCookbookStats(page.stats);
      setHasMoreCookbook(page.hasMore);
      setNextCookbookCursor(page.nextCursor);
      setSummarySyncError("");
    } finally {
      if (canCommitForIdentity(requestIdentity)) {
        setIsCookbookLoadingMore(false);
      }
    }
  }, [
    canCommitForIdentity,
    hasLoadedCookbook,
    hasMoreCookbook,
    isCookbookLoadingMore,
    markSummariesSaved,
    nextCookbookCursor,
  ]);

  const loadRecord = useCallback(
    async (recipeId: string) => {
      const requestIdentity = captureMobileSessionIdentity();
      const cached =
        stateOwnerRevision === requestIdentity.revision
          ? cookbookRecordCache[recipeId]
          : undefined;
      if (cached) {
        return cached;
      }

      const cachedDetail = await readCachedCookbookRecipe(recipeId);
      if (!canCommitForIdentity(requestIdentity)) {
        throw new Error("Mobile account changed while the recipe was loading.");
      }
      if (cachedDetail) {
        upsertCookbookRecordState(cachedDetail);
        return cachedDetail;
      }

      const record = await fetchCookbookRecipe(recipeId);
      if (!canCommitForIdentity(requestIdentity)) {
        throw new Error("Mobile account changed while the recipe was loading.");
      }
      upsertCookbookRecordState(record);
      return record;
    },
    [
      canCommitForIdentity,
      cookbookRecordCache,
      stateOwnerRevision,
      upsertCookbookRecordState,
    ],
  );

  const refreshRecord = useCallback(
    async (recipeId: string) => {
      const requestIdentity = captureMobileSessionIdentity();
      const record = await fetchCookbookRecipe(recipeId);
      if (!canCommitForIdentity(requestIdentity)) {
        throw new Error("Mobile account changed while the recipe was refreshing.");
      }
      upsertCookbookRecordState(record);
      return record;
    },
    [canCommitForIdentity, upsertCookbookRecordState],
  );

  const saveRecord = useCallback(
    async (record: GeneratedRecipeRecord) => {
      const requestIdentity = captureMobileSessionIdentity();
      const savedRecord = await saveCookbookRecipe(record);
      if (!canCommitForIdentity(requestIdentity)) {
        throw new Error("Mobile account changed while the recipe was saving.");
      }
      upsertCookbookRecordState(savedRecord);
      setSummarySyncError("");
      return savedRecord;
    },
    [canCommitForIdentity, upsertCookbookRecordState],
  );

  const deleteRecord = useCallback(async (recipeId: string) => {
    const requestIdentity = captureMobileSessionIdentity();
    const deletedRecord =
      stateOwnerRevision === requestIdentity.revision
        ? cookbookRecordCache[recipeId]
        : undefined;
    await deleteCookbookRecipe(recipeId);
    if (!canCommitForIdentity(requestIdentity)) {
      throw new Error("Mobile account changed while the recipe was deleting.");
    }
    if (deletedRecord) {
      void upsertDashboardFusionHistory({
        recipe: deletedRecord.recipe,
        sourceInput: deletedRecord.sourceInput,
        createdAt: deletedRecord.savedAt,
      });
    }
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
      return next;
    });
    markSavedMembership(recipeId, false);
    setSummarySyncError("");
  }, [
    canCommitForIdentity,
    cookbookRecordCache,
    markSavedMembership,
    stateOwnerRevision,
  ]);

  const getSavedRecipeMembership = useCallback(
    (recipeId: string) => {
      if (!isStateOwnedByCurrentSession) {
        return "unknown" as const;
      }
      return getCookbookSavedMembershipStatus(savedRecipeMembership, recipeId, {
        isChecking: checkingSavedRecipeIds.has(recipeId),
        isUnavailable: unavailableSavedRecipeIds.has(recipeId),
      });
    },
    [
      checkingSavedRecipeIds,
      isStateOwnedByCurrentSession,
      savedRecipeMembership,
      unavailableSavedRecipeIds,
    ],
  );

  const ensureSavedRecipeMembership = useCallback(
    async (recipeId: string) => {
      const normalizedRecipeId = recipeId.trim();
      const requestIdentity = captureMobileSessionIdentity();
      if (!normalizedRecipeId || !requestIdentity.userId) {
        return false;
      }
      const knownMembership = savedRecipeMembership[normalizedRecipeId];
      if (typeof knownMembership === "boolean") {
        return knownMembership;
      }
      const expectedMembershipRevision =
        membershipRevisionTracker.capture(normalizedRecipeId);

      const lookup = membershipLookupCoordinator.run(
        requestIdentity.revision,
        normalizedRecipeId,
        () => checkCookbookRecipeSaved(normalizedRecipeId, requestIdentity),
      );
      if (lookup.started) {
        setCheckingSavedRecipeIds((current) => {
          const next = new Set(current);
          next.add(normalizedRecipeId);
          return next;
        });
      }

      try {
        const isSaved = await lookup.promise;
        if (!canCommitForIdentity(requestIdentity)) {
          throw new Error("Mobile account changed while saved recipe membership was loading.");
        }
        if (
          !membershipRevisionTracker.isCurrent(
            normalizedRecipeId,
            expectedMembershipRevision,
          )
        ) {
          return savedRecipeMembership[normalizedRecipeId] ?? isSaved;
        }
        markSavedMembership(normalizedRecipeId, isSaved);
        return isSaved;
      } catch (error) {
        if (
          canCommitForIdentity(requestIdentity) &&
          membershipRevisionTracker.isCurrent(
            normalizedRecipeId,
            expectedMembershipRevision,
          )
        ) {
          setUnavailableSavedRecipeIds((current) => {
            const next = new Set(current);
            next.add(normalizedRecipeId);
            return next;
          });
        }
        throw error;
      } finally {
        if (lookup.started && canCommitForIdentity(requestIdentity)) {
          setCheckingSavedRecipeIds((current) => {
            if (!current.has(normalizedRecipeId)) {
              return current;
            }
            const next = new Set(current);
            next.delete(normalizedRecipeId);
            return next;
          });
        }
      }
    },
    [
      canCommitForIdentity,
      markSavedMembership,
      membershipLookupCoordinator,
      membershipRevisionTracker,
      savedRecipeMembership,
    ],
  );

  const updateRecipeFlags = useCallback(
    async (recipeId: string, flags: { isFavorite?: boolean; isToTry?: boolean }) => {
      const requestIdentity = captureMobileSessionIdentity();
      const ownsCurrentState = stateOwnerRevision === requestIdentity.revision;
      const currentRecord = ownsCurrentState ? cookbookRecordCache[recipeId] : undefined;
      // Update the button state immediately, then roll back if the API call fails.
      if (currentRecord) {
        upsertCookbookRecordState({
          ...currentRecord,
          isFavorite: flags.isFavorite ?? currentRecord.isFavorite,
          isToTry: flags.isToTry ?? currentRecord.isToTry,
        });
      } else if (ownsCurrentState) {
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
          return next;
        });
      }

      try {
        const updated = await updateCookbookRecipeFlags(recipeId, flags);
        if (!canCommitForIdentity(requestIdentity)) {
          throw new Error("Mobile account changed while the recipe was updating.");
        }
        upsertCookbookRecordState(updated);
        setSummarySyncError("");
        return updated;
      } catch (error) {
        if (!canCommitForIdentity(requestIdentity)) {
          throw error;
        }
        if (currentRecord) {
          upsertCookbookRecordState(currentRecord);
        } else {
          await refreshSummaries().catch(() => {});
        }
        throw error;
      }
    },
    [
      canCommitForIdentity,
      cookbookRecordCache,
      refreshSummaries,
      stateOwnerRevision,
      upsertCookbookRecordState,
    ],
  );

  const value = useMemo<MobileCookbookContextValue>(
    () => ({
      summaries: isStateOwnedByCurrentSession ? cookbookSummaries : [],
      stats: isStateOwnedByCurrentSession ? cookbookStats : EMPTY_COOKBOOK_STATS,
      isLoading: isStateOwnedByCurrentSession ? isCookbookLoading : false,
      isRefreshing: isStateOwnedByCurrentSession ? isCookbookRefreshing : false,
      isLoadingMore: isStateOwnedByCurrentSession ? isCookbookLoadingMore : false,
      hasLoaded: isStateOwnedByCurrentSession ? hasLoadedCookbook : false,
      hasMore: isStateOwnedByCurrentSession ? hasMoreCookbook : false,
      isShowingCachedSummaries:
        isStateOwnedByCurrentSession && isShowingCachedSummaries,
      summarySyncError: isStateOwnedByCurrentSession ? summarySyncError : "",
      getSavedRecipeMembership,
      ensureSavedRecipeMembership,
      loadSummaries,
      refreshSummaries,
      loadMoreSummaries,
      saveRecord,
      getRecord: (recipeId: string) =>
        isStateOwnedByCurrentSession ? cookbookRecordCache[recipeId] : undefined,
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
      ensureSavedRecipeMembership,
      getSavedRecipeMembership,
      hasMoreCookbook,
      hasLoadedCookbook,
      isShowingCachedSummaries,
      isCookbookLoading,
      isCookbookLoadingMore,
      isCookbookRefreshing,
      isStateOwnedByCurrentSession,
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
