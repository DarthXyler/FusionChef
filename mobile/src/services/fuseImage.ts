import { getApiBaseUrl } from "../config/api";
import type { MealType } from "../types/recipe";

type FuseImageRequest = {
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  mealType: MealType;
};

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : "The recipe image request failed.";
  } catch {
    return "The recipe image request failed.";
  }
}

export async function fetchRecipeImagePreview(
  input: FuseImageRequest,
): Promise<string> {
  const response = await fetch(`${getApiBaseUrl()}/api/fuse-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as { imageUrl?: unknown };
  if (typeof payload.imageUrl !== "string" || payload.imageUrl.trim().length === 0) {
    throw new Error("The recipe image response was not in the expected format.");
  }

  return payload.imageUrl;
}
