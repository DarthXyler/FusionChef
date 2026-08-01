import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  previewPurchaseReconciliationResolution,
  PurchaseReconciliationActionError,
  resolvePurchaseReconciliationIssue,
} from "./monetization-purchase-reconciliation-actions.ts";
import { scanPurchaseReconciliation } from "./monetization-purchase-reconciliation.ts";

const migrationSql = readFileSync(
  new URL(
    "../migrations/20260731_001_create_purchase_settlement_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const previewRouteSource = readFileSync(
  new URL(
    "../app/api/admin/monetization/reconciliation/purchases/preview/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const resolveRouteSource = readFileSync(
  new URL(
    "../app/api/admin/monetization/reconciliation/purchases/resolve/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const uiSource = readFileSync(
  new URL("../components/AdminPurchaseReconciliationSection.tsx", import.meta.url),
  "utf8",
);

const NOW = "2026-08-01T12:00:00.000Z";
const PREVIEW_SECRET = "pur05-ephemeral-test-preview-secret";
const GOOGLE_TOKEN = "ephemeral-google-token-never-store";

const baseSchemaSql = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY,
    available_credits INTEGER NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
    pending_credits INTEGER NOT NULL DEFAULT 0 CHECK(pending_credits >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_available_after INTEGER NOT NULL CHECK(balance_available_after >= 0),
    balance_pending_after INTEGER NOT NULL CHECK(balance_pending_after >= 0),
    reservation_id TEXT,
    idempotency_scope TEXT,
    idempotency_key TEXT,
    actor TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX idx_credit_ledger_idempotency
    ON credit_ledger_entries (idempotency_scope, idempotency_key)
    WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL;
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('apple_app_store','google_play')),
    provider_transaction_id TEXT NOT NULL,
    provider_original_transaction_id TEXT,
    anon_user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('verified','rejected','revoked','reversal_pending')),
    granted_credits INTEGER NOT NULL DEFAULT 0 CHECK(granted_credits >= 0),
    reversed_credits INTEGER NOT NULL DEFAULT 0 CHECK(reversed_credits >= 0),
    outstanding_reversal_credits INTEGER NOT NULL DEFAULT 0 CHECK(outstanding_reversal_credits >= 0),
    risk_flags_json TEXT NOT NULL DEFAULT '[]',
    payload_json TEXT NOT NULL DEFAULT '{}',
    verified_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(provider, provider_transaction_id)
  );
`;

async function createFixture(options = {}) {
  const databasePath = path.join(tmpdir(), `ff-pur05-${randomUUID()}.db`);
  const url = `file:${databasePath.replace(/\\/g, "/")}`;
  const client = createClient({ url });
  await client.executeMultiple(baseSchemaSql);
  await client.executeMultiple(migrationSql);
  return {
    client,
    url,
    close(additionalClients = []) {
      for (const additional of additionalClients) {
        additional.close();
      }
      client.close();
      if (options.keepFile !== true) {
        try {
          unlinkSync(databasePath);
        } catch {
          // libSQL may retain the file briefly on Windows; it is in the OS temp directory.
        }
      }
    },
  };
}

function providerProduct(provider) {
  return provider === "google_play"
    ? "credits_20_android"
    : "com.flavorfusion.credits.20";
}

async function seedBalance(client, amount = 0, owner = "user-1") {
  await client.execute({
    sql: `INSERT INTO credit_balances (
            anon_user_id, available_credits, pending_credits, updated_at
          ) VALUES (?, ?, 0, ?)`,
    args: [owner, amount, NOW],
  });
}

async function seedPurchase(client, overrides = {}) {
  const provider = overrides.provider ?? "apple_app_store";
  const transactionId = overrides.transactionId ?? `${provider}-transaction-1`;
  const productId = overrides.productId ?? providerProduct(provider);
  const rowId = overrides.rowId ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO credit_purchase_transactions (
            row_id, provider, provider_transaction_id,
            provider_original_transaction_id, anon_user_id, product_id,
            status, granted_credits, reversed_credits,
            outstanding_reversal_credits, risk_flags_json, payload_json,
            verified_at, revoked_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      rowId,
      provider,
      transactionId,
      overrides.originalTransactionId ?? transactionId,
      overrides.owner ?? "user-1",
      productId,
      overrides.status ?? "verified",
      overrides.grantedCredits ?? 20,
      overrides.reversedCredits ?? 0,
      overrides.outstandingReversalCredits ?? 0,
      JSON.stringify(overrides.riskFlags ?? []),
      JSON.stringify(overrides.payload ?? {}),
      overrides.verifiedAt === null ? null : (overrides.verifiedAt ?? NOW),
      overrides.revokedAt ?? null,
      NOW,
      NOW,
    ],
  });
  return { provider, transactionId, productId, rowId, owner: overrides.owner ?? "user-1" };
}

async function seedLedger(client, purchase, overrides = {}) {
  const entryId = overrides.entryId ?? randomUUID();
  const provider = overrides.provider ?? purchase?.provider ?? "apple_app_store";
  const transactionId =
    overrides.transactionId ?? purchase?.transactionId ?? "apple-missing-purchase";
  const productId = overrides.productId ?? purchase?.productId ?? providerProduct(provider);
  const amount = overrides.amount ?? 20;
  const owner = overrides.owner ?? purchase?.owner ?? "user-1";
  await client.execute({
    sql: `INSERT INTO credit_ledger_entries (
            entry_id, anon_user_id, event_type, amount,
            balance_available_after, balance_pending_after,
            reservation_id, idempotency_scope, idempotency_key,
            actor, metadata_json, created_at
          ) VALUES (?, ?, 'purchase_grant', ?, ?, 0, NULL, ?, ?,
            'purchase_verification', ?, ?)`,
    args: [
      entryId,
      owner,
      amount,
      overrides.balanceAfter ?? amount,
      overrides.idempotencyScope === undefined
        ? "purchase-credit-grant"
        : overrides.idempotencyScope,
      overrides.idempotencyKey === undefined
        ? `${provider}:${transactionId}`
        : overrides.idempotencyKey,
      JSON.stringify(
        overrides.metadata ?? { provider, providerTransactionId: transactionId, productId },
      ),
      NOW,
    ],
  });
  return { entryId, provider, transactionId, productId, amount, owner };
}

async function seedLink(client, purchase, ledger) {
  await client.execute({
    sql: `INSERT INTO credit_purchase_ledger_links (
            id, purchase_transaction_id, ledger_entry_id, link_kind, created_at
          ) VALUES (?, ?, ?, 'base_grant', ?)`,
    args: [randomUUID(), purchase.rowId, ledger.entryId, NOW],
  });
}

async function issueByType(client, issueType) {
  const report = await scanPurchaseReconciliation({
    client,
    now: () => new Date(NOW),
  });
  const issue = report.issues.find((candidate) => candidate.issueType === issueType);
  assert.ok(issue, `Expected ${issueType} issue`);
  return issue;
}

function verificationFor(facts, overrides = {}) {
  return {
    provider: facts.provider,
    providerTransactionId: overrides.providerTransactionId ?? facts.transactionId,
    providerOriginalTransactionId:
      overrides.providerOriginalTransactionId ?? facts.transactionId,
    productId: overrides.productId ?? facts.productId,
    state: overrides.state ?? "purchased",
    purchasedAt: overrides.purchasedAt ?? NOW,
    revokedAt: overrides.revokedAt ?? null,
    riskFlags: overrides.riskFlags ?? [],
    payload: overrides.payload ?? {
      providerState: "purchased",
      purchaseToken: GOOGLE_TOKEN,
      productId: facts.productId,
    },
  };
}

function actionOptions(client, verifier, overrides = {}) {
  return {
    client,
    verifyProvider: verifier,
    previewSecret: PREVIEW_SECRET,
    now: overrides.now ?? (() => new Date(NOW)),
    previewTtlMs: overrides.previewTtlMs,
    faultInjector: overrides.faultInjector,
  };
}

async function previewIssue(client, issue, verifier, token = "", overrides = {}) {
  return previewPurchaseReconciliationResolution(
    { issueId: issue.id, googlePurchaseToken: token },
    actionOptions(client, verifier, overrides),
  );
}

async function resolveIssue(client, issue, preview, verifier, overrides = {}) {
  return resolvePurchaseReconciliationIssue(
    {
      issueId: issue.id,
      previewFingerprint: preview.previewFingerprint,
      confirmation:
        overrides.confirmation ?? preview.requiredConfirmationPhrase,
      reason:
        overrides.reason ?? "Verified provider evidence and approved targeted correction.",
      idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
      adminActor: overrides.adminActor ?? "admin-test",
      googlePurchaseToken: overrides.googlePurchaseToken ?? "",
    },
    actionOptions(client, verifier, overrides),
  );
}

async function scalar(client, sql, args = []) {
  const result = await client.execute({ sql, args });
  return Number(Object.values(result.rows[0] ?? {})[0] ?? 0);
}

test("missing-link preview and resolution create only the link and audit", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 20);
    const purchase = await seedPurchase(fixture.client);
    await seedLedger(fixture.client, purchase);
    const issue = await issueByType(fixture.client, "missing_purchase_ledger_link");
    const verifier = async () => {
      throw new Error("provider must not be called");
    };
    const preview = await previewIssue(fixture.client, issue, verifier);
    assert.equal(preview.providerVerificationStatus, "not_required");
    assert.equal(preview.proposedCreditDelta, 0);
    assert.equal(preview.automaticResolutionSupported, true);
    await resolveIssue(fixture.client, issue, preview, verifier);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links"), 1);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_ledger_entries"), 1);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 20);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions"), 1);
    assert.equal((await scanPurchaseReconciliation({ client: fixture.client })).totalIssues, 0);
  } finally {
    fixture.close();
  }
});

test("missing grant is recovered atomically after Apple reverification", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 5);
    const purchase = await seedPurchase(fixture.client);
    const issue = await issueByType(fixture.client, "purchase_missing_grant");
    let verificationCalls = 0;
    const verifier = async () => {
      verificationCalls += 1;
      return verificationFor(purchase);
    };
    const preview = await previewIssue(fixture.client, issue, verifier);
    assert.equal(preview.proposedCreditDelta, 20);
    const result = await resolveIssue(fixture.client, issue, preview, verifier);
    assert.equal(result.creditDelta, 20);
    assert.equal(verificationCalls, 2);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 25);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_ledger_entries"), 1);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links"), 1);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions WHERE status = 'completed'"), 1);
  } finally {
    fixture.close();
  }
});

test("missing Google grant requires transient token and grants once", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 0);
    const purchase = await seedPurchase(fixture.client, {
      provider: "google_play",
      transactionId: "GPA.1234-5678-9012-34567",
    });
    const issue = await issueByType(fixture.client, "purchase_missing_grant");
    const seenInputs = [];
    const verifier = async (provider, input) => {
      seenInputs.push({ provider, input: { ...input } });
      assert.equal(input.purchaseToken, GOOGLE_TOKEN);
      assert.equal("packageName" in input, false);
      return verificationFor(purchase);
    };
    await assert.rejects(
      previewIssue(fixture.client, issue, verifier),
      (error) => error instanceof PurchaseReconciliationActionError && error.code === "google_purchase_token_required",
    );
    const preview = await previewIssue(fixture.client, issue, verifier, GOOGLE_TOKEN);
    await resolveIssue(fixture.client, issue, preview, verifier, {
      googlePurchaseToken: GOOGLE_TOKEN,
    });
    assert.equal(seenInputs.length, 2);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 20);
    const serialized = JSON.stringify(
      (await fixture.client.execute(`
        SELECT payload_json AS value FROM credit_purchase_transactions
        UNION ALL SELECT metadata_json FROM credit_ledger_entries
        UNION ALL SELECT metadata_json FROM purchase_reconciliation_actions
      `)).rows,
    );
    assert.doesNotMatch(serialized, new RegExp(GOOGLE_TOKEN));
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(GOOGLE_TOKEN));
  } finally {
    fixture.close();
  }
});

test("missing purchase is created and linked without a duplicate balance increase", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 20);
    const ledger = await seedLedger(fixture.client, null);
    const issue = await issueByType(fixture.client, "grant_missing_purchase");
    const verifier = async () => verificationFor(ledger);
    const preview = await previewIssue(fixture.client, issue, verifier);
    assert.equal(preview.proposedCreditDelta, 0);
    await resolveIssue(fixture.client, issue, preview, verifier);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 20);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_transactions"), 1);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_ledger_entries"), 1);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links"), 1);
  } finally {
    fixture.close();
  }
});

async function arrangeAmountMismatch(fixture, ledgerAmount, balance) {
  await seedBalance(fixture.client, balance);
  const purchase = await seedPurchase(fixture.client);
  const ledger = await seedLedger(fixture.client, purchase, { amount: ledgerAmount, balanceAfter: balance });
  await seedLink(fixture.client, purchase, ledger);
  const issue = await issueByType(fixture.client, "credit_amount_mismatch");
  return { purchase, issue };
}

test("positive amount correction adds only the missing repair adjustment", async () => {
  const fixture = await createFixture();
  try {
    const { purchase, issue } = await arrangeAmountMismatch(fixture, 10, 10);
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    assert.equal(preview.proposedCreditDelta, 10);
    await resolveIssue(fixture.client, issue, preview, verifier);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 20);
    assert.equal(await scalar(fixture.client, "SELECT amount FROM credit_ledger_entries WHERE event_type = 'purchase_adjustment'"), 10);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links WHERE link_kind = 'repair_adjustment'"), 1);
    assert.equal((await scanPurchaseReconciliation({ client: fixture.client })).totalIssues, 0);
  } finally {
    fixture.close();
  }
});

test("safe negative correction is audited without changing the original grant", async () => {
  const fixture = await createFixture();
  try {
    const { purchase, issue } = await arrangeAmountMismatch(fixture, 30, 30);
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    assert.equal(preview.proposedCreditDelta, -10);
    await resolveIssue(fixture.client, issue, preview, verifier);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 20);
    assert.equal(await scalar(fixture.client, "SELECT amount FROM credit_ledger_entries WHERE event_type = 'purchase_grant'"), 30);
    assert.equal(await scalar(fixture.client, "SELECT amount FROM credit_ledger_entries WHERE event_type = 'purchase_adjustment'"), -10);
    assert.equal((await scanPurchaseReconciliation({ client: fixture.client })).totalIssues, 0);
  } finally {
    fixture.close();
  }
});

test("negative correction remains manual when the balance would become negative", async () => {
  const fixture = await createFixture();
  try {
    const { purchase, issue } = await arrangeAmountMismatch(fixture, 30, 5);
    const preview = await previewIssue(fixture.client, issue, async () => verificationFor(purchase));
    assert.equal(preview.proposedCreditDelta, -10);
    assert.equal(preview.automaticResolutionSupported, false);
    assert.match(preview.manualInvestigationReason, /cannot safely absorb/i);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions"), 0);
  } finally {
    fixture.close();
  }
});

test("owner mismatch, duplicate grant, and product conflict remain manual-only", async (t) => {
  const scenarios = [
    {
      type: "owner_mismatch",
      arrange: async (fixture) => {
        await seedBalance(fixture.client, 20);
        const purchase = await seedPurchase(fixture.client);
        const ledger = await seedLedger(fixture.client, purchase, { owner: "user-2" });
        await seedLink(fixture.client, purchase, ledger);
      },
    },
    {
      type: "duplicate_grant",
      arrange: async (fixture) => {
        await seedBalance(fixture.client, 40);
        const purchase = await seedPurchase(fixture.client);
        const ledger = await seedLedger(fixture.client, purchase);
        await seedLink(fixture.client, purchase, ledger);
        await seedLedger(fixture.client, purchase, { idempotencyScope: null, idempotencyKey: null });
      },
    },
    {
      type: "product_or_transaction_conflict",
      arrange: async (fixture) => {
        await seedBalance(fixture.client, 20);
        const purchase = await seedPurchase(fixture.client);
        const ledger = await seedLedger(fixture.client, purchase, {
          metadata: {
            provider: purchase.provider,
            providerTransactionId: purchase.transactionId,
            productId: "com.flavorfusion.credits.50",
          },
        });
        await seedLink(fixture.client, purchase, ledger);
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.type, async () => {
      const fixture = await createFixture();
      try {
        await scenario.arrange(fixture);
        const issue = await issueByType(fixture.client, scenario.type);
        const preview = await previewIssue(fixture.client, issue, async () => {
          throw new Error("provider should not be called");
        });
        assert.equal(preview.automaticResolutionSupported, false);
        assert.match(preview.manualInvestigationReason, /Manual investigation required/);
      } finally {
        fixture.close();
      }
    });
  }
});

test("a supported amount mismatch is manual-only when a duplicate grant conflict coexists", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 20);
    const purchase = await seedPurchase(fixture.client);
    const baseLedger = await seedLedger(fixture.client, purchase, {
      amount: 10,
      balanceAfter: 10,
    });
    await seedLink(fixture.client, purchase, baseLedger);
    await seedLedger(fixture.client, purchase, {
      amount: 10,
      idempotencyScope: null,
      idempotencyKey: null,
    });
    const issue = await issueByType(fixture.client, "credit_amount_mismatch");
    const preview = await previewIssue(fixture.client, issue, async () => {
      throw new Error("provider should not be called for ambiguous evidence");
    });
    assert.equal(preview.automaticResolutionSupported, false);
    assert.match(preview.manualInvestigationReason, /duplicate-grant/i);
  } finally {
    fixture.close();
  }
});

test("refunded, revoked, fraudulent, and canceled provider facts cannot be repaired", async (t) => {
  for (const scenario of [
    { state: "canceled", riskFlags: [] },
    { state: "revoked", revokedAt: NOW, riskFlags: [] },
    { state: "purchased", riskFlags: ["provider_refunded"] },
    { state: "purchased", riskFlags: ["fraud_detected"] },
  ]) {
    await t.test(`${scenario.state}:${scenario.riskFlags.join(",")}`, async () => {
      const fixture = await createFixture();
      try {
        await seedBalance(fixture.client, 0);
        const purchase = await seedPurchase(fixture.client);
        const issue = await issueByType(fixture.client, "purchase_missing_grant");
        const preview = await previewIssue(fixture.client, issue, async () =>
          verificationFor(purchase, scenario),
        );
        assert.equal(preview.automaticResolutionSupported, false);
        assert.equal(preview.providerVerificationStatus, "failed");
      } finally {
        fixture.close();
      }
    });
  }
});

test("stale, expired, changed-balance, and changed-provider previews are rejected", async (t) => {
  await t.test("stale issue", async () => {
    const fixture = await createFixture();
    try {
      await seedBalance(fixture.client, 20);
      const purchase = await seedPurchase(fixture.client);
      const ledger = await seedLedger(fixture.client, purchase);
      const issue = await issueByType(fixture.client, "missing_purchase_ledger_link");
      const verifier = async () => verificationFor(purchase);
      const preview = await previewIssue(fixture.client, issue, verifier);
      await fixture.client.execute({
        sql: "UPDATE credit_ledger_entries SET amount = 19 WHERE entry_id = ?",
        args: [ledger.entryId],
      });
      await assert.rejects(resolveIssue(fixture.client, issue, preview, verifier), /changed|no longer exists/i);
    } finally {
      fixture.close();
    }
  });

  await t.test("expired preview", async () => {
    const fixture = await createFixture();
    try {
      await seedBalance(fixture.client, 20);
      const purchase = await seedPurchase(fixture.client);
      await seedLedger(fixture.client, purchase);
      const issue = await issueByType(fixture.client, "missing_purchase_ledger_link");
      const verifier = async () => verificationFor(purchase);
      const preview = await previewIssue(fixture.client, issue, verifier, "", {
        previewTtlMs: 1_000,
      });
      await assert.rejects(
        resolveIssue(fixture.client, issue, preview, verifier, {
          now: () => new Date("2026-08-01T12:00:02.000Z"),
        }),
        (error) => error instanceof PurchaseReconciliationActionError && error.code === "preview_expired",
      );
    } finally {
      fixture.close();
    }
  });

  await t.test("changed balance", async () => {
    const fixture = await createFixture();
    try {
      await seedBalance(fixture.client, 0);
      const purchase = await seedPurchase(fixture.client);
      const issue = await issueByType(fixture.client, "purchase_missing_grant");
      const verifier = async () => verificationFor(purchase);
      const preview = await previewIssue(fixture.client, issue, verifier);
      await fixture.client.execute("UPDATE credit_balances SET available_credits = 1");
      await assert.rejects(resolveIssue(fixture.client, issue, preview, verifier), /changed/i);
    } finally {
      fixture.close();
    }
  });

  await t.test("changed provider result", async () => {
    const fixture = await createFixture();
    try {
      await seedBalance(fixture.client, 0);
      const purchase = await seedPurchase(fixture.client);
      const issue = await issueByType(fixture.client, "purchase_missing_grant");
      const preview = await previewIssue(fixture.client, issue, async () => verificationFor(purchase));
      await assert.rejects(
        resolveIssue(fixture.client, issue, preview, async () =>
          verificationFor(purchase, { purchasedAt: "2026-08-01T11:59:00.000Z" }),
        ),
        /provider result changed/i,
      );
    } finally {
      fixture.close();
    }
  });
});

test("typed confirmation and admin reason are mandatory", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 20);
    const purchase = await seedPurchase(fixture.client);
    await seedLedger(fixture.client, purchase);
    const issue = await issueByType(fixture.client, "missing_purchase_ledger_link");
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    await assert.rejects(
      resolveIssue(fixture.client, issue, preview, verifier, { confirmation: "WRONG" }),
      (error) => error instanceof PurchaseReconciliationActionError && error.code === "confirmation_mismatch",
    );
    await assert.rejects(
      resolveIssue(fixture.client, issue, preview, verifier, { reason: "short" }),
      (error) => error instanceof PurchaseReconciliationActionError && error.code === "admin_reason_required",
    );
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links"), 0);
  } finally {
    fixture.close();
  }
});

test("repeated and concurrent commits apply one correction and replay the audit", async () => {
  const fixture = await createFixture();
  const extraClients = [];
  try {
    await seedBalance(fixture.client, 20);
    const purchase = await seedPurchase(fixture.client);
    await seedLedger(fixture.client, purchase);
    const issue = await issueByType(fixture.client, "missing_purchase_ledger_link");
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    const idempotencyKey = randomUUID();
    const first = await resolveIssue(fixture.client, issue, preview, verifier, { idempotencyKey });
    const replay = await resolveIssue(fixture.client, issue, preview, verifier, { idempotencyKey });
    assert.equal(first.status, "resolved");
    assert.equal(replay.status, "replayed");
    assert.equal(first.actionId, replay.actionId);

    const secondPurchase = await seedPurchase(fixture.client, { transactionId: "apple-concurrent" });
    await seedLedger(fixture.client, secondPurchase);
    const secondIssue = await issueByType(fixture.client, "missing_purchase_ledger_link");
    const secondPreview = await previewIssue(fixture.client, secondIssue, verifier);
    const concurrentKey = randomUUID();
    const clientTwo = createClient({ url: fixture.url });
    extraClients.push(clientTwo);
    const results = await Promise.all([
      resolveIssue(fixture.client, secondIssue, secondPreview, verifier, { idempotencyKey: concurrentKey }),
      resolveIssue(clientTwo, secondIssue, secondPreview, verifier, { idempotencyKey: concurrentKey }),
    ]);
    assert.deepEqual(new Set(results.map((result) => result.status)), new Set(["resolved", "replayed"]));
    assert.equal(results[0].actionId, results[1].actionId);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions"), 2);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links"), 2);
  } finally {
    fixture.close(extraClients);
  }
});

test("financial correction and completed audit roll back together on injected failure", async () => {
  const fixture = await createFixture();
  try {
    const { purchase, issue } = await arrangeAmountMismatch(fixture, 10, 10);
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    await assert.rejects(
      resolveIssue(fixture.client, issue, preview, verifier, {
        faultInjector(stage) {
          if (stage === "after_audit_insert") {
            throw new Error("injected audit rollback");
          }
        },
      }),
      /injected audit rollback/,
    );
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 10);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_ledger_entries WHERE event_type = 'purchase_adjustment'"), 0);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions"), 0);
  } finally {
    fixture.close();
  }
});

test("PUR-02 settlement writes and reconciliation audit roll back together", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 0);
    const purchase = await seedPurchase(fixture.client);
    const issue = await issueByType(fixture.client, "purchase_missing_grant");
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    await assert.rejects(
      resolveIssue(fixture.client, issue, preview, verifier, {
        faultInjector(stage) {
          if (stage === "after_audit_insert") {
            throw new Error("injected settlement audit rollback");
          }
        },
      }),
      /injected settlement audit rollback/,
    );
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 0);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_ledger_entries"), 0);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_purchase_ledger_links"), 0);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions"), 0);
    assert.equal(await scalar(fixture.client, "SELECT granted_credits FROM credit_purchase_transactions"), 20);
  } finally {
    fixture.close();
  }
});

test("concurrent financial corrections change the balance only once", async () => {
  const fixture = await createFixture();
  const extraClients = [];
  try {
    const { purchase, issue } = await arrangeAmountMismatch(fixture, 10, 10);
    const verifier = async () => verificationFor(purchase);
    const preview = await previewIssue(fixture.client, issue, verifier);
    const clientTwo = createClient({ url: fixture.url });
    extraClients.push(clientTwo);
    const outcomes = await Promise.allSettled([
      resolveIssue(fixture.client, issue, preview, verifier, {
        idempotencyKey: randomUUID(),
      }),
      resolveIssue(clientTwo, issue, preview, verifier, {
        idempotencyKey: randomUUID(),
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.equal(await scalar(fixture.client, "SELECT available_credits FROM credit_balances"), 20);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM credit_ledger_entries WHERE event_type = 'purchase_adjustment'"), 1);
    assert.equal(await scalar(fixture.client, "SELECT COUNT(*) FROM purchase_reconciliation_actions"), 1);
  } finally {
    fixture.close(extraClients);
  }
});

test("preview performs no financial writes", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 20);
    const purchase = await seedPurchase(fixture.client);
    await seedLedger(fixture.client, purchase);
    const issue = await issueByType(fixture.client, "missing_purchase_ledger_link");
    const statements = [];
    const readOnlyClient = {
      execute(statement) {
        const sql = typeof statement === "string" ? statement : statement.sql;
        statements.push(sql);
        assert.match(sql, /^\s*SELECT\b/i);
        return fixture.client.execute(statement);
      },
      transaction() {
        throw new Error("preview attempted a write transaction");
      },
    };
    const preview = await previewPurchaseReconciliationResolution(
      { issueId: issue.id },
      actionOptions(readOnlyClient, async () => verificationFor(purchase)),
    );
    assert.equal(preview.automaticResolutionSupported, true);
    assert.equal(statements.length, 1);
  } finally {
    fixture.close();
  }
});

test("legacy plaintext Google identifiers are not copied by automatic financial repair", async () => {
  const fixture = await createFixture();
  try {
    await seedBalance(fixture.client, 0);
    await seedPurchase(fixture.client, {
      provider: "google_play",
      transactionId: `token:${GOOGLE_TOKEN}`,
    });
    const issue = await issueByType(fixture.client, "purchase_missing_grant");
    const preview = await previewIssue(
      fixture.client,
      issue,
      async () => {
        throw new Error("legacy secret should not be submitted automatically");
      },
      GOOGLE_TOKEN,
    );
    assert.equal(preview.automaticResolutionSupported, false);
    assert.match(preview.manualInvestigationReason, /plaintext provider token/i);
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(GOOGLE_TOKEN));
  } finally {
    fixture.close();
  }
});

test("admin endpoints require authentication and preserve transient-secret boundaries", () => {
  for (const source of [previewRouteSource, resolveRouteSource]) {
    assert.match(source, /requireMonetizationAdmin\(request/);
    assert.match(source, /enforceRateLimit\(request/);
    assert.match(source, /withNoStore/);
    assert.doesNotMatch(source, /logMonetizationAudit\([\s\S]*googlePurchaseToken/);
  }
  assert.match(resolveRouteSource, /requireMonetizationAdmin\(request, \{ requireActor: true \}\)/);
  assert.match(resolveRouteSource, /getIdempotencyKeyFromHeaders/);
  assert.match(uiSource, /Review resolution/);
  assert.match(uiSource, /Manual investigation required/);
  assert.match(uiSource, /setGooglePurchaseToken\(""\)/);
  assert.doesNotMatch(uiSource, /Repair all|multi-select/i);
});
