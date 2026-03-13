/**
 * ResultPageClient
 *
 * Purpose:
 * - Displays the generated fusion recipe result to the user.
 *
 * Flow:
 * - Reads the recipe id from the URL query (?id=...)
 * - Loads the corresponding recipe from localStorage
 * - If no id is present, falls back to the most recently generated recipe
 * - Renders the recipe using RecipeResultView
 *
 * User actions:
 * - Save to Cookbook: persists the recipe via the cookbook API
 * - Reroll: calls /api/fuse again using the same input to generate a new variation
 * - Back to Edit: returns to the input screen
 *
 * This completes the main user journey from recipe input to final result.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RecipeResultView } from "@/components/RecipeResultView";
import {
  getGeneratedRecipeById,
  getLastInput,
  getLatestGeneratedRecipe,
  saveGeneratedRecipe,
  setLastInput,
} from "@/lib/storage";
import type { GeneratedRecipeRecord } from "@/lib/types";
import { isRecipeFusion } from "@/lib/validation";

type ResultPageClientProps = {
  initialRecipeId?: string | null;
};

export function ResultPageClient({ initialRecipeId = null }: ResultPageClientProps) {
  const IMAGE_FETCH_TIMEOUT_MS = 25_000;
  const REROLL_TIMEOUT_MS = 30_000;
  const SAVE_REQUEST_TIMEOUT_MS = 30_000;
  const router = useRouter();
  // Holds the current recipe result pulled from local storage.
  const [record, setRecord] = useState<GeneratedRecipeRecord | null>(null);
  // Loading state while we find the saved result.
  const [isLoading, setIsLoading] = useState(true);
  // Loading state for the "Reroll" action.
  const [isRerolling, setIsRerolling] = useState(false);
  // Loading state for the generated image.
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [hasCheckedPreviewCache, setHasCheckedPreviewCache] = useState(false);
  const [imageError, setImageError] = useState(false);
  // Short success message shown after save/reroll.
  const [statusMessage, setStatusMessage] = useState("");
  // Short error message shown when something goes wrong.
  const [error, setError] = useState("");
  // Generic error message shown when something goes wrong.
  const GENERIC_REROLL_ERROR = "Something went wrong. Please try again.";
  const recipeId = record?.recipe.id;

  async function cleanupUploadedImage(imageUrl: string) {
    const CLEANUP_TIMEOUT_MS = 5_000;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
    try {
      await fetch("/api/r2-delete", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl }),
      });
    } catch {
      // Best-effort cleanup; ignore failures.
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
  ) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  // On first render, load the recipe by id from the URL (or the latest saved one).
  useEffect(() => {
    const id = initialRecipeId;
    const loaded = id ? getGeneratedRecipeById(id) : getLatestGeneratedRecipe();
    setRecord(loaded);
    setIsLoading(false);
  }, [initialRecipeId]);

  useEffect(() => {
    setHasCheckedPreviewCache(false);
    if (!recipeId) {
      setPreviewImageUrl(null);
      setImageError(false);
      setHasCheckedPreviewCache(true);
      return;
    }

    setImageError(false);
    if (typeof window !== "undefined") {
      const cached = window.sessionStorage.getItem(`preview:${recipeId}`);
      setPreviewImageUrl(cached);
    } else {
      setPreviewImageUrl(null);
    }
    setHasCheckedPreviewCache(true);
  }, [recipeId]);

  useEffect(() => {
    async function fetchImage() {
      if (
        !record ||
        !recipeId ||
        !hasCheckedPreviewCache ||
        previewImageUrl ||
        isImageLoading ||
        imageError ||
        typeof window === "undefined"
      ) {
        return;
      }

      const pendingKey = `preview:pending:${recipeId}`;
      if (window.sessionStorage.getItem(pendingKey) !== "1") {
        return;
      }

      setIsImageLoading(true);
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch("/api/fuse-image", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: record.recipe.title,
            baseCuisine: record.recipe.baseCuisine,
            fusionCuisine: record.recipe.fusionCuisine,
          }),
        });

        const data = (await response.json()) as { imageUrl?: string };
        if (!response.ok || !data.imageUrl) {
          window.sessionStorage.removeItem(pendingKey);
          setImageError(true);
          return;
        }

        setPreviewImageUrl(data.imageUrl);
        window.sessionStorage.setItem(`preview:${recipeId}`, data.imageUrl);
        window.sessionStorage.removeItem(pendingKey);
      } catch {
        window.sessionStorage.removeItem(pendingKey);
        setImageError(true);
      } finally {
        window.clearTimeout(timeoutId);
        setIsImageLoading(false);
      }
    }

    fetchImage();
  }, [record, recipeId, hasCheckedPreviewCache, previewImageUrl, isImageLoading, imageError]);

  const imageStatus = imageError ? "error" : isImageLoading ? "loading" : undefined;

  // Reroll uses the last input settings and calls /api/fuse again.
  async function handleReroll() {
    const sourceInput = record?.sourceInput ?? getLastInput();
    if (!sourceInput) {
      setError("No previous input found. Go back and submit a recipe first.");
      return;
    }

    setIsRerolling(true);
    setError("");
    setStatusMessage("");
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REROLL_TIMEOUT_MS);

    try {
      // Call the AI endpoint again with the same input settings.
      const response = await fetch("/api/fuse", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sourceInput),
      });
      const data = (await response.json()) as unknown;

      if (!response.ok) {
        throw new Error("Reroll failed");
      }

      if (!isRecipeFusion(data)) {
        throw new Error("Reroll schema mismatch");
      }

      const nextRecord: GeneratedRecipeRecord = {
        recipe: data,
        sourceInput,
        createdAt: new Date().toISOString(),
      };
      saveGeneratedRecipe(nextRecord);
      setLastInput(sourceInput);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(`preview:pending:${data.id}`, "1");
      }
      setPreviewImageUrl(null);
      setImageError(false);
      setHasCheckedPreviewCache(false);
      setRecord(nextRecord);
      setStatusMessage("Generated a new variation.");

      router.replace(`/result?id=${encodeURIComponent(data.id)}`);
    } catch {
      setError(GENERIC_REROLL_ERROR);
    } finally {
      window.clearTimeout(timeoutId);
      setIsRerolling(false);
    }
  }

  // Save this recipe to the cookbook API (persisted in Turso for this anonymous browser identity).
  async function handleSave() {
    if (!record) {
      return;
    }

    setError("");
    setStatusMessage("");
    let imageUrl = record.recipe.imageUrl ?? previewImageUrl ?? "";
    let uploadedImageUrl: string | null = null;
    const uploadIdempotencyKey = `r2-upload-${record.recipe.id}`;
    const cookbookSaveIdempotencyKey = `cookbook-save-${record.recipe.id}`;

    if (imageUrl.startsWith("data:image/")) {
      try {
        const response = await fetchWithTimeout("/api/r2-upload", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uploadIdempotencyKey,
          },
          body: JSON.stringify({
            imageDataUrl: imageUrl,
            title: record.recipe.title,
          }),
        }, SAVE_REQUEST_TIMEOUT_MS);
        const data = (await response.json()) as { imageUrl?: string };
        if (!response.ok || !data.imageUrl) {
          setError("Could not upload image. Please try again.");
          return;
        }
        imageUrl = data.imageUrl;
        uploadedImageUrl = data.imageUrl;
      } catch {
        setError("Could not upload image. Please try again.");
        return;
      }
    }

    try {
      const response = await fetchWithTimeout("/api/cookbook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": cookbookSaveIdempotencyKey,
        },
        body: JSON.stringify({
          recipe: { ...record.recipe, imageUrl: imageUrl || undefined },
          sourceInput: record.sourceInput,
        }),
      }, SAVE_REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        if (uploadedImageUrl) {
          void cleanupUploadedImage(uploadedImageUrl);
        }
        setError("Could not save recipe. Please try again.");
        setStatusMessage("");
        return;
      }
    } catch {
      if (uploadedImageUrl) {
        void cleanupUploadedImage(uploadedImageUrl);
      }
      setError("Could not save recipe. Please try again.");
      setStatusMessage("");
      return;
    }

    setStatusMessage("Saved to cookbook.");
  }

  // Simple loading state while local data is being fetched.
  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-zinc-700">Loading recipe...</p>
      </div>
    );
  }

  // Empty state if no result was found in local storage.
  if (!record) {
    return (
      <section className="mx-auto w-full max-w-4xl rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <h1 className="font-serif text-3xl text-zinc-900">No recipe found</h1>
        <p className="mt-3 text-zinc-600">
          Generate a fusion recipe first, then this page will show your result.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-2xl bg-emerald-500 px-5 py-3 font-semibold text-white hover:bg-emerald-600"
        >
          Back to Home
        </Link>
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl animate-rise-in space-y-4">
      {/* Success or status messages */}
      {statusMessage ? (
        <p className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {statusMessage}
        </p>
      ) : null}
      {/* Error message if reroll/save fails */}
      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {/* Full recipe view with action buttons */}
      <RecipeResultView
        key={record.recipe.id}
        recipe={{
          ...record.recipe,
          imageUrl: previewImageUrl ?? record.recipe.imageUrl,
        }}
        mealType={record.sourceInput.mealType}
        imageStatus={imageStatus}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              Save to Cookbook
            </button>
            <button
              type="button"
              onClick={handleReroll}
              disabled={isRerolling}
              className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRerolling ? "Rerolling..." : "Reroll"}
            </button>
            <Link
              href="/"
              className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-zinc-50"
            >
              Back to Edit
            </Link>
          </div>
        }
      />
    </div>
  );
}
