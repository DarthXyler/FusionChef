/**
 * /api/fuse
 * Generates a structured fusion recipe JSON by calling OpenAI and validating output strictly.
 */
import { NextResponse } from "next/server";
import type { FuseRequest, RecipeFusion } from "@/lib/types";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import {
  isLikelyRecipeOrFoodName,
  RECIPE_INPUT_GUIDANCE_MESSAGE,
} from "@/lib/recipe-input-guard";
import {
  isFuseRequest,
  normalizeFuseRequest,
  parseRecipeFusionFromText,
  recipeFusionJsonSchema,
} from "@/lib/validation";

type OpenAIMessage = {
  role: "system" | "user";
  content: string;
};

type FuseStageTiming = {
  stage: string;
  durationMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 30_000;
const MAX_FUSE_BODY_BYTES = 100_000;
const MAX_BASE_RECIPE_CHARS = 10_000;
const MAX_FUSION_CUISINE_CHARS = 80;
const DEFAULT_GENERATION_TEMPERATURE = 0.85;
const REPAIR_TEMPERATURE = 0.35;
const EGG_PATTERN = /\begg(s)?\b/i;
const COCONUT_DAIRY_PATTERN = /\bcoconut\s+(milk|cream|yogurt|curd)\b/i;
const IMPROBABLE_DESSERT_OR_BEVERAGE_PATTERN =
  /\b(beef|steak|pork|rib|ribs|chicken|lamb|mutton|bacon|ham|sausage|duck|turkey|salami|prosciutto|salmon|tuna|fish|shrimp|prawn|crab|lobster|anchovy|sardine|meat|broth|stock|bone-in|bones?)\b/i;

const BASE_SYSTEM_PROMPT = [
  "You are a fusion chef assistant.",
  "Output valid JSON only.",
  "Do not use markdown.",
  "Do not include extra keys.",
  'Use simple quantities like "2 tbsp" and "1 cup".',
  "Keep steps short and practical.",
  "Ingredient categories must be accurate: eggs are not dairy, and coconut milk, coconut cream, coconut yogurt, and coconut curd are not dairy.",
  "Every recipe must be realistic, edible, and something a normal restaurant or home cook would plausibly make and serve.",
  "Generate a fresh variation each time while respecting all inputs.",
];

function normalizeIngredientCategory(item: string, category: string) {
  const trimmedCategory = category.trim();
  if (!trimmedCategory) {
    return category;
  }

  if (EGG_PATTERN.test(item)) {
    return "protein";
  }

  if (COCONUT_DAIRY_PATTERN.test(item)) {
    return "pantry";
  }

  return trimmedCategory;
}

function normalizeRecipeCategories(recipe: RecipeFusion): RecipeFusion {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient) => ({
      ...ingredient,
      category: normalizeIngredientCategory(ingredient.item, ingredient.category),
    })),
    shoppingList: recipe.shoppingList.map((item) => ({
      ...item,
      category: normalizeIngredientCategory(item.item, item.category),
    })),
  };
}

function getCountryNameFromCode(countryCode: string) {
  try {
    const normalized = countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) {
      return null;
    }

    const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    return displayNames.of(normalized) ?? null;
  } catch {
    return null;
  }
}

function buildSystemPrompt(request: Request) {
  const countryCode = request.headers.get("x-vercel-ip-country")?.trim().toUpperCase() ?? "";
  const countryName = getCountryNameFromCode(countryCode);
  const swapGuidance = countryName
    ? `Swaps must be realistic and commonly available in ${countryName} where possible.`
    : "Swaps must be realistic, practical, and location-neutral.";

  return [...BASE_SYSTEM_PROMPT, swapGuidance].join("\n");
}

function buildMealTypeGuidance(input: FuseRequest) {
  if (input.mealType === "dessert") {
    return [
      "This recipe must be a realistic dessert.",
      "If the source recipe is savory, translate its inspiration into dessert-friendly flavors, textures, or presentation instead of using entree-style proteins literally.",
      "Do not include meat, poultry, seafood, broth, stock, or bone-in ingredients in desserts.",
    ].join(" ");
  }

  if (input.mealType === "beverage") {
    return [
      "This recipe must be a realistic beverage.",
      "If the source recipe is savory, translate its inspiration into beverage-friendly flavors instead of using entree-style proteins literally.",
      "Do not include meat, poultry, seafood, broth, stock, or bone-in ingredients in beverages.",
    ].join(" ");
  }

  return "Prefer realistic ingredient pairings, cooking methods, and titles over novelty or shock value.";
}

function buildUserPrompt(input: FuseRequest) {
  // The OpenAI call already enforces our JSON schema via response_format.
  return [
    "Create one fusion recipe that matches the required response format.",
    "Return JSON only.",
    buildMealTypeGuidance(input),
    "",
    `Input:\n${JSON.stringify(input, null, 2)}`,
  ].join("\n");
}

