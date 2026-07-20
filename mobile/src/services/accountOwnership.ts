export function buildAccountStorageKey(
  namespace: string,
  userId: string,
  ...segments: string[]
) {
  const normalizedNamespace = namespace.trim();
  const normalizedUserId = userId.trim();
  if (!normalizedNamespace || !normalizedUserId) {
    throw new Error("Account storage keys require a namespace and authenticated user ID.");
  }
  return [normalizedNamespace, normalizedUserId, ...segments.map((segment) => segment.trim())].join(
    ":",
  );
}

export function selectAccountOwnedValue<T>(scopedValue: T | null, emptyValue: T) {
  return scopedValue ?? emptyValue;
}

export function hasInvalidMobileAuthReason(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const reason = (payload as Record<string, unknown>).reason;
  return reason === "account_deleted" || reason === "auth_invalid";
}

export function shouldInvalidateMobileSession(status: number, payload: unknown) {
  return status === 401 && hasInvalidMobileAuthReason(payload);
}
