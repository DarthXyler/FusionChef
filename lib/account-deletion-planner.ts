import { createHash, createHmac } from "crypto";
import type { Client } from "@libsql/client";
import { resolveAccountDeletionStorageReference } from "./account-deletion-storage.ts";
import { getTursoClient } from "./turso.ts";

type PlanningClient = Pick<Client, "execute">;

const QUERY_CHUNK_SIZE = 250;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AccountDeletionBlocker =
  | "unselected_authenticated_owner"
  | "conflicting_authenticated_owners"
  | "canonical_is_alias"
  | "alias_cycle"
  | "conflicting_financial_ownership"
  | "invalid_identity";

export type AccountDeletionInventory = {
  authUsers: number;
  identityLinks: number;
  mobileDeviceLinks: number;
  mobileAliases: number;
  cookbookRecipes: number;
  productActivityEvents: number;
  creditBalanceRows: number;
  creditReservations: number;
  activeCreditReservations: number;
  expiredCreditReservations: number;
  creditLedgerEntries: number;
  financialLedgerEntriesRetained: number;
  operationalLedgerEntriesDeleted: number;
  dailyUsageRows: number;
  purchaseTransactionsPreserved: number;
  purchaseLedgerLinks: number;
  reconciliationActions: number;
  priorDeletionEvents: number;
};

export type AccountDeletionAliasEdge = {
  anonUserId: string;
  canonicalAnonUserId: string;
};

export type AccountDeletionStorageReference = {
  category: "cookbook_image" | "profile_avatar";
  value: string;
};

export type AccountDeletionGraphPlan = {
  graphId: string;
  status: "ready" | "manual_review";
  blockers: AccountDeletionBlocker[];
  selectedAuthUserIds: string[];
  ownerAuthUserIds: string[];
  unselectedOwnerAuthUserIds: string[];
  identityNodes: string[];
  canonicalIdentityIds: string[];
  aliasEdges: AccountDeletionAliasEdge[];
  deviceKeys: string[];
  storageReferences: AccountDeletionStorageReference[];
  mutableFactDigests: AccountDeletionMutableFactDigests;
  inventory: AccountDeletionInventory;
};

export type AccountDeletionMutableFactDigests = {
  authAndProfile: string;
  identityGraph: string;
  purchases: string;
  purchaseLinksAndAudit: string;
  ledger: string;
  reservations: string;
  balancesAndUsage: string;
  cookbookAndActivity: string;
  storageReferences: string;
};

export type AccountDeletionPlan = {
  selectedAuthUserIds: string[];
  missingAuthUserIds: string[];
  graphs: AccountDeletionGraphPlan[];
  targetGraphIds: Record<string, string>;
};

type AuthLink = { authUserId: string; canonicalAnonUserId: string };

export class AccountDeletionPlanningError extends Error {
  code = "account_deletion_job_unavailable";
  statusCode = 503;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function chunks<T>(values: T[], size = QUERY_CHUNK_SIZE) {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function sortedUnique(values: Iterable<string>) {
  return [...new Set(values)].filter(Boolean).sort();
}

function getFactDigestSecret(explicitSecret?: string) {
  const secret =
    explicitSecret?.trim() ||
    process.env.ACCOUNT_DELETION_JOB_SECRET?.trim() ||
    process.env.ACCOUNT_DELETION_PSEUDONYM_SECRET?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    "";
  if (secret.length < 32) {
    throw new AccountDeletionPlanningError(
      "Account deletion fact verification is unavailable.",
    );
  }
  return secret;
}

function canonicalizeFact(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeFact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeFact(child)]),
    );
  }
  return value;
}

function stableFactRows(rows: Array<Record<string, unknown>>) {
  return rows
    .map((row) => JSON.stringify(canonicalizeFact(row)))
    .sort();
}

function digestFacts(kind: string, facts: unknown, secret: string) {
  return `${kind}:v1:${createHmac("sha256", secret)
    .update(`flavor-fusion-chef:account-deletion-facts:${kind}:v1\u0000`)
    .update(JSON.stringify(canonicalizeFact(facts)))
    .digest("hex")}`;
}

