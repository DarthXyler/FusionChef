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

## S4 - Admin Auth Upgrade (Login + Passkey + Token Fallback)

Goal: move from token-only admin access to user-friendly, strongly authenticated admin login.

### S4.1 - Auth Foundation

- [ ] Add admin auth provider for web admin routes (`/admin/*`) with:
- [ ] Google OAuth login
- [ ] Email magic-link login
- [ ] Passkey (WebAuthn) login
- [ ] Add admin user table with allowlisted emails
- [ ] Add admin session table with device/session metadata
- [ ] Enforce HTTPS-only secure session cookies

### S4.2 - Admin Access Guardrails

- [ ] Restrict `/admin/monetization` UI route to authenticated admin users only
- [ ] Restrict admin APIs to authenticated admin users only (not just token)
- [ ] Keep `MONETIZATION_ADMIN_TOKEN` as break-glass fallback for incidents
- [ ] Add feature flag to temporarily disable token fallback if abuse detected

### S4.3 - Passkey and Account Recovery UX

- [ ] Add passkey enrollment UI after first successful admin login
- [ ] Support multiple passkeys per admin account (phone + laptop)
- [ ] Add account recovery path via verified email magic link
- [ ] Add step-up check for sensitive actions (for example: moving to `enforce` mode)

### S4.4 - Audit and Security Logging

- [ ] Log admin auth events: login success/failure, logout, passkey create/delete
- [ ] Log admin authorization events for config/reconciliation endpoints
- [ ] Add immutable audit trail fields: actor, action, requestId, ip, userAgent, outcome
- [ ] Add alerting for suspicious admin activity (repeated failures, unusual IP/geo)

### S4.5 - Rollout and Cutover

- [ ] Phase A: ship auth in shadow mode (login works; token path still primary)
- [ ] Phase B: make auth primary, keep token fallback for emergency use
- [ ] Phase C: require auth + optional step-up for critical admin actions
- [ ] Publish runbook: token rotation, admin lockout recovery, incident response

## Monetization Admin UID Decision (Locked)

- [ ] Do not build/expand compensation UI on anonymous user IDs.
- [ ] After account login is live, implement compensation workflows on account UID only.
- [ ] Compensation panel scope (post-login):
- [ ] Search user by account email/UID
- [ ] Grant/deduct credits by account UID
- [ ] Require reason + actor for every manual adjustment
- [ ] Persist immutable audit trail for compensation actions
