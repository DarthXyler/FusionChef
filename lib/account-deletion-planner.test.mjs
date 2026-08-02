import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "@libsql/client";
import { buildAccountDeletionGraphCleanupStatements } from "./account-deletion-execution.ts";
import { fingerprintAccountDeletionPlan } from "./account-deletion-jobs.ts";
import { planAccountDeletion as planAccountDeletionWithSecret } from "./account-deletion-planner.ts";
import { createAccountDeletionPseudonym } from "./purchase-settlement-retention.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const ALIAS = "22222222-2222-4222-8222-222222222222";
const DEEP_ALIAS = "33333333-3333-4333-8333-333333333333";
const OTHER_ROOT = "44444444-4444-4444-8444-444444444444";
const SECRET = "planner-fixture-secret-that-is-at-least-32-bytes";

function planAccountDeletion(options) {
  return planAccountDeletionWithSecret({
    ...options,
    secret: SECRET,
    publicBaseUrl: "https://r2.example.test",
  });
}

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE auth_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE auth_identity_links (
    auth_user_id TEXT PRIMARY KEY,
    canonical_anon_user_id TEXT NOT NULL
  );
  CREATE TABLE mobile_identity_aliases (
    anon_user_id TEXT PRIMARY KEY,
    canonical_anon_user_id TEXT NOT NULL
  );
  CREATE TABLE mobile_identity_links (
    device_key TEXT PRIMARY KEY,
    canonical_anon_user_id TEXT NOT NULL
  );
  CREATE TABLE cookbook_recipes (
    row_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE product_activity_events (
    event_id TEXT PRIMARY KEY,
    auth_user_id TEXT NOT NULL
  );
  CREATE TABLE credit_balances (
    anon_user_id TEXT PRIMARY KEY,
    available_credits INTEGER NOT NULL,
    pending_credits INTEGER NOT NULL
  );
  CREATE TABLE credit_reservations (
    reservation_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    expires_at TEXT
  );
  CREATE TABLE credit_daily_usage (
    anon_user_id TEXT NOT NULL,
    day_key TEXT NOT NULL
  );
  CREATE TABLE credit_ledger_entries (
    entry_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reservation_id TEXT,
    actor TEXT NOT NULL DEFAULT 'fixture',
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE credit_purchase_transactions (
    row_id TEXT PRIMARY KEY,
    anon_user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE credit_purchase_ledger_links (
    id TEXT PRIMARY KEY,
    purchase_transaction_id TEXT NOT NULL,
    ledger_entry_id TEXT NOT NULL,
    link_kind TEXT NOT NULL
  );
  CREATE TABLE purchase_reconciliation_actions (
    id TEXT PRIMARY KEY,
    purchase_transaction_id TEXT,
    ledger_entry_id TEXT,
    metadata_json TEXT
  );
  CREATE TABLE account_deletion_events (
    deletion_id TEXT PRIMARY KEY,
    auth_user_id TEXT,
    canonical_anon_user_id TEXT
  );
`;

async function createFixture() {
  const client = createClient({ url: "file::memory:" });
  await client.executeMultiple(schema);
  return client;
}

async function seedRecursiveGraph(client) {
  await client.executeMultiple(`
    INSERT INTO auth_users (id, email) VALUES ('auth-a', 'a@example.test');
    INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id)
      VALUES ('auth-a', '${ROOT}');
    INSERT INTO mobile_identity_aliases (anon_user_id, canonical_anon_user_id) VALUES
      ('${ALIAS}', '${ROOT}'),
      ('${DEEP_ALIAS}', '${ALIAS}');
    INSERT INTO mobile_identity_links (device_key, canonical_anon_user_id)
      VALUES ('device-deep', '${DEEP_ALIAS}');
    INSERT INTO cookbook_recipes (row_id, anon_user_id)
      VALUES ('recipe-deep', '${DEEP_ALIAS}');
    INSERT INTO product_activity_events (event_id, auth_user_id)
      VALUES ('activity-a', 'auth-a');
    INSERT INTO credit_balances (anon_user_id, available_credits, pending_credits)
      VALUES ('${ALIAS}', 2, 0);
    INSERT INTO credit_reservations (reservation_id, anon_user_id, status, expires_at) VALUES
      ('reservation-active', '${DEEP_ALIAS}', 'reserved', '2999-01-01T00:00:00.000Z'),
      ('reservation-expired', '${ALIAS}', 'released', '2000-01-01T00:00:00.000Z');
    INSERT INTO credit_daily_usage (anon_user_id, day_key)
      VALUES ('${DEEP_ALIAS}', '2026-08-02');
    INSERT INTO credit_ledger_entries (entry_id, anon_user_id, event_type, amount)
      VALUES ('ledger-deep', '${DEEP_ALIAS}', 'purchase', 10);
    INSERT INTO credit_purchase_transactions (row_id, anon_user_id, payload_json)
      VALUES ('purchase-deep', '${ALIAS}', '{"private":"remove"}');
    INSERT INTO credit_purchase_ledger_links (
      id, purchase_transaction_id, ledger_entry_id, link_kind
    ) VALUES ('link-deep', 'purchase-deep', 'ledger-deep', 'base_grant');
    INSERT INTO purchase_reconciliation_actions (
      id, purchase_transaction_id, ledger_entry_id, metadata_json
    ) VALUES ('action-deep', 'purchase-deep', 'ledger-deep', '{"private":"remove"}');
  `);
}

test("normal linked user resolves recursive aliases and every graph-owned table", async () => {
  const client = await createFixture();
  try {
    await seedRecursiveGraph(client);
    const plan = await planAccountDeletion({ authUserIds: ["auth-a"], client });
    assert.equal(plan.graphs.length, 1);
    const [graph] = plan.graphs;
    assert.equal(graph.status, "ready");
    assert.deepEqual(graph.identityNodes, [ROOT, ALIAS, DEEP_ALIAS].sort());
    assert.deepEqual(graph.deviceKeys, ["device-deep"]);
    assert.deepEqual(graph.inventory, {
      authUsers: 1,
      identityLinks: 1,
      mobileDeviceLinks: 1,
      mobileAliases: 2,
      cookbookRecipes: 1,
      productActivityEvents: 1,
      creditBalanceRows: 1,
      creditReservations: 2,
      creditReservationAmount: 2,
      activeCreditReservations: 1,
      activeCreditReservationAmount: 1,
      expiredCreditReservations: 0,
      expiredCreditReservationAmount: 0,
      finalizedCreditReservations: 1,
      finalizedCreditReservationAmount: 1,
      malformedCreditReservations: 0,
      malformedCreditReservationAmount: 0,
      creditLedgerEntries: 1,
      financialLedgerEntriesRetained: 1,
      operationalLedgerEntriesDeleted: 0,
      dailyUsageRows: 1,
      purchaseTransactionsPreserved: 1,
      purchaseLedgerLinks: 1,
      reconciliationActions: 1,
      priorDeletionEvents: 0,
    });
  } finally {
    client.close();
  }
});

test("reservation lifecycle categories are exclusive at one exact server snapshot", async () => {
  const client = await createFixture();
  try {
    await seedRecursiveGraph(client);
    await client.execute("DELETE FROM credit_reservations");
    await client.executeMultiple(`
      INSERT INTO credit_reservations VALUES
        ('future-active', '${ROOT}', 1, 'reserved', '2026-08-02T12:00:00.001Z'),
        ('exact-boundary', '${ROOT}', 2, 'reserved', '2026-08-02T12:00:00.000Z'),
        ('past-expired', '${ALIAS}', 3, 'reserved', '2026-08-02T11:59:59.999Z'),
        ('committed-finalized', '${ROOT}', 4, 'committed', NULL),
        ('released-finalized', '${ALIAS}', 5, 'released', 'invalid-but-finalized'),
        ('null-malformed', '${ROOT}', 6, 'reserved', NULL),
        ('invalid-malformed', '${ALIAS}', 7, 'reserved', 'not-a-timestamp');
    `);
    const plan = await planAccountDeletion({
      authUserIds: ["auth-a"],
      client,
      snapshot: new Date("2026-08-02T12:00:00.000Z"),
    });
    const inventory = plan.graphs[0].inventory;
    assert.deepEqual(
      {
        total: inventory.creditReservations,
        totalAmount: inventory.creditReservationAmount,
        active: inventory.activeCreditReservations,
        activeAmount: inventory.activeCreditReservationAmount,
        expired: inventory.expiredCreditReservations,
        expiredAmount: inventory.expiredCreditReservationAmount,
        finalized: inventory.finalizedCreditReservations,
        finalizedAmount: inventory.finalizedCreditReservationAmount,
        malformed: inventory.malformedCreditReservations,
        malformedAmount: inventory.malformedCreditReservationAmount,
      },
      {
        total: 7,
        totalAmount: 28,
        active: 1,
        activeAmount: 1,
        expired: 2,
        expiredAmount: 5,
        finalized: 2,
        finalizedAmount: 9,
        malformed: 2,
        malformedAmount: 13,
      },
    );
    assert.equal(
      inventory.activeCreditReservations +
        inventory.expiredCreditReservations +
        inventory.finalizedCreditReservations +
        inventory.malformedCreditReservations,
      inventory.creditReservations,
    );
    const crossedBoundaryPlan = await planAccountDeletion({
      authUserIds: ["auth-a"],
      client,
      snapshot: new Date("2026-08-02T12:00:00.001Z"),
    });
    assert.equal(crossedBoundaryPlan.graphs[0].inventory.activeCreditReservations, 0);
    assert.equal(crossedBoundaryPlan.graphs[0].inventory.expiredCreditReservations, 3);
    assert.notEqual(
      fingerprintAccountDeletionPlan({
        plan,
        reason: "reservation lifecycle preview",
        secret: SECRET,
      }),
      fingerprintAccountDeletionPlan({
        plan: crossedBoundaryPlan,
        reason: "reservation lifecycle preview",
        secret: SECRET,
      }),
    );
  } finally {
    client.close();
  }
});

test("unlinked user produces an auth-only graph", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email, avatar_url)
        VALUES ('auth-only', 'only@example.test', 'https://cdn.example/avatar.png');
      INSERT INTO product_activity_events (event_id, auth_user_id)
        VALUES ('auth-only-event', 'auth-only');
    `);
    const plan = await planAccountDeletion({ authUserIds: ["auth-only"], client });
    const [graph] = plan.graphs;
    assert.equal(graph.status, "ready");
    assert.deepEqual(graph.identityNodes, []);
    assert.equal(graph.inventory.authUsers, 1);
    assert.equal(graph.inventory.productActivityEvents, 1);
    assert.equal(graph.inventory.creditBalanceRows, 0);
    assert.equal(graph.inventory.cookbookRecipes, 0);
    await client.batch(
      buildAccountDeletionGraphCleanupStatements({
        graph,
        deletedPurchaseOwner: createAccountDeletionPseudonym({
          authUserIds: graph.ownerAuthUserIds,
          identityNodes: graph.identityNodes,
          secret: "test-secret-that-is-at-least-thirty-two-bytes",
        }),
      }),
      "write",
    );
    const authRows = await client.execute(
      "SELECT COUNT(*) AS count FROM auth_users",
    );
    const activityRows = await client.execute(
      "SELECT COUNT(*) AS count FROM product_activity_events",
    );
    assert.equal(Number(authRows.rows[0].count), 0);
    assert.equal(Number(activityRows.rows[0].count), 0);
  } finally {
    client.close();
  }
});

