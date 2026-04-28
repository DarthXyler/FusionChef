/**
 * /api/fuse
 * Generates a structured fusion recipe JSON by calling OpenAI and validating output strictly.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { FuseRequest, RecipeFusion } from "@/lib/types";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { applyAnonymousIdentityCookie } from "@/lib/anon-user";
import { resolveCookbookIdentity } from "@/lib/cookbook-identity";
import { getMonetizationRuntimeConfig } from "@/lib/monetization-config";
import {
  commitReservedCredits,
  getCreditBalance,
  recordObservedMonetizationAction,
  releaseReservedCredits,
  reserveCredits,
  type MonetizationActionKind,
} from "@/lib/monetization-ledger";
import {
  getTodayDailyMonetizationUsage,
  recordDailyMonetizationUsage,
} from "@/lib/monetization-operations";
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

type MonetizationPreflightResult = {
  blocked: boolean;
  runtimeEnabled: boolean;
  enforcementMode: "off" | "observe" | "enforce";
  freeActionLimit: number;
  usedToday: number;
  freeActionsRemaining: number;
  reservationId: string | null;
  balance: Awaited<ReturnType<typeof getCreditBalance>> | null;
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 30_000;
const MAX_FUSE_BODY_BYTES = 100_000;
const MAX_BASE_RECIPE_CHARS = 10_000;
const MAX_FUSION_CUISINE_CHARS = 80;
const DEFAULT_GENERATION_TEMPERATURE = 0.85;
const REPAIR_TEMPERATURE = 0.35;
const CREDIT_COST_PER_ACTION = 1;
const CREDIT_RESERVATION_TTL_MS = 10 * 60 * 1_000;
const EGG_PATTERN = /\begg(s)?\b/i;
const COCONUT_DAIRY_PATTERN = /\bcoconut\s+(milk|cream|yogurt|curd)\b/i;
const IMPROBABLE_DESSERT_OR_BEVERAGE_PATTERN =
  /\b(beef|steak|pork|rib|ribs|chicken|lamb|mutton|bacon|ham|sausage|duck|turkey|salami|prosciutto|salmon|tuna|fish|shrimp|prawn|crab|lobster|anchovy|sardine|meat|broth|stock|bone-in|bones?)\b/i;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function resolveFuseRequestId(request: Request) {
  const providedRequestId = request.headers.get("x-flavor-fusion-request-id")?.trim() ?? "";
  if (UUID_V4_PATTERN.test(providedRequestId)) {
    return providedRequestId;
  }
  return crypto.randomUUID();
}

function withCookbookIdentityHeader(response: NextResponse, anonUserId: string) {
  response.headers.set("x-flavor-fusion-anon-id", anonUserId);
}

function getMonetizationActionKind(request: Request): MonetizationActionKind {
  const action = request.headers.get("x-flavor-fusion-action")?.trim().toLowerCase();
  return action === "reroll" ? "reroll" : "fuse";
}

function getFreeActionLimitForKind(
  actionKind: MonetizationActionKind,
  config: Awaited<ReturnType<typeof getMonetizationRuntimeConfig>>,
) {
  return actionKind === "reroll" ? config.freeDailyRerollActions : config.freeDailyFuseActions;
}

function getUsedTodayForKind(
  actionKind: MonetizationActionKind,
  usage: Awaited<ReturnType<typeof getTodayDailyMonetizationUsage>>,
) {
  return actionKind === "reroll" ? usage.rerollCount : usage.fuseCount;
}

async function preflightFuseMonetization(params: {
  anonUserId: string;
  actionKind: MonetizationActionKind;
  requestId: string;
}) {
  const runtimeConfig = await getMonetizationRuntimeConfig();
  if (!runtimeConfig.enabled || runtimeConfig.enforcementMode !== "enforce") {
    return {
      blocked: false,
      runtimeEnabled: runtimeConfig.enabled,
      enforcementMode: runtimeConfig.enforcementMode,
      freeActionLimit: 0,
      usedToday: 0,
      freeActionsRemaining: 0,
      reservationId: null,
      balance: null,
    } satisfies MonetizationPreflightResult;
  }

  const freeActionLimit = getFreeActionLimitForKind(params.actionKind, runtimeConfig);
  let usedToday = 0;
  let freeActionsRemaining = 0;
  try {
    const todayUsage = await getTodayDailyMonetizationUsage(params.anonUserId);
    usedToday = getUsedTodayForKind(params.actionKind, todayUsage);
    freeActionsRemaining = Math.max(0, freeActionLimit - usedToday);
  } catch (error) {
    logFuseTiming({
      requestId: params.requestId,
      event: "monetization_usage_read_failed",
      actionKind: params.actionKind,
      reason:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "usage_read_failed",
    });
    freeActionsRemaining = 0;
  }

  if (freeActionsRemaining > 0) {
    return {
      blocked: false,
      runtimeEnabled: runtimeConfig.enabled,
      enforcementMode: runtimeConfig.enforcementMode,
      freeActionLimit,
      usedToday,
      freeActionsRemaining,
      reservationId: null,
      balance: null,
    } satisfies MonetizationPreflightResult;
  }

  let reserveResult: Awaited<ReturnType<typeof reserveCredits>>;
  try {
    reserveResult = await reserveCredits({
      anonUserId: params.anonUserId,
      amount: CREDIT_COST_PER_ACTION,
      actionKind: params.actionKind,
      actor: "api_fuse_enforcement",
      reason: "Credit spend for Fuse API action.",
      expiresAt: new Date(Date.now() + CREDIT_RESERVATION_TTL_MS).toISOString(),
      idempotencyScope: "api-fuse-credit-reserve",
      idempotencyKey: params.requestId,
      metadata: {
        requestId: params.requestId,
        actionKind: params.actionKind,
      },
    });
  } catch (error) {
    logFuseTiming({
      requestId: params.requestId,
      event: "credit_reserve_failed",
      actionKind: params.actionKind,
      reason:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "reserve_failed",
    });
    const balance = await getCreditBalance(params.anonUserId).catch(() => null);
    const availableCredits = balance?.availableCredits ?? 0;
    if (availableCredits < CREDIT_COST_PER_ACTION) {
      return {
        blocked: true,
        runtimeEnabled: runtimeConfig.enabled,
        enforcementMode: runtimeConfig.enforcementMode,
        freeActionLimit,
        usedToday,
        freeActionsRemaining: 0,
        reservationId: null,
        balance,
      } satisfies MonetizationPreflightResult;
    }
    throw error;
  }

  if (!reserveResult.ok) {
    const balance = await getCreditBalance(params.anonUserId);
    return {
      blocked: true,
      runtimeEnabled: runtimeConfig.enabled,
      enforcementMode: runtimeConfig.enforcementMode,
      freeActionLimit,
      usedToday,
      freeActionsRemaining: 0,
      reservationId: null,
      balance,
    } satisfies MonetizationPreflightResult;
  }

  return {
    blocked: false,
    runtimeEnabled: runtimeConfig.enabled,
    enforcementMode: runtimeConfig.enforcementMode,
    freeActionLimit,
    usedToday,
    freeActionsRemaining: 0,
    reservationId: reserveResult.reservation.reservationId,
    balance: reserveResult.balance,
  } satisfies MonetizationPreflightResult;
}

async function finalizeReservedFuseCredit(params: {
  anonUserId: string;
  reservationId: string;
  requestId: string;
  actionKind: MonetizationActionKind;
  target: "commit" | "release";
}) {
  if (params.target === "commit") {
    try {
      const commitResult = await commitReservedCredits({
        anonUserId: params.anonUserId,
        reservationId: params.reservationId,
        actor: "api_fuse_enforcement",
        reason: "Fuse API request completed successfully.",
        idempotencyScope: "api-fuse-credit-commit",
        idempotencyKey: params.requestId,
        metadata: {
          requestId: params.requestId,
          actionKind: params.actionKind,
        },
      });

      if (!commitResult.ok && commitResult.reason !== "already_finalized") {
        throw new Error("CREDIT_RESERVATION_COMMIT_FAILED");
      }
    } catch (error) {
      // Do not fail a completed recipe generation due to post-generation
      // credit settlement hiccups; reconciliation can recover pending reservations.
      logFuseTiming({
        requestId: params.requestId,
        event: "credit_commit_deferred",
        actionKind: params.actionKind,
        reservationId: params.reservationId,
        reason:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "commit_exception",
      });
    }
    return;
  }

  try {
    const releaseResult = await releaseReservedCredits({
      anonUserId: params.anonUserId,
      reservationId: params.reservationId,
      actor: "api_fuse_enforcement",
      reason: "Fuse API request failed before completion.",
      idempotencyScope: "api-fuse-credit-release",
      idempotencyKey: params.requestId,
      metadata: {
        requestId: params.requestId,
        actionKind: params.actionKind,
      },
    });

    if (!releaseResult.ok && releaseResult.reason !== "already_finalized") {
      logFuseTiming({
        requestId: params.requestId,
        event: "credit_release_failed",
        actionKind: params.actionKind,
        reason: releaseResult.reason,
        reservationId: params.reservationId,
      });
    }
  } catch (error) {
    logFuseTiming({
      requestId: params.requestId,
      event: "credit_release_failed",
      actionKind: params.actionKind,
      reason: error instanceof Error ? error.message : "release_exception",
      reservationId: params.reservationId,
    });
  }
}

async function observeFuseUsage(params: {
  anonUserId: string;
  actionKind: MonetizationActionKind;
  requestId: string;
  totalDurationMs: number;
  success: boolean;
  usedRepair: boolean;
}) {
  try {
    const runtimeConfig = await getMonetizationRuntimeConfig();
    if (!runtimeConfig.enabled || runtimeConfig.enforcementMode === "off") {
      return;
    }

    await recordObservedMonetizationAction({
      anonUserId: params.anonUserId,
      actionKind: params.actionKind,
      metadata: {
        requestId: params.requestId,
        success: params.success,
        totalDurationMs: params.totalDurationMs,
        usedRepair: params.usedRepair,
        mode: runtimeConfig.enforcementMode,
      },
    });
    await recordDailyMonetizationUsage({
      anonUserId: params.anonUserId,
      actionKind: params.actionKind,
    });
  } catch (error) {
    logFuseTiming({
      requestId: params.requestId,
      event: "monetization_observe_failed",
      reason: error instanceof Error ? error.message : "unknown_error",
    });
  }
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

export async function POST(request: NextRequest) {
  const requestId = resolveFuseRequestId(request);
  const requestStartedAt = Date.now();
  const stageTimings: FuseStageTiming[] = [];
  const monetizationActionKind = getMonetizationActionKind(request);
  let identity: Awaited<ReturnType<typeof resolveCookbookIdentity>> | null = null;
  let reservedCreditReservationId: string | null = null;

  const respond = (body: unknown, status = 200) => {
    const response = NextResponse.json(body, { status });
    if (identity) {
      withCookbookIdentityHeader(response, identity.anonUserId);
      applyAnonymousIdentityCookie(response, identity);
    }
    return response;
  };
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
      return respond(
        { error: "Request is too large." },
        413,
      );
    }

    const body = (await request.json()) as unknown;
    if (!isFuseRequest(body)) {
      return respond(
        { error: "Invalid request body for /api/fuse." },
        400,
      );
    }

    const trimmedRecipe = body.baseRecipe.trim();
    if (trimmedRecipe.length > MAX_BASE_RECIPE_CHARS) {
      return respond(
        { error: "Recipe text is too long. Please shorten it and try again." },
        400,
      );
    }

    if (body.fusionCuisine.trim().length > MAX_FUSION_CUISINE_CHARS) {
      return respond(
        { error: "Fusion cuisine is too long." },
        400,
      );
    }

    if (!isLikelyRecipeOrFoodName(body.baseRecipe)) {
      return respond(
        { error: RECIPE_INPUT_GUIDANCE_MESSAGE },
        400,
      );
    }

    const input = normalizeFuseRequest(body);
    identity = await resolveCookbookIdentity(request);
    const monetizationPreflight = await preflightFuseMonetization({
      anonUserId: identity.anonUserId,
      actionKind: monetizationActionKind,
      requestId,
    });

    if (monetizationPreflight.blocked) {
      logFuseTiming({
        requestId,
        event: "request_blocked_insufficient_credits",
        actionKind: monetizationActionKind,
        anonUserId: identity.anonUserId,
        enforcementMode: monetizationPreflight.enforcementMode,
        freeActionLimit: monetizationPreflight.freeActionLimit,
        usedToday: monetizationPreflight.usedToday,
        freeActionsRemaining: monetizationPreflight.freeActionsRemaining,
        availableCredits: monetizationPreflight.balance?.availableCredits ?? 0,
      });
      return respond(
        {
          error: "You are out of credits for this action. Buy more credits to continue.",
          reason: "insufficient_credits",
          actionKind: monetizationActionKind,
          purchaseRequired: true,
          creditsRequired: CREDIT_COST_PER_ACTION,
          freeActionLimit: monetizationPreflight.freeActionLimit,
          usedToday: monetizationPreflight.usedToday,
          freeActionsRemaining: monetizationPreflight.freeActionsRemaining,
          balance: monetizationPreflight.balance,
        },
        402,
      );
    }

    reservedCreditReservationId = monetizationPreflight.reservationId;
    const systemPrompt = buildSystemPrompt(request);
    logFuseTiming({
      requestId,
      event: "request_started",
      actionKind: monetizationActionKind,
      anonUserId: identity.anonUserId,
      enforcementMode: monetizationPreflight.enforcementMode,
      runtimeEnabled: monetizationPreflight.runtimeEnabled,
      freeActionLimit: monetizationPreflight.freeActionLimit,
      usedToday: monetizationPreflight.usedToday,
      freeActionsRemaining: monetizationPreflight.freeActionsRemaining,
      reservedCredit: reservedCreditReservationId !== null,
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
      if (reservedCreditReservationId) {
        await finalizeReservedFuseCredit({
          anonUserId: identity.anonUserId,
          reservationId: reservedCreditReservationId,
          requestId,
          actionKind: monetizationActionKind,
          target: "commit",
        });
        // Commit can be deferred for reconciliation; do not hold the id in memory.
        reservedCreditReservationId = null;
      }
      const totalDurationMs = Date.now() - requestStartedAt;
      await observeFuseUsage({
        anonUserId: identity.anonUserId,
        actionKind: monetizationActionKind,
        requestId,
        totalDurationMs,
        success: true,
        usedRepair: false,
      });
      logFuseTiming({
        requestId,
        event: "request_succeeded",
        actionKind: monetizationActionKind,
        totalDurationMs,
        stageTimings,
        usedRepair: false,
      });
      return respond(finalizedRecipe);
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
      if (reservedCreditReservationId) {
        await finalizeReservedFuseCredit({
          anonUserId: identity.anonUserId,
          reservationId: reservedCreditReservationId,
          requestId,
          actionKind: monetizationActionKind,
          target: "release",
        });
        reservedCreditReservationId = null;
      }
      logFuseTiming({
        requestId,
        event: "request_failed",
        actionKind: monetizationActionKind,
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "schema_parse_failed_after_repair",
      });
      return respond(
        { error: "Model output could not be parsed as valid recipe JSON." },
        502,
      );
    }

    const finalizedRecipe = await finalizeRecipe(input, repairedParsed, systemPrompt, stageTimings);
    if (reservedCreditReservationId) {
      await finalizeReservedFuseCredit({
        anonUserId: identity.anonUserId,
        reservationId: reservedCreditReservationId,
        requestId,
        actionKind: monetizationActionKind,
        target: "commit",
      });
      // Commit can be deferred for reconciliation; do not hold the id in memory.
      reservedCreditReservationId = null;
    }
    const totalDurationMs = Date.now() - requestStartedAt;
    await observeFuseUsage({
      anonUserId: identity.anonUserId,
      actionKind: monetizationActionKind,
      requestId,
      totalDurationMs,
      success: true,
      usedRepair: true,
    });
    logFuseTiming({
      requestId,
      event: "request_succeeded",
      actionKind: monetizationActionKind,
      totalDurationMs,
      stageTimings,
      usedRepair: true,
    });
    return respond(finalizedRecipe);
  } catch (error) {
    if (identity && reservedCreditReservationId) {
      await finalizeReservedFuseCredit({
        anonUserId: identity.anonUserId,
        reservationId: reservedCreditReservationId,
        requestId,
        actionKind: monetizationActionKind,
        target: "release",
      });
      reservedCreditReservationId = null;
    }

    if (error instanceof Error && error.message === "CREDIT_RESERVATION_COMMIT_FAILED") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        actionKind: monetizationActionKind,
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "credit_commit_failed",
      });
      return respond(
        { error: "Could not finalize credit usage. Please retry." },
        500,
      );
    }

    if (error instanceof Error && error.name === "AbortError") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        actionKind: monetizationActionKind,
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "timeout",
      });
      return respond(
        { error: "Recipe generation timed out. Please try again." },
        504,
      );
    }

    if (error instanceof Error && error.message === "UPSTREAM_OPENAI_ERROR") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        actionKind: monetizationActionKind,
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "upstream_openai_error",
      });
      return respond(
        { error: "Recipe generation failed. Please try again." },
        502,
      );
    }

    if (error instanceof Error && error.message === "IMPLAUSIBLE_RECIPE") {
      logFuseTiming({
        requestId,
        event: "request_failed",
        actionKind: monetizationActionKind,
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "implausible_recipe",
      });
      return respond(
        {
          error:
            "Could not generate a realistic recipe for that combination. Try adjusting the meal type or base recipe.",
        },
        422,
      );
    }

    if (error instanceof Error && error.message.toLowerCase().includes("turso query timed out")) {
      logFuseTiming({
        requestId,
        event: "request_failed",
        actionKind: monetizationActionKind,
        totalDurationMs: Date.now() - requestStartedAt,
        stageTimings,
        reason: "database_timeout",
      });
      return respond(
        { error: "Service is busy right now. Please retry in a moment." },
        503,
      );
    }

    logFuseTiming({
      requestId,
      event: "request_failed",
      actionKind: monetizationActionKind,
      totalDurationMs: Date.now() - requestStartedAt,
      stageTimings,
      reason: "unexpected_server_error",
      errorName: error instanceof Error ? error.name : "unknown_error",
      errorMessage: error instanceof Error ? error.message : "unknown_error",
    });
    return respond(
      { error: "Unexpected server error." },
      500,
    );
  }
}

