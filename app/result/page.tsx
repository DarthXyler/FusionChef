/**
 * Result route wrapper.
 * Uses Suspense so the result client can load URL-based data safely.
 */
import { Suspense } from "react";
import { ResultPageClient } from "@/app/result/result-page-client";

type ResultPageProps = {
  searchParams?: Promise<{ id?: string | string[] | undefined }>;
};

export default async function ResultPage({ searchParams }: ResultPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const rawId = resolvedSearchParams?.id;
  const initialRecipeId = Array.isArray(rawId) ? rawId[0] : rawId;

  return (
    // Shows a friendly loading message while the result data is being prepared.
    <Suspense fallback={<p className="text-zinc-700">Loading recipe...</p>}>
      {/* Displays the full recipe result screen once ready */}
      <ResultPageClient initialRecipeId={initialRecipeId ?? null} />
    </Suspense>
  );
}
