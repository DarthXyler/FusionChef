# Cookbook Account Migration Plan

## Escalation Trigger
- If cookbook identity split/loss behavior repeats after current hardening, we immediately move to account-based cookbook ownership.
- Anonymous identity (`anon_user_id`) is retired as cookbook source-of-truth.

## Goal
- Ensure saved cookbook data is reliably tied to a user account, not device-local identity.
- Support reinstall/device change without cookbook loss.

## Non-Goals
- Do not block basic recipe generation behind login.
- Do not remove local UI caching for performance.

## Target Outcome
- Cookbook operations (`save`, `list`, `detail`, `delete`) are owned by authenticated `user_id`.
- Anonymous identity is used only for temporary non-critical local UX.

## Phase 0: Preflight
1. Confirm auth provider choice (recommended: email OTP/magic link).
2. Define user identifier strategy (stable internal UUID).
3. Define session strategy for web and mobile.
4. Freeze non-critical cookbook refactors until migration lands.

## Phase 1: Data Model
1. Add `users` table.
2. Extend cookbook schema:
   - add nullable `user_id`
   - keep `anon_user_id` temporarily for migration bridge
3. Add indexes:
   - `(user_id, saved_at DESC)`
   - `(user_id, recipe_id)` unique
4. Keep existing anon indexes during transition.

## Phase 2: API Migration
1. Add auth middleware/session validation.
2. Update cookbook APIs to read/write by `user_id` when authenticated.
3. Preserve legacy anon path only as temporary fallback.
4. Add migration endpoint:
   - input: authenticated user + current anon identity context
   - action: merge anon cookbook rows into `user_id`
   - output: migrated count and status

## Phase 3: App Flow Changes
1. Web:
   - allow generation without login
   - require login on first cookbook save/open
   - run migration endpoint once post-login
2. Mobile:
   - same behavior as web
   - maintain local cache for display speed, never as ownership source
3. Add clear success state after migration:
   - "Cookbook synced to your account."

## Phase 4: Cutover
1. Stop creating new cookbook rows with `anon_user_id`.
2. Keep read-only anon migration bridge for grace period (7-14 days).
3. Monitor:
   - migration success rate
   - cookbook 4xx/5xx errors
   - duplicate/merge conflicts

## Phase 5: Decommission
1. Remove anon cookbook write/read logic from backend.
2. Remove anon identity merge utilities tied only to cookbook ownership.
3. Drop deprecated anon cookbook columns/indexes after safe window.
4. Keep local cache keys but decouple from ownership identity.

## Security Notes
- Store auth/session secrets as Sensitive env vars.
- Enforce least privilege for DB/API tokens.
- Keep idempotency for save routes to avoid duplicate records.

## Testing Checklist
1. Existing anon user signs in and all old recipes appear.
2. New save after sign-in is visible across devices.
3. App reinstall still shows full cookbook after login.
4. Delete works and stays consistent across sessions.
5. No cross-user data leakage in migration edge cases.

## Rollback Plan
1. Keep previous anon-read code path behind a short-lived feature flag during migration window.
2. If severe regression appears:
   - disable account-only write enforcement
   - restore previous cookbook read path
   - keep migration logs for replay

## Definition Of Done
- All cookbook operations are account-owned.
- Reinstall/device switch does not cause cookbook disappearance.
- Anonymous identity no longer determines cookbook visibility.
