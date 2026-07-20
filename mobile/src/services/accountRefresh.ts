export type AccountRefreshIdentity = {
  userId: string | null;
  revision: number;
  refreshGeneration?: number;
};

export function createAccountRefreshRequestCoalescer<T>() {
  let inFlight:
    | {
        revision: number;
        refreshGeneration: number;
        promise: Promise<T>;
      }
    | null = null;

  return {
    run(identity: AccountRefreshIdentity, operation: () => Promise<T>) {
      const refreshGeneration = identity.refreshGeneration ?? 0;
      if (
        inFlight?.revision === identity.revision &&
        inFlight.refreshGeneration === refreshGeneration
      ) {
        return inFlight.promise;
      }

      const promise = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (inFlight?.promise === promise) {
            inFlight = null;
          }
        });
      inFlight = {
        revision: identity.revision,
        refreshGeneration,
        promise,
      };
      return promise;
    },
    reset() {
      inFlight = null;
    },
  };
}

export function mergeVerifiedAccountBalance<
  TSnapshot extends { balance: TBalance },
  TBalance,
>(snapshot: TSnapshot, balance: TBalance): TSnapshot {
  return {
    ...snapshot,
    balance,
  };
}

export function createPostMutationAccountRefresh<
  TSnapshot,
  TBalance,
  TIdentity extends AccountRefreshIdentity,
>(options: {
  isCurrent: (identity: TIdentity) => boolean;
  onMutation?: (identity: TIdentity, mutationSequence: number) => void;
  prepareFreshRequest?: (identity: TIdentity, mutationSequence: number) => void;
  requestFreshSnapshot: (
    identity: TIdentity,
    mutationSequence: number,
  ) => Promise<TSnapshot>;
  publishFreshSnapshot?: (
    snapshot: TSnapshot,
    identity: TIdentity,
    mutationSequence: number,
  ) => void;
  publishVerifiedBalance: (
    balance: TBalance,
    identity: TIdentity,
    mutationSequence: number,
  ) => void;
  refreshTimeoutMs?: number;
}) {
  const refreshTimeoutMs = Math.max(0, options.refreshTimeoutMs ?? 5_000);
  let activeRevision: number | null = null;
  let latestMutationSequence = 0;
  let inFlight:
    | {
        revision: number;
        mutationSequence: number;
        token: symbol;
        promise: Promise<void>;
      }
    | null = null;
  const idleResolvers = new Set<() => void>();

  function resolveIdleWaiters() {
    if (inFlight) {
      return;
    }
    idleResolvers.forEach((resolve) => resolve());
    idleResolvers.clear();
  }

  function startRefresh(identity: TIdentity, mutationSequence: number) {
    if (
      !options.isCurrent(identity) ||
      activeRevision !== identity.revision
    ) {
      resolveIdleWaiters();
      return;
    }

    options.prepareFreshRequest?.(identity, mutationSequence);
    const token = Symbol("post-mutation-account-refresh");
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const request = Promise.resolve()
      .then(() => options.requestFreshSnapshot(identity, mutationSequence))
      .then(
        (snapshot) => snapshot,
        () => null,
      );
    const boundedRequest =
      refreshTimeoutMs > 0
        ? Promise.race([
            request,
            new Promise<null>((resolve) => {
              timeoutId = setTimeout(() => resolve(null), refreshTimeoutMs);
            }),
          ])
        : request;
    const promise = boundedRequest
      .then((snapshot) => {
        if (
          snapshot &&
          options.publishFreshSnapshot &&
          options.isCurrent(identity) &&
          activeRevision === identity.revision &&
          mutationSequence === latestMutationSequence
        ) {
          options.publishFreshSnapshot(snapshot, identity, mutationSequence);
        }
      })
      .finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (inFlight?.token !== token) {
          return;
        }

        inFlight = null;
        if (
          options.isCurrent(identity) &&
          activeRevision === identity.revision &&
          latestMutationSequence > mutationSequence
        ) {
          startRefresh(identity, latestMutationSequence);
          return;
        }
        resolveIdleWaiters();
      });
    inFlight = {
      revision: identity.revision,
      mutationSequence,
      token,
      promise,
    };
  }

  function schedule(input: {
    expectedIdentity: TIdentity;
    verifiedBalance?: TBalance | null;
  }) {
    if (!options.isCurrent(input.expectedIdentity)) {
      return null;
    }
    if (activeRevision !== input.expectedIdentity.revision) {
      activeRevision = input.expectedIdentity.revision;
      latestMutationSequence = 0;
      inFlight = null;
      resolveIdleWaiters();
    }

    latestMutationSequence += 1;
    const mutationSequence = latestMutationSequence;
    options.onMutation?.(input.expectedIdentity, mutationSequence);
    if (input.verifiedBalance) {
      try {
        options.publishVerifiedBalance(
          input.verifiedBalance,
          input.expectedIdentity,
          mutationSequence,
        );
      } catch {
        // Publishing the verified balance must not fail a successful purchase.
      }
    }

    if (!inFlight) {
      startRefresh(input.expectedIdentity, mutationSequence);
    }
    return mutationSequence;
  }

  function waitForIdle() {
    if (!inFlight) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleResolvers.add(resolve);
    });
  }

  return {
    schedule,
    waitForIdle,
  };
}