function buildRepairPrompt(invalidText: string) {
  // One retry prompt used when first model output is invalid JSON/schema.
  return [
    "The previous output was not valid for the required schema.",
    "Repair it into valid JSON that matches the schema exactly.",
    "Output JSON only and no extra keys.",
    "",
    `Schema:\n${JSON.stringify(recipeFusionJsonSchema, null, 2)}`,
    "",
    `Invalid output:\n${invalidText}`,
  ].join("\n");
}

function buildRealismRepairPrompt(input: FuseRequest, recipe: RecipeFusion) {
  return [
    "The recipe below is structurally valid but likely implausible for the requested meal type.",
    "Rewrite it into the closest realistic, appealing fusion recipe that a normal person would plausibly order, cook, and eat.",
    "Keep the same meal type and fusion cuisines.",
    "Preserve inspiration from the original request through flavor notes, spices, aroma, texture, or presentation rather than literal use of implausible ingredients.",
    buildMealTypeGuidance(input),
    "Output valid JSON only and no extra keys.",
    "",
    `Schema:\n${JSON.stringify(recipeFusionJsonSchema, null, 2)}`,
    "",
    `Original input:\n${JSON.stringify(input, null, 2)}`,
    "",
    `Implausible recipe to repair:\n${JSON.stringify(recipe, null, 2)}`,
  ].join("\n");
}

function shouldRunRealismRepair(input: FuseRequest, recipe: RecipeFusion) {
  if (input.mealType !== "dessert" && input.mealType !== "beverage") {
    return false;
  }

  const combinedText = [
    recipe.title,
    ...recipe.ingredients.map((ingredient) => ingredient.item),
    ...recipe.steps,
  ].join(" ");

  return IMPROBABLE_DESSERT_OR_BEVERAGE_PATTERN.test(combinedText);
}

function extractContentText(raw: unknown): string | null {
  // Supports both string and array-based OpenAI message content formats.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const firstChoice = choices[0];
  if (typeof firstChoice !== "object" || firstChoice === null) {
    return null;
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }
      const partType = (part as { type?: unknown }).type;
      const partText = (part as { text?: unknown }).text;
      return partType === "text" && typeof partText === "string" ? partText : "";
    })
    .join("")
    .trim();

  return textParts.length > 0 ? textParts : null;
}

function extractUsage(raw: unknown): FuseStageTiming["usage"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const usage = (raw as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return undefined;
  }

  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const completionTokens = (usage as { completion_tokens?: unknown }).completion_tokens;
  const totalTokens = (usage as { total_tokens?: unknown }).total_tokens;

  const normalized = {
    promptTokens: typeof promptTokens === "number" ? promptTokens : undefined,
    completionTokens: typeof completionTokens === "number" ? completionTokens : undefined,
    totalTokens: typeof totalTokens === "number" ? totalTokens : undefined,
  };

  if (
    normalized.promptTokens === undefined &&
    normalized.completionTokens === undefined &&
    normalized.totalTokens === undefined
  ) {
    return undefined;
  }

  return normalized;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  // Prevents indefinite wait if upstream API hangs.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function logFuseTiming(event: Record<string, unknown>) {
  console.info("[api/fuse]", JSON.stringify(event));
}

async function callOpenAI(
  messages: OpenAIMessage[],
  stage: string,
  temperature = DEFAULT_GENERATION_TEMPERATURE,
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const startedAt = Date.now();
  // Forces model to respond in our strict JSON schema.
  const response = await fetchWithTimeout(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "recipe_fusion",
          strict: true,
          schema: recipeFusionJsonSchema,
        },
      },
    }),
  }, OPENAI_TIMEOUT_MS);

  if (!response.ok) {
    await response.text();
    throw new Error("UPSTREAM_OPENAI_ERROR");
  }

  const payload = (await response.json()) as unknown;
  const content = extractContentText(payload);
  if (!content) {
    throw new Error("OpenAI response did not include text content.");
  }
  const usage = extractUsage(payload);

  return {
    content,
    timing: {
      stage,
      durationMs: Date.now() - startedAt,
      ...(usage ? { usage } : {}),
    } satisfies FuseStageTiming,
  };
}

