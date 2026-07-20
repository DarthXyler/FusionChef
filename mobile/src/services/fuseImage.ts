import { getApiBaseUrl } from "../config/api";
import type { MealType } from "../types/recipe";
import { shouldInvalidateMobileSession } from "./accountOwnership";
import { getMobileAuthRequestContext } from "./auth";
import {
  isMobileSessionIdentityCurrent,
  MobileSessionChangedError,
  type MobileSessionIdentity,
} from "./authSession";
import { getMobileAnonymousId, getMobileDeviceKey } from "./mobileIdentity";
import { clearInvalidMobileSession } from "./sessionInvalidation";

type FuseImageRequest = {
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  mealType: MealType;
};

type FuseImageErrorPayload = {
  error?: unknown;
  reason?: unknown;
};

async function readErrorPayload(response: Response): Promise<FuseImageErrorPayload> {
  try {
    return (await response.json()) as FuseImageErrorPayload;
  } catch {
    return {};
  }
}

function getFuseImageErrorMessage(response: Response, payload: FuseImageErrorPayload) {
  if (response.status === 401 && payload.reason === "login_required") {
    return "Sign in to create or reroll recipes.";
  }
  return typeof payload.error === "string" && payload.error.trim().length > 0
    ? payload.error
    : "The recipe image request failed.";
}

async function handleFuseImageError(
  response: Response,
  identity: MobileSessionIdentity,
): Promise<never> {
  const payload = await readErrorPayload(response);
  if (
    shouldInvalidateMobileSession(response.status, payload) &&
    isMobileSessionIdentityCurrent(identity)
  ) {
    await clearInvalidMobileSession(identity);
    throw new MobileSessionChangedError();
  }
  if (!isMobileSessionIdentityCurrent(identity)) {
    throw new MobileSessionChangedError();
  }
  throw new Error(getFuseImageErrorMessage(response, payload));
}

export async function fetchRecipeImagePreview(
  input: FuseImageRequest,
): Promise<string> {
  const authContext = await getMobileAuthRequestContext();
  if (!authContext.token) {
    throw new Error("Sign in to create or reroll recipes.");
  }

  const [mobileAnonId, mobileDeviceKey] = await Promise.all([
    getMobileAnonymousId(),
    getMobileDeviceKey(),
  ]);
  if (!isMobileSessionIdentityCurrent(authContext.identity)) {
    throw new MobileSessionChangedError();
  }
  const response = await fetch(`${getApiBaseUrl()}/api/fuse-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flavor-fusion-anon-id": mobileAnonId,
      "x-flavor-fusion-device-key": mobileDeviceKey,
      authorization: `Bearer ${authContext.token}`,
    },
    body: JSON.stringify(input),
  });

  if (!isMobileSessionIdentityCurrent(authContext.identity)) {
    throw new MobileSessionChangedError();
  }
  if (!response.ok) {
    return handleFuseImageError(response, authContext.identity);
  }

  const payload = (await response.json()) as { imageUrl?: unknown };
  if (!isMobileSessionIdentityCurrent(authContext.identity)) {
    throw new MobileSessionChangedError();
  }
  if (typeof payload.imageUrl !== "string" || payload.imageUrl.trim().length === 0) {
    throw new Error("The recipe image response was not in the expected format.");
  }

  return payload.imageUrl;
}
