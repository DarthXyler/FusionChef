import * as ImageManipulator from "expo-image-manipulator";
import { getApiBaseUrl } from "../config/api";
import { getMobileAuthRequestContext } from "./auth";
import {
  assertMobileSessionIdentityCurrent,
  assertSameMobileSessionIdentity,
  type MobileSessionIdentity,
} from "./authSession";

function generateIdempotencyKey() {
  return `mobile-profile-photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : "Could not upload image.";
  } catch {
    return "Could not upload image.";
  }
}

export async function uploadProfilePhoto(
  uri: string,
  title: string,
  expectedIdentity: MobileSessionIdentity,
) {
  const authContext = await getMobileAuthRequestContext();
  assertSameMobileSessionIdentity(expectedIdentity, authContext.identity);
  if (!authContext.token) {
    throw new Error("Sign in to save a profile photo.");
  }

  const rendered = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 768, height: 768 } }],
    {
      base64: true,
      compress: 0.82,
      format: ImageManipulator.SaveFormat.JPEG,
    },
  );
  if (!rendered.base64) {
    throw new Error("Could not prepare profile photo.");
  }

  assertMobileSessionIdentityCurrent(expectedIdentity);
  const response = await fetch(`${getApiBaseUrl()}/api/r2-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "idempotency-key": generateIdempotencyKey(),
      authorization: `Bearer ${authContext.token}`,
    },
    body: JSON.stringify({
      imageDataUrl: `data:image/jpeg;base64,${rendered.base64}`,
      title,
      purpose: "profile_photo",
    }),
  });

  assertMobileSessionIdentityCurrent(expectedIdentity);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = (await response.json()) as { imageUrl?: unknown };
  assertMobileSessionIdentityCurrent(expectedIdentity);
  if (typeof payload.imageUrl !== "string" || payload.imageUrl.trim().length === 0) {
    throw new Error("Image upload response was not in the expected format.");
  }
  return payload.imageUrl.trim();
}
