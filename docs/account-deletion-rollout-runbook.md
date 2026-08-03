# Account deletion rollout and rollback runbook

This runbook covers the protected Admin Console account-deletion workflow. It
does not authorize a production migration, deployment, deletion, or provider
revocation by itself.

## Required configuration

- `ACCOUNT_DELETION_TOMBSTONE_SECRET` is a dedicated server-only secret of at
  least 32 characters. It must match the persisted tombstone key reference.
- `ACCOUNT_DELETION_EXECUTION_ENABLED` controls only destructive deletion
  execution. The only enabled value is the exact value `true` (surrounding
  whitespace is ignored). Missing, blank, `false`, and malformed values keep
  execution disabled.
- Never expose either setting through a `NEXT_PUBLIC_` variable or a client
  bundle.

Tombstone-secret rotation is not supported. A secret change requires a
separately reviewed, version-aware data migration. A mismatched secret fails
identity resolution and deletion execution closed.

## Stage 1: tombstone-aware compatibility deployment

1. Take and verify the normal production database backup or snapshot.
2. Apply the account-deletion migrations in this exact order:
   1. `20260802_001_create_account_deletion_jobs.sql`
   2. `20260802_002_create_account_deletion_storage_outbox.sql`
   3. `20260802_003_create_deleted_identity_tombstones.sql`
3. Configure and independently verify the dedicated tombstone secret.
4. Set `ACCOUNT_DELETION_EXECUTION_ENABLED=false` (or leave it absent).
5. Deploy the final tombstone-aware application SHA.
6. Verify normal authenticated and guest identity resolution, OAuth account
   creation, cookbook/profile ownership guards, purchase verification, credit
   balance reads, and unrelated application health.
7. Run protected admin authorization and preview-only deletion smoke tests.
   Confirm a commit attempt returns `409` with
   `account_deletion_execution_disabled` and changes no job target, audit,
   tombstone, outbox, product, or financial row.
8. Record this exact SHA with execution disabled as the only application
   rollback target for this release.

Tombstone lookup and identity write guards remain active in compatibility mode.
Only destructive account-deletion execution is disabled.

## Stage 2: separately approved execution enablement

1. Obtain separate operational approval to enable destructive deletion.
2. Keep the same tombstone-aware SHA and all three migrations in place.
3. Set `ACCOUNT_DELETION_EXECUTION_ENABLED=true` and deploy the configuration.
4. Create a fresh preview after enablement. A preview created while execution
   was disabled is policy-bound to that state and must fail as `stale_preview`.
5. Verify one approved internal canary through the protected workflow, including
   database completion, storage outbox processing, permanent audit evidence,
   tombstone containment, and financial retention.

## Rollback after any tombstone exists

Use one of these two rollback modes only:

1. Disable `ACCOUNT_DELETION_EXECUTION_ENABLED` on the same tombstone-aware SHA,
   or
2. Redeploy the same recorded tombstone-aware SHA with execution disabled.

Allow in-flight requests from the prior deployment to drain, then confirm new
commit requests are disabled. Continue monitoring identity-unavailable errors,
job/target status, and storage-outbox health.

Never roll back to a tombstone-unaware build after the first tombstone exists.
In particular, `3d3bc4e...`, `a352507...`, and any earlier build that ignores
deleted-identity tombstones are not valid rollback targets. Such a build could
allow a deleted identity to be reclaimed.

Do not drop or reverse the tombstone, key-metadata, job, target, or storage
outbox tables during a normal rollback. The additive schema can remain while
the tombstone-aware application operates in compatibility mode.

## Rollback triggers

Disable execution or redeploy the recorded compatibility SHA when any of the
following is observed:

- unexpected deletion execution or a gate bypass;
- tombstone-key mismatch or sustained `identity_unavailable` responses;
- deletion of unpreviewed data, fingerprint drift, or incomplete graph
  transaction behavior;
- incorrect financial anonymization or retention;
- storage-outbox corruption or unsafe object targeting;
- material regression in authentication, identity isolation, cookbook,
  credits, purchase settlement, or purchase reconciliation.

Database restoration is not a routine rollback step. Escalate any completed
deletion anomaly for evidence-preserving incident handling before considering a
restore or data repair.
