import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const runId = `ff_regression_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const usingRemote = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
const client = createClient({
  url: usingRemote
    ? process.env.TURSO_DATABASE_URL
    : `file:${join(tmpdir(), `${runId}.db`).replace(/\\/g, "/")}`,
  authToken: usingRemote ? process.env.TURSO_AUTH_TOKEN : "local-regression",
});

const provider = "apple_app_store";
const anonUserId = runId;
const firstTransactionId = `${runId}_txn_20`;
const secondTransactionId = `${runId}_txn_50`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseTypeScriptSource(relativePath, scriptKind) {
  const sourceText = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
  return ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
}

function getNumericLiteralValue(node) {
  return ts.isNumericLiteral(node) ? Number(node.text) : null;
}

function collectNumericPropertyValues(sourceFile, propertyName) {
  const values = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === propertyName &&
      ts.isNumericLiteral(node.initializer)
    ) {
      values.push(Number(node.initializer.text));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return values;
}

function findCalls(sourceFile, functionName) {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === functionName) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return calls;
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer = null;
  function visit(node) {
    if (
      !initializer &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === variableName
    ) {
      initializer = node.initializer ?? null;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return initializer;
}

function findFunctionReturnObject(sourceFile, functionName) {
  let returnObject = null;
  function visit(node) {
    if (
      !returnObject &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.body
    ) {
      const returnStatement = node.body.statements.find(ts.isReturnStatement);
      if (returnStatement?.expression && ts.isObjectLiteralExpression(returnStatement.expression)) {
        returnObject = returnStatement.expression;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return returnObject;
}

function findNestedObjectProperty(sourceFile, objectLiteral, propertyPath) {
  let current = objectLiteral;
  for (const [index, propertyName] of propertyPath.entries()) {
    if (!current || !ts.isObjectLiteralExpression(current)) {
      return null;
    }
    const property = current.properties.find(
      (entry) =>
        ts.isPropertyAssignment(entry) && entry.name.getText(sourceFile) === propertyName,
    );
    if (!property || !ts.isPropertyAssignment(property)) {
      return null;
    }
    if (index === propertyPath.length - 1) {
      return property.initializer;
    }
    current = property.initializer;
  }
  return null;
}

async function assertFuseCostFallbacks() {
  const [backend, admin, mobile, profile] = await Promise.all([
    parseTypeScriptSource("lib/monetization-config.ts", ts.ScriptKind.TS),
    parseTypeScriptSource("components/AdminMonetizationConfigPanel.tsx", ts.ScriptKind.TSX),
    parseTypeScriptSource("mobile/src/services/monetization.ts", ts.ScriptKind.TS),
    parseTypeScriptSource("mobile/src/screens/ProfileScreen.tsx", ts.ScriptKind.TSX),
  ]);

  const backendLiteralFallbacks = collectNumericPropertyValues(backend, "fuseCreditCost");
  assert(
    backendLiteralFallbacks.length === 1 && backendLiteralFallbacks[0] === 3,
    "backend default fuse cost must be 3",
  );
  const backendNormalizationCall = findCalls(backend, "toIntegerInRange").find(
    (call) => call.arguments[0]?.getText(backend) === "raw.fuseCreditCost",
  );
  assert(
    backendNormalizationCall && getNumericLiteralValue(backendNormalizationCall.arguments[1]) === 3,
    "backend normalization fallback fuse cost must be 3",
  );

  const adminFuseCosts = collectNumericPropertyValues(admin, "fuseCreditCost");
  assert(
    adminFuseCosts.length === 5 && adminFuseCosts.every((value) => value === 3),
    "every admin default and preset fuse cost must be 3",
  );

  const signedOutSnapshot = findFunctionReturnObject(mobile, "buildSignedOutAccountSnapshot");
  const mobileSignedOutFuseCost = findNestedObjectProperty(
    mobile,
    signedOutSnapshot,
    ["actionCosts", "fuse"],
  );
  assert(
    mobileSignedOutFuseCost && getNumericLiteralValue(mobileSignedOutFuseCost) === 3,
    "mobile signed-out fallback fuse cost must be 3",
  );
  const mobileParsingCall = findCalls(mobile, "asInteger").find((call) =>
    call.arguments[0]?.getText(mobile).includes("payload.actionCosts.fuse"),
  );
  const mobileConditionalFallback =
    mobileParsingCall && ts.isConditionalExpression(mobileParsingCall.arguments[0])
      ? getNumericLiteralValue(mobileParsingCall.arguments[0].whenFalse)
      : null;
  assert(
    mobileParsingCall &&
      mobileConditionalFallback === 3 &&
      getNumericLiteralValue(mobileParsingCall.arguments[1]) === 3,
    "mobile account parser fallback fuse cost must be 3",
  );

  const profileFallback = findVariableInitializer(profile, "fuseCreditCost");
  assert(
    profileFallback &&
      ts.isBinaryExpression(profileFallback) &&
      profileFallback.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      getNumericLiteralValue(profileFallback.right) === 3,
    "Profile fuse cost display fallback must be 3",
  );
}

async function execute(sql, args = []) {
  return client.execute({ sql, args });
}

async function ensureSchema() {
  await execute(`CREATE TABLE IF NOT EXISTS credit_balances (
    anon_user_id TEXT PRIMARY KEY,
    available_credits INTEGER NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
    pending_credits INTEGER NOT NULL DEFAULT 0 CHECK(pending_credits >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS credit_ledger_entries (
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
  )`);
  await execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idempotency
    ON credit_ledger_entries (idempotency_scope, idempotency_key)
    WHERE idempotency_scope IS NOT NULL AND idempotency_key IS NOT NULL`);
  await execute(`CREATE TABLE IF NOT EXISTS credit_purchase_transactions (
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
  )`);
}

