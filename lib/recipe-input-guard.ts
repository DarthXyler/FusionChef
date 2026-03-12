/**
 * Lightweight heuristic guard for base recipe text.
 * Blocks clearly unrelated inputs while allowing short real food names.
 */
// Friendly message shown when input doesn't look like food/recipe text.
export const RECIPE_INPUT_GUIDANCE_MESSAGE =
  'Please enter a recipe or food name (for example, "Pancake").';

const QUESTION_PREFIXES = [
  "what is",
  "what's",
  "who is",
  "where is",
  "when is",
  "why is",
  "how to build",
  "how do i build",
  "calculate",
  "solve",
];

const COOKING_HINTS =
  /\b(recipe|ingredient|ingredients|step|steps|cook|cooking|make|bake|fry|boil|grill|roast|saute|dish|meal|cuisine|soup|salad|dessert|beverage|drink|curry|pasta|noodle|rice|kottu|pancake)\b/i;

function isMathOnlyInput(text: string) {
  return /^[-+/*().=\d\s?]+$/.test(text);
}

function startsWithQuestionPrefix(text: string) {
  const lowered = text.toLowerCase();
  return QUESTION_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

export function isLikelyRecipeOrFoodName(input: string) {
  const text = input.trim();
  if (!text) {
    return false;
  }

  // Allow short simple food names by default.
  const words = text.split(/\s+/);
  if (words.length <= 4 && /^[A-Za-z\s'-]+$/.test(text)) {
    return true;
  }

  // Block obvious non-food inputs like pure math.
  if (isMathOnlyInput(text)) {
    return false;
  }

  // Block non-cooking question/trivia prompts.
  const looksLikeQuestion = text.includes("?") || startsWithQuestionPrefix(text);
  if (looksLikeQuestion && !COOKING_HINTS.test(text)) {
    return false;
  }

  return true;
}
