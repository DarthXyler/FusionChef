type CookbookSummaryIdentity = {
  recipeId: string;
};

export type CookbookSaveAttempt = Readonly<{
  token: number;
  recipeId: string;
  sessionRevision: number;
}>;

export function isRecipeConfirmedSaved(
  recipeId: string,
  summaries: readonly CookbookSummaryIdentity[],
) {
  return summaries.some((summary) => summary.recipeId === recipeId);
}

export function getCookbookSaveButtonState(options: {
  isSaving: boolean;
  isSaved: boolean;
  isBlocked: boolean;
}) {
  return {
    disabled: options.isSaving || options.isSaved || options.isBlocked,
    label: options.isSaving ? "Saving..." : options.isSaved ? "Saved" : "Save",
  };
}

export function createCookbookSaveAttemptController() {
  let nextToken = 0;
  let activeAttempt: CookbookSaveAttempt | null = null;

  return {
    begin(recipeId: string, sessionRevision: number) {
      if (activeAttempt) {
        return null;
      }

      const attempt = {
        token: ++nextToken,
        recipeId,
        sessionRevision,
      } satisfies CookbookSaveAttempt;
      activeAttempt = attempt;
      return attempt;
    },
    canConfirm(
      attempt: CookbookSaveAttempt,
      activeRecipeId: string,
      activeSessionRevision: number,
    ) {
      return (
        activeAttempt?.token === attempt.token &&
        attempt.recipeId === activeRecipeId &&
        attempt.sessionRevision === activeSessionRevision
      );
    },
    finish(attempt: CookbookSaveAttempt) {
      if (activeAttempt?.token !== attempt.token) {
        return false;
      }
      activeAttempt = null;
      return true;
    },
    reset() {
      activeAttempt = null;
    },
  };
}
