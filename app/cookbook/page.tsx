/**
 * Cookbook list page.
 * Loads recipe summaries from the server and shows saved recipes for this browser profile.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CookbookRecipeSummary } from "@/lib/types";

const COOKBOOK_CACHE_KEY = "flavor-fusion:cookbook-summary-cache:v1";
const COOKBOOK_CACHE_TTL_MS = 120_000;
const COOKBOOK_DETAIL_CACHE_PREFIX = "flavor-fusion:cookbook-detail-cache:v1:";
const COOKBOOK_PAGE_SIZE = 10;
const COOKBOOK_REQUEST_TIMEOUT_MS = 12_000;

type CookbookBrowserCache = {
  cachedAt: number;
  recipes: CookbookRecipeSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  etag?: string;
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = COOKBOOK_REQUEST_TIMEOUT_MS,
) {
  // Prevent UI from hanging forever on poor networks.
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

function formatDate(dateString: string) {
  // Converts ISO time into a user-friendly date label.
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isCookbookCacheFresh(cachedAt: number) {
  // Small TTL so UI feels fast while still refreshing from server.
  return Date.now() - cachedAt <= COOKBOOK_CACHE_TTL_MS;
}

export default function CookbookPage() {
  const [recipes, setRecipes] = useState<CookbookRecipeSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const didStartLoadRef = useRef(false);

  function readBrowserCookbookCache(): CookbookBrowserCache | null {
    if (typeof window === "undefined") {
      return null;
    }

    try {
      const raw = window.sessionStorage.getItem(COOKBOOK_CACHE_KEY);
      if (!raw) {
        return null;
      }

      // Parse cached summaries from session storage if available.
      const parsed = JSON.parse(raw) as Partial<CookbookBrowserCache>;
      if (!parsed || !Array.isArray(parsed.recipes) || typeof parsed.cachedAt !== "number") {
        return null;
      }

      return {
        cachedAt: parsed.cachedAt,
        recipes: parsed.recipes,
        hasMore: typeof parsed.hasMore === "boolean" ? parsed.hasMore : false,
        nextCursor: typeof parsed.nextCursor === "string" ? parsed.nextCursor : null,
        etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
      };
    } catch {
      return null;
    }
  }

  function writeBrowserCookbookCache(
    nextRecipes: CookbookRecipeSummary[],
    options?: { etag?: string; hasMore?: boolean; nextCursor?: string | null },
  ) {
    if (typeof window === "undefined") {
      return;
    }

    // Store a lightweight snapshot for instant cookbook rendering.
    const payload: CookbookBrowserCache = {
      cachedAt: Date.now(),
      recipes: nextRecipes,
      hasMore: options?.hasMore ?? false,
      nextCursor: options?.nextCursor ?? null,
      etag: options?.etag,
    };
    window.sessionStorage.setItem(COOKBOOK_CACHE_KEY, JSON.stringify(payload));
  }

  useEffect(() => {
    if (didStartLoadRef.current) {
      return;
    }
    didStartLoadRef.current = true;

    let isMounted = true;
    const cached = readBrowserCookbookCache();
    if (cached) {
      const sortedCachedRecipes = [...cached.recipes].sort(
        (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
      );
      setRecipes(sortedCachedRecipes);
      setHasMore(cached.hasMore);
      setNextCursor(cached.nextCursor);
      setIsLoading(false);
    }

    async function loadCookbook() {
      // Load from API in the background; use ETag to avoid unnecessary payload transfer.
      try {
        const requestHeaders =
          cached?.etag && isCookbookCacheFresh(cached.cachedAt)
            ? { "If-None-Match": cached.etag }
            : undefined;

        const response = await fetchWithTimeout(`/api/cookbook?pageSize=${COOKBOOK_PAGE_SIZE}`, {
          cache: "no-store",
          headers: requestHeaders,
        });
        if (response.status === 304) {
          return;
        }

        const data = (await response.json()) as {
          recipes?: CookbookRecipeSummary[];
          hasMore?: boolean;
          nextCursor?: string | null;
        };

        if (!response.ok || !Array.isArray(data.recipes)) {
          if (isMounted) {
            if (!cached) {
              setLoadError("Could not load cookbook right now.");
            }
          }
          return;
        }

        if (isMounted) {
          const sortedRecipes = [...data.recipes].sort(
            (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
          );
          setRecipes(sortedRecipes);
          setHasMore(Boolean(data.hasMore));
          setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
          writeBrowserCookbookCache(
            sortedRecipes,
            {
              etag: response.headers.get("etag") ?? cached?.etag ?? undefined,
              hasMore: Boolean(data.hasMore),
              nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
            },
          );
        }
      } catch {
        if (isMounted) {
          if (!cached) {
            setLoadError("Could not load cookbook right now.");
          }
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadCookbook();
    return () => {
      isMounted = false;
    };
  }, []);

  async function handleDelete(recipeId: string) {
    // Deletes from server and instantly updates local UI/cache state.
    setDeleteError("");

    try {
      const response = await fetchWithTimeout(`/api/cookbook/${encodeURIComponent(recipeId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        setDeleteError("Could not delete recipe. Please try again.");
        return;
      }

      setRecipes((current) => {
        const next = current.filter((entry) => entry.recipeId !== recipeId);
        writeBrowserCookbookCache(next, { hasMore, nextCursor });
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(`${COOKBOOK_DETAIL_CACHE_PREFIX}${recipeId}`);
        }
        return next;
      });
    } catch {
      setDeleteError("Could not delete recipe. Please try again.");
    }
  }

  async function handleLoadMore() {
    // Cursor-based paging for scale: fetches next slice of summaries only.
    if (!nextCursor || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setLoadError("");

    try {
      const response = await fetchWithTimeout(
        `/api/cookbook?pageSize=${COOKBOOK_PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        recipes?: CookbookRecipeSummary[];
        hasMore?: boolean;
        nextCursor?: string | null;
      };

      if (!response.ok || !Array.isArray(data.recipes)) {
        setLoadError("Could not load more recipes right now.");
        return;
      }

      setRecipes((current) => {
        const merged = [...current];
        const seen = new Set(current.map((item) => item.recipeId));
        for (const item of data.recipes ?? []) {
          if (!seen.has(item.recipeId)) {
            merged.push(item);
            seen.add(item.recipeId);
          }
        }
        writeBrowserCookbookCache(merged, {
          hasMore: Boolean(data.hasMore),
          nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
        });
        return merged;
      });
      setHasMore(Boolean(data.hasMore));
      setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
    } catch {
      setLoadError("Could not load more recipes right now.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  return (
    <div className="animate-rise-in space-y-6">
      <section className="space-y-2 lg:pl-4 xl:pl-6">
        <h1 className="font-serif text-4xl leading-tight text-zinc-900 md:text-5xl">Cookbook</h1>
        <p className="max-w-2xl text-lg text-zinc-700">
          Your saved fusion recipes are stored for this browser profile.
        </p>
        {loadError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {loadError}
          </p>
        ) : null}
        {deleteError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {deleteError}
          </p>
        ) : null}
      </section>

      {isLoading ? (
        <section className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-zinc-700">Loading saved recipes...</p>
        </section>
      ) : recipes.length === 0 ? (
        <section className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-zinc-700">No saved recipes yet.</p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
          >
            Generate a Recipe
          </Link>
        </section>
      ) : (
        <section className="space-y-4">
          {recipes.map((entry) => (
            <article
              key={entry.recipeId}
              className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div className="flex-1">
                  <p className="text-xs uppercase tracking-wide text-zinc-500">
                    Saved {formatDate(entry.savedAt)}
                  </p>
                  <h2 className="mt-1 text-2xl font-bold text-zinc-900">{entry.title}</h2>
                  <p className="mt-2 text-sm text-zinc-700">
                    {entry.baseCuisine} + {entry.fusionCuisine}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={`/cookbook/${encodeURIComponent(entry.recipeId)}`}
                      className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
                    >
                      Open
                    </Link>
                    <button
                      type="button"
                      onClick={() => handleDelete(entry.recipeId)}
                      className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-zinc-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="w-full md:w-[220px] lg:w-[240px]">
                  <div className="h-[150px] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 shadow-sm">
                    {entry.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={entry.imageUrl}
                        alt={`${entry.title} plated`}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                        Image unavailable
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
          {hasMore ? (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoadingMore ? "Loading..." : "Load more"}
              </button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
