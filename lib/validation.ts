/**
 * Runtime validators and JSON schema for recipe input/output data.
 * These checks protect the app from malformed API payloads.
 */
import type { FuseRequest, RecipeFusion } from "@/lib/types";

// Required keys for the input payload sent to /api/fuse.
const FUSE_REQUEST_KEYS = [
  "baseRecipe",
  "mealType",
  "fusionCuisine",
  "spiceLevel",
  "dietaryStyle",
] as const;

// Required keys for the final recipe JSON returned by AI.
const RECIPE_KEYS = [
  "id",
  "title",
  "baseCuisine",
  "fusionCuisine",
  "servings",
  "timeMinutes",
  "spiceLevel",
  "dietaryStyle",
  "ingredients",
  "steps",
  "swaps",
  "shoppingList",
  "nutritionNotes",
] as const;

const RECIPE_OPTIONAL_KEYS = ["imageUrl"] as const;

const INGREDIENT_KEYS = ["item", "quantity", "notes", "category"] as const;
const SWAP_KEYS = ["original", "replacement", "reason"] as const;
const SHOPPING_KEYS = ["item", "quantity", "category"] as const;

const VALID_DIETARY_STYLES = new Set(["none", "vegetarian", "high_protein"]);
const VALID_MEAL_TYPES = new Set([
  "appetizer",
  "main",
  "soup",
  "salad",
  "dessert",
  "beverage",
]);

// Utility: true for plain objects only (not arrays, not null).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Enforces exact keys so no extra fields slip through.
function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]) {
  const objKeys = Object.keys(obj);
  if (objKeys.length !== keys.length) {
    return false;
  }

  return keys.every((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

function hasAllowedKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
) {
  const allowed = new Set([...required, ...optional]);
  const objKeys = Object.keys(obj);
  if (objKeys.some((key) => !allowed.has(key))) {
    return false;
  }
  return required.every((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Valid spice levels are strictly 1..5.
function isSpiceLevel(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

// Verifies request payload shape before calling the AI API.
export function isFuseRequest(value: unknown): value is FuseRequest {
  if (!isPlainObject(value) || !hasExactKeys(value, FUSE_REQUEST_KEYS)) {
    return false;
  }

  return (
    isNonEmptyString(value.baseRecipe) &&
    typeof value.mealType === "string" &&
    VALID_MEAL_TYPES.has(value.mealType) &&
    isNonEmptyString(value.fusionCuisine) &&
    isSpiceLevel(value.spiceLevel) &&
    typeof value.dietaryStyle === "string" &&
    VALID_DIETARY_STYLES.has(value.dietaryStyle)
  );
}

// Trim text fields so downstream checks use clean values.
export function normalizeFuseRequest(input: FuseRequest): FuseRequest {
  const normalizedSpiceLevel =
    input.mealType === "dessert" || input.mealType === "beverage"
      ? 1
      : input.spiceLevel;

  return {
    baseRecipe: input.baseRecipe.trim(),
    mealType: input.mealType,
    fusionCuisine: input.fusionCuisine.trim(),
    spiceLevel: normalizedSpiceLevel,
    dietaryStyle: input.dietaryStyle,
  };
}

// Ingredient row validation.
function isIngredient(value: unknown) {
  if (!isPlainObject(value) || !hasExactKeys(value, INGREDIENT_KEYS)) {
    return false;
  }

  return (
    isNonEmptyString(value.item) &&
    isNonEmptyString(value.quantity) &&
    typeof value.notes === "string" &&
    typeof value.category === "string"
  );
}

// Swap row validation.
function isSwap(value: unknown) {
  if (!isPlainObject(value) || !hasExactKeys(value, SWAP_KEYS)) {
    return false;
  }

  return (
    isNonEmptyString(value.original) &&
    isNonEmptyString(value.replacement) &&
    isNonEmptyString(value.reason)
  );
}

// Shopping row validation.
function isShoppingItem(value: unknown) {
  if (!isPlainObject(value) || !hasExactKeys(value, SHOPPING_KEYS)) {
    return false;
  }

  return (
    isNonEmptyString(value.item) &&
    isNonEmptyString(value.quantity) &&
    typeof value.category === "string"
  );
}

// Full strict runtime validation for the RecipeFusion object.
export function isRecipeFusion(value: unknown): value is RecipeFusion {
  if (!isPlainObject(value) || !hasAllowedKeys(value, RECIPE_KEYS, RECIPE_OPTIONAL_KEYS)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.baseCuisine) &&
    isNonEmptyString(value.fusionCuisine) &&
    typeof value.servings === "number" &&
    Number.isInteger(value.servings) &&
    value.servings > 0 &&
    typeof value.timeMinutes === "number" &&
    Number.isInteger(value.timeMinutes) &&
    value.timeMinutes > 0 &&
    isSpiceLevel(value.spiceLevel) &&
    typeof value.dietaryStyle === "string" &&
    VALID_DIETARY_STYLES.has(value.dietaryStyle) &&
    Array.isArray(value.ingredients) &&
    value.ingredients.every(isIngredient) &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(isNonEmptyString) &&
    Array.isArray(value.swaps) &&
    value.swaps.every(isSwap) &&
    Array.isArray(value.shoppingList) &&
    value.shoppingList.every(isShoppingItem) &&
    typeof value.nutritionNotes === "string" &&
    (typeof value.imageUrl === "undefined" || isNonEmptyString(value.imageUrl))
  );
}

// Parse text and return typed recipe only if fully valid.
export function parseRecipeFusionFromText(text: string): RecipeFusion | null {
  try {
    const parsed = JSON.parse(text);
    return isRecipeFusion(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// JSON Schema used in prompts so model output stays structured.
export const recipeFusionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: RECIPE_KEYS,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    baseCuisine: { type: "string" },
    fusionCuisine: { type: "string" },
    servings: { type: "integer", minimum: 1 },
    timeMinutes: { type: "integer", minimum: 1 },
    spiceLevel: { type: "integer", minimum: 1, maximum: 5 },
    dietaryStyle: {
      type: "string",
      enum: ["none", "vegetarian", "high_protein"],
    },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: INGREDIENT_KEYS,
        properties: {
          item: { type: "string" },
          quantity: { type: "string" },
          notes: { type: "string" },
          category: { type: "string" },
        },
      },
    },
    steps: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
    swaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: SWAP_KEYS,
        properties: {
          original: { type: "string" },
          replacement: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    shoppingList: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: SHOPPING_KEYS,
        properties: {
          item: { type: "string" },
          quantity: { type: "string" },
          category: { type: "string" },
        },
      },
    },
    nutritionNotes: { type: "string" },
  },
} as const;
