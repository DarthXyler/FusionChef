/**
 * /api/r2-delete
 * Deletes a previously uploaded R2 image by its public URL.
 */
import { NextResponse } from "next/server";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { deleteR2ImageByPublicUrl } from "@/lib/r2-storage";

type DeleteRequest = {
  imageUrl: string;
};

const MAX_DELETE_BODY_BYTES = 8_000;
const MAX_IMAGE_URL_CHARS = 2048;

function isDeleteRequest(value: unknown): value is DeleteRequest {
  // Minimal runtime validation for delete requests.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.imageUrl === "string" && candidate.imageUrl.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    // Limit request rate and payload size for safety.
    const limited = await enforceRateLimit(request, {
      bucket: "api-r2-delete",
      limit: 40,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_DELETE_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const body = (await request.json()) as unknown;
    if (!isDeleteRequest(body)) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    if (body.imageUrl.length > MAX_IMAGE_URL_CHARS) {
      return NextResponse.json({ error: "Image URL is too long." }, { status: 400 });
    }

    await deleteR2ImageByPublicUrl(body.imageUrl);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Image delete failed." }, { status: 502 });
  }
}