async function ensureBalanceRow() {
  await execute(
    `INSERT INTO credit_balances (anon_user_id, available_credits, pending_credits)
     VALUES (?, 0, 0)
     ON CONFLICT(anon_user_id) DO NOTHING`,
    [anonUserId],
  );
}

async function grantCredits({ transactionId, productId, credits }) {
  const existing = await execute(
    `SELECT provider_transaction_id FROM credit_purchase_transactions
     WHERE provider = ? AND provider_transaction_id = ?
     LIMIT 1`,
    [provider, transactionId],
  );
  if (existing.rows.length > 0) {
    return { replay: true };
  }

  const nowIso = new Date().toISOString();
  const entryId = `${transactionId}_ledger`;
  const rowId = `${transactionId}_purchase`;
  const results = await client.batch(
    [
      {
        sql: `UPDATE credit_balances
          SET available_credits = available_credits + ?, updated_at = ?
          WHERE anon_user_id = ?
          RETURNING available_credits, pending_credits`,
        args: [credits, nowIso, anonUserId],
      },
      {
        sql: `INSERT INTO credit_ledger_entries (
          entry_id, anon_user_id, event_type, amount, balance_available_after,
          balance_pending_after, reservation_id, idempotency_scope, idempotency_key,
          actor, metadata_json, created_at
        )
        VALUES (
          ?, ?, 'purchase_grant', ?,
          (SELECT available_credits FROM credit_balances WHERE anon_user_id = ?),
          (SELECT pending_credits FROM credit_balances WHERE anon_user_id = ?),
          NULL, 'purchase-credit-grant', ?, 'purchase_verification', ?, ?
        )
        RETURNING balance_available_after, balance_pending_after`,
        args: [
          entryId,
          anonUserId,
          credits,
          anonUserId,
          anonUserId,
          `${provider}:${transactionId}`,
          JSON.stringify({ provider, productId, providerTransactionId: transactionId }),
          nowIso,
        ],
      },
      {
        sql: `INSERT INTO credit_purchase_transactions (
          row_id, provider, provider_transaction_id, provider_original_transaction_id,
          anon_user_id, product_id, status, granted_credits, reversed_credits,
          outstanding_reversal_credits, verified_at, payload_json, risk_flags_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, 0, 0, ?, '{}', '[]', ?, ?)`,
        args: [
          rowId,
          provider,
          transactionId,
          transactionId,
          anonUserId,
          productId,
          credits,
          nowIso,
          nowIso,
          nowIso,
        ],
      },
    ],
    "write",
  );
  return {
    replay: false,
    balanceAfter: Number(results[1].rows[0].balance_available_after),
  };
}