async function readFactRows(
  client: PlanningClient,
  sql: string,
  args: string[],
) {
  const result = await client.execute({ sql, args });
  return result.rows.map((row) => ({ ...row } as Record<string, unknown>));
}

function graphIdFor(authUserIds: string[], identityNodes: string[]) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ authUserIds, identityNodes }))
    .digest("hex")
    .slice(0, 24);
  return `account-graph:${digest}`;
}

function emptyInventory(): AccountDeletionInventory {
  return {
    authUsers: 0,
    identityLinks: 0,
    mobileDeviceLinks: 0,
    mobileAliases: 0,
    cookbookRecipes: 0,
    productActivityEvents: 0,
    creditBalanceRows: 0,
    creditReservations: 0,
    activeCreditReservations: 0,
    expiredCreditReservations: 0,
    creditLedgerEntries: 0,
    financialLedgerEntriesRetained: 0,
    operationalLedgerEntriesDeleted: 0,
    dailyUsageRows: 0,
    purchaseTransactionsPreserved: 0,
    purchaseLedgerLinks: 0,
    reconciliationActions: 0,
    priorDeletionEvents: 0,
  };
}

async function readExistingAuthUserIds(
  client: PlanningClient,
  authUserIds: string[],
) {
  const found = new Set<string>();
  for (const part of chunks(authUserIds)) {
    const result = await client.execute({
      sql: `SELECT id FROM auth_users WHERE id IN (${placeholders(part)})`,
      args: part,
    });
    result.rows.forEach((row) => found.add(asString(row.id)));
  }
  return found;
}

async function readAuthLinks(
  client: PlanningClient,
  authUserIds: string[],
) {
  const links: AuthLink[] = [];
  for (const part of chunks(authUserIds)) {
    const result = await client.execute({
      sql: `SELECT auth_user_id, canonical_anon_user_id
            FROM auth_identity_links
            WHERE auth_user_id IN (${placeholders(part)})`,
      args: part,
    });
    result.rows.forEach((row) => {
      links.push({
        authUserId: asString(row.auth_user_id),
        canonicalAnonUserId: asString(row.canonical_anon_user_id),
      });
    });
  }
  return links;
}

async function readIdentityClosure(client: PlanningClient, root: string) {
  const result = await client.execute({
    sql: `WITH RECURSIVE identity_graph(node) AS (
            VALUES (?)
            UNION
            SELECT aliases.anon_user_id
            FROM mobile_identity_aliases aliases
            JOIN identity_graph graph
              ON aliases.canonical_anon_user_id = graph.node
            UNION
            SELECT aliases.canonical_anon_user_id
            FROM mobile_identity_aliases aliases
            JOIN identity_graph graph
              ON aliases.anon_user_id = graph.node
          )
          SELECT node FROM identity_graph`,
    args: [root],
  });
  return new Set(result.rows.map((row) => asString(row.node)).filter(Boolean));
}

