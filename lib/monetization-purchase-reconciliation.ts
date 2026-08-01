import { createHash } from "crypto";
import type { Client } from "@libsql/client";
import { getTursoClient } from "./turso.ts";

export const PURCHASE_RECONCILIATION_ISSUE_TYPES = [
  "purchase_missing_grant",
  "grant_missing_purchase",
  "missing_purchase_ledger_link",
  "credit_amount_mismatch",
  "owner_mismatch",
  "duplicate_grant",
  "product_or_transaction_conflict",
] as const;

export type PurchaseReconciliationIssueType =
  (typeof PURCHASE_RECONCILIATION_ISSUE_TYPES)[number];

export type PurchaseReconciliationIssue = {
  id: string;
  issueType: PurchaseReconciliationIssueType;
  userId: string;
  relatedUserId: string | null;
  provider: "apple_app_store" | "google_play" | "unknown";
  maskedProviderTransactionId: string;
  productId: string;
  purchaseDate: string | null;
  purchaseAmount: number | null;
  ledgerAmount: number | null;
  currentBalance: number;
  explanation: string;
  recommendedStep: string;
};

export type PurchaseReconciliationCounts = Record<
  PurchaseReconciliationIssueType,
  number
>;

export type PurchaseReconciliationReport = {
  status: "healthy" | "needs_attention";
  checkedAt: string;
  totalIssues: number;
  counts: PurchaseReconciliationCounts;
  issues: PurchaseReconciliationIssue[];
};

export type PurchaseReconciliationEvidence = {
  issue: PurchaseReconciliationIssue;
  purchaseRowId: string | null;
  ledgerEntryId: string | null;
  providerTransactionId: string;
  userId: string;
  productId: string;
  purchaseStatus: string | null;
  purchaseVerifiedAt: string | null;
  purchaseGrantedCredits: number | null;
  recordedCredits: number | null;
  ledgerOwnerId: string | null;
  ledgerIdempotencyScope: string | null;
  ledgerIdempotencyKey: string | null;
  balanceExists: boolean;
  blockingIssueTypes: PurchaseReconciliationIssueType[];
};

type ReconciliationClient = Pick<Client, "execute">;

type Purchase = {
  rowId: string;
  provider: "apple_app_store" | "google_play";
  providerTransactionId: string;
  anonUserId: string;
  productId: string;
  status: string;
  grantedCredits: number;
  reversedCredits: number;
  outstandingReversalCredits: number;
  verifiedAt: string | null;
  createdAt: string;
};

type Ledger = {
  entryId: string;
  anonUserId: string;
  eventType: string;
  amount: number;
  idempotencyScope: string;
  idempotencyKey: string;
  metadataProvider: string;
  metadataTransactionId: string;
  metadataProductId: string;
  createdAt: string;
};

type PurchaseLink = {
  linkId: string;
  purchaseTransactionId: string;
  ledgerEntryId: string;
  linkKind: string;
};

type IssueFacts = {
  issueType: PurchaseReconciliationIssueType;
  purchase?: Purchase | null;
  ledger?: Ledger | null;
  provider?: "apple_app_store" | "google_play" | "unknown";
  providerTransactionId?: string;
  userId?: string;
  purchaseAmount?: number | null;
  ledgerAmount?: number | null;
};

