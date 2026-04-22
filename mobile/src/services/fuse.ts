import { getApiBaseUrl } from "../config/api";
import type {
  DietaryStyle,
  FuseRequest,
  GeneratedRecipeRecord,
  RecipeFusion,
  SpiceLevel,
} from "../types/recipe";
import { getMobileAnonymousId, getMobileDeviceKey, setMobileAnonymousId } from "./mobileIdentity";

type FuseActionKind = "fuse" | "reroll";

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
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : "The live recipe request failed.";
  } catch {
    return "The live recipe request failed.";
  }
}

export async function fetchLiveRecipeRecord(
  input: FuseRequest,
  action: FuseActionKind = "fuse",
): Promise<GeneratedRecipeRecord> {
  const mobileAnonId = await getMobileAnonymousId();
  const mobileDeviceKey = await getMobileDeviceKey();
  const response = await fetch(`${getApiBaseUrl()}/api/fuse`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flavor-fusion-anon-id": mobileAnonId,
      "x-flavor-fusion-device-key": mobileDeviceKey,
      "x-flavor-fusion-action": action,
    },
    body: JSON.stringify(input),
  });
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (canonicalAnonId) {
    await setMobileAnonymousId(canonicalAnonId);
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
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
