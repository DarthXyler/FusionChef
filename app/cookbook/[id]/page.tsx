/**
 * Cookbook detail page.
 * Loads one saved recipe by id and reuses the result-view component for display.
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { RecipeResultView } from "@/components/RecipeResultView";
import { saveGeneratedRecipe, setLastInput } from "@/lib/storage";
import type { CookbookRecipeRecord } from "@/lib/types";

const COOKBOOK_DETAIL_CACHE_PREFIX = "flavor-fusion:cookbook-detail-cache:v1:";
const COOKBOOK_DETAIL_CACHE_TTL_MS = 120_000;
const COOKBOOK_DETAIL_REQUEST_TIMEOUT_MS = 12_000;

type CookbookDetailBrowserCache = {
  cachedAt: number;
  record: CookbookRecipeRecord;
  etag?: string;
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = COOKBOOK_DETAIL_REQUEST_TIMEOUT_MS,
) {
  // Network timeout guard for smoother failure handling.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function CookbookDetailPage() {
  const params = useParams<{ id: string | string[] }>();
  const recipeId = useMemo(() => {
    const rawId = params.id;
    return Array.isArray(rawId) ? rawId[0] : rawId;
  }, [params.id]);

  const [record, setRecord] = useState<CookbookRecipeRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadRecipe() {
      // Try short-lived session cache first, then refresh from API.
      setLoadError("");
      setIsLoading(true);

      if (!recipeId) {
        if (isMounted) {
          setIsLoading(false);
        }
        return;
      }

      let cached: CookbookDetailBrowserCache | null = null;
      if (typeof window !== "undefined") {
        try {
          const raw = window.sessionStorage.getItem(`${COOKBOOK_DETAIL_CACHE_PREFIX}${recipeId}`);
          if (raw) {
            const parsed = JSON.parse(raw) as {
              cachedAt?: number;
              record?: CookbookRecipeRecord;
              etag?: string;
            };
            const cachedAt = parsed.cachedAt;
            const cachedRecord = parsed.record;
            // Keep cache fresh for a short period to avoid stale details.
            const isCacheFresh =
              typeof cachedAt === "number" && Date.now() - cachedAt <= COOKBOOK_DETAIL_CACHE_TTL_MS;

            if (isCacheFresh && cachedRecord) {
              cached = {
                cachedAt,
                record: cachedRecord,
                etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
              };
              if (isMounted) {
                setRecord(cachedRecord);
                setIsLoading(false);
              }
            }
          }
        } catch {
          // Ignore cache parse errors and continue with API load.
        }
      }

      try {
        // Ask server with ETag so unchanged responses can return 304.
        const response = await fetchWithTimeout(`/api/cookbook/${encodeURIComponent(recipeId)}`, {
          cache: "no-store",
          headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined,
        });
        if (response.status === 304) {
          return;
        }

        const data = (await response.json()) as { record?: CookbookRecipeRecord };

        if (!response.ok || !data.record) {
          if (isMounted) {
            if (!cached) {
              setRecord(null);
              setLoadError("Recipe not found.");
            }
          }
          return;
        }

        if (isMounted) {
          setRecord(data.record);
          if (typeof window !== "undefined") {
            const cachePayload: CookbookDetailBrowserCache = {
              cachedAt: Date.now(),
              record: data.record,
              etag: response.headers.get("etag") ?? cached?.etag ?? undefined,
            };
            window.sessionStorage.setItem(
              `${COOKBOOK_DETAIL_CACHE_PREFIX}${recipeId}`,
              JSON.stringify(cachePayload),
            );
          }
        }
      } catch {
        if (isMounted) {
          if (!cached) {
            setRecord(null);
            setLoadError("Could not load recipe.");
          }
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadRecipe();
    return () => {
      isMounted = false;
    };
  }, [recipeId]);

  if (isLoading) {
    return (
      <section className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="font-serif text-3xl text-zinc-900">Loading recipe...</h1>
        <p className="mt-2 text-zinc-700">Fetching your saved recipe.</p>
      </section>
    );
  }

  if (!recipeId || !record) {
    return (
      <section className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="font-serif text-3xl text-zinc-900">Recipe not found</h1>
        <p className="mt-2 text-zinc-700">
          {loadError || "This saved recipe is missing or was deleted."}
        </p>
        <Link
          href="/cookbook"
          className="mt-5 inline-block rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
        >
          Back to Cookbook
        </Link>
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl animate-rise-in">
      <RecipeResultView
        key={record.recipe.id}
        recipe={record.recipe}
        mealType={record.sourceInput.mealType}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/cookbook"
              className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              Back to Cookbook
            </Link>
            <Link
              href={`/result?id=${encodeURIComponent(record.recipe.id)}`}
              onClick={() => {
                saveGeneratedRecipe({
                  recipe: record.recipe,
                  sourceInput: record.sourceInput,
                  createdAt: new Date().toISOString(),
                });
                setLastInput(record.sourceInput);
              }}
              className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-zinc-50"
            >
              Open in Result View
            </Link>
          </div>
        }
      />
    </div>
  );
}
