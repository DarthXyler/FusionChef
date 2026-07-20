export type MobileProfileResponseOperation = "get" | "patch";

export type MobileProfileResponseDisposition =
  | "success"
  | "fallback"
  | "invalid_session"
  | "error";

export function classifyMobileProfileResponse(
  operation: MobileProfileResponseOperation,
  status: number,
  ok: boolean,
  payload: unknown,
): MobileProfileResponseDisposition {
  const reason =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).reason
      : null;
  if (
    status === 401 &&
    (reason === "auth_invalid" || reason === "account_deleted")
  ) {
    return "invalid_session";
  }
  if (ok) {
    return "success";
  }
  return operation === "get" ? "fallback" : "error";
}

export function getMobileProfileResponseError(
  payload: unknown,
  fallback: string,
) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fallback;
  }
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" && error.trim().length > 0
    ? error.trim()
    : fallback;
}
