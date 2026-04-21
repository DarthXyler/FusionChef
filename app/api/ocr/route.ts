/**
 * /api/ocr
 * Extracts recipe text from an image (data URL or HTTPS image URL).
 */
import { NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";

type OcrRequestBody = {
  imageDataUrl?: unknown;
  imageUrl?: unknown;
};

type OpenAIMessage = {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
      >;
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OCR_MODEL = process.env.OPENAI_OCR_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 30_000;
const MAX_OCR_BODY_BYTES = 4_000_000;
const MAX_IMAGE_INPUT_CHARS = 3_800_000;
const HTTPS_URL_PATTERN = /^https:\/\/[^\s]+$/i;
const IMAGE_DATA_URL_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;

const ocrJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedText"],
  properties: {
    extractedText: {
      type: "string",
    },
  },
} as const;

class OcrRequestError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidImageDataUrl(value: string) {
  const normalized = value.trim();
  if (!IMAGE_DATA_URL_PREFIX.test(normalized)) {
    return false;
  }
  return normalized.length <= MAX_IMAGE_INPUT_CHARS;
}

function isValidHttpsImageUrl(value: string) {
  const normalized = value.trim();
  if (!HTTPS_URL_PATTERN.test(normalized)) {
    return false;
  }
  return normalized.length <= 2_000;
}

function pickImageInput(body: OcrRequestBody) {
  const dataUrl =
    typeof body.imageDataUrl === "string" ? body.imageDataUrl.trim() : "";
  if (dataUrl) {
    if (!isValidImageDataUrl(dataUrl)) {
      throw new OcrRequestError("Invalid imageDataUrl.", 400);
    }
    return dataUrl;
  }

  const imageUrl =
    typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  if (imageUrl) {
    if (!isValidHttpsImageUrl(imageUrl)) {
      throw new OcrRequestError("Invalid imageUrl.", 400);
    }
    return imageUrl;
  }

  throw new OcrRequestError("imageDataUrl or imageUrl is required.", 400);
}

function extractContentText(raw: unknown): string | null {
  if (!isObjectRecord(raw)) {
    return null;
  }

  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const firstChoice = choices[0];
  if (!isObjectRecord(firstChoice)) {
    return null;
  }

  const message = firstChoice.message;
  if (!isObjectRecord(message)) {
    return null;
  }

  const content = message.content;
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .map((part) => {
      if (!isObjectRecord(part)) {
        return "";
      }
      return part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();

  return textParts.length > 0 ? textParts : null;
}

function parseOcrJson(content: string) {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isObjectRecord(parsed)) {
      return null;
    }
    if (typeof parsed.extractedText !== "string") {
      return null;
    }
    const extractedText = parsed.extractedText.trim();
    if (!extractedText) {
      return null;
    }
    return { extractedText };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildMessages(imageInput: string): OpenAIMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are an OCR assistant for recipe images.",
        "Return JSON only.",
        "Do not include markdown fences.",
        "Preserve readable line breaks and list numbering/bullets.",
        "If the image is not a recipe, extract the visible text as-is.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Extract the recipe text from this image.",
            "Keep the text practical and readable.",
            "Output JSON with one field: extractedText.",
          ].join("\n"),
        },
        {
          type: "image_url",
          image_url: {
            url: imageInput,
            detail: "high",
          },
        },
      ],
    },
  ];
}

export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, {
      bucket: "api-ocr",
      limit: 20,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_OCR_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const body = (await request.json()) as unknown;
    if (!isObjectRecord(body)) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const imageInput = pickImageInput(body as OcrRequestBody);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing." }, { status: 500 });
    }

    const response = await fetchWithTimeout(
      OPENAI_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OCR_MODEL,
          temperature: 0,
          messages: buildMessages(imageInput),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "recipe_ocr_result",
              strict: true,
              schema: ocrJsonSchema,
            },
          },
        }),
      },
      OPENAI_TIMEOUT_MS,
    );

    if (!response.ok) {
      await response.text();
      return NextResponse.json({ error: "OCR extraction failed." }, { status: 502 });
    }

    const payload = (await response.json()) as unknown;
    const content = extractContentText(payload);
    if (!content) {
      return NextResponse.json({ error: "OCR response was empty." }, { status: 502 });
    }

    const parsed = parseOcrJson(content);
    if (!parsed) {
      return NextResponse.json({ error: "OCR response was not valid." }, { status: 502 });
    }

    return NextResponse.json(parsed);
  } catch (error) {
    if (error instanceof OcrRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json({ error: "OCR extraction timed out." }, { status: 504 });
    }
    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}
