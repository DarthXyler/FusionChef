# Monetization S2 Setup (Purchase Verification)

## New Endpoints

- `POST /api/monetization/purchases/verify`
  - Public (mobile-facing) purchase verification endpoint.
  - Requires `idempotency-key` header.
  - Uses mobile anonymous identity headers/cookie merge.

- `POST /api/admin/monetization/purchases/reversal`
  - Admin-only forced reversal endpoint (refund/chargeback handling).
  - Requires `x-admin-token`, `x-admin-actor`, and `idempotency-key`.

## Required Environment Variables

## Current Release Scope

- Apple App Store purchase verification: **active scope**
- Google Play purchase verification: **deferred to a later release**

### Shared

- `MONETIZATION_CREDIT_PACKS_JSON`
  - JSON map from store product ids to credits.
  - Example:
    ```json
    {
      "apple_app_store": {
        "com.flavorfusion.credits.20": 20,
        "com.flavorfusion.credits.50": 50
      },
      "google_play": {
        "credits_20": 20,
        "credits_50": 50
      }
    }
    ```

### Apple App Store Verification

- `APPLE_IAP_ISSUER_ID`
- `APPLE_IAP_KEY_ID`
- `APPLE_IAP_PRIVATE_KEY`
  - Store as sensitive multiline key (`\n` supported in env value).

### Google Play Verification

- `GOOGLE_PLAY_PACKAGE_NAME`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY`
  - Store as sensitive multiline key (`\n` supported in env value).

## Verification Request Body

### Apple

```json
{
  "provider": "apple_app_store",
  "productId": "com.flavorfusion.credits.20",
  "appleTransactionId": "2000001234567890"
}
```

### Google

```json
{
  "provider": "google_play",
  "productId": "credits_20",
  "googlePurchaseToken": "purchase-token-from-play",
  "packageName": "optional.override.package"
}
```

## Anti-Replay Behavior

- A purchase is unique by `(provider, provider_transaction_id)`.
- Re-using the same transaction for a different anonymous identity is blocked.
- First successful verification grants credits once and stores a transaction record.

## Reversal Behavior

- Reversal attempts deduct previously granted credits.
- If full deduction succeeds:
  - Purchase status becomes `revoked`.
- If balance is insufficient:
  - Purchase status becomes `reversal_pending`.
  - Outstanding reversal credits are tracked on the purchase record.
