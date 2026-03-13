/**
 * RecipeResultView
 * Renders the complete fusion recipe screen:
 * hero details, ingredients, steps, swaps, nutrition notes, and shopping checklist.
 */
"use client";

import { useMemo, useState } from "react";
import type { MealType, RecipeFusion } from "@/lib/types";
import { buildShoppingItemKey, getShoppingChecks, saveShoppingChecks } from "@/lib/storage";

// Props: the final recipe data plus optional action buttons (save, reroll, etc.).
type RecipeResultViewProps = {
  recipe: RecipeFusion;
  mealType?: MealType;
  actions?: React.ReactNode;
  imageStatus?: "loading" | "error";
};

// Internal shape for grouping shopping list items by category.
type GroupedShoppingItem = {
  item: RecipeFusion["shoppingList"][number];
  index: number;
};

export function RecipeResultView({
  recipe,
  mealType = "main",
  actions,
  imageStatus,
}: RecipeResultViewProps) {
  // Dessert/beverage recipes intentionally hide the spice tag.
  const shouldShowSpiceTag = mealType !== "dessert" && mealType !== "beverage";
  // Text-format helpers for cleaner display labels.
  const formatIngredientName = (name: string) =>
    name
      .split(" ")
      .map((word) =>
        word ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}` : "",
      )
      .join(" ");
  const capitalizeFirst = (value: string) =>
    value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
  const toTitleCase = (value: string) =>
    value
      .replace(/_/g, " ")
      .split(" ")
      .map((word) =>
        word ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}` : "",
      )
      .join(" ");
  // Checkbox state for the shopping list (stored per recipe).
  const [checks, setChecks] = useState<Record<string, boolean>>(() =>
    getShoppingChecks(recipe.id),
  );

  // Toggle one shopping list item and persist the change.
  function onToggleCheck(key: string, checked: boolean) {
    const next = { ...checks, [key]: checked };
    setChecks(next);
    saveShoppingChecks(recipe.id, next);
  }

  // Determine whether the AI provided shopping categories.
  const hasShoppingCategories = recipe.shoppingList.some(
    (item) => item.category.trim().length > 0,
  );

  // Build grouped shopping list data so we can render by category.
  const groupedShopping = useMemo(() => {
    if (!hasShoppingCategories) {
      return [
        {
          category: "Shopping List",
          items: recipe.shoppingList.map((item, index) => ({ item, index })),
        },
      ];
    }

    const map = new Map<string, GroupedShoppingItem[]>();
    recipe.shoppingList.forEach((item, index) => {
      const category = item.category.trim() || "Other";
      const current = map.get(category) ?? [];
      current.push({ item, index });
      map.set(category, current);
    });
    return Array.from(map.entries()).map(([category, items]) => ({ category, items }));
  }, [hasShoppingCategories, recipe.shoppingList]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 lg:space-y-8">
      {/* Title area with high-level details */}
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="flex-1">
        <p className="text-sm font-medium text-orange-700">
          {recipe.baseCuisine} + {recipe.fusionCuisine}
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-zinc-900">{recipe.title}</h1>
        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          <span className="rounded-full bg-emerald-50/70 px-3 py-1 text-emerald-800/70">
            Servings: {recipe.servings}
          </span>
          <span className="rounded-full bg-emerald-50/70 px-3 py-1 text-emerald-800/70">
            Time: {recipe.timeMinutes} min
          </span>
          {shouldShowSpiceTag ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50/70 px-3 py-1 text-emerald-800/70">
              <span>Spice:</span>
              <span className="flex items-center gap-1 text-red-500">
                {Array.from({ length: recipe.spiceLevel }).map((_, index) => (
                  <span key={`chili-${index}`} aria-hidden="true">
                    &#127798;
                  </span>
                ))}
              </span>
            </span>
          ) : null}
          {recipe.dietaryStyle !== "none" ? (
            <span className="rounded-full bg-emerald-50/70 px-3 py-1 text-emerald-800/70">
              {toTitleCase(recipe.dietaryStyle)}
            </span>
          ) : null}
        </div>
        {actions ? <div className="mt-5">{actions}</div> : null}
          </div>
          <div className="order-last w-full md:order-none md:w-[280px] lg:w-[320px]">
            <div
              id="result-hero-image"
              className="aspect-[4/3] overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 shadow-sm"
            >
              {recipe.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={recipe.imageUrl}
                  alt={`${recipe.title} plated`}
                  className="h-full w-full object-cover"
                />
              ) : imageStatus === "loading" ? (
                <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                  Generating image...
                </div>
              ) : imageStatus === "error" ? (
                <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                  Image unavailable
                </div>
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                  Image unavailable
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Ingredient list */}
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-[5px] pb-5">
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="h-6 w-6 text-emerald-900 md:h-7 md:w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M30 6h6" />
            <rect x="27" y="6" width="10" height="6" rx="2" />
            <path d="M26 12c0 4-3 7-3 12v24a9 9 0 0 0 18 0V24c0-5-3-8-3-12" />
            <path d="M26 30h12" />
            <path d="M30 34c2 1 2 3 0 4" />
            <path d="M18 22c-5 1-8 4-9 9 5-1 9-4 10-8" />
            <path d="M14 30c-4 2-6 5-6 9 5-1 8-4 9-8" />
            <path d="M20 28c-2 6-4 9-8 13" />
            <rect x="41" y="28" width="16" height="22" rx="4" />
            <path d="M43 26h12" />
            <path d="M43 34h12" />
            <path d="M46 42h0" />
            <path d="M52 44h0" />
            <path d="M48 48h0" />
          </svg>
          <h2 className="text-xl font-semibold text-zinc-900">Ingredients</h2>
        </div>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {recipe.ingredients.map((ingredient, index) => (
            <li
              key={`${ingredient.item}-${index}`}
              className="rounded-2xl bg-emerald-50/70 px-4 py-3 shadow-sm ring-1 ring-emerald-200/70 backdrop-blur-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold text-emerald-900">
                      {formatIngredientName(ingredient.item)}
                    </p>
                    <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs italic uppercase text-amber-800">
                      {ingredient.category}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-emerald-800/70">{ingredient.notes}</p>
                </div>
                <span className="shrink-0 text-right text-sm font-semibold text-emerald-900">
                  {ingredient.quantity}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Step-by-step cooking instructions */}
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-[5px] pb-5">
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="h-6 w-6 text-emerald-900 md:h-7 md:w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="14" cy="16" r="5" />
            <circle cx="50" cy="32" r="5" />
            <circle cx="14" cy="48" r="5" />
            <path d="M19 16h18c8 0 12 6 12 12" />
            <path d="M49 32c0 6-4 12-12 12H19" />
          </svg>
          <h2 className="text-xl font-semibold text-zinc-900">Steps</h2>
        </div>
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {recipe.steps.map((step, index) => (
            <li
              key={`${index}-${step}`}
              className="rounded-2xl bg-emerald-50/70 px-4 py-3 shadow-sm ring-1 ring-emerald-200/70 backdrop-blur-sm"
            >
              <div className="flex gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-sm font-semibold text-white">
                  {index + 1}
                </span>
                <div className="text-emerald-800/70">
                  <p className="text-sm leading-relaxed font-normal">{step}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Swap suggestions for alternate ingredients */}
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-[5px]">
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="h-6 w-6 text-emerald-900 md:h-7 md:w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 28a20 20 0 0 1 34-10" />
            <path d="M46 12l6 6-8 1" />
            <path d="M50 36a20 20 0 0 1-34 10" />
            <path d="M18 52l-6-6 8-1" />
          </svg>
          <h2 className="text-xl font-semibold text-zinc-900">Ingredient Swaps</h2>
        </div>
        {recipe.swaps.length === 0 ? (
          <p className="mt-4 text-emerald-800/70">No swaps were needed for this version.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {recipe.swaps.map((swap, index) => (
              <li
                key={`${swap.original}-${index}`}
                className="rounded-2xl bg-emerald-50/70 px-4 py-3 shadow-sm ring-1 ring-emerald-200/70 backdrop-blur-sm"
              >
                <p className="text-base font-semibold text-emerald-900">
                  {capitalizeFirst(swap.original)} to {swap.replacement}
                </p>
                <p className="mt-1 text-sm text-emerald-800/70">{swap.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Short nutrition summary */}
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-[5px]">
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="h-6 w-6 text-emerald-900 md:h-7 md:w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 50h40L32 12 12 50z" />
            <path d="M20 42h24" />
            <path d="M24 34h16" />
            <path d="M28 26h8" />
          </svg>
          <h2 className="text-xl font-semibold text-zinc-900">Nutrition Notes</h2>
        </div>
        <p className="mt-1 text-sm text-emerald-800/70">{recipe.nutritionNotes}</p>
      </section>

      {/* Shopping list with checkboxes */}
      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-[5px]">
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="h-6 w-6 text-emerald-900 md:h-7 md:w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 12h28a4 4 0 0 1 4 4v34a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z" />
            <path d="M26 10h12a4 4 0 0 1 4 4v2H22v-2a4 4 0 0 1 4-4z" />
            <path d="M22 26l3 3 5-6" />
            <path d="M34 29h12" />
            <path d="M22 36l3 3 5-6" />
            <path d="M34 39h10" />
            <path d="M22 46l3 3 5-6" />
            <circle cx="46" cy="46" r="8" />
            <path d="M42 46l3 3 5-5" />
          </svg>
          <h2 className="text-xl font-semibold text-zinc-900">Shopping List</h2>
        </div>
        <div className="mt-4 space-y-4 md:grid md:grid-cols-2 md:gap-6 md:space-y-0 xl:grid-cols-3">
          {groupedShopping.map((group) => (
            <div
              key={group.category}
              className="space-y-2 rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm"
            >
              {hasShoppingCategories ? (
                <h3 className="text-base font-semibold text-emerald-900">
                  {capitalizeFirst(group.category)}
                </h3>
              ) : null}
              <ul className="space-y-2">
                {group.items.map(({ item, index }) => {
                  const key = buildShoppingItemKey(item, index);
                  return (
                    <li
                      key={key}
                      className="rounded-2xl bg-emerald-50/70 px-4 py-3 shadow-sm ring-1 ring-emerald-200/70 backdrop-blur-sm"
                    >
                      <label className="flex cursor-pointer items-center gap-3">
                        <input
                          type="checkbox"
                          checked={Boolean(checks[key])}
                          onChange={(event) => onToggleCheck(key, event.target.checked)}
                          className="mt-0.5 h-4 w-4 rounded border-emerald-200 accent-emerald-600"
                        />
                        <span
                          className={`text-sm text-emerald-800/70 ${
                            checks[key] ? "line-through opacity-60" : ""
                          }`}
                        >
                          {item.quantity} {item.item}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
