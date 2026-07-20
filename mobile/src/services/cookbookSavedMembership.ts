export type CookbookSavedMembershipIndex = Readonly<Record<string, boolean>>;

export type CookbookSavedMembershipStatus =
  | "unknown"
  | "checking"
  | "saved"
  | "unsaved"
  | "unavailable";

export function setCookbookSavedMembership(
  current: CookbookSavedMembershipIndex,
  recipeId: string,
  isSaved: boolean,
): CookbookSavedMembershipIndex {
  const normalizedRecipeId = recipeId.trim();
  if (!normalizedRecipeId || current[normalizedRecipeId] === isSaved) {
    return current;
  }
  return {
    ...current,
    [normalizedRecipeId]: isSaved,
  };
}

export function mergeSavedCookbookRecipeIds(
  current: CookbookSavedMembershipIndex,
  recipeIds: readonly string[],
): CookbookSavedMembershipIndex {
  return recipeIds.reduce(
    (next, recipeId) => setCookbookSavedMembership(next, recipeId, true),
    current,
  );
}

export function getCookbookSavedMembershipStatus(
  membership: CookbookSavedMembershipIndex,
  recipeId: string,
  options?: {
    isChecking?: boolean;
    isUnavailable?: boolean;
  },
): CookbookSavedMembershipStatus {
  if (options?.isChecking) {
    return "checking";
  }
  const saved = membership[recipeId.trim()];
  if (saved === true) {
    return "saved";
  }
  if (saved === false) {
    return "unsaved";
  }
  return options?.isUnavailable ? "unavailable" : "unknown";
}

export function isCookbookSavedMembershipBlocking(
  status: CookbookSavedMembershipStatus,
  isAuthenticated: boolean,
) {
  return (
    isAuthenticated &&
    status !== "saved" &&
    status !== "unsaved"
  );
}

export function createCookbookMembershipLookupCoordinator() {
  const inFlight = new Map<string, Promise<boolean>>();

  return {
    run(
      sessionRevision: number,
      recipeId: string,
      operation: () => Promise<boolean>,
    ) {
      const key = `${sessionRevision}:${recipeId.trim()}`;
      const existing = inFlight.get(key);
      if (existing) {
        return { promise: existing, started: false };
      }

      const promise = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key);
          }
        });
      inFlight.set(key, promise);
      return { promise, started: true };
    },
    reset() {
      inFlight.clear();
    },
  };
}

export function createCookbookMembershipRevisionTracker() {
  const revisions = new Map<string, number>();

  return {
    capture(recipeId: string) {
      return revisions.get(recipeId.trim()) ?? 0;
    },
    advance(recipeId: string) {
      const normalizedRecipeId = recipeId.trim();
      const nextRevision = (revisions.get(normalizedRecipeId) ?? 0) + 1;
      revisions.set(normalizedRecipeId, nextRevision);
      return nextRevision;
    },
    isCurrent(recipeId: string, expectedRevision: number) {
      return (revisions.get(recipeId.trim()) ?? 0) === expectedRevision;
    },
    reset() {
      revisions.clear();
    },
  };
}
