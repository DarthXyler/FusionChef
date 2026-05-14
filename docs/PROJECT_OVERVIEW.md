# Flavor Fusion Chef Project Overview

This document explains the app in plain English. It is meant for anyone who needs to understand what the project does without first reading the code.

## What The Product Does

Flavor Fusion Chef is a mobile-first recipe app. A user enters a base recipe or imports a recipe photo, chooses a fusion cuisine and preferences, then receives a generated fusion recipe. The user can save recipes to a private cookbook, mark them as Favorite or To Try, and buy one-time credit packs for more recipe generation.

The web app is mostly the public website, support pages, pricing, FAQ, legal pages, and admin tools. The mobile app is the main user product.

## Main Folders

- `app`: Next.js web pages and API routes.
- `components`: Shared web UI components.
- `lib`: Server-side helpers for Turso, auth, cookbook storage, credits, purchases, image storage, validation, and public site content.
- `mobile`: Expo React Native app used by customers.
- `docs`: Human-readable notes, checklists, and project guides.
- `scripts`: Operational scripts and regression checks.
- `public`: Images and static files for the public website.

## User Identity

The app now treats account-based login as the real user identity. Older anonymous IDs still exist because they are used to keep cookbook and credit records connected during migration and device/account linking.

Important identity concepts:

- `auth_user_id`: the logged-in account identity.
- `anon_user_id`: the internal ID used by older cookbook and credit records.
- `mobile device key`: a durable mobile-device ID used to keep the same user attached across app launches.
- `canonical_anon_user_id`: the one internal ID that old records are merged into.

In practice, when a signed-in mobile user calls the API, the backend resolves all possible IDs and chooses one canonical record owner. If older records exist under another anonymous ID, they are merged into the canonical ID.

## Cookbook Data

Saved recipes live in Turso in the `cookbook_recipes` table.

Cookbook records include:

- recipe title, ingredients, steps, swaps, shopping list, and nutrition notes.
- source input used to create the recipe.
- saved date.
- image URL, if available.
- Favorite and To Try flags.

The mobile app also caches cookbook summaries/details locally so the UI can show recently opened cookbook data quickly or while reconnecting.

## Recent Fusions

Recent Fusions are different from the Cookbook.

The mobile app keeps a local device history of recent generated/rerolled recipes in `AsyncStorage`. This is capped at 12 items. It is meant as a safety net in case a user forgets to save a recipe.

Recent Fusions:

- live only on the device unless saved to Cookbook.
- can include unsaved recipes.
- can be opened and saved later if the full generated record exists in local history.
- do not count as Turso cookbook records until the user saves them.

Older local recent items may only have a summary if they were created before the full-record history feature was added.

## Credits

Credits are one-time consumable units. They are not a subscription.

Credit usage is controlled by the monetization runtime configuration. Admins can change the cost of recipe generation and rerolls through the admin monetization policy page.

The current production behavior is:

- recipe generation deducts the configured fuse cost.
- reroll deducts the configured reroll cost.
- observation/reporting can track usage without necessarily charging credits.

When a paid action starts, the backend reserves credits first. If generation succeeds, the reservation is committed. If generation fails before completion, the reservation is released.

This prevents the app from double-charging the user or giving free paid generations when a request is retried.

## Purchases

Mobile credit purchases are verified server-side.

The purchase flow is:

1. User buys a credit pack through the app store flow.
2. Mobile sends the purchase token/transaction ID to the backend.
3. Backend verifies it with Apple App Store or Google Play.
4. Backend grants credits only once for a verified purchase.
5. Backend stores a purchase transaction record for audit and replay protection.

If a provider later reports a refund or revocation, the backend attempts to deduct the previously granted credits.

## Admin Tools

The admin monetization page controls credit policy, pricing/catalog display data, credit grants, purchase reconciliation, and user exports.

The Users tab is designed for large lists. It supports filters and export-style flows so admin work can scale beyond a few manual users.

Manual credit grants are guarded by an admin compensation switch. That switch does not give credits by itself; it only allows or blocks admin-side grant actions.

## Public Website

The public website contains the landing page, pricing page, FAQ, support page, contact page, privacy policy, terms, and refund policy.

Pricing page content is dynamic where possible and reads from monetization configuration so future pricing/catalog updates can be reflected without editing static copy everywhere.

FAQ has normal short answers for direct visitors. Support-page links can reveal hidden detailed FAQ entries for specific support topics.

## Storage Summary

- Turso stores account-linked operational data: cookbook, credits, purchases, daily usage, identity links, admin-visible user data.
- Mobile `AsyncStorage` stores local convenience data: recent fusions, cached cookbook summaries/details, mobile auth token fallback, profile overrides, and device identity fallback.
- R2 stores generated/imported recipe images where needed.

## Safety Notes

- Before creating the next iOS build, confirm the native display name is exactly `Flavor Fusion Chef`. The OAuth prompt is controlled by iOS, so a branded app name and branded login domain are important for user trust.
- Do not delete old identity tables just because they look anonymous; they help map old records into account-based records.
- Do not manually edit credit balances without using ledger/grant functions; the ledger is the audit trail.
- Do not assume Recent Fusions are saved recipes. Only Cookbook entries are persisted as saved recipes in Turso.
- Do not hard-code pricing copy in multiple places unless the app store product configuration also changes.
