/**
 * /api/cookbook/[id]
 * GET: returns one saved recipe record for the current anonymous user.
 * DELETE: removes one recipe and its R2 image (if owned by this app).
 */
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/api-security";
import { applyAnonymousIdentityCookie, getAnonymousIdentity } from "@/lib/anon-user";
import {
  deleteCookbookRecordAndReturnImageUrl,
  getCookbookRecord,
} from "@/lib/cookbook-db";
import { deleteR2ImageByPublicUrl, getR2ObjectKeyFromPublicUrl } from "@/lib/r2-storage";

const COOKBOOK_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=120";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

async function getRecipeId(context: RouteContext) {
  // Route params can be encoded; always decode and trim.
  const params = await context.params;
  return decodeURIComponent(params.id ?? "").trim();
}

function buildEtag(value: unknown) {
  const payload = JSON.stringify(value);
  const hash = createHash("sha256").update(payload).digest("base64url");
  return `"${hash}"`;
}

function isIfNoneMatchSatisfied(ifNoneMatch: string | null, etag: string) {
  if (!ifNoneMatch) {
    return false;
  }

  const normalized = ifNoneMatch
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^W\//, ""));

  return normalized.includes(etag) || normalized.includes("*");
}

function withCookbookCacheHeaders(response: NextResponse, etag: string) {
  // Shared cache headers for detail responses.
  response.headers.set("Cache-Control", COOKBOOK_CACHE_CONTROL);
  response.headers.set("ETag", etag);
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    // Detail fetch endpoint with ETag-based conditional responses.
    const limited = await enforceRateLimit(request, {
      bucket: "api-cookbook-detail",
      limit: 120,
      windowMs: 60_000,
      strategy: "memory",
    });
    if (limited) {
      return limited;
    }

    const recipeId = await getRecipeId(context);
    if (!recipeId) {
      return NextResponse.json({ error: "Recipe id is required." }, { status: 400 });
    }

    const identity = getAnonymousIdentity(request);
    const record = await getCookbookRecord(identity.anonUserId, recipeId);
    if (!record) {
      const response = NextResponse.json({ error: "Recipe not found." }, { status: 404 });
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }

    const etag = buildEtag(record);
    if (isIfNoneMatchSatisfied(request.headers.get("if-none-match"), etag)) {
      const response = new NextResponse(null, { status: 304 });
      withCookbookCacheHeaders(response, etag);
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }

    const response = NextResponse.json({ record });
    withCookbookCacheHeaders(response, etag);
    applyAnonymousIdentityCookie(response, identity);
    return response;
  } catch {
    return NextResponse.json({ error: "Could not load recipe." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    // Hard-delete recipe from DB and remove linked cloud image.
    const limited = await enforceRateLimit(request, {
      bucket: "api-cookbook-delete",
      limit: 80,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    const recipeId = await getRecipeId(context);
    if (!recipeId) {
      return NextResponse.json({ error: "Recipe id is required." }, { status: 400 });
    }

    const identity = getAnonymousIdentity(request);
    const result = await deleteCookbookRecordAndReturnImageUrl(identity.anonUserId, recipeId);
    if (!result.deleted) {
      const response = NextResponse.json({ error: "Recipe not found." }, { status: 404 });
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }

    if (result.imageUrl && getR2ObjectKeyFromPublicUrl(result.imageUrl)) {
      try {
        await deleteR2ImageByPublicUrl(result.imageUrl);
      } catch {
        return NextResponse.json(
          { error: "Could not delete image from cloud storage." },
          { status: 502 },
        );
      }
    }

    const response = NextResponse.json({ success: result.deleted });
    applyAnonymousIdentityCookie(response, identity);
    return response;
  } catch {
    return NextResponse.json({ error: "Could not delete recipe." }, { status: 500 });
  }
}

