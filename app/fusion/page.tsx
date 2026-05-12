/**
 * Legacy web fusion interface.
 *
 * The code is intentionally preserved here so the browser-based generator can
 * be re-enabled later without rebuilding the flow from scratch.
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader, PageShell, PrimaryLink, SecondaryLink } from "@/components/PublicSite";
import { RecipeInputForm } from "@/components/RecipeInputForm";
import { isWebFusionEnabled } from "@/lib/web-fusion-access";

export const metadata: Metadata = {
  title: "Web Fusion",
  description: "Legacy browser recipe fusion interface for Flavor Fusion Chef.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function FusionPage() {
  if (!isWebFusionEnabled()) {
    return (
      <PageShell maxWidth="max-w-4xl">
        <PageHeader eyebrow="Mobile-first launch" title="Web fusion is currently retired.">
          <p>
            Flavor Fusion Chef is focused on the mobile app experience. The older web generator is
            preserved, but it is not available publicly right now.
          </p>
        </PageHeader>
        <div className="flex flex-wrap gap-3">
          <PrimaryLink href="/">Back to homepage</PrimaryLink>
          <SecondaryLink href="/support">Contact support</SecondaryLink>
        </div>
      </PageShell>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 animate-rise-in lg:space-y-10">
      <section className="space-y-3 px-1 sm:px-2">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          AI Recipe Studio
        </p>
        <h1 className="text-4xl font-extrabold leading-tight text-zinc-900 md:text-5xl">
          Fuse any base recipe into a new cuisine.
        </h1>
        <p className="max-w-3xl text-lg text-zinc-700">
          Paste your recipe, choose a target cuisine and spice level, then generate a clean,
          practical fusion version with shopping list and swaps.
        </p>
      </section>
      <Suspense fallback={<p className="text-zinc-700">Loading form...</p>}>
        <RecipeInputForm />
      </Suspense>
    </div>
  );
}
