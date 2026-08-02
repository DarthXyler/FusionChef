# Account deletion operational-data policy boundary

## Implemented minimization

Account-deletion jobs persist HMAC references for the acting administrator,
request reason, idempotency key, selected users, identity graph, device mappings,
alias edges, and storage references. The HMAC secret stays server-side. Job and
target errors are fixed, client-safe summaries rather than exception messages.

Deletion API responses contain only the user name/email and account-setup state
needed to confirm the selected authenticated accounts. Identity nodes and alias
edges are returned as pseudonymous references. R2 object keys, provider payloads,
purchase tokens, profile URLs, normalized emails, balances, activity timestamps,
and full user records are not returned by the deletion workflow.

The storage outbox retains the exact app-owned R2 object key because the worker
cannot delete an object using a digest. Keys are never returned by the admin API
or written to audit logs. References containing an email address, provider-token
terminology, or a long token-like segment fail closed for manual review before an
outbox row is created. Outbox error text is a fixed safe summary.

Financial purchases, linked financial ledger evidence, purchase-ledger links,
and reconciliation actions remain retained and are anonymized according to the
settlement-retention implementation. New deletion audit rows store the acting
administrator and free-form reason as HMAC references; the target-identifier
columns remain inside the explicit policy boundary below.

## Unresolved product-policy decision

`account_deletion_events` contains historical raw target `auth_user_id` and
`canonical_anon_user_id` values. Product/legal owners must explicitly decide:

- the retention period for account-deletion audit events; and
- whether retained target identifiers should remain raw, become pseudonymous,
  or follow another documented treatment, including treatment of existing rows.

No retention duration is assumed. This implementation does not purge, rewrite,
or backfill historical `account_deletion_events`, and it does not add an inactive
configuration flag that could be mistaken for an enforced retention policy.

After the policy decision, implementation should add an additive migration and a
tested, observable retention job. It must preserve required financial/deletion
evidence, be idempotent, use a bounded batch size, and be deployed only after the
chosen retention period and identifier treatment are approved.
