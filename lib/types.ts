/**
 * Shared TypeScript types for request/response data used across the app.
 * Keeping them centralized ensures frontend and backend stay in sync.
 */
// Dietary preference chosen by the user on the input form.
export type DietaryStyle = "none" | "vegetarian" | "high_protein";

// Meal type chosen by the user on the input form.
export type MealType =
  | "appetizer"
  | "main"
  | "soup"
  | "salad"
  | "dessert"
  | "beverage";

// 1 = mild, 5 = very spicy.
export type SpiceLevel = 1 | 2 | 3 | 4 | 5;

// One ingredient line shown in the recipe card.
export type RecipeIngredient = {
  item: string;
  quantity: string;
  notes: string;
  category: string;
};

// One suggested replacement shown in "Ingredient Swaps".
export type RecipeSwap = {
  original: string;
  replacement: string;
  reason: string;
};

// One line in the shopping checklist.
export type ShoppingListItem = {
  item: string;
  quantity: string;
  category: string;
};

// Final structured recipe object returned by the AI endpoint.
export type RecipeFusion = {
  id: string;
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  servings: number;
  timeMinutes: number;
  spiceLevel: SpiceLevel;
  dietaryStyle: DietaryStyle;
  ingredients: RecipeIngredient[];
  steps: string[];
  swaps: RecipeSwap[];
  shoppingList: ShoppingListItem[];
  nutritionNotes: string;
  imageUrl?: string;
};

// Input payload sent from the form to /api/fuse.
export type FuseRequest = {
  baseRecipe: string;
  mealType: MealType;
  fusionCuisine: string;
  spiceLevel: SpiceLevel;
  dietaryStyle: DietaryStyle;
};

// One generated result plus its original input settings.
export type GeneratedRecipeRecord = {
  recipe: RecipeFusion;
  sourceInput: FuseRequest;
  createdAt: string;
};

// One saved cookbook item plus when it was saved.
export type CookbookRecipeRecord = {
  recipe: RecipeFusion;
  sourceInput: FuseRequest;
  savedAt: string;
};

// Lightweight cookbook list item used for cookbook overview screens.
export type CookbookRecipeSummary = {
  recipeId: string;
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  savedAt: string;
  imageUrl?: string;
};
