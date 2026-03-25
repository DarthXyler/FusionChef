import type { ImportedRecipePhotoSource } from "../types/importedRecipePhoto";

type BuildMockExtractedTextOptions = {
  sourceLabel: ImportedRecipePhotoSource;
  width: number;
  height: number;
};

export function buildMockExtractedText(options: BuildMockExtractedTextOptions) {
  void options;
  return [
    "Coconut Lime Chicken Rice Bowl",
    "Serves: 4",
    "",
    "Ingredients",
    "- 2 chicken breasts",
    "- 1 cup coconut milk",
    "- 2 tbsp lime juice",
    "- 2 cups cooked rice",
    "- 1 cucumber, sliced",
    "",
    "Method",
    "1. Season and cook the chicken until golden.",
    "2. Simmer coconut milk with lime juice for a quick sauce.",
    "3. Serve over rice with cucumber and sliced chicken.",
  ].join("\n");
}
