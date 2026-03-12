/**
 * Browser localStorage/session helpers.
 * Used for temporary generated recipes, last input, and shopping checkbox state.
 */
import type {
  FuseRequest,
  GeneratedRecipeRecord,
  ShoppingListItem,
} from "@/lib/types";
import { isFuseRequest, isRecipeFusion } from "@/lib/validation";

// All browser localStorage keys used by this app.
const STORAGE_KEYS = {
  lastInput: "flavor-fusion:last-input",
  generatedRecipes: "flavor-fusion:generated-recipes",
  shoppingChecks: "flavor-fusion:shopping-checks",
} as const;

type ShoppingCheckMap = Record<string, Record<string, boolean>>;

// Browser-only guard. localStorage does not exist on the server.
function canUseStorage() {
  return typeof window !== "undefined";
}

// Safe localStorage read that returns a fallback value on any error.
function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Safe localStorage write helper. Returns false if storage is full or unavailable.
function writeJson<T>(key: string, value: T): boolean {
  if (!canUseStorage()) {
    return false;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const MAX_GENERATED_RECIPES = 6;

function stripDataImageUrl(recipe: GeneratedRecipeRecord["recipe"]) {
  if (typeof recipe.imageUrl === "string" && recipe.imageUrl.startsWith("data:")) {
    return { ...recipe, imageUrl: undefined };
  }
  return recipe;
}

// Runtime shape check for generated recipe records.
function isGeneratedRecipeRecord(value: unknown): value is GeneratedRecipeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.createdAt === "string" &&
    isRecipeFusion(candidate.recipe) &&
    isFuseRequest(candidate.sourceInput)
  );
}

// Last form settings so the user can reroll quickly.
export function getLastInput(): FuseRequest | null {
  const value = readJson<unknown>(STORAGE_KEYS.lastInput, null);
  return isFuseRequest(value) ? value : null;
}

export function setLastInput(input: FuseRequest) {
  writeJson(STORAGE_KEYS.lastInput, input);
}

export function clearLastInput() {
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEYS.lastInput);
  } catch {
    // Ignore storage clear failures.
  }
}

// Temporary generated items (used by /result).
export function getGeneratedRecipes(): GeneratedRecipeRecord[] {
  const value = readJson<unknown>(STORAGE_KEYS.generatedRecipes, []);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isGeneratedRecipeRecord);
}

// Upsert by recipe id so same id does not duplicate.
export function saveGeneratedRecipe(entry: GeneratedRecipeRecord) {
  const existing = getGeneratedRecipes().filter(
    (item) => item.recipe.id !== entry.recipe.id,
  );
  const next = [...existing, entry];
  const trimmed = next.slice(-MAX_GENERATED_RECIPES);
  const withSingleImage = trimmed.map((item, index) => {
    const isLatest = index === trimmed.length - 1;
    return isLatest ? item : { ...item, recipe: stripDataImageUrl(item.recipe) };
  });

  if (writeJson(STORAGE_KEYS.generatedRecipes, withSingleImage)) {
    return;
  }

  const withoutImages = withSingleImage.map((item) => ({
    ...item,
    recipe: stripDataImageUrl(item.recipe),
  }));
  writeJson(STORAGE_KEYS.generatedRecipes, withoutImages);
}

export function getGeneratedRecipeById(id: string): GeneratedRecipeRecord | null {
  const entries = getGeneratedRecipes();
  return entries.find((entry) => entry.recipe.id === id) ?? null;
}

// Most recent generated result.
export function getLatestGeneratedRecipe(): GeneratedRecipeRecord | null {
  const entries = getGeneratedRecipes();
  if (entries.length === 0) {
    return null;
  }
  return entries[entries.length - 1] ?? null;
}

// Stable key for each shopping checkbox row.
export function buildShoppingItemKey(item: ShoppingListItem, index: number) {
  return `${index}:${item.item}|${item.quantity}|${item.category}`;
}

// Read checked/unchecked state for one recipe's shopping list.
export function getShoppingChecks(recipeId: string): Record<string, boolean> {
  const map = readJson<ShoppingCheckMap>(STORAGE_KEYS.shoppingChecks, {});
  return map[recipeId] ?? {};
}

// Save checked/unchecked state for one recipe's shopping list.
export function saveShoppingChecks(recipeId: string, checks: Record<string, boolean>) {
  const map = readJson<ShoppingCheckMap>(STORAGE_KEYS.shoppingChecks, {});
  writeJson(STORAGE_KEYS.shoppingChecks, {
    ...map,
    [recipeId]: checks,
  });
}
