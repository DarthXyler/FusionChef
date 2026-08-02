import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const jobsSource = readFileSync(
  new URL("./account-deletion-jobs.ts", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../app/api/admin/monetization/users/route.ts", import.meta.url),
  "utf8",
);
const componentSource = readFileSync(
  new URL("../components/AdminMonetizationConfigPanel.tsx", import.meta.url),
  "utf8",
);
const policySource = readFileSync(
  new URL("../docs/account-deletion-data-policy.md", import.meta.url),
  "utf8",
);

test("job reason and idempotency persistence use pseudonymous references", () => {
  const createSource = jobsSource.slice(
    jobsSource.indexOf("export async function createAccountDeletionPreview"),
    jobsSource.indexOf("function safeFailureCode"),
  );
  assert.match(createSource, /hmacReference\(\s*"idempotency"/);
  assert.match(createSource, /hmacReference\("reason"/);
  assert.match(createSource, /actingAdminRef/);
  assert.match(createSource, /reasonRef/);
  assert.match(createSource, /idempotencyKeyRef/);
  assert.doesNotMatch(createSource, /options\.reason\.trim\(\),\s*JSON\.stringify/);
});

test("deletion response minimizes users and pseudonymizes graph identifiers", () => {
  const responseSource = routeSource.slice(
    routeSource.indexOf("function buildDeleteResponse"),
    routeSource.indexOf("function buildReadyGraphDeletionStatements"),
  );
  assert.doesNotMatch(responseSource, /\.\.\.target/);
  assert.doesNotMatch(responseSource, /input: target\.input/);
  assert.doesNotMatch(
    responseSource,
    /normalizedEmail|availableCredits|pendingCredits|lastActivityAt|provider|avatarUrl/,
  );
  assert.match(responseSource, /email: target\.user\.email/);
  assert.match(responseSource, /name: target\.user\.name/);
  assert.match(responseSource, /accountSetup: target\.user\.accountSetup/);
  assert.match(responseSource, /kind: "response-identity"/);
  const previewPanel = componentSource.slice(
    componentSource.indexOf("function AccountDeletionPreviewPanel"),
    componentSource.indexOf("function csvEscape"),
  );
  assert.doesNotMatch(previewPanel, /target\.input/);
});

test("deletion audit uses pseudonymous admin, network, and reason references", () => {
  const statementSource = routeSource.slice(
    routeSource.indexOf("function buildReadyGraphDeletionStatements"),
    routeSource.indexOf("export async function POST"),
  );
  assert.match(statementSource, /params\.actorRef/);
  assert.match(statementSource, /params\.reasonRef/);
  assert.doesNotMatch(statementSource, /params\.actor,/);
  assert.doesNotMatch(statementSource, /params\.reason,/);

  const successAudit = routeSource.slice(
    routeSource.indexOf('event: "account_delete_succeeded"') - 80,
    routeSource.indexOf('event: "account_delete_succeeded"') + 900,
  );
  assert.match(successAudit, /actorRef:/);
  assert.match(successAudit, /networkRef:/);
  assert.doesNotMatch(successAudit, /actorEmail:/);
  assert.doesNotMatch(successAudit, /actorAuthUserId:/);
  assert.doesNotMatch(successAudit, /\nip:/);
});

test("retention boundary is explicit without inventing a retention period", () => {
  assert.match(policySource, /Unresolved product-policy decision/);
  assert.match(policySource, /retention period/);
  assert.match(policySource, /raw target `auth_user_id`/);
  assert.match(policySource, /does not purge, rewrite,\s*or backfill historical/);
  assert.doesNotMatch(policySource, /retain for \d+ (?:day|month|year)/i);
});
