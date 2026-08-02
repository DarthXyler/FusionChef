import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("../components/AdminMonetizationConfigPanel.tsx", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);

test("account deletion UI binds commit to the issued job and fingerprint", () => {
  const requestSource = componentSource.slice(
    componentSource.indexOf("async function runAccountDelete"),
    componentSource.indexOf("async function readConfig"),
  );
  assert.match(requestSource, /jobId: deleteDryRun\.job\.jobId/);
  assert.match(requestSource, /fingerprint: deleteDryRun\.job\.fingerprint/);
  assert.match(requestSource, /confirmation: deleteConfirmation/);
  assert.match(requestSource, /reason: deleteReason/);
  assert.match(requestSource, /errorCode === "stale_preview"/);
  assert.match(requestSource, /errorCode === "expired_preview"/);
  assert.match(requestSource, /Run a new deletion preview before retrying/);
});

test("changing account deletion scope invalidates the visible preview", () => {
  const deletionPanel = componentSource.slice(
    componentSource.indexOf(">Account Deletion<"),
    componentSource.indexOf("panelNotices.users.error"),
  );
  const identifiersHandler = deletionPanel.slice(
    deletionPanel.indexOf("setDeleteIdentifiersText"),
    deletionPanel.indexOf("rows={6}"),
  );
  const reasonHandler = deletionPanel.slice(
    deletionPanel.indexOf("setDeleteReason"),
    deletionPanel.indexOf('placeholder="user requested deletion"'),
  );
  assert.match(identifiersHandler, /setDeleteDryRun\(null\)/);
  assert.match(identifiersHandler, /setDeleteConfirmation\(""\)/);
  assert.match(reasonHandler, /setDeleteDryRun\(null\)/);
  assert.match(reasonHandler, /setDeleteConfirmation\(""\)/);
});

test("account deletion preview exposes operational status without raw storage keys", () => {
  const previewPanel = componentSource.slice(
    componentSource.indexOf("function AccountDeletionPreviewPanel"),
    componentSource.indexOf("function csvEscape"),
  );
  for (const label of [
    "Authenticated users",
    "Account Setup",
    "Identity graph",
    "Canonical identities",
    "Alias graph",
    "Device mappings",
    "Manual-review blockers",
    "Records to delete",
    "Financial evidence retained",
    "Storage objects",
    "Preview expires",
    "Per-target job status",
    "Storage cleanup status",
  ]) {
    assert.match(previewPanel, new RegExp(label));
  }
  for (const lifecycle of [
    "Active:",
    "Expired:",
    "Finalized:",
    "Malformed / review:",
  ]) {
    assert.match(previewPanel, new RegExp(lifecycle));
  }
  assert.match(previewPanel, /creditReservationAmount/);
  assert.match(previewPanel, /server-time boundary/);
  assert.match(previewPanel, /failed_retryable/);
  assert.doesNotMatch(previewPanel, /objectKey|object_key|providerPayload|purchaseToken/);
});

test("admin route returns persisted per-target and storage status", () => {
  const deletionBranch = routeSource.slice(
    routeSource.indexOf('if (operation === "account_delete")'),
    routeSource.indexOf("const payload = parseBatchPayload"),
  );
  assert.match(deletionBranch, /getAccountDeletionJobStatus/);
  assert.match(deletionBranch, /actingAdminAuthUserId: deletionAdmin\.context\.actorAuthUserId/);
  assert.match(routeSource, /deviceMappingCount/);
  assert.match(routeSource, /recipeImages/);
  assert.match(routeSource, /profileAvatars/);
  assert.match(routeSource, /generatedImages/);
});
