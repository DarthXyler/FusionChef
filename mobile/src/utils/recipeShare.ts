import type { RecipeFusion } from "../types/recipe";

function titleCase(value: string) {
  return value
    .replace(/_/g, " ")
    .split(" ")
    .map((word) => (word ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : ""))
    .join(" ");
}

export function formatRecipeShareText(recipe: RecipeFusion) {
  const sections = [
    recipe.title,
    `${recipe.baseCuisine} + ${recipe.fusionCuisine}`,
    `Servings: ${recipe.servings} | Time: ${recipe.timeMinutes} min | Dietary: ${titleCase(recipe.dietaryStyle)}`,
    "",
    "Ingredients:",
    ...recipe.ingredients.map(
      (ingredient) => `- ${ingredient.quantity} ${ingredient.item}${ingredient.notes ? ` (${ingredient.notes})` : ""}`,
    ),
    "",
    "Steps:",
    ...recipe.steps.map((step, index) => `${index + 1}. ${step}`),
  ];

  if (recipe.swaps.length > 0) {
    sections.push("", "Ingredient swaps:");
    sections.push(
      ...recipe.swaps.map(
        (swap) => `- ${swap.original} -> ${swap.replacement}: ${swap.reason}`,
      ),
    );
  }

  if (recipe.nutritionNotes.trim()) {
    sections.push("", `Nutrition notes: ${recipe.nutritionNotes}`);
  }

  sections.push("", "Shared from Flavor Fusion Chef");
  return sections.join("\n");
}

export function formatShoppingListShareText(recipe: RecipeFusion) {
  const groupedItems = new Map<string, string[]>();

  recipe.shoppingList.forEach((item) => {
    const category = item.category.trim() || "Other";
    const current = groupedItems.get(category) ?? [];
    current.push(`- ${item.quantity} ${item.item}`);
    groupedItems.set(category, current);
  });

  const sections = [
    `${recipe.title} shopping list`,
    `${recipe.baseCuisine} + ${recipe.fusionCuisine}`,
    "",
  ];

  groupedItems.forEach((items, category) => {
    sections.push(`${titleCase(category)}:`);
    sections.push(...items);
    sections.push("");
  });

  sections.push("Shared from Flavor Fusion Chef");
  return sections.join("\n");
}
