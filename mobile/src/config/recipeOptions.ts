import type { DietaryStyle, MealType, SpiceLevel } from "../types/recipe";

export const CUISINE_OPTIONS = [
  "Japanese",
  "Italian",
  "Mexican",
  "Thai",
  "Middle Eastern",
  "Korean",
  "Chinese",
  "French",
  "Greek",
  "Peruvian",
] as const;

export const MEAL_TYPE_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: "appetizer", label: "Appetizer" },
  { value: "main", label: "Main" },
  { value: "soup", label: "Soup" },
  { value: "salad", label: "Salad" },
  { value: "dessert", label: "Dessert" },
  { value: "beverage", label: "Beverage" },
];

export const DIETARY_OPTIONS: Array<{ value: DietaryStyle; label: string }> = [
  { value: "none", label: "None" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "high_protein", label: "High Protein" },
];

export const SPICE_LEVEL_OPTIONS: Array<{
  value: SpiceLevel;
  label: string;
}> = [
  { value: 1, label: "Mild" },
  { value: 2, label: "Mild-Medium" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Hot" },
  { value: 5, label: "Very Hot" },
];
