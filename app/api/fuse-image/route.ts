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
const PREVIEW_SIZE = 768;
const PREVIEW_WEBP_QUALITY = 72;
const OPENAI_IMAGE_QUALITIES = ["medium", "low"] as const;
const OPENAI_IMAGE_TIMEOUT_MS = 45_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const OPENAI_IMAGE_REQUEST_ATTEMPTS = 2;
const OPENAI_IMAGE_RETRY_DELAY_MS = 900;
const MAX_IMAGE_REQUEST_BYTES = 12_000;
const MAX_TITLE_CHARS = 140;
const MAX_CUISINE_CHARS = 80;

type ImageFetchResult = {
  imageBytes: Buffer | null;
  status?: number;
  reason?: string;
};

function buildPremiumStyleGuidance() {
  return [
    "Professional editorial food photography for a premium restaurant menu.",
    "Hyper-realistic and appetizing with natural textures and believable plating.",
    "Cinematic side lighting with soft fill and shallow depth of field.",
    "Keep the hero subject sharply focused with clean composition and minimal props.",
    "Rich natural color grading, subtle contrast, no surreal or cartoon look.",
    "No text, watermark, logos, labels, people, or hands.",
  ];
}

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

function logFuseImage(event: Record<string, unknown>) {
  console.info("[api/fuse-image]", JSON.stringify(event));
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryImageRequest(result: ImageFetchResult) {
  if (!result.reason) {
    return false;
  }

  if (result.reason === "request_timeout" || result.reason === "request_error") {
    return true;
  }

  if (typeof result.status === "number") {
    return result.status === 429 || result.status >= 500;
  }

  return false;
}

async function fetchGeneratedImageBytes(
  apiKey: string,
  prompt: string,
  quality: (typeof OPENAI_IMAGE_QUALITIES)[number],
) {
  try {
    const response = await fetchWithTimeout(
      OPENAI_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt,
          size: "auto",
          quality,
          n: 1,
        }),
      },
      OPENAI_IMAGE_TIMEOUT_MS,
    );

    if (!response.ok) {
      await response.text();
      return { imageBytes: null, status: response.status, reason: "openai_generation_failed" };
    }

    const payload = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string }>;
    };
    const b64 = payload.data?.[0]?.b64_json;
    const url = payload.data?.[0]?.url;

    if (typeof b64 === "string" && b64.length > 0) {
      return { imageBytes: Buffer.from(b64, "base64") };
    }

    if (typeof url !== "string" || url.length === 0) {
      return { imageBytes: null, reason: "missing_image_payload" };
    }

    const imageResponse = await fetchWithTimeout(url, {}, IMAGE_DOWNLOAD_TIMEOUT_MS);
    if (!imageResponse.ok) {
      return { imageBytes: null, status: imageResponse.status, reason: "image_download_failed" };
    }

    const arrayBuffer = await imageResponse.arrayBuffer();
    return { imageBytes: Buffer.from(arrayBuffer) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { imageBytes: null, reason: "request_timeout" };
    }
    return { imageBytes: null, reason: "request_error" };
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
  const style = buildPremiumStyleGuidance();

  if (body.mealType === "beverage") {
    return [
      "Create a realistic fusion beverage photo.",
      `Drink title: ${body.title}`,
      `Base cuisine: ${body.baseCuisine}`,
      `Fusion cuisine: ${body.fusionCuisine}`,
      "The subject must be a drink only, not food.",
      "Show the beverage served in a glass, cup, or cocktail vessel with visible liquid.",
      "Keep the image focused on the drink itself, using garnish, color, herbs, citrus, ice, foam, or glassware to express the fusion.",
      "If the title refers to a known drink such as mojito, cocktail, mocktail, soda, tea, coffee, juice, or smoothie, preserve that drink presentation.",
      "Do not show plated food, bowls, rice, noodles, dumplings, buns, bread, salad, soup, meat, seafood, dessert, or any solid entree.",
      "No plate, no bowl, no fork, no spoon, no table spread dominated by food.",
      "Neutral background.",
      ...style,
    ].join("\n");
  }

  if (body.mealType === "dessert") {
    return [
      "Create a realistic fusion dessert photo.",
      `Dessert title: ${body.title}`,
      `Base cuisine: ${body.baseCuisine}`,
      `Fusion cuisine: ${body.fusionCuisine}`,
      "Show a plated dessert, pastry, cake, tart, ice cream, or sweet treat.",
      "No savory entree presentation, no rice bowl, no meat, no soup.",
      "Neutral background.",
      ...style,
    ].join("\n");
  }

  return [
    "Create a realistic fusion dish photo.",
    `Dish title: ${body.title}`,
    `Base cuisine: ${body.baseCuisine}`,
    `Fusion cuisine: ${body.fusionCuisine}`,
    "Show one plated dish as the hero subject.",
    "Neutral background.",
    ...style,
  ].join("\n");
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const requestStartedAt = Date.now();
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

    let imageBytes: Buffer | null = null;
    const attempts: Array<Record<string, unknown>> = [];
    for (const quality of OPENAI_IMAGE_QUALITIES) {
      for (let attempt = 1; attempt <= OPENAI_IMAGE_REQUEST_ATTEMPTS; attempt += 1) {
        const result = await fetchGeneratedImageBytes(apiKey, prompt, quality);
        attempts.push({
          quality,
          attempt,
          status: result.status ?? null,
          reason: result.reason ?? null,
          ok: Boolean(result.imageBytes),
        });

        if (result.imageBytes) {
          imageBytes = result.imageBytes;
          break;
        }

        const hasMoreAttempts = attempt < OPENAI_IMAGE_REQUEST_ATTEMPTS;
        if (hasMoreAttempts && shouldRetryImageRequest(result)) {
          await sleep(OPENAI_IMAGE_RETRY_DELAY_MS * attempt);
        } else {
          break;
        }
      }
      if (imageBytes) break;
    }

    if (!imageBytes) {
      logFuseImage({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        attempts,
      });
      return NextResponse.json({ error: "Image generation failed." }, { status: 502 });
    }

    try {
      // Normalize output size/format for consistent UI performance.
      const optimized = await sharp(imageBytes)
        .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: "cover" })
        .webp({ quality: PREVIEW_WEBP_QUALITY })
        .toBuffer();
      logFuseImage({
        requestId,
        event: "request_succeeded",
        totalDurationMs: Date.now() - requestStartedAt,
        attempts,
      });
      return NextResponse.json({
        imageUrl: `data:image/webp;base64,${optimized.toString("base64")}`,
      });
    } catch {
      logFuseImage({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        attempts,
        reason: "image_processing_failed",
      });
      return NextResponse.json({ error: "Image processing failed." }, { status: 500 });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logFuseImage({
        requestId,
        event: "request_failed",
        totalDurationMs: Date.now() - requestStartedAt,
        reason: "request_timeout",
      });
      return NextResponse.json({ error: "Image generation timed out." }, { status: 504 });
    }
    logFuseImage({
      requestId,
      event: "request_failed",
      totalDurationMs: Date.now() - requestStartedAt,
      reason: "unexpected_server_error",
    });
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}

