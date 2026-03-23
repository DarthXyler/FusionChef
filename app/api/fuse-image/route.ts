/**
 * /api/fuse-image
 * Generates a recipe preview image with OpenAI and returns optimized WebP as a data URL.
 */
import type { MealType } from "@/lib/types";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";

type FuseImageRequest = {
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  mealType: MealType;
};

const OPENAI_URL = "https://api.openai.com/v1/images/generations";
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
const PREVIEW_SIZE = 512;
const OPENAI_IMAGE_TIMEOUT_MS = 25_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REQUEST_BYTES = 12_000;
const MAX_TITLE_CHARS = 140;
const MAX_CUISINE_CHARS = 80;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  // Timeout wrapper to avoid long-running API requests.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isFuseImageRequest(value: unknown): value is FuseImageRequest {
  // Minimal runtime request validation.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
      typeof candidate.title === "string" &&
      candidate.title.trim().length > 0 &&
      typeof candidate.baseCuisine === "string" &&
      candidate.baseCuisine.trim().length > 0 &&
      typeof candidate.fusionCuisine === "string" &&
      candidate.fusionCuisine.trim().length > 0 &&
      typeof candidate.mealType === "string" &&
      candidate.mealType.trim().length > 0
  );
}

function buildImagePrompt(body: FuseImageRequest) {
  if (body.mealType === "beverage") {
    return [
      "Create a clean, appetizing photo-style image of a realistic fusion beverage.",
      `Drink title: ${body.title}`,
      `Base cuisine: ${body.baseCuisine}`,
      `Fusion cuisine: ${body.fusionCuisine}`,
      "The subject must be a drink only, not food.",
      "Show the beverage served in a glass, cup, or cocktail vessel with visible liquid.",
      "Keep the image focused on the drink itself, using garnish, color, herbs, citrus, ice, foam, or glassware to express the fusion.",
      "If the title refers to a known drink such as mojito, cocktail, mocktail, soda, tea, coffee, juice, or smoothie, preserve that drink presentation.",
      "Do not show plated food, bowls, rice, noodles, dumplings, buns, bread, salad, soup, meat, seafood, dessert, or any solid entree.",
      "No plate, no bowl, no fork, no spoon, no table spread dominated by food.",
      "Neutral background, no text, no watermarks.",
    ].join("\n");
  }

  if (body.mealType === "dessert") {
    return [
      "Create a clean, appetizing photo-style image of a realistic fusion dessert.",
      `Dessert title: ${body.title}`,
      `Base cuisine: ${body.baseCuisine}`,
      `Fusion cuisine: ${body.fusionCuisine}`,
      "Show a plated dessert, pastry, cake, tart, ice cream, or sweet treat.",
      "No savory entree presentation, no rice bowl, no meat, no soup.",
      "Neutral background, no text, no watermarks.",
    ].join("\n");
  }

  return [
    "Create a clean, appetizing photo-style image of a fusion dish.",
    `Dish title: ${body.title}`,
    `Base cuisine: ${body.baseCuisine}`,
    `Fusion cuisine: ${body.fusionCuisine}`,
    "Single plate, neutral background, no text, no watermarks.",
  ].join("\n");
}

export async function POST(request: Request) {
  try {
    // Request guardrails.
    const limited = await enforceRateLimit(request, {
      bucket: "api-fuse-image",
      limit: 20,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_IMAGE_REQUEST_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const body = (await request.json()) as unknown;
    if (!isFuseImageRequest(body)) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    if (body.title.trim().length > MAX_TITLE_CHARS) {
      return NextResponse.json({ error: "Title is too long." }, { status: 400 });
    }
    if (
      body.baseCuisine.trim().length > MAX_CUISINE_CHARS ||
      body.fusionCuisine.trim().length > MAX_CUISINE_CHARS
    ) {
      return NextResponse.json({ error: "Cuisine label is too long." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing." }, { status: 500 });
    }

    const prompt = buildImagePrompt(body);

    // Ask OpenAI for one food image.
    const response = await fetchWithTimeout(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        size: "auto",
        quality: "low",
        n: 1,
      }),
    }, OPENAI_IMAGE_TIMEOUT_MS);

  if (!response.ok) {
    await response.text();
    return NextResponse.json(
      { error: "Image generation failed." },
      { status: 502 },
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const b64 = payload.data?.[0]?.b64_json;
    const url = payload.data?.[0]?.url;

    let imageBytes: Buffer | null = null;
    if (b64) {
      imageBytes = Buffer.from(b64, "base64");
    } else if (url) {
      const imageResponse = await fetchWithTimeout(url, {}, IMAGE_DOWNLOAD_TIMEOUT_MS);
      if (imageResponse.ok) {
        const arrayBuffer = await imageResponse.arrayBuffer();
        imageBytes = Buffer.from(arrayBuffer);
      }
    }

    if (!imageBytes) {
      return NextResponse.json({ error: "No image returned." }, { status: 502 });
    }

    try {
      // Normalize output size/format for consistent UI performance.
      const optimized = await sharp(imageBytes)
        .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: "cover" })
        .webp({ quality: 60 })
        .toBuffer();
      return NextResponse.json({
        imageUrl: `data:image/webp;base64,${optimized.toString("base64")}`,
      });
    } catch {
      return NextResponse.json({ error: "Image processing failed." }, { status: 500 });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json({ error: "Image generation timed out." }, { status: 504 });
    }
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}