const SNAPSHOT_SQL = `
  SELECT
    'purchase' AS row_kind,
    row_id AS primary_id,
    NULL AS secondary_id,
    provider,
    provider_transaction_id,
    anon_user_id,
    product_id,
    status AS record_type,
    granted_credits AS amount,
    reversed_credits AS auxiliary_amount,
    outstanding_reversal_credits AS secondary_amount,
    verified_at AS occurred_at,
    created_at,
    NULL AS idempotency_scope,
    NULL AS idempotency_key,
    NULL AS metadata_provider,
    NULL AS metadata_transaction_id,
    NULL AS metadata_product_id
  FROM credit_purchase_transactions

  UNION ALL

  SELECT
    'ledger' AS row_kind,
    entry_id AS primary_id,
    NULL AS secondary_id,
    NULL AS provider,
    NULL AS provider_transaction_id,
    anon_user_id,
    NULL AS product_id,
    event_type AS record_type,
    amount,
    0 AS auxiliary_amount,
    0 AS secondary_amount,
    created_at AS occurred_at,
    created_at,
    idempotency_scope,
    idempotency_key,
    CASE WHEN json_valid(metadata_json)
      THEN json_extract(metadata_json, '$.provider') ELSE NULL END,
    CASE WHEN json_valid(metadata_json)
      THEN json_extract(metadata_json, '$.providerTransactionId') ELSE NULL END,
    CASE WHEN json_valid(metadata_json)
      THEN json_extract(metadata_json, '$.productId') ELSE NULL END
  FROM credit_ledger_entries
  WHERE event_type IN ('purchase_grant', 'purchase_adjustment')

  UNION ALL

  SELECT
    'link' AS row_kind,
    id AS primary_id,
    purchase_transaction_id AS secondary_id,
    NULL AS provider,
    ledger_entry_id AS provider_transaction_id,
    NULL AS anon_user_id,
    NULL AS product_id,
    link_kind AS record_type,
    0 AS amount,
    0 AS auxiliary_amount,
    0 AS secondary_amount,
    created_at AS occurred_at,
    created_at,
    NULL AS idempotency_scope,
    NULL AS idempotency_key,
    NULL AS metadata_provider,
    NULL AS metadata_transaction_id,
    NULL AS metadata_product_id
  FROM credit_purchase_ledger_links
  WHERE link_kind IN ('base_grant', 'repair_adjustment')

  UNION ALL

  SELECT
    'balance' AS row_kind,
    anon_user_id AS primary_id,
    NULL AS secondary_id,
    NULL AS provider,
    NULL AS provider_transaction_id,
    anon_user_id,
    NULL AS product_id,
    'balance' AS record_type,
    available_credits AS amount,
    pending_credits AS auxiliary_amount,
    0 AS secondary_amount,
    updated_at AS occurred_at,
    updated_at AS created_at,
    NULL AS idempotency_scope,
    NULL AS idempotency_key,
    NULL AS metadata_provider,
    NULL AS metadata_transaction_id,
    NULL AS metadata_product_id
  FROM credit_balances AS balance
  WHERE EXISTS (
    SELECT 1
    FROM credit_purchase_transactions AS purchase
    WHERE purchase.anon_user_id = balance.anon_user_id
  ) OR EXISTS (
    SELECT 1
    FROM credit_ledger_entries AS ledger
    WHERE ledger.anon_user_id = balance.anon_user_id
      AND ledger.event_type = 'purchase_grant'
  )
`;

const ISSUE_COPY: Record<
  PurchaseReconciliationIssueType,
  { explanation: string; recommendedStep: string }
> = {
  purchase_missing_grant: {
    explanation:
      "A verified purchase exists, but no corresponding purchase credit grant was found.",
    recommendedStep:
      "Confirm the provider transaction and inspect the settlement records before considering any correction.",
  },
  grant_missing_purchase: {
    explanation:
      "A purchase credit grant exists without a matching purchase transaction record.",
    recommendedStep:
      "Review the ledger idempotency key and provider transaction evidence to identify the missing purchase record.",
  },
  missing_purchase_ledger_link: {
    explanation:
      "The purchase and deterministic credit grant match, but their base-grant link is missing.",
    recommendedStep:
      "Verify both records are the intended pair before using a future audited link-repair workflow.",
  },
  credit_amount_mismatch: {
    explanation:
      "The purchase credited amount does not equal the associated ledger grant amount.",
    recommendedStep:
      "Compare the verified product credit value with the purchase and ledger records before adjusting anything.",
  },
  owner_mismatch: {
    explanation:
      "The purchase and associated ledger grant belong to different internal user identities.",
    recommendedStep:
      "Investigate identity ownership and account history; do not move credits until ownership is proven.",
  },
  duplicate_grant: {
    explanation:
      "More than one purchase credit grant is associated with the same provider transaction.",
    recommendedStep:
      "Review every associated ledger entry and balance effect before considering a reversal or correction.",
  },
  product_or_transaction_conflict: {
    explanation:
      "Product or provider transaction facts conflict between the purchase and ledger records.",
    recommendedStep:
      "Compare the deterministic ledger key and stored product metadata with authoritative provider evidence.",
  },
};

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function asProvider(
  value: unknown,
): "apple_app_store" | "google_play" | "unknown" {
  return value === "apple_app_store" || value === "google_play"
    ? value
    : "unknown";
}

