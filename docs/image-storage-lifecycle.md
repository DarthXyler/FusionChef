# Image Storage Lifecycle

## Current Behavior

- `/api/fuse-image` generates a food preview image and returns it as a `data:image/webp;base64,...` string.
- Web save flow uploads that temporary data URL to `/api/r2-upload` before saving the recipe. Turso then stores the returned R2 URL.
- Mobile save flow currently sends the generated preview image directly to `/api/cookbook`. If the preview is a data URL, Turso stores that full base64 image string in `cookbook_recipes.image_url` and inside `recipe_json.imageUrl`.
- Mobile profile photos upload to `/api/r2-upload`, but that route stores every image under the shared `fusion-images/` prefix.

## Storage Tables And Objects

- Turso table: `cookbook_recipes`
  - `image_url TEXT`
  - `recipe_json TEXT`
- Turso table: `auth_users`
  - `avatar_url TEXT`
- R2 bucket prefix currently used by `/api/r2-upload`:
  - `fusion-images/`

Useful Turso check:

```sql
SELECT
  recipe_id,
  substr(image_url, 1, 40) AS image_prefix,
  length(image_url) AS image_length,
  saved_at
FROM cookbook_recipes
WHERE image_url IS NOT NULL
ORDER BY saved_at DESC
LIMIT 20;
```

Base64-stored recipe images start with `data:image/webp;base64,`. R2-backed recipe images start with the configured `R2_PUBLIC_BASE_URL`.

## Findings

1. Mobile generated recipe images bypass R2.

   This is not an intentional move away from R2. The web flow already proves the intended design: upload image preview to R2, then save the R2 URL in Turso. The mobile flow skipped that upload step and persisted the temporary data URL.

2. Profile photos can be misclassified as R2 orphans.

   `/api/r2-upload` stores profile photos under `fusion-images/`, but `runR2OrphanCleanup` builds its protected reference set only from cookbook image URLs. A profile photo referenced by `auth_users.avatar_url` can look unreferenced to cleanup once it is older than the configured max age.

3. Recipe delete is not fully transactional with R2 delete.

   Cookbook delete removes the Turso row first and then attempts R2 delete. If R2 delete fails, the DB row is already gone and the object remains until orphan cleanup removes it.

4. Mobile recent fusion history can cache base64 images locally.

   This is capped and intended as a convenience cache, but once recipe images move to R2 the local history should prefer R2 URLs or omit oversized data URLs.

## 2.0 Target Design

- Keep `/api/fuse-image` as a preview generator if needed, but treat returned data URLs as temporary.
- Before mobile cookbook save, upload any `data:image/...` preview through `/api/r2-upload`.
- Save only stable R2 URLs into `cookbook_recipes.image_url` and `recipe_json.imageUrl`.
- Split R2 keys by purpose:
  - `recipe-images/`
  - `profile-photos/`
  - optionally `temp-images/`
- Update orphan cleanup so each prefix has the right protected reference set:
  - recipe images: `cookbook_recipes.image_url`
  - profile photos: `auth_users.avatar_url`
- Add a migration/backfill script for existing `data:image/...` rows:
  - read affected `cookbook_recipes`
  - upload decoded image to R2
  - update `image_url`
  - update `recipe_json.imageUrl`
  - verify counts before and after
- Add tests or script checks for:
  - mobile save converts data URL to R2 URL
  - cleanup does not delete active profile photos
  - cookbook delete handles R2 delete failures predictably
