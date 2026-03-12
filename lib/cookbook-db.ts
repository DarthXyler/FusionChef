/**
 * Turso-backed cookbook data access layer.
 * Handles schema setup, read/write/delete operations, and short-lived in-memory cache.
 */
import { randomUUID } from "crypto";
import type { InStatement } from "@libsql/client";
import type { CookbookRecipeRecord, CookbookRecipeSummary } from "@/lib/types";
import { isFuseRequest, isRecipeFusion } from "@/lib/validation";
import { executeTurso } from "@/lib/turso";

type CookbookRow = {
  recipe_json: string;
  source_input_json: string;
  saved_at: string;
  image_url: string | null;
};

type CookbookSummaryRow = {
  recipe_id: string;
  title: string;
  base_cuisine: string;
  fusion_cuisine: string;
  saved_at: string;
  image_url: string | null;
};

let schemaReady: Promise<void> | null = null;
const COOKBOOK_LIST_CACHE_TTL_MS = 300_000;
const DEFAULT_COOKBOOK_SUMMARY_PAGE_SIZE = 10;

type CookbookListCacheEntry = {
  records: CookbookRecipeRecord[];
  expiresAt: number;
};

type CookbookSummaryListCacheEntry = {
  records: CookbookRecipeSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  expiresAt: number;
};

const cookbookRecordListCache = new Map<string, CookbookListCacheEntry>();
const cookbookSummaryListCache = new Map<string, CookbookSummaryListCacheEntry>();
const COOKBOOK_SUMMARY_CACHE_KEY_SEPARATOR = "|";

function getCachedCookbookList(anonUserId: string) {
  // Returns valid cache entry or clears expired entry.
  const cached = cookbookRecordListCache.get(anonUserId);
  if (!cached) {
    return null;
  }
  if (Date.now() > cached.expiresAt) {
    cookbookRecordListCache.delete(anonUserId);
    return null;
  }
  return cached.records;
}

function makeCookbookSummaryCacheKey(
  anonUserId: string,
  cursor: string | null,
  pageSize: number,
) {
  // Cache key includes user + cursor + page size.
  return [anonUserId, cursor ?? "__start__", String(pageSize)].join(
    COOKBOOK_SUMMARY_CACHE_KEY_SEPARATOR,
  );
}

function getCachedCookbookSummaryList(anonUserId: string, cursor: string | null, pageSize: number) {
  const cacheKey = makeCookbookSummaryCacheKey(anonUserId, cursor, pageSize);
  const cached = cookbookSummaryListCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (Date.now() > cached.expiresAt) {
    cookbookSummaryListCache.delete(cacheKey);
    return null;
  }
  return { records: cached.records, hasMore: cached.hasMore, nextCursor: cached.nextCursor };
}

function getCachedCookbookListEntry(anonUserId: string) {
  const records = getCachedCookbookList(anonUserId);
  if (!records) {
    return null;
  }
  return { records };
}

function setCachedCookbookList(anonUserId: string, records: CookbookRecipeRecord[]) {
  cookbookRecordListCache.set(anonUserId, {
    records,
    expiresAt: Date.now() + COOKBOOK_LIST_CACHE_TTL_MS,
  });
}

function setCachedCookbookSummaryList(
  anonUserId: string,
  cursor: string | null,
  pageSize: number,
  records: CookbookRecipeSummary[],
  hasMore: boolean,
  nextCursor: string | null,
) {
  const cacheKey = makeCookbookSummaryCacheKey(anonUserId, cursor, pageSize);
  cookbookSummaryListCache.set(cacheKey, {
    records,
    hasMore,
    nextCursor,
    expiresAt: Date.now() + COOKBOOK_LIST_CACHE_TTL_MS,
  });
}

