/**
 * /api/fuse
 * Generates a structured fusion recipe JSON by calling OpenAI and validating output strictly.
 */
import { NextResponse } from "next/server";
import type { FuseRequest } from "@/lib/types";
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

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 30_000;
const MAX_FUSE_BODY_BYTES = 100_000;
const MAX_BASE_RECIPE_CHARS = 10_000;
const MAX_FUSION_CUISINE_CHARS = 80;

const SYSTEM_PROMPT = [
  "You are a fusion chef assistant.",
  "Output valid JSON only.",
  "Do not use markdown.",
  "Do not include extra keys.",
  'Use simple quantities like "2 tbsp" and "1 cup".',
  "Keep steps short and practical.",
  "Swaps must be realistic, practical, and location-neutral.",
  "Generate a fresh variation each time while respecting all inputs.",
].join("\n");

function buildUserPrompt(input: FuseRequest) {
  // Includes both schema and user inputs so output shape stays predictable.
  return [
    "Create one recipe that matches this exact schema.",
    "Return JSON only.",
    "",
    `Schema:\n${JSON.stringify(recipeFusionJsonSchema, null, 2)}`,
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

async function callOpenAI(messages: OpenAIMessage[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  // Forces model to respond in our strict JSON schema.
  const response = await fetchWithTimeout(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.9,
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

  return content;
}

export async function POST(request: Request) {
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
    const baseMessages: OpenAIMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ];

    // First model attempt.
    const firstAttempt = await callOpenAI(baseMessages);
    const firstParsed = parseRecipeFusionFromText(firstAttempt);
    if (firstParsed) {
      return NextResponse.json(firstParsed);
    }

    // Repair attempt if first output is invalid.
    const repairMessages: OpenAIMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildRepairPrompt(firstAttempt) },
    ];

    const repairedAttempt = await callOpenAI(repairMessages);
    const repairedParsed = parseRecipeFusionFromText(repairedAttempt);
    if (!repairedParsed) {
      return NextResponse.json(
        { error: "Model output could not be parsed as valid recipe JSON." },
        { status: 502 },
      );
    }

    return NextResponse.json(repairedParsed);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        { error: "Recipe generation timed out. Please try again." },
        { status: 504 },
      );
    }

    if (error instanceof Error && error.message === "UPSTREAM_OPENAI_ERROR") {
      return NextResponse.json(
        { error: "Recipe generation failed. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { error: "Unexpected server error." },
      { status: 500 },
    );
  }
}

