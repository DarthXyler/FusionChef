# Project TODO

## App Store Release Blockers

- Add Sign in with Apple alongside Google Sign-In before iOS App Store submission. Apple login must create/reuse `auth_users` records, map into `auth_identity_links`, and attach cookbook, credits, purchases, usage, favorites, and to-try data exactly like Google accounts.
- Before App Store submission, run a same-device account-switching smoke test: sign in as Min, confirm credits/cookbook/recent fusions, sign out, confirm Profile/Home/Cookbook/Recent Fusions show signed-out or empty state, then sign in as Kevin and confirm no Min-owned credits, cookbook rows, favorites, to-try flags, or recent fusions appear.
- Run final account-based regression: mobile login, cookbook list/detail, Favorite/To Try toggles, credit balance, Home/Profile credit refresh, recipe generation credit deduction, reroll credit deduction, Apple purchase verification, and sign-out/sign-in recovery.
- Confirm `darthxyler@gmail.com` remains the canonical main testnet user with expected cookbook count, credits, favorites, to-try flags, purchase history, and usage data after the final deployment.
- Verify native iOS build metadata before the next build: display name must be exactly `Flavor Fusion Chef`, and OAuth prompt/domain trust should be reviewed if still using the Vercel domain.

## Data And Auth Follow-Up

- Keep old anonymous/device identity tables for migration and account-link safety. Do not drop or clean them before launch unless there is a documented benefit, dry-run output, and rollback plan.
- Update or replace `docs/cookbook-account-migration-plan.md`; it is partly historical now. Current behavior keeps `anon_user_id` as an internal canonical storage key bridged by `auth_identity_links`, not a fully retired field.
- Expand Turso schema documentation with table-by-table fields for auth users, identity links, cookbook recipes, credit balances, reservations, ledger entries, purchase transactions, daily usage, admin config, and which tables store email or account identifiers.

## Mobile 2.0

- Replace local mobile profile overrides with a server-backed profile endpoint after monetization is finalized. Scope: persist display name and profile photo URL per authenticated user, upload/store profile images, sync the mobile Profile screen from API state, and keep local AsyncStorage only as an offline/cache fallback.
- Keep Activity hidden from the tab bar until there is a clear product role and backed data model for it.

## Low Priority

- Create `project-context-checkpoint` Codex skill to preserve active project state, blockers, current decisions, and safe resume context across sessions.
- Create `release-verification-pack` Codex skill to standardize final checks such as typecheck, lint, build, smoke tests, expected failure checks, and screenshot review.
