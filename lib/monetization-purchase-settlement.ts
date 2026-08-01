import { createHash, randomUUID } from "crypto";
import type { Client, Transaction } from "@libsql/client";
import type { PurchaseProvider } from "./monetization-credit-packs.ts";
import { getTursoClient } from "./turso.ts";

const PURCHASE_LEDGER_SCOPE = "purchase-credit-grant";
const MAX_SETTLEMENT_CREDITS = 100_000;

export type VerifiedPurchaseSettlementInput = {
  provider: PurchaseProvider;
  providerTransactionId: string;
  providerOriginalTransactionId?: string | null;
  canonicalAnonUserId: string;
  productId: string;
  verifiedCredits: number;
  verifiedAt: string;
  settlementIdempotencyKey: string;
  providerVerificationPayload?: Record<string, unknown>;
  providerVerificationHash?: string | null;
  providerMetadata?: Record<string, unknown>;
  currency?: string | null;
  price?: string | number | null;
  riskFlags?: string[];
};

export type SettledPurchaseRecord = {
  rowId: string;
  provider: PurchaseProvider;
  providerTransactionId: string;
  providerOriginalTransactionId: string | null;
  anonUserId: string;
  productId: string;
  status: "verified" | "rejected" | "revoked" | "reversal_pending";
  grantedCredits: number;
  reversedCredits: number;
  outstandingReversalCredits: number;
  riskFlags: string[];
  verifiedAt: string | null;
  revokedAt: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SettledCreditBalance = {
  anonUserId: string;
  availableCredits: number;
  pendingCredits: number;
  updatedAt: string;
};

type SuccessfulSettlementStatus = "settled" | "replay" | "recovered";

export type VerifiedPurchaseSettlementSuccess = {
  status: SuccessfulSettlementStatus;
  purchase: SettledPurchaseRecord;
  balance: SettledCreditBalance;
  ledgerEntryId: string;
};

export type VerifiedPurchaseSettlementResult =
  | VerifiedPurchaseSettlementSuccess
  | {
      status: "owner_conflict";
      reason: "purchase_owner_mismatch" | "ledger_owner_mismatch";
    }
  | {
      status: "inconsistent_state";
      reason:
        | "multiple_purchase_candidates"
        | "multiple_ledger_candidates"
        | "purchase_status_conflict"
        | "purchase_amount_mismatch"
        | "purchase_product_mismatch"
        | "purchase_original_transaction_mismatch"
        | "ledger_event_type_mismatch"
        | "ledger_amount_mismatch"
        | "ledger_product_mismatch"
        | "ledger_metadata_unproven"
        | "base_grant_link_conflict"
        | "ledger_link_conflict"
        | "missing_balance_for_existing_grant";
    };

export type PurchaseSettlementFaultStage =
  | "after_purchase_insert"
  | "after_ledger_insert"
  | "after_balance_update"
  | "after_link_insert";

type SettlementClient = Pick<Client, "transaction">;

type PurchaseSettlementOptions = {
  client?: SettlementClient;
  ensureSchemas?: () => Promise<void>;
  now?: () => Date;
  createId?: () => string;
  faultInjector?: (stage: PurchaseSettlementFaultStage) => void | Promise<void>;
  afterCommit?: (
    result: VerifiedPurchaseSettlementSuccess,
  ) => void | Promise<void>;
};

type PurchaseRow = Record<string, unknown>;

type LedgerCandidate = {
  entryId: string;
  anonUserId: string;
  eventType: string;
  amount: number;
  balanceAvailableAfter: number;
  balancePendingAfter: number;
  metadata: Record<string, unknown> | null;
};

type LinkCandidate = {
  id: string;
  purchaseTransactionId: string;
  ledgerEntryId: string;
  linkKind: string;
};

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function parseObjectJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown) {
  const parsed = parseObjectOrArrayJson(value);
  if (!Array.isArray(parsed)) {
    return [] as string[];
  }
  return parsed
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseObjectOrArrayJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeJsonValue(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(normalizeJsonValue(value));
}

function hashVerificationPayload(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function rowToPurchase(row: PurchaseRow): SettledPurchaseRecord {
  const provider: PurchaseProvider =
    asString(row.provider) === "google_play"
      ? "google_play"
      : "apple_app_store";
  const statusValue = asString(row.status);
  const status =
    statusValue === "verified" ||
    statusValue === "revoked" ||
    statusValue === "reversal_pending"
      ? statusValue
      : "rejected";
  return {
    rowId: asString(row.row_id),
    provider,
    providerTransactionId: asString(row.provider_transaction_id),
    providerOriginalTransactionId:
      asString(row.provider_original_transaction_id) || null,
    anonUserId: asString(row.anon_user_id),
    productId: asString(row.product_id),
    status,
    grantedCredits: asInteger(row.granted_credits),
    reversedCredits: asInteger(row.reversed_credits),
    outstandingReversalCredits: asInteger(
      row.outstanding_reversal_credits,
    ),
    riskFlags: parseStringArray(row.risk_flags_json),
    verifiedAt: asString(row.verified_at) || null,
    revokedAt: asString(row.revoked_at) || null,
    payload: parseObjectJson(row.payload_json) ?? {},
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function rowToBalance(
  row: Record<string, unknown>,
  anonUserId: string,
): SettledCreditBalance {
  return {
    anonUserId,
    availableCredits: asInteger(row.available_credits),
    pendingCredits: asInteger(row.pending_credits),
    updatedAt: asString(row.updated_at),
  };
}

function rowToLedger(row: Record<string, unknown>): LedgerCandidate {
  return {
    entryId: asString(row.entry_id),
    anonUserId: asString(row.anon_user_id),
    eventType: asString(row.event_type),
    amount: asInteger(row.amount),
    balanceAvailableAfter: asInteger(row.balance_available_after),
    balancePendingAfter: asInteger(row.balance_pending_after),
    metadata: parseObjectJson(row.metadata_json),
  };
}

function rowToLink(row: Record<string, unknown>): LinkCandidate {
  return {
    id: asString(row.id),
    purchaseTransactionId: asString(row.purchase_transaction_id),
    ledgerEntryId: asString(row.ledger_entry_id),
    linkKind: asString(row.link_kind),
  };
}

function validateInput(input: VerifiedPurchaseSettlementInput) {
  const expectedKey = `${input.provider}:${input.providerTransactionId.trim()}`;
  if (
    !input.providerTransactionId.trim() ||
    !input.canonicalAnonUserId.trim() ||
    !input.productId.trim() ||
    !input.verifiedAt.trim()
  ) {
    throw new Error("Verified purchase settlement facts are incomplete.");
  }
  if (
    !Number.isInteger(input.verifiedCredits) ||
    input.verifiedCredits < 1 ||
    input.verifiedCredits > MAX_SETTLEMENT_CREDITS
  ) {
    throw new Error("Verified purchase credit amount is invalid.");
  }
  if (input.settlementIdempotencyKey.trim() !== expectedKey) {
    throw new Error(
      "Settlement idempotency key must match the verified provider transaction.",
    );
  }
}

async function ensureDefaultSchemas() {
  const [{ ensureMonetizationLedgerSchema }, { ensureMonetizationPurchaseSchema }] =
    await Promise.all([
      import("./monetization-ledger.ts"),
      import("./monetization-purchases.ts"),
    ]);
  await Promise.all([
    ensureMonetizationLedgerSchema(),
    ensureMonetizationPurchaseSchema(),
  ]);
}

async function loadPurchaseCandidates(
  transaction: Transaction,
  input: VerifiedPurchaseSettlementInput,
) {
  const result = await transaction.execute({
    sql: `SELECT
            row_id,
            provider,
            provider_transaction_id,
            provider_original_transaction_id,
            anon_user_id,
            product_id,
            status,
            granted_credits,
            reversed_credits,
            outstanding_reversal_credits,
            risk_flags_json,
            payload_json,
            verified_at,
            revoked_at,
            created_at,
            updated_at
          FROM credit_purchase_transactions
          WHERE provider = ? AND provider_transaction_id = ?`,
    args: [input.provider, input.providerTransactionId],
  });
  return result.rows.map((row) =>
    rowToPurchase(row as Record<string, unknown>),
  );
}

async function loadLedgerCandidates(
  transaction: Transaction,
  settlementIdempotencyKey: string,
) {
  const result = await transaction.execute({
    sql: `SELECT
            entry_id,
            anon_user_id,
            event_type,
            amount,
            balance_available_after,
            balance_pending_after,
            metadata_json
          FROM credit_ledger_entries
          WHERE idempotency_scope = ?
            AND idempotency_key = ?`,
    args: [PURCHASE_LEDGER_SCOPE, settlementIdempotencyKey],
  });
  return result.rows.map((row) =>
    rowToLedger(row as Record<string, unknown>),
  );
}

async function loadLinkCandidates(
  transaction: Transaction,
  purchaseTransactionId: string | null,
  ledgerEntryId: string | null,
) {
  if (!purchaseTransactionId && !ledgerEntryId) {
    return [] as LinkCandidate[];
  }
  const conditions: string[] = [];
  const args: string[] = [];
  if (purchaseTransactionId) {
    conditions.push(
      "(purchase_transaction_id = ? AND link_kind = 'base_grant')",
    );
    args.push(purchaseTransactionId);
  }
  if (ledgerEntryId) {
    conditions.push("ledger_entry_id = ?");
    args.push(ledgerEntryId);
  }
  const result = await transaction.execute({
    sql: `SELECT
            id,
            purchase_transaction_id,
            ledger_entry_id,
            link_kind
          FROM credit_purchase_ledger_links
          WHERE ${conditions.join(" OR ")}`,
    args,
  });
  return result.rows.map((row) =>
    rowToLink(row as Record<string, unknown>),
  );
}

function validatePurchase(
  purchase: SettledPurchaseRecord,
  input: VerifiedPurchaseSettlementInput,
): VerifiedPurchaseSettlementResult | null {
  if (purchase.anonUserId !== input.canonicalAnonUserId) {
    return {
      status: "owner_conflict",
      reason: "purchase_owner_mismatch",
    };
  }
  if (
    purchase.status !== "verified" ||
    !purchase.verifiedAt ||
    purchase.reversedCredits !== 0 ||
    purchase.outstandingReversalCredits !== 0 ||
    purchase.revokedAt !== null
  ) {
    return {
      status: "inconsistent_state",
      reason: "purchase_status_conflict",
    };
  }
  if (purchase.grantedCredits !== input.verifiedCredits) {
    return {
      status: "inconsistent_state",
      reason: "purchase_amount_mismatch",
    };
  }
  if (purchase.productId !== input.productId) {
    return {
      status: "inconsistent_state",
      reason: "purchase_product_mismatch",
    };
  }
  const incomingOriginal =
    input.providerOriginalTransactionId?.trim() || null;
  if (
    purchase.providerOriginalTransactionId &&
    incomingOriginal &&
    purchase.providerOriginalTransactionId !== incomingOriginal
  ) {
    return {
      status: "inconsistent_state",
      reason: "purchase_original_transaction_mismatch",
    };
  }
  return null;
}

function validateLedger(
  ledger: LedgerCandidate,
  input: VerifiedPurchaseSettlementInput,
  purchaseExists: boolean,
): VerifiedPurchaseSettlementResult | null {
  if (ledger.anonUserId !== input.canonicalAnonUserId) {
    return {
      status: "owner_conflict",
      reason: "ledger_owner_mismatch",
    };
  }
  if (ledger.eventType !== "purchase_grant") {
    return {
      status: "inconsistent_state",
      reason: "ledger_event_type_mismatch",
    };
  }
  if (ledger.amount !== input.verifiedCredits) {
    return {
      status: "inconsistent_state",
      reason: "ledger_amount_mismatch",
    };
  }

  const metadata = ledger.metadata;
  const metadataProductId = asString(metadata?.productId);
  const metadataProvider = asString(metadata?.provider);
  const metadataTransactionId = asString(metadata?.providerTransactionId);
  if (metadataProductId && metadataProductId !== input.productId) {
    return {
      status: "inconsistent_state",
      reason: "ledger_product_mismatch",
    };
  }
  if (
    (metadataProvider && metadataProvider !== input.provider) ||
    (metadataTransactionId &&
      metadataTransactionId !== input.providerTransactionId)
  ) {
    return {
      status: "inconsistent_state",
      reason: "ledger_metadata_unproven",
    };
  }
  if (
    !purchaseExists &&
    (!metadataProductId ||
      metadataProvider !== input.provider ||
      metadataTransactionId !== input.providerTransactionId)
  ) {
    return {
      status: "inconsistent_state",
      reason: "ledger_metadata_unproven",
    };
  }
  return null;
}

function validateLinks(
  links: LinkCandidate[],
  purchaseTransactionId: string | null,
  ledgerEntryId: string | null,
) {
  const baseLinks = purchaseTransactionId
    ? links.filter(
        (link) =>
          link.purchaseTransactionId === purchaseTransactionId &&
          link.linkKind === "base_grant",
      )
    : [];
  const ledgerLinks = ledgerEntryId
    ? links.filter((link) => link.ledgerEntryId === ledgerEntryId)
    : [];

  if (
    baseLinks.length > 1 ||
    baseLinks.some(
      (link) =>
        !ledgerEntryId ||
        link.ledgerEntryId !== ledgerEntryId ||
        link.linkKind !== "base_grant",
    )
  ) {
    return {
      result: {
        status: "inconsistent_state",
        reason: "base_grant_link_conflict",
      } satisfies VerifiedPurchaseSettlementResult,
      exactLink: null,
    };
  }
  if (
    ledgerLinks.length > 1 ||
    ledgerLinks.some(
      (link) =>
        !purchaseTransactionId ||
        link.purchaseTransactionId !== purchaseTransactionId ||
        link.linkKind !== "base_grant",
    )
  ) {
    return {
      result: {
        status: "inconsistent_state",
        reason: "ledger_link_conflict",
      } satisfies VerifiedPurchaseSettlementResult,
      exactLink: null,
    };
  }

  const exactLink =
    baseLinks.find(
      (link) =>
        link.ledgerEntryId === ledgerEntryId &&
        link.purchaseTransactionId === purchaseTransactionId,
    ) ?? null;
  return { result: null, exactLink };
}

async function rollbackAndReturn(
  transaction: Transaction,
  result: VerifiedPurchaseSettlementResult,
) {
  await transaction.rollback();
  return result;
}

function logAfterCommitFailure(
  status: SuccessfulSettlementStatus,
  error: unknown,
) {
  console.warn(
    "[purchase-settlement]",
    JSON.stringify({
      event: "after_commit_callback_failed",
      status,
      errorName: error instanceof Error ? error.name : "unknown",
    }),
  );
}

function isBusyTransactionError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
}

async function beginWriteTransaction(client: SettlementClient) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await client.transaction("write");
    } catch (error) {
      if (!isBusyTransactionError(error) || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, 10 * (attempt + 1))),
      );
    }
  }
  throw new Error("Could not begin purchase settlement transaction.");
}

