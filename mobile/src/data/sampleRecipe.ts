import type { RecipeFusion } from "../types/recipe";

export const sampleRecipe: RecipeFusion = {
  id: "sample-mobile-share",
  title: "Sri Lankan Miso Salmon Rice Bowl",
  baseCuisine: "Japanese",
  fusionCuisine: "Sri Lankan",
  servings: 2,
  timeMinutes: 30,
  spiceLevel: 2,
  dietaryStyle: "high_protein",
  ingredients: [
    {
      item: "salmon fillet",
      quantity: "2 fillets",
      notes: "skin-on if possible",
      category: "protein",
    },
    {
      item: "white miso",
      quantity: "2 tbsp",
      notes: "for the glaze",
      category: "condiment",
    },
    {
      item: "lime juice",
      quantity: "1 tbsp",
      notes: "freshly squeezed",
      category: "produce",
    },
    {
      item: "coconut milk",
      quantity: "1/3 cup",
      notes: "for the sambol-style drizzle",
      category: "pantry",
    },
    {
      item: "steamed rice",
      quantity: "2 cups",
      notes: "served warm",
      category: "grain",
    },
    {
      item: "cucumber",
      quantity: "1 small",
      notes: "thinly sliced",
      category: "produce",
    },
  ],
  steps: [
    "Whisk miso, lime juice, and a spoon of water into a loose glaze.",
    "Coat the salmon and roast or pan-sear until just cooked through and glossy.",
    "Warm the coconut milk with a pinch of chili and salt for a quick creamy drizzle.",
    "Build bowls with rice, cucumber, and salmon, then spoon over the coconut drizzle.",
    "Finish with herbs or sesame if you have them.",
  ],
  swaps: [
    {
      original: "salmon fillet",
      replacement: "firm tuna steak",
      reason: "Keeps the rich, meaty texture while staying realistic for the bowl format.",
    },
  ],
  shoppingList: [
    { item: "salmon fillet", quantity: "2 fillets", category: "Protein" },
    { item: "white miso", quantity: "2 tbsp", category: "Pantry" },
    { item: "lime", quantity: "1", category: "Produce" },
    { item: "coconut milk", quantity: "1 can", category: "Pantry" },
    { item: "rice", quantity: "2 cups", category: "Grains" },
    { item: "cucumber", quantity: "1 small", category: "Produce" },
  ],
  nutritionNotes:
    "High in protein and healthy fats. Use brown rice or add extra cucumber for more fiber.",
};