function invalidateCookbookSummaryListCache(anonUserId: string) {
  for (const key of cookbookSummaryListCache.keys()) {
    if (key.startsWith(`${anonUserId}${COOKBOOK_SUMMARY_CACHE_KEY_SEPARATOR}`)) {
      cookbookSummaryListCache.delete(key);
    }
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function rowToRecord(row: CookbookRow): CookbookRecipeRecord | null {
  // Converts DB row JSON fields back to typed app record.
  try {
    const recipe = JSON.parse(row.recipe_json) as unknown;
    const sourceInput = JSON.parse(row.source_input_json) as unknown;

    if (!isRecipeFusion(recipe) || !isFuseRequest(sourceInput)) {
      return null;
    }

    return {
      recipe: {
        ...recipe,
        imageUrl: recipe.imageUrl ?? row.image_url ?? undefined,
      },
      sourceInput,
      savedAt: row.saved_at,
    };
  } catch {
    return null;
  }
}

function rowToSummary(row: CookbookSummaryRow): CookbookRecipeSummary | null {
  // Converts a summary query row into lightweight card data.
  const recipeId = asString(row.recipe_id).trim();
  const title = asString(row.title).trim();
  const baseCuisine = asString(row.base_cuisine).trim();
  const fusionCuisine = asString(row.fusion_cuisine).trim();
  const savedAt = asString(row.saved_at).trim();

  if (!recipeId || !title || !baseCuisine || !fusionCuisine || !savedAt) {
    return null;
  }

  return {
    recipeId,
    title,
    baseCuisine,
    fusionCuisine,
    savedAt,
    imageUrl: typeof row.image_url === "string" ? row.image_url : undefined,
  };
}

async function runStatements(statements: InStatement[]) {
  for (const statement of statements) {
    await executeTurso(statement);
  }
}

async function ensureSchema() {
  // Lazy DB schema initialization.
  if (schemaReady) {
    return schemaReady;
  }

  schemaReady = runStatements([
    {
      sql: `CREATE TABLE IF NOT EXISTS cookbook_recipes (
        row_id TEXT PRIMARY KEY,
        anon_user_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        source_input_json TEXT NOT NULL,
        image_url TEXT,
        saved_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(anon_user_id, recipe_id)
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_cookbook_user_saved
            ON cookbook_recipes (anon_user_id, saved_at DESC)`,
    },
    {
      // Keep an explicit composite index for anon-user detail lookups at scale.
      sql: `CREATE INDEX IF NOT EXISTS idx_cookbook_user_recipe
            ON cookbook_recipes (anon_user_id, recipe_id)`,
    },
  ]);

  return schemaReady;
}

type ListCookbookRecipeSummariesOptions = {
  cursor?: string;
  pageSize?: number;
};

type CookbookSummaryPage = {
  recipes: CookbookRecipeSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  pageSize: number;
};

type CookbookListCursor = {
  savedAt: string;
  recipeId: string;
};

function encodeCookbookListCursor(value: CookbookListCursor) {
  // Encodes cursor for API pagination.
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCookbookListCursor(value: string): CookbookListCursor | null {
  // Decodes and validates cursor from API query param.
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as Partial<CookbookListCursor>;
    if (
      typeof parsed.savedAt !== "string" ||
      parsed.savedAt.trim().length === 0 ||
      typeof parsed.recipeId !== "string" ||
      parsed.recipeId.trim().length === 0
    ) {
      return null;
    }
    return {
      savedAt: parsed.savedAt,
      recipeId: parsed.recipeId,
    };
  } catch {
    return null;
  }
}

export async function listCookbookRecipeSummaries(
  anonUserId: string,
  options?: ListCookbookRecipeSummariesOptions,
): Promise<CookbookSummaryPage> {
  // Cursor-based list query for scalable paging.
  const cursor = options?.cursor?.trim() || null;
  const parsedCursor = cursor ? decodeCookbookListCursor(cursor) : null;
  const pageSize = Math.max(1, Math.min(100, options?.pageSize ?? DEFAULT_COOKBOOK_SUMMARY_PAGE_SIZE));
  if (cursor && !parsedCursor) {
    return {
      recipes: [],
      hasMore: false,
      nextCursor: null,
      pageSize,
    };
  }
  const cached = getCachedCookbookSummaryList(anonUserId, cursor, pageSize);
  if (cached) {
    return {
      recipes: cached.records,
      hasMore: cached.hasMore,
      nextCursor: cached.nextCursor,
      pageSize,
    };
  }

  await ensureSchema();
  const limitWithProbe = pageSize + 1;
  const result =
    cursor && parsedCursor
      ? await executeTurso({
          sql: `SELECT
                  recipe_id,
                  COALESCE(json_extract(recipe_json, '$.title'), '') AS title,
                  COALESCE(json_extract(recipe_json, '$.baseCuisine'), '') AS base_cuisine,
                  COALESCE(json_extract(recipe_json, '$.fusionCuisine'), '') AS fusion_cuisine,
                  saved_at,
                  image_url
                FROM cookbook_recipes
                WHERE anon_user_id = ?
                  AND (saved_at < ? OR (saved_at = ? AND recipe_id < ?))
                ORDER BY saved_at DESC, recipe_id DESC
                LIMIT ?`,
          args: [
            anonUserId,
            parsedCursor.savedAt,
            parsedCursor.savedAt,
            parsedCursor.recipeId,
            limitWithProbe,
          ],
        })
      : await executeTurso({
          sql: `SELECT
                  recipe_id,
                  COALESCE(json_extract(recipe_json, '$.title'), '') AS title,
                  COALESCE(json_extract(recipe_json, '$.baseCuisine'), '') AS base_cuisine,
                  COALESCE(json_extract(recipe_json, '$.fusionCuisine'), '') AS fusion_cuisine,
                  saved_at,
                  image_url
                FROM cookbook_recipes
                WHERE anon_user_id = ?
                ORDER BY saved_at DESC, recipe_id DESC
                LIMIT ?`,
          args: [anonUserId, limitWithProbe],
        });

  const rows = result.rows
    .map((row) =>
      rowToSummary({
        recipe_id: asString(row.recipe_id),
        title: asString(row.title),
        base_cuisine: asString(row.base_cuisine),
        fusion_cuisine: asString(row.fusion_cuisine),
        saved_at: asString(row.saved_at),
        image_url: typeof row.image_url === "string" ? row.image_url : null,
      }),
    )
    .filter((record): record is CookbookRecipeSummary => Boolean(record));

  const hasMore = rows.length > pageSize;
  const records = hasMore ? rows.slice(0, pageSize) : rows;
  const tail = records.at(-1);
  const nextCursor = hasMore && tail
    ? encodeCookbookListCursor({
        savedAt: tail.savedAt,
        recipeId: tail.recipeId,
      })
    : null;

  setCachedCookbookSummaryList(anonUserId, cursor, pageSize, records, hasMore, nextCursor);
  return {
    recipes: records,
    hasMore,
    nextCursor,
    pageSize,
  };
}

export async function getCookbookRecord(anonUserId: string, recipeId: string) {
  // Read one recipe detail, with cache fast-path when available.
  const cached = getCachedCookbookList(anonUserId);
  if (cached) {
    const cachedRecord = cached.find((record) => record.recipe.id === recipeId);
    if (cachedRecord) {
      return cachedRecord;
    }
  }

  await ensureSchema();
  const result = await executeTurso({
    sql: `SELECT recipe_json, source_input_json, saved_at, image_url
          FROM cookbook_recipes
          WHERE anon_user_id = ? AND recipe_id = ?
          LIMIT 1`,
    args: [anonUserId, recipeId],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return rowToRecord({
    recipe_json: asString(row.recipe_json),
    source_input_json: asString(row.source_input_json),
    saved_at: asString(row.saved_at),
    image_url: typeof row.image_url === "string" ? row.image_url : null,
  });
}

export async function upsertCookbookRecord(
  anonUserId: string,
  record: CookbookRecipeRecord,
) {
  // Insert or update one recipe by (anon_user_id, recipe_id).
  await ensureSchema();
  const savedAt = record.savedAt || new Date().toISOString();
  const imageUrl = record.recipe.imageUrl ?? null;

  await executeTurso({
    sql: `INSERT INTO cookbook_recipes (
            row_id,
            anon_user_id,
            recipe_id,
            recipe_json,
            source_input_json,
            image_url,
            saved_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(anon_user_id, recipe_id) DO UPDATE SET
            recipe_json = excluded.recipe_json,
            source_input_json = excluded.source_input_json,
            image_url = excluded.image_url,
            saved_at = excluded.saved_at,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args: [
      randomUUID(),
      anonUserId,
      record.recipe.id,
      JSON.stringify(record.recipe),
      JSON.stringify(record.sourceInput),
      imageUrl,
      savedAt,
    ],
  });

  const savedRecord: CookbookRecipeRecord = {
    ...record,
    savedAt,
    recipe: {
      ...record.recipe,
      imageUrl: imageUrl ?? undefined,
    },
  };

  const cached = getCachedCookbookListEntry(anonUserId);
  if (cached) {
    const next = [
      savedRecord,
      ...cached.records.filter((entry) => entry.recipe.id !== savedRecord.recipe.id),
    ].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
    setCachedCookbookList(anonUserId, next);
  } else {
    cookbookRecordListCache.delete(anonUserId);
  }

  invalidateCookbookSummaryListCache(anonUserId);

  return savedRecord;
}

export async function deleteCookbookRecordAndReturnImageUrl(
  anonUserId: string,
  recipeId: string,
) {
  // Deletes DB record and returns image URL so caller can remove cloud file.
  await ensureSchema();
  const result = await executeTurso({
    sql: `DELETE FROM cookbook_recipes
          WHERE anon_user_id = ? AND recipe_id = ?
          RETURNING image_url`,
    args: [anonUserId, recipeId],
  });
  const row = result.rows[0];
  const imageUrl = row && typeof row.image_url === "string" ? row.image_url : null;
  const deleted = (result.rowsAffected ?? 0) > 0;

  const cached = getCachedCookbookListEntry(anonUserId);
  if (cached) {
    setCachedCookbookList(
      anonUserId,
      cached.records.filter((entry) => entry.recipe.id !== recipeId),
    );
  } else {
    cookbookRecordListCache.delete(anonUserId);
  }

  invalidateCookbookSummaryListCache(anonUserId);

  return {
    deleted,
    imageUrl,
  };
}

export async function listCookbookImageUrls() {
  // Used by orphan cleanup to detect referenced images.
  await ensureSchema();
  const result = await executeTurso({
    sql: `SELECT image_url
          FROM cookbook_recipes
          WHERE image_url IS NOT NULL
            AND TRIM(image_url) != ''`,
  });

  return result.rows
    .map((row) => (typeof row.image_url === "string" ? row.image_url.trim() : ""))
    .filter((imageUrl) => imageUrl.length > 0);
}