function purchaseKey(provider: string, providerTransactionId: string) {
  return provider && providerTransactionId
    ? `${provider}:${providerTransactionId}`
    : "";
}

function parsePurchaseKey(value: string) {
  const separator = value.indexOf(":");
  if (separator < 1) {
    return { provider: "unknown" as const, providerTransactionId: "" };
  }
  return {
    provider: asProvider(value.slice(0, separator)),
    providerTransactionId: value.slice(separator + 1),
  };
}

function getLedgerAssociationKeys(ledger: Ledger) {
  const keys = new Set<string>();
  if (
    ledger.idempotencyScope === "purchase-credit-grant" &&
    ledger.idempotencyKey
  ) {
    keys.add(ledger.idempotencyKey);
  }
  const metadataKey = purchaseKey(
    ledger.metadataProvider,
    ledger.metadataTransactionId,
  );
  if (metadataKey) {
    keys.add(metadataKey);
  }
  return keys;
}

function hasLedgerIdentityConflict(ledger: Ledger) {
  if (
    ledger.idempotencyScope !== "purchase-credit-grant" ||
    !ledger.idempotencyKey
  ) {
    return false;
  }
  const metadataKey = purchaseKey(
    ledger.metadataProvider,
    ledger.metadataTransactionId,
  );
  return Boolean(metadataKey && metadataKey !== ledger.idempotencyKey);
}