async function reversePurchase({ transactionId, credits }) {
  const nowIso = new Date().toISOString();
  const results = await client.batch(
    [
      {
        sql: `UPDATE credit_balances
          SET available_credits = available_credits - ?, updated_at = ?
          WHERE anon_user_id = ? AND available_credits >= ?
          RETURNING available_credits, pending_credits`,
        args: [credits, nowIso, anonUserId, credits],
      },
      {
        sql: `INSERT INTO credit_ledger_entries (
          entry_id, anon_user_id, event_type, amount, balance_available_after,
          balance_pending_after, reservation_id, idempotency_scope, idempotency_key,
          actor, metadata_json, created_at
        )
        VALUES (
          ?, ?, 'purchase_reversal', ?,
          (SELECT available_credits FROM credit_balances WHERE anon_user_id = ?),
          (SELECT pending_credits FROM credit_balances WHERE anon_user_id = ?),
          NULL, 'provider-reversal', ?, 'provider_reversal', ?, ?
        )`,
        args: [
          `${transactionId}_reversal_ledger`,
          anonUserId,
          -credits,
          anonUserId,
          anonUserId,
          `${provider}:${transactionId}`,
          JSON.stringify({ provider, providerTransactionId: transactionId }),
          nowIso,
        ],
      },
      {
        sql: `UPDATE credit_purchase_transactions
          SET status = 'revoked', reversed_credits = ?, revoked_at = ?, updated_at = ?
          WHERE provider = ? AND provider_transaction_id = ?`,
        args: [credits, nowIso, nowIso, provider, transactionId],
      },
    ],
    "write",
  );
  assert(results[0].rows.length === 1, "reversal did not update balance");
}

async function getBalance() {
  const result = await execute(
    `SELECT available_credits, pending_credits FROM credit_balances WHERE anon_user_id = ?`,
    [anonUserId],
  );
  return {
    available: Number(result.rows[0]?.available_credits ?? 0),
    pending: Number(result.rows[0]?.pending_credits ?? 0),
  };
}

try {
  await assertFuseCostFallbacks();
  await ensureSchema();
  await ensureBalanceRow();

  const firstGrant = await grantCredits({
    transactionId: firstTransactionId,
    productId: "com.flavorfusion.credits.20",
    credits: 20,
  });
  assert(!firstGrant.replay && firstGrant.balanceAfter === 20, "first purchase grant failed");

  const replay = await grantCredits({
    transactionId: firstTransactionId,
    productId: "com.flavorfusion.credits.20",
    credits: 20,
  });
  assert(replay.replay, "duplicate purchase was not treated as replay");
  assert((await getBalance()).available === 20, "duplicate purchase changed balance");

  const secondGrant = await grantCredits({
    transactionId: secondTransactionId,
    productId: "com.flavorfusion.credits.50",
    credits: 50,
  });
  assert(!secondGrant.replay && secondGrant.balanceAfter === 70, "second purchase grant failed");

  await reversePurchase({ transactionId: firstTransactionId, credits: 20 });
  const finalBalance = await getBalance();
  assert(finalBalance.available === 50, "reversal balance mismatch");
  assert(finalBalance.pending === 0, "pending balance mismatch");

  console.log(
    JSON.stringify(
      {
        ok: true,
        database: usingRemote ? "remote-turso" : "local-libsql",
        anonUserId,
        checks: [
          "schema",
          "fuse_cost_fallbacks_3",
          "purchase_grant_20",
          "duplicate_purchase_replay",
          "purchase_grant_50",
          "purchase_reversal_20",
          "final_balance",
        ],
        finalBalance,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
