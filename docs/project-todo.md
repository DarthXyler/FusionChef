# Project TODO

## Mobile 2.0

- Before the next iOS build, verify the native app display name is exactly `Flavor Fusion Chef` with spaces. The current Expo config has the right name, but the tester build showed `FlavorFusionChef` in the iOS Google sign-in permission dialog, which means the installed native build may still contain an older display name.
- Replace local mobile profile overrides with a server-backed profile endpoint after monetization is finalized. Scope: persist display name and profile photo URL per authenticated user, upload/store profile images, sync the mobile Profile screen from API state, and keep local AsyncStorage only as an offline/cache fallback.
- Keep Activity hidden from the tab bar until there is a clear product role and backed data model for it.

## Low Priority

- Create `project-context-checkpoint` Codex skill to preserve active project state, blockers, current decisions, and safe resume context across sessions.
- Create `release-verification-pack` Codex skill to standardize final checks such as typecheck, lint, build, smoke tests, expected failure checks, and screenshot review.
