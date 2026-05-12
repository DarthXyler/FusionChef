import { getApiBaseUrl } from "../config/api";
import { getMobileAnonymousId, getMobileDeviceKey } from "./mobileIdentity";

type OcrRequest = {
  imageDataUrl?: string;
  imageUrl?: string;
};

type OcrResponse = {
  extractedText: string;
};

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : "Could not extract recipe text from this image.";
  } catch {
    return "Could not extract recipe text from this image.";
  }
}

export async function fetchOcrExtractedText(input: OcrRequest): Promise<string> {
  const [mobileAnonId, mobileDeviceKey] = await Promise.all([
    getMobileAnonymousId(),
    getMobileDeviceKey(),
  ]);
  const response = await fetch(`${getApiBaseUrl()}/api/ocr`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-flavor-fusion-anon-id": mobileAnonId,
      "x-flavor-fusion-device-key": mobileDeviceKey,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as OcrResponse;
  if (typeof payload.extractedText !== "string" || payload.extractedText.trim().length === 0) {
    throw new Error("OCR response was empty.");
  }

  return payload.extractedText.trim();
}
