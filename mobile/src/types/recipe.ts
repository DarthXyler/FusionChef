export type DietaryStyle = "none" | "vegetarian" | "high_protein";

export type MealType =
  | "appetizer"
  | "main"
  | "soup"
  | "salad"
  | "dessert"
  | "beverage";

export type SpiceLevel = 1 | 2 | 3 | 4 | 5;

export type RecipeIngredient = {
  item: string;
  quantity: string;
  notes: string;
  category: string;
};

export type RecipeSwap = {
  original: string;
  replacement: string;
  reason: string;
};

export type ShoppingListItem = {
  item: string;
  quantity: string;
  category: string;
};

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

export type FuseRequest = {
  baseRecipe: string;
  mealType: MealType;
  fusionCuisine: string;
  spiceLevel: SpiceLevel;
  dietaryStyle: DietaryStyle;
};

export type GeneratedRecipeRecord = {
  recipe: RecipeFusion;
  sourceInput: FuseRequest;
  createdAt: string;
};

export type CookbookRecipeRecord = {
  recipe: RecipeFusion;
  sourceInput: FuseRequest;
  savedAt: string;
};

export type CookbookRecipeSummary = {
  recipeId: string;
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  savedAt: string;
  imageUrl?: string;
};