export function maskProviderTransactionIdentifier(
  provider: string,
  value: string,
) {
  const normalized = value.trim();
  if (!normalized) {
    return "Unavailable";
  }
  if (provider === "google_play" && normalized.startsWith("token:")) {
    const digest = createHash("sha256").update(normalized).digest("hex");
    return `Google token ••••${digest.slice(-10)}`;
  }
  if (
    provider === "google_play" &&
    normalized.startsWith("token_sha256:")
  ) {
    return `Google token hash ••••${normalized.slice(-10)}`;
  }
  if (normalized.length <= 10) {
    return `${normalized.slice(0, 2)}••••${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 6)}…${normalized.slice(-4)}`;
}

function emptyCounts(): PurchaseReconciliationCounts {
  return Object.fromEntries(
    PURCHASE_RECONCILIATION_ISSUE_TYPES.map((issueType) => [issueType, 0]),
  ) as PurchaseReconciliationCounts;
}

async function scanPurchaseReconciliationWithEvidence(
  options: {
    client?: ReconciliationClient;
    now?: () => Date;
  } = {},
): Promise<{
  report: PurchaseReconciliationReport;
  evidenceById: Map<string, PurchaseReconciliationEvidence>;
}> {
  const client = options.client ?? getTursoClient();
  const snapshot = await client.execute(SNAPSHOT_SQL);

  const purchases: Purchase[] = [];
  const ledgers: Ledger[] = [];
  const links: PurchaseLink[] = [];
  const balances = new Map<string, number>();

  for (const rawRow of snapshot.rows) {
    const row = rawRow as Record<string, unknown>;
    const rowKind = asString(row.row_kind);
    if (rowKind === "purchase") {
      const provider = asProvider(row.provider);
      if (provider === "unknown") {
        continue;
      }
      purchases.push({
        rowId: asString(row.primary_id),
        provider,
        providerTransactionId: asString(row.provider_transaction_id),
        anonUserId: asString(row.anon_user_id),
        productId: asString(row.product_id),
        status: asString(row.record_type),
        grantedCredits: asInteger(row.amount),
        reversedCredits: asInteger(row.auxiliary_amount),
        outstandingReversalCredits: asInteger(row.secondary_amount),
        verifiedAt: asString(row.occurred_at) || null,
        createdAt: asString(row.created_at),
      });
    } else if (rowKind === "ledger") {
      ledgers.push({
        entryId: asString(row.primary_id),
        anonUserId: asString(row.anon_user_id),
        eventType: asString(row.record_type),
        amount: asInteger(row.amount),
        idempotencyScope: asString(row.idempotency_scope),
        idempotencyKey: asString(row.idempotency_key),
        metadataProvider: asString(row.metadata_provider),
        metadataTransactionId: asString(row.metadata_transaction_id),
        metadataProductId: asString(row.metadata_product_id),
        createdAt: asString(row.created_at),
      });
    } else if (rowKind === "link") {
      links.push({
        linkId: asString(row.primary_id),
        purchaseTransactionId: asString(row.secondary_id),
        ledgerEntryId: asString(row.provider_transaction_id),
        linkKind: asString(row.record_type),
      });
    } else if (rowKind === "balance") {
      balances.set(asString(row.anon_user_id), asInteger(row.amount));
    }
  }

  const purchasesByRowId = new Map(
    purchases.map((purchase) => [purchase.rowId, purchase]),
  );
  const purchasesByKey = new Map<string, Purchase[]>();
  for (const purchase of purchases) {
    const key = purchaseKey(
      purchase.provider,
      purchase.providerTransactionId,
    );
    purchasesByKey.set(key, [...(purchasesByKey.get(key) ?? []), purchase]);
  }
  const ledgersById = new Map(
    ledgers.map((ledger) => [ledger.entryId, ledger]),
  );
  const ledgersByKey = new Map<string, Ledger[]>();
  for (const ledger of ledgers.filter(
    (candidate) => candidate.eventType === "purchase_grant",
  )) {
    for (const key of getLedgerAssociationKeys(ledger)) {
      ledgersByKey.set(key, [...(ledgersByKey.get(key) ?? []), ledger]);
    }
  }
  const linksByPurchase = new Map<string, PurchaseLink[]>();
  for (const link of links) {
    linksByPurchase.set(link.purchaseTransactionId, [
      ...(linksByPurchase.get(link.purchaseTransactionId) ?? []),
      link,
    ]);
  }

  const issues = new Map<string, PurchaseReconciliationIssue>();
  const evidenceById = new Map<string, PurchaseReconciliationEvidence>();
  const addIssue = (facts: IssueFacts) => {
    const purchase = facts.purchase ?? null;
    const ledger = facts.ledger ?? null;
    const provider =
      facts.provider ??
      purchase?.provider ??
      asProvider(ledger?.metadataProvider);
    const providerTransactionId =
      facts.providerTransactionId ??
      purchase?.providerTransactionId ??
      ledger?.metadataTransactionId ??
      parsePurchaseKey(ledger?.idempotencyKey ?? "").providerTransactionId;
    const userId = facts.userId ?? purchase?.anonUserId ?? ledger?.anonUserId ?? "";
    const dedupeKey = [
      facts.issueType,
      purchase?.rowId ?? "",
      ledger?.entryId ?? "",
      provider,
      providerTransactionId,
    ].join("|");
    if (issues.has(dedupeKey)) {
      return;
    }
    const copy = ISSUE_COPY[facts.issueType];
    const issueId = createHash("sha256")
      .update(dedupeKey)
      .digest("hex")
      .slice(0, 20);
    const issue: PurchaseReconciliationIssue = {
      id: issueId,
      issueType: facts.issueType,
      userId: userId || "Unavailable",
      relatedUserId:
        purchase && ledger && purchase.anonUserId !== ledger.anonUserId
          ? ledger.anonUserId
          : null,
      provider,
      maskedProviderTransactionId: maskProviderTransactionIdentifier(
        provider,
        providerTransactionId,
      ),
      productId: purchase?.productId || ledger?.metadataProductId || "Unavailable",
      purchaseDate: purchase?.verifiedAt ?? purchase?.createdAt ?? ledger?.createdAt ?? null,
      purchaseAmount:
        facts.purchaseAmount !== undefined
          ? facts.purchaseAmount
          : purchase?.grantedCredits ?? null,
      ledgerAmount:
        facts.ledgerAmount !== undefined
          ? facts.ledgerAmount
          : ledger?.amount ?? null,
      currentBalance: balances.get(userId) ?? 0,
      explanation: copy.explanation,
      recommendedStep: copy.recommendedStep,
    };
    issues.set(dedupeKey, issue);
    evidenceById.set(issueId, {
      issue,
      purchaseRowId: purchase?.rowId ?? null,
      ledgerEntryId: ledger?.entryId ?? null,
      providerTransactionId,
      userId,
      productId: purchase?.productId || ledger?.metadataProductId || "",
      purchaseStatus: purchase?.status ?? null,
      purchaseVerifiedAt: purchase?.verifiedAt ?? null,
      purchaseGrantedCredits: purchase?.grantedCredits ?? null,
      recordedCredits:
        facts.ledgerAmount !== undefined
          ? facts.ledgerAmount
          : ledger?.amount ?? null,
      ledgerOwnerId: ledger?.anonUserId ?? null,
      ledgerIdempotencyScope: ledger?.idempotencyScope ?? null,
      ledgerIdempotencyKey: ledger?.idempotencyKey ?? null,
      balanceExists: balances.has(userId),
      blockingIssueTypes: [],
    });
  };

  for (const purchase of purchases.filter(
    (candidate) => candidate.status === "verified",
  )) {
    const key = purchaseKey(
      purchase.provider,
      purchase.providerTransactionId,
    );
    const deterministicLedgers = ledgersByKey.get(key) ?? [];
    const purchaseLinks = linksByPurchase.get(purchase.rowId) ?? [];
    const baseLinks = purchaseLinks.filter(
      (link) => link.linkKind === "base_grant",
    );
    const repairLinks = purchaseLinks.filter(
      (link) => link.linkKind === "repair_adjustment",
    );
    const linkedLedgers = baseLinks
      .map((link) => ledgersById.get(link.ledgerEntryId) ?? null)
      .filter((ledger): ledger is Ledger => ledger !== null);
    const repairLedgers = repairLinks
      .map((link) => ledgersById.get(link.ledgerEntryId) ?? null)
      .filter((ledger): ledger is Ledger => ledger !== null);
    const recordedCredits = [...linkedLedgers, ...repairLedgers].reduce(
      (total, ledger) => total + ledger.amount,
      0,
    );

    if (deterministicLedgers.length > 1 || linkedLedgers.length > 1) {
      addIssue({
        issueType: "duplicate_grant",
        purchase,
        ledger: deterministicLedgers[0] ?? linkedLedgers[0] ?? null,
        ledgerAmount: deterministicLedgers.reduce(
          (total, ledger) => total + ledger.amount,
          0,
        ),
      });
    }

    if (linkedLedgers.length === 0) {
      if (deterministicLedgers.length === 0) {
        addIssue({ issueType: "purchase_missing_grant", purchase });
        continue;
      }
      if (deterministicLedgers.length > 1) {
        continue;
      }
      const ledger = deterministicLedgers[0];
      if (ledger.anonUserId !== purchase.anonUserId) {
        addIssue({ issueType: "owner_mismatch", purchase, ledger });
      } else if (ledger.amount !== purchase.grantedCredits) {
        addIssue({ issueType: "credit_amount_mismatch", purchase, ledger });
      } else if (
        hasLedgerIdentityConflict(ledger) ||
        (ledger.metadataProductId &&
          ledger.metadataProductId !== purchase.productId)
      ) {
        addIssue({
          issueType: "product_or_transaction_conflict",
          purchase,
          ledger,
        });
      } else {
        addIssue({
          issueType: "missing_purchase_ledger_link",
          purchase,
          ledger,
        });
      }
      continue;
    }

    for (const ledger of linkedLedgers) {
      const associationKeys = getLedgerAssociationKeys(ledger);
      if (ledger.anonUserId !== purchase.anonUserId) {
        addIssue({ issueType: "owner_mismatch", purchase, ledger });
      }
      if (
        !associationKeys.has(key) ||
        hasLedgerIdentityConflict(ledger) ||
        (ledger.metadataProductId &&
          ledger.metadataProductId !== purchase.productId)
      ) {
        addIssue({
          issueType: "product_or_transaction_conflict",
          purchase,
          ledger,
        });
      }
    }
    for (const ledger of repairLedgers) {
      const associationKeys = getLedgerAssociationKeys(ledger);
      if (ledger.anonUserId !== purchase.anonUserId) {
        addIssue({ issueType: "owner_mismatch", purchase, ledger });
      }
      if (
        (associationKeys.size > 0 && !associationKeys.has(key)) ||
        hasLedgerIdentityConflict(ledger) ||
        (ledger.metadataProductId &&
          ledger.metadataProductId !== purchase.productId)
      ) {
        addIssue({
          issueType: "product_or_transaction_conflict",
          purchase,
          ledger,
        });
      }
    }
    if (recordedCredits !== purchase.grantedCredits) {
      addIssue({
        issueType: "credit_amount_mismatch",
        purchase,
        ledger: linkedLedgers[0] ?? null,
        ledgerAmount: recordedCredits,
      });
    }
  }

  for (const ledger of ledgers.filter(
    (candidate) => candidate.eventType === "purchase_grant",
  )) {
    const keys = [...getLedgerAssociationKeys(ledger)];
    const primaryKey =
      ledger.idempotencyScope === "purchase-credit-grant"
        ? ledger.idempotencyKey
        : keys[0] ?? "";
    const parsedPrimary = parsePurchaseKey(primaryKey);
    const matchingPurchases = Array.from(
      new Map(
        keys.flatMap((key) => purchasesByKey.get(key) ?? []).map((purchase) => [
          purchase.rowId,
          purchase,
        ]),
      ).values(),
    );

    if (hasLedgerIdentityConflict(ledger) || keys.length === 0) {
      addIssue({
        issueType: "product_or_transaction_conflict",
        purchase: matchingPurchases[0] ?? null,
        ledger,
        provider: parsedPrimary.provider,
        providerTransactionId: parsedPrimary.providerTransactionId,
      });
      continue;
    }
    if (matchingPurchases.length === 0) {
      addIssue({
        issueType: "grant_missing_purchase",
        ledger,
        provider: parsedPrimary.provider,
        providerTransactionId: parsedPrimary.providerTransactionId,
      });
    } else if (matchingPurchases.length > 1) {
      addIssue({
        issueType: "product_or_transaction_conflict",
        purchase: matchingPurchases[0],
        ledger,
      });
    } else {
      const purchase = matchingPurchases[0];
      if (purchase.anonUserId !== ledger.anonUserId) {
        addIssue({ issueType: "owner_mismatch", purchase, ledger });
      }
      if (
        ledger.metadataProductId &&
        ledger.metadataProductId !== purchase.productId
      ) {
        addIssue({
          issueType: "product_or_transaction_conflict",
          purchase,
          ledger,
        });
      }
    }
  }

  // Check linked ownership for non-verified financial rows too. Correctly
  // reversed purchases remain healthy because their original grant still
  // belongs to the same owner and retains the deterministic transaction facts.
  for (const link of links) {
    const purchase = purchasesByRowId.get(link.purchaseTransactionId);
    const ledger = ledgersById.get(link.ledgerEntryId);
    if (!purchase || !ledger) {
      continue;
    }
    if (purchase.anonUserId !== ledger.anonUserId) {
      addIssue({ issueType: "owner_mismatch", purchase, ledger });
    }
  }

  const conflictTypes = new Set<PurchaseReconciliationIssueType>([
    "owner_mismatch",
    "duplicate_grant",
    "product_or_transaction_conflict",
  ]);
  const evidenceRows = [...evidenceById.values()];
  for (const evidence of evidenceRows) {
    evidence.blockingIssueTypes = Array.from(
      new Set(
        evidenceRows
          .filter(
            (candidate) =>
              candidate.issue.id !== evidence.issue.id &&
              conflictTypes.has(candidate.issue.issueType) &&
              ((evidence.purchaseRowId &&
                candidate.purchaseRowId === evidence.purchaseRowId) ||
                (candidate.issue.provider === evidence.issue.provider &&
                  candidate.providerTransactionId ===
                    evidence.providerTransactionId)),
          )
          .map((candidate) => candidate.issue.issueType),
      ),
    );
  }

  const issueRows = [...issues.values()].sort((left, right) =>
    left.issueType === right.issueType
      ? (right.purchaseDate ?? "").localeCompare(left.purchaseDate ?? "")
      : left.issueType.localeCompare(right.issueType),
  );
  const counts = emptyCounts();
  for (const issue of issueRows) {
    counts[issue.issueType] += 1;
  }

  return {
    report: {
      status: issueRows.length === 0 ? "healthy" : "needs_attention",
      checkedAt: (options.now ?? (() => new Date()))().toISOString(),
      totalIssues: issueRows.length,
      counts,
      issues: issueRows,
    },
    evidenceById,
  };
}

export async function scanPurchaseReconciliation(
  options: {
    client?: ReconciliationClient;
    now?: () => Date;
  } = {},
) {
  return (await scanPurchaseReconciliationWithEvidence(options)).report;
}

export async function findPurchaseReconciliationEvidence(
  issueId: string,
  options: {
    client?: ReconciliationClient;
    now?: () => Date;
  } = {},
) {
  const snapshot = await scanPurchaseReconciliationWithEvidence(options);
  return snapshot.evidenceById.get(issueId) ?? null;
}