export async function settleVerifiedPurchase(
  input: VerifiedPurchaseSettlementInput,
  options: PurchaseSettlementOptions = {},
): Promise<VerifiedPurchaseSettlementResult> {
  validateInput(input);
  await (options.ensureSchemas ?? ensureDefaultSchemas)();

  const client = options.client ?? getTursoClient();
  const transaction = await beginWriteTransaction(client);
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const createId = options.createId ?? randomUUID;
  const payloadJson = stableJson(input.providerVerificationPayload ?? {});
  const verificationHash =
    input.providerVerificationHash?.trim() ||
    hashVerificationPayload(input.providerVerificationPayload ?? {});
  const riskFlags = Array.from(
    new Set(
      (input.riskFlags ?? []).map((flag) => flag.trim()).filter(Boolean),
    ),
  );

  try {
    const balanceInsert = await transaction.execute({
      sql: `INSERT INTO credit_balances (
              anon_user_id,
              available_credits,
              pending_credits,
              updated_at
            )
            VALUES (?, 0, 0, ?)
            ON CONFLICT(anon_user_id) DO NOTHING`,
      args: [input.canonicalAnonUserId, nowIso],
    });
    const balanceWasCreated = balanceInsert.rowsAffected > 0;

    const purchaseCandidates = await loadPurchaseCandidates(
      transaction,
      input,
    );
    if (purchaseCandidates.length > 1) {
      return rollbackAndReturn(transaction, {
        status: "inconsistent_state",
        reason: "multiple_purchase_candidates",
      });
    }
    let purchase = purchaseCandidates[0] ?? null;
    if (purchase) {
      const invalidPurchase = validatePurchase(purchase, input);
      if (invalidPurchase) {
        return rollbackAndReturn(transaction, invalidPurchase);
      }
    }

    const ledgerCandidates = await loadLedgerCandidates(
      transaction,
      input.settlementIdempotencyKey,
    );
    if (ledgerCandidates.length > 1) {
      return rollbackAndReturn(transaction, {
        status: "inconsistent_state",
        reason: "multiple_ledger_candidates",
      });
    }
    let ledger = ledgerCandidates[0] ?? null;
    if (ledger) {
      const invalidLedger = validateLedger(ledger, input, Boolean(purchase));
      if (invalidLedger) {
        return rollbackAndReturn(transaction, invalidLedger);
      }
      if (balanceWasCreated) {
        return rollbackAndReturn(transaction, {
          status: "inconsistent_state",
          reason: "missing_balance_for_existing_grant",
        });
      }
    }

    let purchaseRowId = purchase?.rowId ?? null;
    if (!purchaseRowId) {
      purchaseRowId = createId();
      await transaction.execute({
        sql: `INSERT INTO credit_purchase_transactions (
                row_id,
                provider,
                provider_transaction_id,
                provider_original_transaction_id,
                anon_user_id,
                product_id,
                status,
                granted_credits,
                reversed_credits,
                outstanding_reversal_credits,
                risk_flags_json,
                payload_json,
                verified_at,
                revoked_at,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, 'verified', 0, 0, 0, ?, ?, NULL, NULL, ?, ?)`,
        args: [
          purchaseRowId,
          input.provider,
          input.providerTransactionId,
          input.providerOriginalTransactionId?.trim() || null,
          input.canonicalAnonUserId,
          input.productId,
          JSON.stringify(riskFlags),
          payloadJson,
          nowIso,
          nowIso,
        ],
      });
      await options.faultInjector?.("after_purchase_insert");
    }

    const links = await loadLinkCandidates(
      transaction,
      purchaseRowId,
      ledger?.entryId ?? null,
    );
    const linkValidation = validateLinks(
      links,
      purchaseRowId,
      ledger?.entryId ?? null,
    );
    if (linkValidation.result) {
      return rollbackAndReturn(transaction, linkValidation.result);
    }

    if (purchase && ledger && linkValidation.exactLink) {
      const balanceResult = await transaction.execute({
        sql: `SELECT available_credits, pending_credits, updated_at
              FROM credit_balances
              WHERE anon_user_id = ?`,
        args: [input.canonicalAnonUserId],
      });
      const balanceRow = balanceResult.rows[0] as
        | Record<string, unknown>
        | undefined;
      if (!balanceRow) {
        return rollbackAndReturn(transaction, {
          status: "inconsistent_state",
          reason: "missing_balance_for_existing_grant",
        });
      }
      const replayResult: VerifiedPurchaseSettlementSuccess = {
        status: "replay",
        purchase,
        balance: rowToBalance(balanceRow, input.canonicalAnonUserId),
        ledgerEntryId: ledger.entryId,
      };
      // A completed replay performs no financial writes. Roll back the read
      // transaction so local libSQL can immediately release every statement.
      await transaction.rollback();
      if (options.afterCommit) {
        try {
          await options.afterCommit(replayResult);
        } catch (error) {
          logAfterCommitFailure(replayResult.status, error);
        }
      }
      return replayResult;
    }

    const isNewSettlement = !purchase && !ledger;
    if (!ledger) {
      const balanceBeforeResult = await transaction.execute({
        sql: `SELECT available_credits, pending_credits
              FROM credit_balances
              WHERE anon_user_id = ?`,
        args: [input.canonicalAnonUserId],
      });
      const balanceBefore = balanceBeforeResult.rows[0] as
        | Record<string, unknown>
        | undefined;
      if (!balanceBefore) {
        throw new Error("Could not resolve credit balance for settlement.");
      }

      const ledgerEntryId = createId();
      const ledgerMetadata = {
        reason: "Verified provider purchase settlement.",
        provider: input.provider,
        productId: input.productId,
        providerTransactionId: input.providerTransactionId,
        providerOriginalTransactionId:
          input.providerOriginalTransactionId?.trim() || null,
        providerVerificationHash: verificationHash,
        currency: input.currency ?? null,
        price: input.price ?? null,
        providerMetadata: input.providerMetadata ?? {},
      };
      const insertedLedger = await transaction.execute({
        sql: `INSERT INTO credit_ledger_entries (
                entry_id,
                anon_user_id,
                event_type,
                amount,
                balance_available_after,
                balance_pending_after,
                reservation_id,
                idempotency_scope,
                idempotency_key,
                actor,
                metadata_json,
                created_at
              )
              VALUES (?, ?, 'purchase_grant', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        args: [
          ledgerEntryId,
          input.canonicalAnonUserId,
          input.verifiedCredits,
          asInteger(balanceBefore.available_credits) + input.verifiedCredits,
          asInteger(balanceBefore.pending_credits),
          PURCHASE_LEDGER_SCOPE,
          input.settlementIdempotencyKey,
          "purchase_verification",
          stableJson(ledgerMetadata),
          nowIso,
        ],
      });
      if (insertedLedger.rowsAffected !== 1) {
        throw new Error("Could not insert purchase ledger grant.");
      }
      ledger = {
        entryId: ledgerEntryId,
        anonUserId: input.canonicalAnonUserId,
        eventType: "purchase_grant",
        amount: input.verifiedCredits,
        balanceAvailableAfter:
          asInteger(balanceBefore.available_credits) + input.verifiedCredits,
        balancePendingAfter: asInteger(balanceBefore.pending_credits),
        metadata: ledgerMetadata,
      };
      await options.faultInjector?.("after_ledger_insert");

      const balanceUpdate = await transaction.execute({
        sql: `UPDATE credit_balances
              SET available_credits = available_credits + ?,
                  updated_at = ?
              WHERE anon_user_id = ?
              RETURNING available_credits, pending_credits, updated_at`,
        args: [
          input.verifiedCredits,
          nowIso,
          input.canonicalAnonUserId,
        ],
      });
      if (balanceUpdate.rows.length !== 1) {
        throw new Error("Could not update purchase credit balance.");
      }
      await options.faultInjector?.("after_balance_update");
    }

    const refreshedLinks = await loadLinkCandidates(
      transaction,
      purchaseRowId,
      ledger.entryId,
    );
    const refreshedLinkValidation = validateLinks(
      refreshedLinks,
      purchaseRowId,
      ledger.entryId,
    );
    if (refreshedLinkValidation.result) {
      return rollbackAndReturn(transaction, refreshedLinkValidation.result);
    }
    if (!refreshedLinkValidation.exactLink) {
      await transaction.execute({
        sql: `INSERT INTO credit_purchase_ledger_links (
                id,
                purchase_transaction_id,
                ledger_entry_id,
                link_kind,
                created_at
              )
              VALUES (?, ?, ?, 'base_grant', ?)`,
        args: [createId(), purchaseRowId, ledger.entryId, nowIso],
      });
      await options.faultInjector?.("after_link_insert");
    }

    const mergedRiskFlags = Array.from(
      new Set([...(purchase?.riskFlags ?? []), ...riskFlags]),
    );
    const finalPurchase = await transaction.execute({
      sql: `UPDATE credit_purchase_transactions
            SET provider_original_transaction_id = COALESCE(
                  provider_original_transaction_id,
                  ?
                ),
                status = 'verified',
                granted_credits = ?,
                reversed_credits = 0,
                outstanding_reversal_credits = 0,
                risk_flags_json = ?,
                payload_json = ?,
                verified_at = COALESCE(verified_at, ?),
                revoked_at = NULL,
                updated_at = ?
            WHERE row_id = ?
            RETURNING
              row_id,
              provider,
              provider_transaction_id,
              provider_original_transaction_id,
              anon_user_id,
              product_id,
              status,
              granted_credits,
              reversed_credits,
              outstanding_reversal_credits,
              risk_flags_json,
              payload_json,
              verified_at,
              revoked_at,
              created_at,
              updated_at`,
      args: [
        input.providerOriginalTransactionId?.trim() || null,
        input.verifiedCredits,
        JSON.stringify(mergedRiskFlags),
        payloadJson,
        input.verifiedAt,
        nowIso,
        purchaseRowId,
      ],
    });
    const finalPurchaseRow = finalPurchase.rows[0] as
      | Record<string, unknown>
      | undefined;
    if (!finalPurchaseRow) {
      throw new Error("Could not finalize verified purchase settlement.");
    }
    purchase = rowToPurchase(finalPurchaseRow);

    const finalBalance = await transaction.execute({
      sql: `SELECT available_credits, pending_credits, updated_at
            FROM credit_balances
            WHERE anon_user_id = ?`,
      args: [input.canonicalAnonUserId],
    });
    const finalBalanceRow = finalBalance.rows[0] as
      | Record<string, unknown>
      | undefined;
    if (!finalBalanceRow) {
      throw new Error("Could not load settled credit balance.");
    }

    const result: VerifiedPurchaseSettlementSuccess = {
      status: isNewSettlement ? "settled" : "recovered",
      purchase,
      balance: rowToBalance(finalBalanceRow, input.canonicalAnonUserId),
      ledgerEntryId: ledger.entryId,
    };
    await transaction.commit();
    if (options.afterCommit) {
      try {
        await options.afterCommit(result);
      } catch (error) {
        logAfterCommitFailure(result.status, error);
      }
    }
    return result;
  } catch (error) {
    if (!transaction.closed) {
      await transaction.rollback();
    }
    throw error;
  } finally {
    transaction.close();
  }
}
