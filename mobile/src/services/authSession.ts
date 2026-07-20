export type MobileSessionIdentity = {
  userId: string | null;
  revision: number;
  initialized: boolean;
};

type SessionTransitionOptions = {
  forceRevision?: boolean;
};

export class MobileSessionChangedError extends Error {
  constructor(message = "Mobile account changed while the request was in progress.") {
    super(message);
    this.name = "MobileSessionChangedError";
  }
}

export function isMobileSessionChangedError(error: unknown) {
  return error instanceof MobileSessionChangedError;
}

export function isSameMobileSessionIdentity(
  left: MobileSessionIdentity,
  right: MobileSessionIdentity,
) {
  return left.revision === right.revision && left.userId === right.userId;
}

export function assertSameMobileSessionIdentity(
  expected: MobileSessionIdentity,
  actual: MobileSessionIdentity,
) {
  if (!isSameMobileSessionIdentity(expected, actual)) {
    throw new MobileSessionChangedError();
  }
}

export function getWorkspaceSessionDisposition(
  owner: MobileSessionIdentity,
  current: MobileSessionIdentity,
  allowSignedOutAuthenticationContinuation: boolean,
) {
  if (isSameMobileSessionIdentity(owner, current)) {
    return "retain" as const;
  }
  if (
    allowSignedOutAuthenticationContinuation &&
    owner.userId === null &&
    current.userId !== null
  ) {
    return "retain" as const;
  }
  return "reset_to_root" as const;
}

export function createMobileSessionIdentitySignal() {
  let snapshot: MobileSessionIdentity = {
    userId: null,
    revision: 0,
    initialized: false,
  };
  const listeners = new Set<() => void>();

  function transition(userId: string | null, options?: SessionTransitionOptions) {
    const normalizedUserId = userId?.trim() || null;
    const shouldAdvance =
      options?.forceRevision === true ||
      !snapshot.initialized ||
      snapshot.userId !== normalizedUserId;
    if (!shouldAdvance) {
      return snapshot;
    }

    snapshot = {
      userId: normalizedUserId,
      revision: snapshot.revision + 1,
      initialized: true,
    };
    listeners.forEach((listener) => listener());
    return snapshot;
  }

  return {
    getSnapshot: () => snapshot,
    transition,
    capture: () => snapshot,
    isCurrent: (candidate: MobileSessionIdentity) =>
      candidate.revision === snapshot.revision && candidate.userId === snapshot.userId,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const mobileSessionIdentitySignal = createMobileSessionIdentitySignal();

export function getMobileSessionIdentity() {
  return mobileSessionIdentitySignal.getSnapshot();
}

export function transitionMobileSessionIdentity(
  userId: string | null,
  options?: SessionTransitionOptions,
) {
  return mobileSessionIdentitySignal.transition(userId, options);
}

export function captureMobileSessionIdentity() {
  return mobileSessionIdentitySignal.capture();
}

export function isMobileSessionIdentityCurrent(candidate: MobileSessionIdentity) {
  return mobileSessionIdentitySignal.isCurrent(candidate);
}

export function assertMobileSessionIdentityCurrent(candidate: MobileSessionIdentity) {
  assertSameMobileSessionIdentity(candidate, getMobileSessionIdentity());
}

export function subscribeToMobileSessionIdentity(listener: () => void) {
  return mobileSessionIdentitySignal.subscribe(listener);
}
