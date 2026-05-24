# Codebase Risk Audit

Date: 2026-05-19

Scope: full-stack website/API, Expo mobile app, Turso persistence, Cloudflare R2, monetization/admin tooling, and local mobile caches.

## High Priority

### 1. R2 cleanup can delete active profile photos

`/api/r2-upload` stores all uploaded images under `fusion-images/`, including profile photos. The scheduled R2 orphan cleanup scans that same prefix but only protects URLs returned by `listCookbookImageUrls()`. It does not include `auth_users.avatar_url`, so profile photos can become orphan candidates once they are older than the cleanup age.

References:

- `app/api/r2-upload/route.ts`
- `lib/r2-orphan-cleanup.ts`
- `lib/auth-users.ts`
- `vercel.json`

Recommended fix:

- Add purpose-specific upload prefixes such as `recipe-images/` and `profile-photos/`.
- Update cleanup to protect `auth_users.avatar_url` for profile photos.
- Run cleanup in dry-run/manual mode after the change before trusting daily cron.

### 2. Mobile generated recipe images bypass R2 and are stored in Turso

Mobile saves generated preview images directly into cookbook records. If the preview is a `data:image/...` URL, Turso stores the full base64 string in `cookbook_recipes.image_url` and `recipe_json.imageUrl`.

References:

- `mobile/src/screens/RecipeWorkspaceScreen.tsx`
- `app/api/fuse-image/route.ts`
- `lib/cookbook-db.ts`

Recommended fix:

- Reuse the web save pattern: upload any `data:image/...` preview to `/api/r2-upload` before cookbook save.
- Store only stable R2 URLs in Turso.
- Backfill existing base64 rows to R2.

### 3. Account deletion removes DB rows but does not directly clean R2 objects

Admin account deletion deletes `cookbook_recipes` and `auth_users` rows, but it does not collect and delete the related R2 images/profile photos before removing references. Cookbook recipe images may eventually be removed by orphan cleanup, but profile photos are not safely handled until the profile-photo cleanup issue is fixed.

References:

- `app/api/admin/monetization/users/route.ts`
- `lib/r2-orphan-cleanup.ts`

Recommended fix:

- Before account deletion removes rows, collect referenced cookbook image URLs and avatar URLs.
- Delete or queue deletion for R2 objects after DB deletion succeeds.
- Record deletion failures for admin follow-up instead of silently relying on orphan cleanup.

### 4. Cookbook delete is not transactional with R2 delete

Single recipe delete removes the Turso row first, then attempts R2 delete. If R2 delete fails, the API returns an error even though the recipe row is already gone. This can confuse clients and leave an orphaned object.

References:

- `app/api/cookbook/[id]/route.ts`
- `lib/cookbook-db.ts`

Recommended fix:

- Treat DB delete as authoritative and make R2 deletion best-effort with logging/cleanup, or introduce a pending-delete queue.
- Return a response that accurately describes recipe deletion vs image cleanup status.

## Medium Priority

### 5. Mobile profile read favors stale local profile over server profile

`readMobileProfile()` returns local display name/photo before server values. This means a stale local profile override can mask newer server profile data on the same device.

References:

- `mobile/src/services/profile.ts`
- `app/api/auth/profile/route.ts`

Recommended fix:

- Treat server profile as source of truth when authenticated.
- Keep local profile only as offline/cache fallback.
- Clear or version local overrides after successful server sync.

### 6. Mobile auth token is delivered through deep-link query string

Google mobile login returns the session token in a deep-link query parameter. This is simple and works, but URLs can be logged by OS/browser tooling more easily than a code-exchange flow.

References:

- `mobile/src/services/auth.ts`
- `app/api/auth/google/start/route.ts`
- `app/api/auth/google/callback/route.ts`

Recommended fix:

- Move toward short-lived auth code exchange for mobile login.
- Exchange code for token inside the app over HTTPS.
- Keep current path until there is a tested migration plan.

### 7. Recipe workspace can fall back to sample data

`RecipeWorkspaceScreen` uses `sampleGeneratedRecipeRecord` when no live recipe record exists. This is useful during development and initial UI rendering, but it can show sample content if navigation state is missing or a flow bug opens the workspace without a real request/result.

References:

- `mobile/src/screens/RecipeWorkspaceScreen.tsx`
- `mobile/src/data/sampleGeneratedRecipe.ts`

Recommended fix:

- Replace runtime sample fallback with an explicit empty/error state for production.
- Keep sample data only for Storybook/tests/dev fixtures if needed.

### 8. Admin token fallback remains enabled

Admin monetization supports a token fallback path alongside authenticated admin access. This is useful as break-glass access, but it should be explicitly time-boxed or guarded by a runtime flag.

References:

- `components/AdminMonetizationConfigPanel.tsx`
- `lib/monetization-security.ts`
- `docs/mobile-monetization-security-checklist.md`

Recommended fix:

- Add `ADMIN_TOKEN_FALLBACK_ENABLED`.
- Default it according to release phase.
- Remove fallback after auth stability window if no longer needed.

### 9. Large modules are hard to review and test

Several files exceed 500 lines, with the largest being admin tooling, mobile screens, and monetization logic. This increases the chance of hidden coupling and missed regressions.

Largest examples:

- `components/AdminMonetizationConfigPanel.tsx`
- `mobile/src/screens/HomeScreen.tsx`
- `mobile/src/screens/RecipeWorkspaceScreen.tsx`
- `app/api/admin/monetization/users/route.ts`
- `lib/monetization-ledger.ts`
- `app/api/fuse/route.ts`

Recommended fix:

- Split by behavior, not by style: API clients, state hooks, validation, rendering sections, and pure business rules.
- Add tests around extracted pure functions before making broad UI changes.

## Low Priority

### 10. Unused/stale assets remain in the repo

`mobile/assets/iap-promo-1024.jpg` is not referenced in the current codebase. It may be an App Store Connect promotional artifact, but it should not live in runtime app assets unless used by the app.

Recommended fix:

- Delete it if obsolete.
- Or move it to a documentation/store-assets folder if it needs to be retained for App Store history.

### 11. Some documentation is stale after auth and cookbook changes

`docs/cookbook-account-migration-plan.md` is already flagged as historical. The image-storage discovery also means README/project overview should be checked for current mobile-vs-web image behavior.

Recommended fix:

- Update architecture docs after the image lifecycle fix.
- Mark historical docs clearly when they are no longer the source of truth.

### 12. No formal automated test command

The repo has build/typecheck scripts, but no normal `test` script. For a production app with payments, identity linking, cookbook persistence, and cleanup jobs, this leaves too much to manual regression.

Recommended fix:

- Add focused tests for pure persistence/monetization/image lifecycle logic first.
- Add smoke scripts for critical API routes where full integration tests are expensive.

## Notes

- `.env.example` exists and does not contain real secrets.
- README setup guidance exists.
- Mobile production API base defaults to `https://www.flavorfusionchef.com`.
- The current App Store binary is not changed by website/GitHub pushes, but Vercel API deployments can affect the live app immediately.
