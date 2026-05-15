# Admin Analytics 2.0 Plan

Post-Apple-release plan for business analytics, infrastructure capacity tracking, and cost/profit visibility.

This is not a launch blocker. Build it after App Store submission, once real usage begins and the product needs stronger business controls.

## Purpose

Give the owner one admin screen for quick business decisions:

- Which user category is consuming AI the most.
- Which credit packs are selling.
- Whether OpenAI, Turso, or Cloudflare capacity is approaching a risky level.
- Whether monthly usage is profitable or loss-making.
- Whether pricing, free limits, or pack discounts need adjustment.

## User Categories

| Category | Meaning | Identity State |
|---|---|---|
| Open Users | Users who have not created an account but use free daily actions. | Anonymous/device identity only. |
| Free Users | Signed-in users who have not purchased credits and use only free daily actions. | `auth_users` record exists, no successful purchase. |
| Paid Users | Signed-in users who have purchased credits and may also use free daily actions. | `auth_users` record exists with at least one verified purchase. |

Important: Open User counts should not be inferred only by subtracting Free/Paid usage from total AI usage. That can estimate cost, but it cannot reliably count unique anonymous users. Analytics 2.0 should track anonymous/device usage directly.

## Required Tracking

Add an analytics event table for every AI-affecting action.

Suggested fields:

| Field | Purpose |
|---|---|
| `event_id` | Unique event ID. |
| `created_at` | Timestamp. |
| `date_key` | Date-only key for daily rollups. |
| `anon_user_id` | Canonical anonymous/internal owner ID at time of action. |
| `auth_user_id` | Signed-in account ID when available. |
| `user_category` | `open`, `free`, or `paid` at time of action. |
| `action_type` | `fuse`, `reroll`, `ocr`, `image_generation`, `photo_import`, etc. |
| `credits_charged` | App credits charged to the user. |
| `free_allowance_used` | Whether a free daily action was consumed. |
| `estimated_openai_cost_usd` | Internal cost estimate for this action. |
| `success` | Whether the action completed. |
| `failure_reason` | Normalized error reason if failed. |
| `metadata_json` | Small optional diagnostic payload. |

The category must be stored at event time so later account changes do not rewrite historical analytics.

## Admin Analytics Sections

### 1. User Mix

Show daily, weekly, and monthly usage for Open, Free, and Paid users.

| Category | Daily Users | Weekly Users | Monthly Users | Credits Burned | Estimated AI Cost | Burn Rate |
|---|---:|---:|---:|---:|---:|---:|
| Open Users | Count | Count | Count | Credits | USD | Negative % |
| Free Users | Count | Count | Count | Credits | USD | Negative % |
| Paid Users | Count | Count | Count | Credits | USD | Negative % |

Burn rate formula:

```text
burn_rate_percent = -1 * ((current_period_burn - previous_period_burn) / max(previous_period_burn, 1)) * 100
```

Display as a negative red value when burn increases, for example `-40%`.

### 2. Paid Pack Demand

Show which credit packs are purchased most and how much value remains unused.

| Pack | Buyers | Purchases | Revenue | Credits Sold | Credits Used | Remaining Credits | Share |
|---|---:|---:|---:|---:|---:|---:|---:|
| Starter Pack | Count | Count | USD | Credits | Credits | Credits | % |
| Chef Pack | Count | Count | USD | Credits | Credits | Credits | % |
| Pro Pack | Count | Count | USD | Credits | Credits | Credits | % |

Use this to decide:

- Whether Starter Pack is too attractive or too cheap.
- Whether Chef Pack needs a stronger value gap.
- Whether Pro Pack is priced too high.
- Whether a new pack should be introduced.
- Whether limited-time discounts are useful.

### 3. AI Credit And Cost Health

OpenAI billing may not always provide a simple balance API for every account type. Start with internal estimated spend and a manual monthly budget. Add direct provider integration only if a reliable billing endpoint is available.

| Provider | Monthly Budget | Estimated Spend | Remaining Budget | Daily Avg Spend | Estimated Days Left | Status |
|---|---:|---:|---:|---:|---:|---|
| OpenAI | USD | USD | USD | USD | Days | Healthy / Warning / Critical |

Admin settings:

- Monthly OpenAI budget.
- Alert threshold percentage, default `20%`.
- Optional daily hard-review threshold.

Critical behavior:

- If remaining budget is below threshold, highlight the row red.
- Show a message: `OpenAI budget is below 20%. Manually top up or reduce free limits.`
- Do not implement automatic OpenAI top-up in 2.0.

### 4. Infrastructure Health

Show Turso and Cloudflare usage in the same admin screen so the owner does not need to visit multiple dashboards daily.

