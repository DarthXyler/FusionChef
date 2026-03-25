import type { GeneratedRecipeRecord } from "../types/recipe";
import { sampleRecipe } from "./sampleRecipe";

export const sampleGeneratedRecipeRecord: GeneratedRecipeRecord = {
  recipe: sampleRecipe,
  sourceInput: {
    baseRecipe: "salmon rice bowl",
    mealType: "main",
    fusionCuisine: "Sri Lankan",
    spiceLevel: 2,
    dietaryStyle: "high_protein",
  },
  createdAt: "2026-03-16T00:00:00.000Z",
};