test("partially selected shared graph is blocked without altering it", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES
        ('auth-a', 'a@example.test'),
        ('auth-b', 'b@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id) VALUES
        ('auth-a', '${ROOT}'),
        ('auth-b', '${ROOT}');
    `);
    const plan = await planAccountDeletion({ authUserIds: ["auth-a"], client });
    const [graph] = plan.graphs;
    assert.equal(graph.status, "manual_review");
    assert.deepEqual(graph.unselectedOwnerAuthUserIds, ["auth-b"]);
    assert.ok(graph.blockers.includes("unselected_authenticated_owner"));
    const owners = await client.execute("SELECT id FROM auth_users ORDER BY id");
    assert.deepEqual(owners.rows.map((row) => row.id), ["auth-a", "auth-b"]);
  } finally {
    client.close();
  }
});

test("fully selected normal shared graph is ready once", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES
        ('auth-a', 'a@example.test'),
        ('auth-b', 'b@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id) VALUES
        ('auth-a', '${ROOT}'),
        ('auth-b', '${ROOT}');
    `);
    const plan = await planAccountDeletion({
      authUserIds: ["auth-a", "auth-b"],
      client,
    });
    assert.equal(plan.graphs.length, 1);
    assert.equal(plan.graphs[0].status, "ready");
    assert.deepEqual(plan.graphs[0].ownerAuthUserIds, ["auth-a", "auth-b"]);
  } finally {
    client.close();
  }
});

