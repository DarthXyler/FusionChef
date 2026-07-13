export type RerollContinuationOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" }
  | { status: "authentication_failed"; error: unknown }
  | { status: "duplicate" };

type RerollContinuationInput<T> = {
  isAuthenticated: () => Promise<boolean>;
  authenticate: () => Promise<boolean>;
  requestReroll: (action: "reroll") => Promise<T>;
};

export function createAuthenticatedRerollContinuation() {
  let isRunning = false;

  return {
    isRunning() {
      return isRunning;
    },
    async run<T>(input: RerollContinuationInput<T>): Promise<RerollContinuationOutcome<T>> {
      if (isRunning) {
        return { status: "duplicate" };
      }

      isRunning = true;
      try {
        let authenticated: boolean;
        try {
          authenticated = await input.isAuthenticated();
          if (!authenticated) {
            authenticated = await input.authenticate();
          }
        } catch (error) {
          return { status: "authentication_failed", error };
        }

        if (!authenticated) {
          return { status: "cancelled" };
        }

        const value = await input.requestReroll("reroll");
        return { status: "completed", value };
      } finally {
        isRunning = false;
      }
    },
  };
}
