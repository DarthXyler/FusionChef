/**
 * RecipeInputForm
 *
 * Purpose:
 * - Collects the base recipe and user preferences (fusion cuisine, spice level, dietary style)
 * - Sends the data to /api/fuse to generate an AI-powered fusion recipe
 *
 * Flow:
 * - Restores the last used input from localStorage so users do not retype
 * - Validates that a base recipe is provided
 * - POSTs the request to /api/fuse
 * - Verifies the response matches the RecipeFusion shape
 * - Saves the generated recipe and input to localStorage
 * - Redirects the user to /result with the generated recipe ID
 *
 * Why this works:
 * - Prevents empty submissions
 * - Shows clear, user-friendly errors
 * - Uses runtime validation to avoid broken or unexpected API responses
 * - Persists state so users can reroll or save recipes later
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DietaryStyle, FuseRequest, MealType } from "@/lib/types";
// Shared cuisine list (kept in one place for easier updates).
import { CUISINE_OPTIONS } from "@/lib/config/cuisines";
import { clearLastInput, saveGeneratedRecipe, getLastInput, setLastInput } from "@/lib/storage";
import {
  isLikelyRecipeOrFoodName,
  RECIPE_INPUT_GUIDANCE_MESSAGE,
} from "@/lib/recipe-input-guard";
import { isRecipeFusion } from "@/lib/validation";

// Dietary options for the optional preference selector.
const DIETARY_OPTIONS: Array<{ value: DietaryStyle; label: string }> = [
  { value: "none", label: "None" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "high_protein", label: "High Protein" },
];

const MEAL_TYPE_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: "appetizer", label: "Appetizer" },
  { value: "main", label: "Main" },
  { value: "soup", label: "Soup" },
  { value: "salad", label: "Salad" },
  { value: "dessert", label: "Dessert" },
  { value: "beverage", label: "Beverage" },
];

export function RecipeInputForm() {
  const router = useRouter();
  const FUSE_REQUEST_TIMEOUT_MS = 35_000;
  const DEFAULT_FUSION_CUISINE = CUISINE_OPTIONS[0] ?? "Japanese";
  // Form state: what user typed/selected.
  const [baseRecipe, setBaseRecipe] = useState("");
  const [fusionCuisine, setFusionCuisine] = useState<string>(
    DEFAULT_FUSION_CUISINE,
  );
  const [mealType, setMealType] = useState<MealType>("main");
  const [dietaryStyle, setDietaryStyle] = useState<DietaryStyle>("none");
  const [spiceLevel, setSpiceLevel] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [isMealTypeOpen, setIsMealTypeOpen] = useState(false);
  const [isCuisineOpen, setIsCuisineOpen] = useState(false);
  const [isDietaryOpen, setIsDietaryOpen] = useState(false);
  const [mealTypeHighlight, setMealTypeHighlight] = useState(0);
  const [cuisineHighlight, setCuisineHighlight] = useState(0);
  const [dietaryHighlight, setDietaryHighlight] = useState(0);
  // UI state: loading + errors while sending request.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
  const shouldShowSpiceLevel = mealType !== "dessert" && mealType !== "beverage";

  // When page opens, restore the last used settings from local storage.
  useEffect(() => {
    const shouldReset =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("reset") === "1";
    if (shouldReset) {
      setBaseRecipe("");
      setMealType("main");
      setFusionCuisine(DEFAULT_FUSION_CUISINE);
      setDietaryStyle("none");
      setSpiceLevel(1);
      setError("");
      setIsMealTypeOpen(false);
      setIsCuisineOpen(false);
      setIsDietaryOpen(false);
      clearLastInput();
      return;
    }

    const lastInput = getLastInput();
    if (!lastInput) {
      return;
    }
    setBaseRecipe(lastInput.baseRecipe);
    setMealType(lastInput.mealType);
    setFusionCuisine(lastInput.fusionCuisine);
    setDietaryStyle(lastInput.dietaryStyle);
    setSpiceLevel(lastInput.spiceLevel);
  }, [DEFAULT_FUSION_CUISINE]);

  useEffect(() => {
    if (isMealTypeOpen) {
      const index = Math.max(
        0,
        MEAL_TYPE_OPTIONS.findIndex((option) => option.value === mealType),
      );
      setMealTypeHighlight(index);
    }
  }, [isMealTypeOpen, mealType]);

  useEffect(() => {
    if (isCuisineOpen) {
      const index = Math.max(
        0,
        CUISINE_OPTIONS.findIndex((option) => option === fusionCuisine),
      );
      setCuisineHighlight(index);
    }
  }, [isCuisineOpen, fusionCuisine]);

  useEffect(() => {
    if (isDietaryOpen) {
      const index = Math.max(
        0,
        DIETARY_OPTIONS.findIndex((option) => option.value === dietaryStyle),
      );
      setDietaryHighlight(index);
    }
  }, [isDietaryOpen, dietaryStyle]);

  // Submit form -> call /api/fuse -> store result -> open /result page.
  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Prevent double-click / multiple submissions
    if (isSubmitting) return;
    
    const trimmedRecipe = baseRecipe.trim();

    if (!trimmedRecipe) {
      setError(RECIPE_INPUT_GUIDANCE_MESSAGE);
      return;
    }

    if (!isLikelyRecipeOrFoodName(trimmedRecipe)) {
      setError(RECIPE_INPUT_GUIDANCE_MESSAGE);
      return;
    }

    const payload: FuseRequest = {
      baseRecipe: trimmedRecipe,
      mealType,
      fusionCuisine: fusionCuisine.trim(),
      spiceLevel: shouldShowSpiceLevel ? spiceLevel : 1,
      dietaryStyle,
    };

    setIsSubmitting(true);
    setError("");
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), FUSE_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/fuse", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as unknown;
      if (!response.ok) {
        const message =
          typeof data === "object" &&
          data !== null &&
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : "Could not fuse this recipe. Please try again.";
        throw new Error(message);
      }

      if (!isRecipeFusion(data)) {
        throw new Error("The response did not match the expected recipe format.");
      }

      saveGeneratedRecipe({
        recipe: data,
        sourceInput: payload,
        createdAt: new Date().toISOString(),
      });
      setLastInput(payload);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(`preview:pending:${data.id}`, "1");
      }

      router.push(`/result?id=${encodeURIComponent(data.id)}`);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      window.clearTimeout(timeoutId);
      setIsSubmitting(false);
    }
  }

  return (
    // Main input form users interact with to generate a fusion recipe.
    <form onSubmit={onSubmit} className="space-y-6 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Base recipe text input */}
        <div className="space-y-2">
          <label htmlFor="baseRecipe" className="text-sm font-semibold text-emerald-900">
            Base Recipe
          </label>
          <textarea
            id="baseRecipe"
            name="baseRecipe"
            rows={10}
            placeholder="Paste your recipe here..."
            value={baseRecipe}
            onChange={(event) => setBaseRecipe(event.target.value)}
            className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base text-emerald-800/70 outline-none transition focus:border-orange-500"
          />
        </div>

        {/* Right column controls */}
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="mealType" className="text-sm font-semibold text-emerald-900">
              Meal Type
            </label>
            <div
              className="relative"
              tabIndex={-1}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsMealTypeOpen(false);
                }
              }}
            >
              <button
                id="mealType"
                type="button"
                onClick={() => setIsMealTypeOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base text-emerald-800/70 transition focus:border-orange-500"
              >
                <span>{MEAL_TYPE_OPTIONS.find((option) => option.value === mealType)?.label}</span>
                <span className="text-emerald-800/70">▾</span>
              </button>
              {isMealTypeOpen ? (
                <div
                  role="listbox"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setIsMealTypeOpen(false);
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setMealTypeHighlight((prev) =>
                        Math.min(prev + 1, MEAL_TYPE_OPTIONS.length - 1),
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setMealTypeHighlight((prev) => Math.max(prev - 1, 0));
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const option = MEAL_TYPE_OPTIONS[mealTypeHighlight];
                      if (option) {
                        setMealType(option.value);
                        setIsMealTypeOpen(false);
                      }
                    }
                  }}
                  className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg"
                >
                  {MEAL_TYPE_OPTIONS.map((option, index) => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={mealType === option.value}
                      onMouseEnter={() => setMealTypeHighlight(index)}
                      onClick={() => {
                        setMealType(option.value);
                        setIsMealTypeOpen(false);
                      }}
                      className={`w-full px-4 py-2 text-left text-sm ${
                        mealTypeHighlight === index || mealType === option.value
                          ? "bg-emerald-500 text-white"
                          : "text-emerald-800/70 hover:bg-emerald-50"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="fusionCuisine" className="text-sm font-semibold text-emerald-900">
              Fusion Cuisine
            </label>
            <div
              className="relative"
              tabIndex={-1}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsCuisineOpen(false);
                }
              }}
            >
              <button
                id="fusionCuisine"
                type="button"
                onClick={() => setIsCuisineOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base text-emerald-800/70 transition focus:border-orange-500"
              >
                <span>{fusionCuisine}</span>
                <span className="text-emerald-800/70">▾</span>
              </button>
              {isCuisineOpen ? (
                <div
                  role="listbox"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setIsCuisineOpen(false);
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setCuisineHighlight((prev) =>
                        Math.min(prev + 1, CUISINE_OPTIONS.length - 1),
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setCuisineHighlight((prev) => Math.max(prev - 1, 0));
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const option = CUISINE_OPTIONS[cuisineHighlight];
                      if (option) {
                        setFusionCuisine(option);
                        setIsCuisineOpen(false);
                      }
                    }
                  }}
                  className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg"
                >
                  {CUISINE_OPTIONS.map((option, index) => (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={fusionCuisine === option}
                      onMouseEnter={() => setCuisineHighlight(index)}
                      onClick={() => {
                        setFusionCuisine(option);
                        setIsCuisineOpen(false);
                      }}
                      className={`w-full px-4 py-2 text-left text-sm ${
                        cuisineHighlight === index || fusionCuisine === option
                          ? "bg-emerald-500 text-white"
                          : "text-emerald-800/70 hover:bg-emerald-50"
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="dietaryStyle" className="text-sm font-semibold text-emerald-900">
              Dietary Style
            </label>
            <div
              className="relative"
              tabIndex={-1}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsDietaryOpen(false);
                }
              }}
            >
              <button
                id="dietaryStyle"
                type="button"
                onClick={() => setIsDietaryOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base text-emerald-800/70 transition focus:border-orange-500"
              >
                <span>{DIETARY_OPTIONS.find((option) => option.value === dietaryStyle)?.label}</span>
                <span className="text-emerald-800/70">▾</span>
              </button>
              {isDietaryOpen ? (
                <div
                  role="listbox"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setIsDietaryOpen(false);
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setDietaryHighlight((prev) =>
                        Math.min(prev + 1, DIETARY_OPTIONS.length - 1),
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setDietaryHighlight((prev) => Math.max(prev - 1, 0));
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const option = DIETARY_OPTIONS[dietaryHighlight];
                      if (option) {
                        setDietaryStyle(option.value);
                        setIsDietaryOpen(false);
                      }
                    }
                  }}
                  className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg"
                >
                  {DIETARY_OPTIONS.map((option, index) => (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={dietaryStyle === option.value}
                      onMouseEnter={() => setDietaryHighlight(index)}
                      onClick={() => {
                        setDietaryStyle(option.value);
                        setIsDietaryOpen(false);
                      }}
                      className={`w-full px-4 py-2 text-left text-sm ${
                        dietaryHighlight === index || dietaryStyle === option.value
                          ? "bg-emerald-500 text-white"
                          : "text-emerald-800/70 hover:bg-emerald-50"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {/* Spice slider (1 to 5) */}
          {shouldShowSpiceLevel ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="spiceLevel" className="text-sm font-semibold text-emerald-900">
                Spice Level
              </label>
              <span className="inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1 text-sm font-semibold text-orange-800">
                <span className="flex items-center gap-1 text-red-500">
                  {Array.from({ length: spiceLevel }).map((_, index) => (
                    <span key={`chili-${index}`} aria-hidden="true">
                      🌶️
                    </span>
                  ))}
                </span>
              </span>
            </div>
            <input
              id="spiceLevel"
              name="spiceLevel"
              type="range"
              min={1}
              max={5}
              step={1}
              value={spiceLevel}
              onChange={(event) =>
                setSpiceLevel(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)
              }
              className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-orange-200 accent-orange-600"
            />
            <p className="text-sm font-medium text-emerald-800/70">
              {spiceLevel === 1
                ? "Mild"
                : spiceLevel === 2
                  ? "Mild-Medium"
                  : spiceLevel === 3
                    ? "Medium"
                    : spiceLevel === 4
                      ? "Hot"
                      : "Very Hot"}
            </p>
          </div>
          ) : null}
        </div>
      </div>

      {/* Friendly error message if request fails */}
      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {/* Submit button with loading state */}
      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-2xl bg-emerald-500 px-5 py-3 text-base font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Fusing..." : "Fuse Recipe"}
      </button>
    </form>
  );
}