test("canonical self-alias remains inventoried and cleanable without blocking deletion", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES ('auth-a', 'a@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id)
        VALUES ('auth-a', '${ROOT}');
      INSERT INTO mobile_identity_aliases (anon_user_id, canonical_anon_user_id)
        VALUES ('${ROOT}', '${ROOT}');
    `);
    const plan = await planAccountDeletion({ authUserIds: ["auth-a"], client });
    const [graph] = plan.graphs;
    assert.equal(graph.status, "ready");
    assert.deepEqual(graph.blockers, []);
    assert.deepEqual(graph.identityNodes, [ROOT]);
    assert.deepEqual(graph.aliasEdges, [
      { anonUserId: ROOT, canonicalAnonUserId: ROOT },
    ]);
    assert.equal(graph.inventory.mobileAliases, 1);

    await client.batch(
      buildAccountDeletionGraphCleanupStatements({
        graph,
        deletedPurchaseOwner: createAccountDeletionPseudonym({
          authUserIds: graph.ownerAuthUserIds,
          identityNodes: graph.identityNodes,
          secret: "test-secret-that-is-at-least-thirty-two-bytes",
        }),
      }),
      "write",
    );
    assert.equal(
      Number(
        (await client.execute("SELECT COUNT(*) AS count FROM mobile_identity_aliases"))
          .rows[0].count,
      ),
      0,
    );
  } finally {
    client.close();
  }
});

test("conflicting roots and alias cycles require manual review", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES
        ('auth-a', 'a@example.test'),
        ('auth-b', 'b@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id) VALUES
        ('auth-a', '${ROOT}'),
        ('auth-b', '${OTHER_ROOT}');
      INSERT INTO mobile_identity_aliases (anon_user_id, canonical_anon_user_id) VALUES
        ('${ROOT}', '${OTHER_ROOT}'),
        ('${OTHER_ROOT}', '${ROOT}');
    `);
    const plan = await planAccountDeletion({
      authUserIds: ["auth-a", "auth-b"],
      client,
    });
    const [graph] = plan.graphs;
    assert.equal(graph.status, "manual_review");
    assert.ok(graph.blockers.includes("conflicting_authenticated_owners"));
    assert.ok(graph.blockers.includes("canonical_is_alias"));
    assert.ok(graph.blockers.includes("alias_cycle"));
  } finally {
    client.close();
  }
});

