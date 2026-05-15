# Project TODO

## App Store Release Blockers

- Completed by user testing: same-device account switching, final auth/account regression, Darth test account data check, credit deduction checks, and Apple/Google sign-in checks.
- Verified locally: next native iOS build should use display name `Flavor Fusion Chef` from `mobile/app.json`.
- Domain note: production website now uses `https://www.flavorfusionchef.com`; mobile links/API default should stay aligned with that domain for future builds.

## Data And Auth Follow-Up

- Keep old anonymous/device identity tables for migration and account-link safety. Do not drop or clean them before launch unless there is a documented benefit, dry-run output, and rollback plan.
- Update or replace `docs/cookbook-account-migration-plan.md`; it is partly historical now. Current behavior keeps `anon_user_id` as an internal canonical storage key bridged by `auth_identity_links`, not a fully retired field.
- Expand Turso schema documentation with table-by-table fields for auth users, identity links, cookbook recipes, credit balances, reservations, ledger entries, purchase transactions, daily usage, admin config, and which tables store email or account identifiers.

## Mobile 2.0

- Build Admin Analytics 2.0 from `docs/admin-analytics-2.0-plan.md`: user mix analytics, paid pack demand, OpenAI budget/burn tracking, Turso/Cloudflare capacity tracking, profit/loss estimates, manual expense entries, threshold alerts, and 15-minute admin refresh.
- Rework current admin observe/paywall analytics wording into simple business language. Avoid labels like `Over Quota`, `Estimated Paywall Hits`, and `Paywall Hit %`; replace them with owner-friendly terms that explain what happened, why it matters, and what action to take.
- Replace local mobile profile overrides with a server-backed profile endpoint after monetization is finalized. Scope: persist display name and profile photo URL per authenticated user, upload/store profile images, sync the mobile Profile screen from API state, and keep local AsyncStorage only as an offline/cache fallback.
- Keep Activity hidden from the tab bar until there is a clear product role and backed data model for it.

## Low Priority

- Create `project-context-checkpoint` Codex skill to preserve active project state, blockers, current decisions, and safe resume context across sessions.
- Create `release-verification-pack` Codex skill to standardize final checks such as typecheck, lint, build, smoke tests, expected failure checks, and screenshot review.
