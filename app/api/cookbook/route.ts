/**
 * /api/cookbook
 * GET: returns paginated cookbook summaries for the current anonymous browser identity.
 * POST: saves/upserts one cookbook recipe.
 */
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { CookbookRecipeRecord } from "@/lib/types";
import type { FuseRequest, RecipeFusion } from "@/lib/types";
import { isFuseRequest, isRecipeFusion } from "@/lib/validation";
import { enforceRateLimit, isRequestBodyTooLarge } from "@/lib/api-security";
import { applyAnonymousIdentityCookie, getAnonymousIdentity } from "@/lib/anon-user";
import { listCookbookRecipeSummaries, upsertCookbookRecord } from "@/lib/cookbook-db";
import {
  beginIdempotentRequest,
  clearIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKeyFromHeaders,
  type IdempotencyContext,
} from "@/lib/idempotency";

const MAX_COOKBOOK_BODY_BYTES = 500_000;
const COOKBOOK_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=120";
const DEFAULT_COOKBOOK_PAGE_SIZE = 10;
const MAX_COOKBOOK_PAGE_SIZE = 100;

type SaveCookbookRequest = {
  recipe: RecipeFusion;
  sourceInput: FuseRequest;
  savedAt?: unknown;
};

function isSaveCookbookRequest(value: unknown): value is SaveCookbookRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const hasOptionalValidSavedAt =
    typeof candidate.savedAt === "undefined" || typeof candidate.savedAt === "string";
  return (
    isRecipeFusion(candidate.recipe) &&
    isFuseRequest(candidate.sourceInput) &&
    hasOptionalValidSavedAt
  );
}

function buildRecord(body: SaveCookbookRequest): CookbookRecipeRecord {
  // Normalizes incoming payload into the DB record format.
  return {
    recipe: body.recipe,
    sourceInput: body.sourceInput,
    savedAt:
      typeof body.savedAt === "string" && body.savedAt.trim().length > 0
        ? body.savedAt
        : new Date().toISOString(),
  };
}

function buildEtag(value: unknown) {
  // Used for conditional GET responses (304 Not Modified).
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
  // Browser/private cache policy for cookbook data.
  response.headers.set("Cache-Control", COOKBOOK_CACHE_CONTROL);
  response.headers.set("ETag", etag);
}

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    // Listing endpoint with rate limiting + anonymous identity cookie.
    const limited = await enforceRateLimit(request, {
      bucket: "api-cookbook-list",
      limit: 120,
      windowMs: 60_000,
      strategy: "memory",
    });
    if (limited) {
      return limited;
    }

    const identity = getAnonymousIdentity(request);
    const cursor = request.nextUrl.searchParams.get("cursor")?.trim() || undefined;
    const pageSize = Math.min(
      parsePositiveInt(
        request.nextUrl.searchParams.get("pageSize"),
        DEFAULT_COOKBOOK_PAGE_SIZE,
      ),
      MAX_COOKBOOK_PAGE_SIZE,
    );

    const pageResult = await listCookbookRecipeSummaries(identity.anonUserId, {
      cursor,
      pageSize,
    });
    const responseBody = {
      recipes: pageResult.recipes,
      pageSize: pageResult.pageSize,
      hasMore: pageResult.hasMore,
      nextCursor: pageResult.nextCursor,
    };
    const etag = buildEtag(responseBody);
    if (isIfNoneMatchSatisfied(request.headers.get("if-none-match"), etag)) {
      const response = new NextResponse(null, { status: 304 });
      withCookbookCacheHeaders(response, etag);
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }

    const response = NextResponse.json(responseBody);
    withCookbookCacheHeaders(response, etag);
    applyAnonymousIdentityCookie(response, identity);
    return response;
  } catch {
    return NextResponse.json({ error: "Could not load cookbook." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let idempotencyContext: IdempotencyContext | null = null;
  try {
    // Save endpoint with rate limiting + idempotency.
    const limited = await enforceRateLimit(request, {
      bucket: "api-cookbook-save",
      limit: 60,
      windowMs: 60_000,
    });
    if (limited) {
      return limited;
    }

    if (isRequestBodyTooLarge(request, MAX_COOKBOOK_BODY_BYTES)) {
      return NextResponse.json({ error: "Request is too large." }, { status: 413 });
    }

    const body = (await request.json()) as unknown;
    if (!isSaveCookbookRequest(body)) {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    const identity = getAnonymousIdentity(request);
    const idempotency = await beginIdempotentRequest({
      key: getIdempotencyKeyFromHeaders(request.headers),
      scope: `cookbook-save:${identity.anonUserId}`,
      requestPayload: body,
    });

    if (idempotency.state === "in_progress") {
      const response = NextResponse.json(
        { error: "This request is already being processed. Please wait and retry." },
        { status: 409 },
      );
      response.headers.set("Idempotency-Status", "in-progress");
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }
    if (idempotency.state === "conflict") {
      const response = NextResponse.json(
        { error: "Idempotency key was reused with a different request payload." },
        { status: 409 },
      );
      response.headers.set("Idempotency-Status", "conflict");
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }
    if (idempotency.state === "replay") {
      const response = NextResponse.json(
        idempotency.responseBody,
        { status: idempotency.responseStatus },
      );
      response.headers.set("Idempotency-Status", "replayed");
      applyAnonymousIdentityCookie(response, identity);
      return response;
    }
    if (idempotency.state === "started") {
      idempotencyContext = idempotency.context;
    }

    const record = await upsertCookbookRecord(identity.anonUserId, buildRecord(body));
    if (!record) {
      return NextResponse.json({ error: "Could not save cookbook recipe." }, { status: 500 });
    }

    const responseBody = { record };
    if (idempotencyContext) {
      await completeIdempotentRequest(idempotencyContext, 200, responseBody);
    }

    const response = NextResponse.json(responseBody);
    if (idempotencyContext) {
      response.headers.set("Idempotency-Status", "stored");
    }
    applyAnonymousIdentityCookie(response, identity);
    return response;
  } catch {
    if (idempotencyContext) {
      await clearIdempotentRequest(idempotencyContext);
    }
    return NextResponse.json({ error: "Could not save cookbook recipe." }, { status: 500 });
  }
}

