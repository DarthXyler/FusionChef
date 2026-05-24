# Mobile 2.0 Workflow Rulebook

This is the working rulebook for Flavor Fusion Chef Mobile 2.0.

## Platform Roles

- Codex Desktop: PM, QA, and Architect.
- VS Code Codex extension: implementation engineer.
- ChatGPT: optional CTO/product sanity checker before major product decisions.
- User: final approver for scope, production-impacting actions, and release decisions.

## Permanent Roles

Keep the permanent role set small:

- PM: defines scope, tickets, priorities, and non-goals.
- Senior Engineer: implements the active ticket.
- QA: verifies acceptance criteria, regressions, and release safety.
- UX Reviewer: checks flow quality, copy, layout, and friction.

Use temporary specialist roles only when needed:

- Security: auth, account deletion, privacy, tokens, sensitive storage.
- DevOps/Release: GitHub, Vercel, EAS, App Store, env vars, cron jobs.
- Monetization: IAP, credits, pricing, admin money actions.

## Core Rules

1. Work one ticket at a time.
2. Use a maximum of 5 tickets per sprint.
3. Always protect production first.
4. Never work directly on production/main branch for Mobile 2.0.
5. Ask approval before GitHub push, Vercel deploy, env changes, destructive migrations, EAS builds, or App Store submission.
6. Keep permanent roles simple: PM, Senior Engineer, QA, UX Reviewer.
7. Use Security or DevOps only when needed.
8. Do not create feature creep.
9. Every ticket must include objective, files likely touched, acceptance criteria, QA checklist, and rollback risk.
10. VS Code Codex extension implements only the active ticket.

## Branching Rule

Mobile 2.0 work should happen on a dedicated branch, not `main`.

Preferred branch:

```txt
mobile-2.0
```

`main` remains for production hotfixes, 1.0.x patches, and urgent backend/website fixes approved by the user.

## Ticket Template

```txt
Ticket:

Objective:

Non-goals:

Files likely touched:

Implementation notes:

Acceptance criteria:

QA checklist:

Rollback risk:

Approval needed before:
```

## Sprint Template

Each sprint has at most 5 tickets.

```txt
Sprint:

Goal:

Tickets:
1.
2.
3.
4.
5.

Production risks:

Approval gates:

Release/deploy expectations:
```

## Execution Flow

For every ticket:

1. Codex Desktop writes or refines the ticket.
2. User approves the ticket scope.
3. VS Code Codex inspects the relevant code.
4. VS Code Codex explains the implementation approach.
5. VS Code Codex implements only the active ticket.
6. VS Code Codex runs the agreed checks.
7. QA review verifies acceptance criteria and regressions.
8. User approves any push, deploy, build, migration, or submission.

## Default Sprint Order

Sprint 0: Production protection and branch setup.

Sprint 1: Image lifecycle and R2 safety.

Sprint 2: Auth/profile consistency.

Sprint 3: Navigation and UX foundation.

Sprint 4: Recipe workspace 2.0.

Sprint 5: Cookbook 2.0.

Sprint 6: Credits and monetization.

Sprint 7: QA hardening.

Sprint 8: Release.

## Current Priority References

- `docs/codebase-risk-audit.md`
- `docs/image-storage-lifecycle.md`
- `docs/admin-analytics-2.0-plan.md`
- `docs/project-todo.md`