test("long non-self alias cycle remains blocked", async () => {
  const client = await createFixture();
  try {
    await client.executeMultiple(`
      INSERT INTO auth_users (id, email) VALUES ('auth-a', 'a@example.test');
      INSERT INTO auth_identity_links (auth_user_id, canonical_anon_user_id)
        VALUES ('auth-a', '${ROOT}');
      INSERT INTO mobile_identity_aliases (anon_user_id, canonical_anon_user_id) VALUES
        ('${ROOT}', '${ALIAS}'),
        ('${ALIAS}', '${DEEP_ALIAS}'),
        ('${DEEP_ALIAS}', '${ROOT}');
    `);
    const plan = await planAccountDeletion({ authUserIds: ["auth-a"], client });
    const [graph] = plan.graphs;
    assert.equal(graph.status, "manual_review");
    assert.ok(graph.blockers.includes("canonical_is_alias"));
    assert.ok(graph.blockers.includes("alias_cycle"));
  } finally {
    client.close();
  }
});

test("graph cleanup leaves no product remnants on aliases or canonical", async () => {
  const client = await createFixture();
  try {
    await seedRecursiveGraph(client);
    const plan = await planAccountDeletion({ authUserIds: ["auth-a"], client });
    const [graph] = plan.graphs;
    const deletedOwner = createAccountDeletionPseudonym({
      authUserIds: graph.ownerAuthUserIds,
      identityNodes: graph.identityNodes,
      secret: "test-secret-that-is-at-least-thirty-two-bytes",
    });
    await client.batch(
      buildAccountDeletionGraphCleanupStatements({
        graph,
        deletedPurchaseOwner: deletedOwner,
      }),
      "write",
    );
    for (const table of [
      "auth_users",
      "auth_identity_links",
      "mobile_identity_aliases",
      "mobile_identity_links",
      "cookbook_recipes",
      "product_activity_events",
      "credit_balances",
      "credit_reservations",
      "credit_daily_usage",
    ]) {
      const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
      assert.equal(Number(result.rows[0].count), 0, table);
    }
    const purchase = await client.execute(
      "SELECT anon_user_id, payload_json FROM credit_purchase_transactions",
    );
    assert.equal(purchase.rows[0].anon_user_id, deletedOwner);
    assert.equal(purchase.rows[0].payload_json, "{}");
    const ledger = await client.execute(
      "SELECT anon_user_id, actor, metadata_json FROM credit_ledger_entries",
    );
    assert.equal(ledger.rows[0].anon_user_id, deletedOwner);
    assert.equal(ledger.rows[0].actor, "account_deletion_retained_financial");
    assert.match(String(ledger.rows[0].metadata_json), /redacted_for_account_deletion/);
  } finally {
    client.close();
  }
});
