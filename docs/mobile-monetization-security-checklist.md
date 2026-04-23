# Mobile Monetization Security Checklist (S0-S3)

This checklist tracks monetization hardening work for the mobile app rollout.

## S0 - Baseline Security (Now)

- [x] Admin-only runtime config endpoint added: `/api/admin/monetization/config`
- [x] Dedicated admin token guard (`MONETIZATION_ADMIN_TOKEN`)
- [x] Constant-time token comparison for admin auth
- [x] Rate limiting on admin read/write config routes
- [x] Idempotency enforced for config writes (`idempotency-key` required)
- [x] Audit logs for config read/update success/failure events
- [x] `Cache-Control: no-store` on admin config responses

## S1 - Credits Ledger Safety

- [x] Add immutable credit ledger table (no balance-only writes)
- [x] Use reserve -> commit/release flow for every credit-spend action
- [x] Add reconciliation job for stuck/expired reservations (`/api/cron/monetization-reconciliation`)
- [x] Add idempotency keys for all spend/grant admin endpoints
- [x] Add durable server-side daily reset logic (timezone-safe day key accounting)
- [x] Add observe-only Fuse/Reroll usage tracking in `/api/fuse` with no enforcement
- [x] Add admin reconciliation preview/run endpoint (`/api/admin/monetization/reconciliation`)

## S2 - Purchase Verification

- [x] Server-side verification for App Store purchases (`/api/monetization/purchases/verify`)
- [ ] Server-side verification for Google Play purchases (`/api/monetization/purchases/verify`) - deferred (not in current release scope)
- [x] Anti-replay purchase protection (unique `provider + provider_transaction_id`)
- [x] Fraud/risk events in verification/reversal logs
- [x] Refund/reversal handling path in ledger (`/api/admin/monetization/purchases/reversal`)

## Deferred Scope (Post-Apple Launch)

- [ ] Configure Google Play service account credentials in Vercel
- [ ] Enable Google Play Android Developer API and finalize Play Console API access
- [ ] Run Google sandbox E2E purchase verification tests

## S3 - Ops & Governance

- [ ] Admin RBAC (read-only ops vs finance ops vs super-admin)
- [ ] Signed admin actions (or second-factor approval for high-risk actions)
- [ ] Alerting for suspicious spend/grant spikes
- [ ] Security review gate before enforcement mode moves to `enforce`
- [ ] Incident runbook for emergency kill switch + recovery

## Known Future Hardening

- [ ] Replace spoofable anonymous identity header with signed session/identity tokens for mobile API calls
