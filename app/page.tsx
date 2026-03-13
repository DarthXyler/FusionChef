/**
 * Home page entry.
 * Shows the app intro and the main recipe input form.
 */
import { Suspense } from "react";
import { RecipeInputForm } from "@/components/RecipeInputForm";

export default function Home() {
  return (
    // Main landing page wrapper with spacing and a small entrance animation.
    <div className="space-y-8 animate-rise-in">
      {/* Intro text that explains what this app does */}
      <section className="space-y-3 lg:pl-4 xl:pl-6">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          AI Recipe Studio
        </p>
        <h1 className="font-serif text-4xl leading-tight text-zinc-900 md:text-5xl">
          Fuse any base recipe into a new cuisine.
        </h1>
        <p className="max-w-2xl text-lg text-zinc-700">
          Paste your recipe, choose a target cuisine and spice level, then generate a clean,
          practical fusion version with shopping list and swaps.
        </p>
      </section>
      {/* The interactive form where users paste a recipe and choose options */}
      <Suspense fallback={<p className="text-zinc-700">Loading form...</p>}>
        <RecipeInputForm />
      </Suspense>
    </div>
  );
}
