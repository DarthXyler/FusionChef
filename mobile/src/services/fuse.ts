import { getApiBaseUrl } from "../config/api";
import type {
  DietaryStyle,
  FuseRequest,
  GeneratedRecipeRecord,
  RecipeFusion,
  SpiceLevel,
} from "../types/recipe";
import { getMobileAuthToken } from "./auth";
import { getMobileAnonymousId, getMobileDeviceKey, setMobileAnonymousId } from "./mobileIdentity";

type FuseActionKind = "fuse" | "reroll";

type FuseErrorPayload = {
  error?: unknown;
  reason?: unknown;
  purchaseRequired?: unknown;
  actionKind?: unknown;
  freeActionLimit?: unknown;
  usedToday?: unknown;
  freeActionsRemaining?: unknown;
  balance?: unknown;
};

export class FuseRequestError extends Error {
  status: number;
  reason: string | null;
  purchaseRequired: boolean;
  details: FuseErrorPayload;

  constructor(status: number, details: FuseErrorPayload, fallbackMessage: string) {
    const message =
      typeof details.error === "string" && details.error.trim().length > 0
        ? details.error
        : fallbackMessage;
    super(message);
    this.name = "FuseRequestError";
    this.status = status;
    this.reason =
      typeof details.reason === "string" && details.reason.trim().length > 0
        ? details.reason
        : null;
    this.purchaseRequired = details.purchaseRequired === true;
    this.details = details;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDietaryStyle(value: unknown): value is DietaryStyle {
  return value === "none" || value === "vegetarian" || value === "high_protein";
}

function isSpiceLevel(value: unknown): value is SpiceLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function isRecipeFusion(value: unknown): value is RecipeFusion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.title) &&
    isNonEmptyString(candidate.baseCuisine) &&
    isNonEmptyString(candidate.fusionCuisine) &&
    typeof candidate.servings === "number" &&
    Number.isFinite(candidate.servings) &&
    typeof candidate.timeMinutes === "number" &&
    Number.isFinite(candidate.timeMinutes) &&
    isSpiceLevel(candidate.spiceLevel) &&
    isDietaryStyle(candidate.dietaryStyle) &&
    Array.isArray(candidate.ingredients) &&
    Array.isArray(candidate.steps) &&
    Array.isArray(candidate.swaps) &&
    Array.isArray(candidate.shoppingList) &&
    typeof candidate.nutritionNotes === "string"
  );
}

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as FuseErrorPayload;
    return new FuseRequestError(response.status, payload, "The live recipe request failed.");
  } catch {
    return new FuseRequestError(response.status, {}, "The live recipe request failed.");
  }
}

export async function fetchLiveRecipeRecord(
  input: FuseRequest,
  action: FuseActionKind = "fuse",
  requestId?: string,
): Promise<GeneratedRecipeRecord> {
  const mobileAnonId = await getMobileAnonymousId();
  const mobileDeviceKey = await getMobileDeviceKey();
  const authToken = await getMobileAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-flavor-fusion-anon-id": mobileAnonId,
    "x-flavor-fusion-device-key": mobileDeviceKey,
    "x-flavor-fusion-action": action,
  };
  if (typeof requestId === "string" && requestId.trim().length > 0) {
    headers["x-flavor-fusion-request-id"] = requestId.trim();
  }
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  const response = await fetch(`${getApiBaseUrl()}/api/fuse`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (canonicalAnonId) {
    await setMobileAnonymousId(canonicalAnonId);
  }

  if (!response.ok) {
    throw await readErrorMessage(response);
  }

  const payload = (await response.json()) as unknown;
  if (!isRecipeFusion(payload)) {
    throw new Error("The live recipe response was not in the expected format.");
  }

  return {
    recipe: payload,
    sourceInput: input,
    createdAt: new Date().toISOString(),
  };
}