function setsIntersect(left: Set<string>, right: Set<string>) {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

async function readOwnersForNodes(
  client: PlanningClient,
  identityNodes: string[],
) {
  const links: AuthLink[] = [];
  for (const part of chunks(identityNodes)) {
    const result = await client.execute({
      sql: `SELECT links.auth_user_id, links.canonical_anon_user_id
            FROM auth_identity_links links
            JOIN auth_users users ON users.id = links.auth_user_id
            WHERE links.canonical_anon_user_id IN (${placeholders(part)})`,
      args: part,
    });
    result.rows.forEach((row) => {
      links.push({
        authUserId: asString(row.auth_user_id),
        canonicalAnonUserId: asString(row.canonical_anon_user_id),
      });
    });
  }
  return links;
}

async function readAliasEdges(
  client: PlanningClient,
  identityNodes: string[],
) {
  const edges = new Map<string, AccountDeletionAliasEdge>();
  for (const part of chunks(identityNodes)) {
    const result = await client.execute({
      sql: `SELECT anon_user_id, canonical_anon_user_id
            FROM mobile_identity_aliases
            WHERE anon_user_id IN (${placeholders(part)})
               OR canonical_anon_user_id IN (${placeholders(part)})`,
      args: [...part, ...part],
    });
    result.rows.forEach((row) => {
      const edge = {
        anonUserId: asString(row.anon_user_id),
        canonicalAnonUserId: asString(row.canonical_anon_user_id),
      };
      edges.set(`${edge.anonUserId}\u0000${edge.canonicalAnonUserId}`, edge);
    });
  }
  return [...edges.values()].sort((left, right) =>
    left.anonUserId.localeCompare(right.anonUserId),
  );
}

async function readDeviceKeys(
  client: PlanningClient,
  identityNodes: string[],
) {
  const keys = new Set<string>();
  for (const part of chunks(identityNodes)) {
    const result = await client.execute({
      sql: `SELECT device_key
            FROM mobile_identity_links
            WHERE canonical_anon_user_id IN (${placeholders(part)})`,
      args: part,
    });
    result.rows.forEach((row) => keys.add(asString(row.device_key)));
  }
  return sortedUnique(keys);
}

async function readStorageReferences(
  client: PlanningClient,
  authUserIds: string[],
  identityNodes: string[],
) {
  const references = new Map<string, AccountDeletionStorageReference>();
  for (const part of chunks(authUserIds)) {
    const result = await client.execute({
      sql: `SELECT avatar_url
            FROM auth_users
            WHERE id IN (${placeholders(part)})
              AND avatar_url IS NOT NULL
              AND trim(avatar_url) <> ''`,
      args: part,
    });
    result.rows.forEach((row) => {
      const value = asString(row.avatar_url);
      if (value) {
        references.set(`profile_avatar\u0000${value}`, {
          category: "profile_avatar",
          value,
        });
      }
    });
  }
  for (const part of chunks(identityNodes)) {
    const result = await client.execute({
      sql: `SELECT image_url
            FROM cookbook_recipes
            WHERE anon_user_id IN (${placeholders(part)})
              AND image_url IS NOT NULL
              AND trim(image_url) <> ''`,
      args: part,
    });
    result.rows.forEach((row) => {
      const value = asString(row.image_url);
      if (value) {
        references.set(`cookbook_image\u0000${value}`, {
          category: "cookbook_image",
          value,
        });
      }
    });
  }
  return [...references.values()].sort((left, right) =>
    `${left.category}:${left.value}`.localeCompare(`${right.category}:${right.value}`),
  );
}

async function readMutableFactDigests(options: {
  client: PlanningClient;
  authUserIds: string[];
  identityNodes: string[];
  storageReferences: AccountDeletionStorageReference[];
  secret: string;
  publicBaseUrl: string;
}): Promise<AccountDeletionMutableFactDigests> {
  const authCte = valueCte("graph_auth_users", options.authUserIds);
  const nodeCte = valueCte("graph_nodes", options.identityNodes);
  const authArgs = options.authUserIds;
  const nodeArgs = options.identityNodes;
  const [
    authRows,
    authLinkRows,
    aliasRows,
    deviceRows,
    purchaseRows,
    purchaseLinkRows,
    reconciliationRows,
    ledgerRows,
    reservationRows,
    balanceRows,
    usageRows,
    cookbookRows,
    activityRows,
    priorDeletionRows,
  ] = await Promise.all([
    readFactRows(
      options.client,
      `WITH ${authCte}
       SELECT * FROM auth_users
       WHERE id IN (SELECT value FROM graph_auth_users)`,
      authArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${authCte}, ${nodeCte}
       SELECT * FROM auth_identity_links
       WHERE auth_user_id IN (SELECT value FROM graph_auth_users)
          OR canonical_anon_user_id IN (SELECT value FROM graph_nodes)`,
      [...authArgs, ...nodeArgs],
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM mobile_identity_aliases
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)
          OR canonical_anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM mobile_identity_links
       WHERE canonical_anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM credit_purchase_transactions
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT links.*
       FROM credit_purchase_ledger_links links
       WHERE links.purchase_transaction_id IN (
         SELECT row_id FROM credit_purchase_transactions
         WHERE anon_user_id IN (SELECT value FROM graph_nodes)
       ) OR links.ledger_entry_id IN (
         SELECT entry_id FROM credit_ledger_entries
         WHERE anon_user_id IN (SELECT value FROM graph_nodes)
       )`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT actions.*
       FROM purchase_reconciliation_actions actions
       WHERE actions.purchase_transaction_id IN (
         SELECT row_id FROM credit_purchase_transactions
         WHERE anon_user_id IN (SELECT value FROM graph_nodes)
       ) OR actions.ledger_entry_id IN (
         SELECT entry_id FROM credit_ledger_entries
         WHERE anon_user_id IN (SELECT value FROM graph_nodes)
       )`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM credit_ledger_entries
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM credit_reservations
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM credit_balances
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM credit_daily_usage
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${nodeCte}
       SELECT * FROM cookbook_recipes
       WHERE anon_user_id IN (SELECT value FROM graph_nodes)`,
      nodeArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${authCte}
       SELECT * FROM product_activity_events
       WHERE auth_user_id IN (SELECT value FROM graph_auth_users)`,
      authArgs,
    ),
    readFactRows(
      options.client,
      `WITH ${authCte}, ${nodeCte}
       SELECT * FROM account_deletion_events
       WHERE auth_user_id IN (SELECT value FROM graph_auth_users)
          OR canonical_anon_user_id IN (SELECT value FROM graph_nodes)`,
      [...authArgs, ...nodeArgs],
    ),
  ]);

  return {
    authAndProfile: digestFacts(
      "auth-profile",
      stableFactRows(authRows),
      options.secret,
    ),
    identityGraph: digestFacts(
      "identity-graph",
      {
        authLinks: stableFactRows(authLinkRows),
        aliases: stableFactRows(aliasRows),
        devices: stableFactRows(deviceRows),
        nodes: [...options.identityNodes].sort(),
        owners: [...options.authUserIds].sort(),
      },
      options.secret,
    ),
    purchases: digestFacts(
      "purchases",
      stableFactRows(purchaseRows),
      options.secret,
    ),
    purchaseLinksAndAudit: digestFacts(
      "purchase-links-audit",
      {
        links: stableFactRows(purchaseLinkRows),
        reconciliation: stableFactRows(reconciliationRows),
        priorDeletionEvents: stableFactRows(priorDeletionRows),
      },
      options.secret,
    ),
    ledger: digestFacts(
      "ledger",
      stableFactRows(ledgerRows),
      options.secret,
    ),
    reservations: digestFacts(
      "reservations",
      stableFactRows(reservationRows),
      options.secret,
    ),
    balancesAndUsage: digestFacts(
      "balances-usage",
      {
        balances: stableFactRows(balanceRows),
        usage: stableFactRows(usageRows),
      },
      options.secret,
    ),
    cookbookAndActivity: digestFacts(
      "cookbook-activity",
      {
        cookbook: stableFactRows(cookbookRows),
        activity: stableFactRows(activityRows),
      },
      options.secret,
    ),
    storageReferences: digestFacts(
      "storage-references",
      options.storageReferences
        .map((reference) =>
          resolveAccountDeletionStorageReference({
            reference,
            publicBaseUrl: options.publicBaseUrl,
          }),
        )
        .filter((reference) => reference !== null)
        .map((reference) => ({
          source: reference.source,
          category: reference.category,
          key: reference.key,
        }))
        .sort((left, right) =>
          `${left.source}:${left.category}:${left.key}`.localeCompare(
            `${right.source}:${right.category}:${right.key}`,
          ),
        ),
      options.secret,
    ),
  };
}

async function hasConflictingFinancialOwnership(
  client: PlanningClient,
  identityNodes: string[],
) {
  if (identityNodes.length === 0) {
    return false;
  }
  const result = await client.execute({
    sql: `WITH ${valueCte("graph_nodes", identityNodes)}
          SELECT EXISTS (
            SELECT 1
            FROM credit_purchase_ledger_links links
            JOIN credit_purchase_transactions purchase
              ON purchase.row_id = links.purchase_transaction_id
            JOIN credit_ledger_entries ledger
              ON ledger.entry_id = links.ledger_entry_id
            WHERE (
              purchase.anon_user_id IN (SELECT value FROM graph_nodes)
              AND ledger.anon_user_id NOT IN (SELECT value FROM graph_nodes)
            ) OR (
              ledger.anon_user_id IN (SELECT value FROM graph_nodes)
              AND purchase.anon_user_id NOT IN (SELECT value FROM graph_nodes)
            )
            UNION ALL
            SELECT 1
            FROM purchase_reconciliation_actions actions
            JOIN credit_purchase_transactions purchase
              ON purchase.row_id = actions.purchase_transaction_id
            JOIN credit_ledger_entries ledger
              ON ledger.entry_id = actions.ledger_entry_id
            WHERE (
              purchase.anon_user_id IN (SELECT value FROM graph_nodes)
              AND ledger.anon_user_id NOT IN (SELECT value FROM graph_nodes)
            ) OR (
              ledger.anon_user_id IN (SELECT value FROM graph_nodes)
              AND purchase.anon_user_id NOT IN (SELECT value FROM graph_nodes)
            )
          ) AS has_conflict`,
    args: identityNodes,
  });
  return asCount(result.rows[0]?.has_conflict) === 1;
}

function hasAliasCycle(edges: AccountDeletionAliasEdge[]) {
  const nextByNode = new Map(
    edges
      .filter(
        (edge) =>
          edge.anonUserId &&
          edge.canonicalAnonUserId &&
          edge.anonUserId !== edge.canonicalAnonUserId,
      )
      .map((edge) => [edge.anonUserId, edge.canonicalAnonUserId]),
  );
  for (const start of nextByNode.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current && nextByNode.has(current)) {
      if (visited.has(current)) {
        return true;
      }
      visited.add(current);
      current = nextByNode.get(current);
    }
  }
  return false;
}

function valueCte(name: string, values: string[]) {
  if (values.length === 0) {
    return `${name}(value) AS (SELECT NULL WHERE 0)`;
  }
  return `${name}(value) AS (VALUES ${values.map(() => "(?)").join(", ")})`;
}

async function readInventory(
  client: PlanningClient,
  authUserIds: string[],
  identityNodes: string[],
) {
  if (authUserIds.length === 0) {
    return emptyInventory();
  }
  const result = await client.execute({
    sql: `WITH
            ${valueCte("graph_auth_users", authUserIds)},
            ${valueCte("graph_nodes", identityNodes)}
          SELECT
            (SELECT COUNT(*) FROM auth_users WHERE id IN (SELECT value FROM graph_auth_users)) AS auth_users,
            (SELECT COUNT(*) FROM auth_identity_links
              WHERE auth_user_id IN (SELECT value FROM graph_auth_users)
                 OR canonical_anon_user_id IN (SELECT value FROM graph_nodes)) AS identity_links,
            (SELECT COUNT(*) FROM mobile_identity_links
              WHERE canonical_anon_user_id IN (SELECT value FROM graph_nodes)) AS mobile_device_links,
            (SELECT COUNT(*) FROM mobile_identity_aliases
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)
                 OR canonical_anon_user_id IN (SELECT value FROM graph_nodes)) AS mobile_aliases,
            (SELECT COUNT(*) FROM cookbook_recipes
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)) AS cookbook_recipes,
            (SELECT COUNT(*) FROM product_activity_events
              WHERE auth_user_id IN (SELECT value FROM graph_auth_users)) AS product_activity_events,
            (SELECT COUNT(*) FROM credit_balances
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)) AS credit_balance_rows,
            (SELECT COUNT(*) FROM credit_reservations
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)) AS credit_reservations,
            (SELECT COUNT(*) FROM credit_reservations
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)
                AND status = 'reserved'
                AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS active_credit_reservations,
            (SELECT COUNT(*) FROM credit_reservations
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)
                AND (status <> 'reserved'
                  OR expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AS expired_credit_reservations,
            (SELECT COUNT(*) FROM credit_ledger_entries
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)) AS credit_ledger_entries,
            (SELECT COUNT(*) FROM credit_ledger_entries ledger
              WHERE ledger.anon_user_id IN (SELECT value FROM graph_nodes)
                AND (
                  ledger.event_type IN (
                    'purchase_grant',
                    'purchase_adjustment',
                    'purchase_reversal'
                  )
                  OR ledger.entry_id IN (
                    SELECT links.ledger_entry_id
                    FROM credit_purchase_ledger_links links
                    JOIN credit_purchase_transactions purchase
                      ON purchase.row_id = links.purchase_transaction_id
                    WHERE purchase.anon_user_id IN (SELECT value FROM graph_nodes)
                  )
                )) AS financial_ledger_entries_retained,
            (SELECT COUNT(*) FROM credit_ledger_entries ledger
              WHERE ledger.anon_user_id IN (SELECT value FROM graph_nodes)
                AND ledger.event_type NOT IN (
                  'purchase_grant',
                  'purchase_adjustment',
                  'purchase_reversal'
                )
                AND ledger.entry_id NOT IN (
                  SELECT links.ledger_entry_id
                  FROM credit_purchase_ledger_links links
                  JOIN credit_purchase_transactions purchase
                    ON purchase.row_id = links.purchase_transaction_id
                  WHERE purchase.anon_user_id IN (SELECT value FROM graph_nodes)
                )) AS operational_ledger_entries_deleted,
            (SELECT COUNT(*) FROM credit_daily_usage
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)) AS daily_usage_rows,
            (SELECT COUNT(*) FROM credit_purchase_transactions
              WHERE anon_user_id IN (SELECT value FROM graph_nodes)) AS purchase_transactions_preserved,
            (SELECT COUNT(*) FROM credit_purchase_ledger_links links
              WHERE links.purchase_transaction_id IN (
                SELECT row_id FROM credit_purchase_transactions
                WHERE anon_user_id IN (SELECT value FROM graph_nodes)
              ) OR links.ledger_entry_id IN (
                SELECT entry_id FROM credit_ledger_entries
                WHERE anon_user_id IN (SELECT value FROM graph_nodes)
              )) AS purchase_ledger_links,
            (SELECT COUNT(*) FROM purchase_reconciliation_actions actions
              WHERE actions.purchase_transaction_id IN (
                SELECT row_id FROM credit_purchase_transactions
                WHERE anon_user_id IN (SELECT value FROM graph_nodes)
              ) OR actions.ledger_entry_id IN (
                SELECT entry_id FROM credit_ledger_entries
                WHERE anon_user_id IN (SELECT value FROM graph_nodes)
              )) AS reconciliation_actions,
            (SELECT COUNT(*) FROM account_deletion_events
              WHERE auth_user_id IN (SELECT value FROM graph_auth_users)
                 OR canonical_anon_user_id IN (SELECT value FROM graph_nodes)) AS prior_deletion_events`,
    args: [...authUserIds, ...identityNodes],
  });
  const row = result.rows[0] ?? {};
  return {
    authUsers: asCount(row.auth_users),
    identityLinks: asCount(row.identity_links),
    mobileDeviceLinks: asCount(row.mobile_device_links),
    mobileAliases: asCount(row.mobile_aliases),
    cookbookRecipes: asCount(row.cookbook_recipes),
    productActivityEvents: asCount(row.product_activity_events),
    creditBalanceRows: asCount(row.credit_balance_rows),
    creditReservations: asCount(row.credit_reservations),
    activeCreditReservations: asCount(row.active_credit_reservations),
    expiredCreditReservations: asCount(row.expired_credit_reservations),
    creditLedgerEntries: asCount(row.credit_ledger_entries),
    financialLedgerEntriesRetained: asCount(
      row.financial_ledger_entries_retained,
    ),
    operationalLedgerEntriesDeleted: asCount(
      row.operational_ledger_entries_deleted,
    ),
    dailyUsageRows: asCount(row.daily_usage_rows),
    purchaseTransactionsPreserved: asCount(row.purchase_transactions_preserved),
    purchaseLedgerLinks: asCount(row.purchase_ledger_links),
    reconciliationActions: asCount(row.reconciliation_actions),
    priorDeletionEvents: asCount(row.prior_deletion_events),
  };
}

export async function planAccountDeletion(options: {
  authUserIds: string[];
  client?: PlanningClient;
  secret?: string;
  publicBaseUrl?: string;
}): Promise<AccountDeletionPlan> {
  const client = options.client ?? getTursoClient();
  const factDigestSecret = getFactDigestSecret(options.secret);
  const publicBaseUrl =
    options.publicBaseUrl?.trim() || process.env.R2_PUBLIC_BASE_URL?.trim() || "";
  const selectedAuthUserIds = sortedUnique(
    options.authUserIds.map((value) => value.trim()),
  );
  const existing = await readExistingAuthUserIds(client, selectedAuthUserIds);
  const missingAuthUserIds = selectedAuthUserIds.filter((id) => !existing.has(id));
  const presentAuthUserIds = selectedAuthUserIds.filter((id) => existing.has(id));
  const selectedSet = new Set(presentAuthUserIds);
  const selectedLinks = await readAuthLinks(client, presentAuthUserIds);
  const linksByAuthUser = new Map<string, AuthLink[]>();
  selectedLinks.forEach((link) => {
    const links = linksByAuthUser.get(link.authUserId) ?? [];
    links.push(link);
    linksByAuthUser.set(link.authUserId, links);
  });

  const linkedComponents: Array<{
    selectedAuthUserIds: Set<string>;
    identityNodes: Set<string>;
  }> = [];
  for (const authUserId of presentAuthUserIds) {
    const links = linksByAuthUser.get(authUserId) ?? [];
    if (links.length === 0) {
      continue;
    }
    const userNodes = new Set<string>();
    for (const link of links) {
      if (link.canonicalAnonUserId) {
        const closure = await readIdentityClosure(client, link.canonicalAnonUserId);
        closure.forEach((node) => userNodes.add(node));
      }
    }
    const intersecting = linkedComponents.filter((component) =>
      setsIntersect(component.identityNodes, userNodes),
    );
    if (intersecting.length === 0) {
      linkedComponents.push({
        selectedAuthUserIds: new Set([authUserId]),
        identityNodes: userNodes,
      });
      continue;
    }
    const primary = intersecting[0];
    primary.selectedAuthUserIds.add(authUserId);
    userNodes.forEach((node) => primary.identityNodes.add(node));
    for (const merged of intersecting.slice(1)) {
      merged.selectedAuthUserIds.forEach((id) =>
        primary.selectedAuthUserIds.add(id),
      );
      merged.identityNodes.forEach((node) => primary.identityNodes.add(node));
      linkedComponents.splice(linkedComponents.indexOf(merged), 1);
    }
  }

  const graphSeeds = [
    ...linkedComponents,
    ...presentAuthUserIds
      .filter((authUserId) => (linksByAuthUser.get(authUserId) ?? []).length === 0)
      .map((authUserId) => ({
        selectedAuthUserIds: new Set([authUserId]),
        identityNodes: new Set<string>(),
      })),
  ];
  const graphs: AccountDeletionGraphPlan[] = [];
  const targetGraphIds: Record<string, string> = {};

  for (const seed of graphSeeds) {
    const identityNodes = sortedUnique(seed.identityNodes);
    const ownerLinks = identityNodes.length
      ? await readOwnersForNodes(client, identityNodes)
      : [];
    const ownerAuthUserIds = sortedUnique([
      ...seed.selectedAuthUserIds,
      ...ownerLinks.map((link) => link.authUserId),
    ]);
    const selectedGraphAuthUserIds = sortedUnique(seed.selectedAuthUserIds);
    const aliasEdges = identityNodes.length
      ? await readAliasEdges(client, identityNodes)
      : [];
    const canonicalIdentityIds = sortedUnique(
      ownerLinks.map((link) => link.canonicalAnonUserId),
    );
    const unselectedOwnerAuthUserIds = ownerAuthUserIds.filter(
      (authUserId) => !selectedSet.has(authUserId),
    );
    const blockers = new Set<AccountDeletionBlocker>();
    const selectedGraphLinks = selectedLinks.filter((link) =>
      seed.selectedAuthUserIds.has(link.authUserId),
    );

    if (
      selectedGraphLinks.some(
        (link) => !UUID_PATTERN.test(link.canonicalAnonUserId),
      ) ||
      aliasEdges.some(
        (edge) =>
          !UUID_PATTERN.test(edge.anonUserId) ||
          !UUID_PATTERN.test(edge.canonicalAnonUserId),
      )
    ) {
      blockers.add("invalid_identity");
    }
    if (unselectedOwnerAuthUserIds.length > 0) {
      blockers.add("unselected_authenticated_owner");
    }
    if (new Set(ownerLinks.map((link) => link.canonicalAnonUserId)).size > 1) {
      blockers.add("conflicting_authenticated_owners");
    }
    if (
      selectedGraphLinks.some((link) =>
        aliasEdges.some(
          (edge) =>
            edge.anonUserId === link.canonicalAnonUserId &&
            edge.canonicalAnonUserId !== link.canonicalAnonUserId,
        ),
      )
    ) {
      blockers.add("canonical_is_alias");
    }
    if (hasAliasCycle(aliasEdges)) {
      blockers.add("alias_cycle");
    }
    if (await hasConflictingFinancialOwnership(client, identityNodes)) {
      blockers.add("conflicting_financial_ownership");
    }

    const graphAuthUserIds = sortedUnique(ownerAuthUserIds);
    const graphId = graphIdFor(graphAuthUserIds, identityNodes);
    const deviceKeys = identityNodes.length
      ? await readDeviceKeys(client, identityNodes)
      : [];
    const storageReferences = await readStorageReferences(
      client,
      graphAuthUserIds,
      identityNodes,
    );
    if (storageReferences.length > 0 && !publicBaseUrl) {
      throw new AccountDeletionPlanningError(
        "Account deletion storage verification is unavailable.",
      );
    }
    const graph: AccountDeletionGraphPlan = {
      graphId,
      status: blockers.size === 0 ? "ready" : "manual_review",
      blockers: [...blockers].sort(),
      selectedAuthUserIds: selectedGraphAuthUserIds,
      ownerAuthUserIds: graphAuthUserIds,
      unselectedOwnerAuthUserIds,
      identityNodes,
      canonicalIdentityIds,
      aliasEdges,
      deviceKeys,
      storageReferences,
      mutableFactDigests: await readMutableFactDigests({
        client,
        authUserIds: graphAuthUserIds,
        identityNodes,
        storageReferences,
        secret: factDigestSecret,
        publicBaseUrl,
      }),
      inventory: await readInventory(
        client,
        graphAuthUserIds,
        identityNodes,
      ),
    };
    graphs.push(graph);
    selectedGraphAuthUserIds.forEach((authUserId) => {
      targetGraphIds[authUserId] = graphId;
    });
  }

  return {
    selectedAuthUserIds: presentAuthUserIds,
    missingAuthUserIds,
    graphs: graphs.sort((left, right) => left.graphId.localeCompare(right.graphId)),
    targetGraphIds,
  };
}

export function getEmptyAccountDeletionInventory() {
  return emptyInventory();
}