| Service | Metric | Used | Limit | Usage % | Estimated Days To Limit | Status |
|---|---|---:|---:|---:|---:|---|
| Turso | Storage | GB | GB | % | Days | Healthy / Warning / Critical |
| Turso | Rows Read | Count | Count | % | Days | Healthy / Warning / Critical |
| Turso | Rows Written | Count | Count | % | Days | Healthy / Warning / Critical |
| Cloudflare R2 | Storage | GB | GB | % | Days | Healthy / Warning / Critical |
| Cloudflare R2 | Class A Writes | Count | Count | % | Days | Healthy / Warning / Critical |
| Cloudflare R2 | Class B Reads | Count | Count | % | Days | Healthy / Warning / Critical |

If provider APIs are not connected yet, use internal estimates:

- DB row counts.
- Saved recipe count.
- Image count.
- Estimated average image size.
- Request/event counts.
- Manual plan limits entered by admin.

### 5. Profit And Loss

Show month-to-date business health.

| Metric | Month To Date |
|---|---:|
| Gross Revenue | USD |
| Apple Fees | Negative USD |
| Net Revenue | USD |
| OpenAI Estimated Cost | Negative USD |
| Turso Cost | Negative USD |
| Cloudflare Cost | Negative USD |
| Other Manual Expenses | Negative USD |
| Estimated Profit | USD |
| Realized Profit | USD |

Manual expense entries:

- Apple Developer Program.
- Domain.
- Ads.
- Testing devices.
- Support/refunds.
- Design/tools.
- Contractor/freelancer cost.

Definitions:

```text
estimated_profit = confirmed_net_revenue - estimated_usage_cost - projected_fixed_cost
realized_profit = confirmed_net_revenue - confirmed_expenses
```

### 6. Extra Product Analytics

Add these if time permits:

| Metric | Business Use |
|---|---|
| Free-to-paid conversion rate | Shows whether free tier and pricing are working. |
| Average generations before purchase | Helps tune paywall timing. |
| Credits used per paid user | Detects underpricing or heavy usage. |
| Image generation failure rate | Detects expensive broken AI path. |
| Save rate after generation | Measures recipe quality. |
| Reroll rate | Measures first-generation quality. |
| Photo import usage | Shows whether image/OCR is a core feature. |
| Daily active users | Basic growth signal. |
| Refund/reversal count | Payment health signal. |
| Account deletion count | Trust/product issue signal. |

## UI Requirements

- Add an `Analytics` tab in the admin monetization panel.
- Refresh analytics data automatically every 15 minutes.
- Provide a manual refresh button.
- Use red highlighted rows/columns for critical thresholds.
- Use yellow/amber for warning thresholds.
- Keep tables dense and operational, not marketing-style.
- Show clear empty states when no analytics events exist yet.
- Use simple owner-facing business language. If a label needs technical explanation, rename it.
- Avoid unclear terms from the current observe report, including `Over Quota`, `Estimated Paywall Hits`, and `Paywall Hit %`.
- Each metric should answer one of these questions:
  - What happened?
  - Is it good or bad?
  - What action should the owner take?

## Current Analytics Wording Rework

The current observe/paywall section is too technical for quick business decisions. Rework it in 2.0.

Replace confusing labels with action-focused labels:

| Current Label | Problem | Better Direction |
|---|---|---|
| `Over Quota` | Sounds technical and does not explain business impact. | Use plain wording such as `Usage After Free Limit`, plus helper text explaining whether users continued with credits. |
| `Estimated Paywall Hits` | Sounds like a website click/hit, not a blocked purchase moment. | Use wording such as `Users Asked To Buy Credits` or `Actions Stopped For No Credits`, depending on the exact data tracked. |
| `Paywall Hit %` | Unclear percentage with no immediate action. | Use wording such as `Blocked Usage Rate`, with a sentence explaining whether it is high, normal, or low. |

Do not show raw technical metrics alone. Add a short business insight below the table, for example:

- `Free usage is low today. No pricing action needed.`
- `Many users tried to continue without credits. Check whether purchases increased after this.`
- `Paid users are using credits normally. No immediate action needed.`
- `Free users are consuming heavily but not buying. Consider lowering free limits or improving the buy-credit prompt.`

## Implementation Phases

### Phase 1: Internal Analytics Foundation

- Add AI action analytics event table.
- Write events from fuse, reroll, OCR, image generation, and purchase flows.
- Store estimated cost per action.
- Add daily/weekly/monthly rollup API.

### Phase 2: Admin Analytics UI

- Add Analytics tab.
- Build User Mix, Paid Pack Demand, and AI Cost Health tables.
- Add 15-minute auto-refresh.
- Add threshold highlighting.

### Phase 3: Infrastructure And Profit Tracking

- Add manual cost/limit settings table.
- Add Turso and Cloudflare estimate tables.
- Add manual expense entries.
- Add profit/loss summary.

### Phase 4: Provider Integrations

- Connect provider APIs only where reliable and low-risk.
- Prefer internal estimates first.
- Do not add automatic OpenAI top-up unless explicitly approved later.

## Launch Decision

Do not block Apple release on this module. It is a post-launch business intelligence feature for version 2.0.