async function finalizeRecipe(
  input: FuseRequest,
  recipe: RecipeFusion,
  systemPrompt: string,
  stageTimings: FuseStageTiming[],
) {
  const normalizedRecipe = normalizeRecipeCategories(recipe);
  if (!shouldRunRealismRepair(input, normalizedRecipe)) {
    return normalizedRecipe;
  }

  const realismMessages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildRealismRepairPrompt(input, normalizedRecipe) },
  ];
  const repairedAttempt = await callOpenAI(realismMessages, "realism_repair", REPAIR_TEMPERATURE);
  stageTimings.push(repairedAttempt.timing);
  const repairedParsed = parseRecipeFusionFromText(repairedAttempt.content);
  if (!repairedParsed) {
    throw new Error("IMPLAUSIBLE_RECIPE");
  }

  const repairedRecipe = normalizeRecipeCategories(repairedParsed);
  if (shouldRunRealismRepair(input, repairedRecipe)) {
    throw new Error("IMPLAUSIBLE_RECIPE");
  }

  return repairedRecipe;
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const requestStartedAt = Date.now();
  const stageTimings: FuseStageTiming[] = [];
  try {
    // Basic abuse protection.
    const limited = await enforceRateLimit(request, {
      bucket: "api-fuse",
      limit: 20,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_FUSE_BODY_BYTES)) {
      return NextResponse.json(
        { error: "Request is too large." },
        { status: 413 },
      );
    }

    const body = (await request.json()) as unknown;
    if (!isFuseRequest(body)) {
      return NextResponse.json(
        { error: "Invalid request body for /api/fuse." },
        { status: 400 },
      );
    }

    const trimmedRecipe = body.baseRecipe.trim();
    if (trimmedRecipe.length > MAX_BASE_RECIPE_CHARS) {
      return NextResponse.json(
        { error: "Recipe text is too long. Please shorten it and try again." },
        { status: 400 },
      );
    }

    if (body.fusionCuisine.trim().length > MAX_FUSION_CUISINE_CHARS) {
      return NextResponse.json(
        { error: "Fusion cuisine is too long." },
        { status: 400 },
      );
    }

    if (!isLikelyRecipeOrFoodName(body.baseRecipe)) {
      return NextResponse.json(
        { error: RECIPE_INPUT_GUIDANCE_MESSAGE },
        { status: 400 },
      );
    }

    const input = normalizeFuseRequest(body);
    const systemPrompt = buildSystemPrompt(request);
    logFuseTiming({
      requestId,
      event: "request_started",
      mealType: input.mealType,
      dietaryStyle: input.dietaryStyle,
      fusionCuisine: input.fusionCuisine,
      baseRecipeLength: input.baseRecipe.length,
    });
    const baseMessages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserPrompt(input) },
    ];

    // First model attempt.
    const firstAttempt = await callOpenAI(baseMessages, "initial_generation");
    stageTimings.push(firstAttempt.timing);
    const firstParsed = parseRecipeFusionFromText(firstAttempt.content);
    if (firstParsed) {
      const finalizedRecipe = await finalizeRecipe(input, firstParsed, systemPrompt, stageTimings);
      logFuseTiming({
        requestId,
        event: "request_succeeded",
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        usedRepair: false,
      });
      return NextResponse.json(finalizedRecipe);
    }

    // Repair attempt if first output is invalid.
    const repairMessages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildRepairPrompt(firstAttempt.content) },
    ];

    const repairedAttempt = await callOpenAI(repairMessages, "schema_repair", REPAIR_TEMPERATURE);
    stageTimings.push(repairedAttempt.timing);
    const repairedParsed = parseRecipeFusionFromText(repairedAttempt.content);
    if (!repairedParsed) {
      logFuseTiming({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "schema_parse_failed_after_repair",
      });
      return NextResponse.json(
        { error: "Model output could not be parsed as valid recipe JSON." },
        { status: 502 },
      );
    }

    const finalizedRecipe = await finalizeRecipe(input, repairedParsed, systemPrompt, stageTimings);
    logFuseTiming({
      requestId,
      event: "request_succeeded",
      totalDurationMs: Date.now() - requestStartedAt,
      stageTimings,
      usedRepair: true,
    });
    return NextResponse.json(finalizedRecipe);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "timeout",
      });
      return NextResponse.json(
        { error: "Recipe generation timed out. Please try again." },
        { status: 504 },
      );
    }

    if (error instanceof Error && error.message === "UPSTREAM_OPENAI_ERROR") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "upstream_openai_error",
      });
      return NextResponse.json(
        { error: "Recipe generation failed. Please try again." },
        { status: 502 },
      );
    }

    if (error instanceof Error && error.message === "IMPLAUSIBLE_RECIPE") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "implausible_recipe",
      });
      return NextResponse.json(
        {
          error:
            "Could not generate a realistic recipe for that combination. Try adjusting the meal type or base recipe.",
        },
        { status: 422 },
      );
    }

    logFuseTiming({
      requestId,
      event: "request_failed",
      totalDurationMs: Date.now() - requestStartedAt,
      stageTimings,
      reason: "unexpected_server_error",
    });
    return NextResponse.json(
      { error: "Unexpected server error." },
      { status: 500 },
    );
  }
}

