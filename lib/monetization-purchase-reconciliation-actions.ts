import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import type { Client } from "@libsql/client";
import {
  getCreditsForProduct,
  type PurchaseProvider,
} from "./monetization-credit-packs.ts";
import {
  findPurchaseReconciliationEvidence,
  type PurchaseReconciliationEvidence,
  type PurchaseReconciliationIssueType,
} from "./monetization-purchase-reconciliation.ts";
import { insertCompletedPurchaseReconciliationAudit } from "./monetization-purchase-reconciliation-audit.ts";
import { settleVerifiedPurchase } from "./monetization-purchase-settlement.ts";
import {
  buildLegacyGooglePurchaseTransactionIdForLookup,
  verifyProviderPurchase,
  type AppleVerificationInput,
  type GoogleVerificationInput,
  type VerificationResult,
} from "./monetization-provider-verification.ts";
import { getTursoClient } from "./turso.ts";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_REASON_LENGTH = 500;
const MAX_GOOGLE_TOKEN_LENGTH = 20_000;
const SUPPORTED_ISSUE_TYPES = new Set<PurchaseReconciliationIssueType>([
  "missing_purchase_ledger_link",
  "purchase_missing_grant",
  "grant_missing_purchase",
  "credit_amount_mismatch",
]);

type ResolutionClient = Pick<Client, "execute" | "transaction">;
type ProviderVerifier = (
  provider: PurchaseProvider,
  input: AppleVerificationInput | GoogleVerificationInput,
) => Promise<VerificationResult>;

export type PurchaseResolutionPreview = {
  issueId: string;
  issueType: PurchaseReconciliationIssueType;
  maskedProviderTransactionId: string;
  userId: string;
  provider: "apple_app_store" | "google_play" | "unknown";
  productId: string;
  currentBalance: number;
  expectedCredits: number | null;
  recordedCredits: number | null;
  proposedCreditDelta: number;
  resultingBalance: number;
  providerVerificationStatus: "verified" | "not_required" | "failed";
  automaticResolutionSupported: boolean;
  manualInvestigationReason: string | null;
  requiredConfirmationPhrase: string;
  previewFingerprint: string;
  previewExpiresAt: string;
};

export type PurchaseResolutionResult = {
  status: "resolved" | "replayed";
  actionId: string;
  issueId: string;
  issueType: PurchaseReconciliationIssueType;
  creditDelta: number;
  balanceBefore: number;
  balanceAfter: number;
};

export type PurchaseResolutionFaultStage =
  | "after_financial_write"
  | "after_audit_insert";

type ActionOptions = {
  client?: ResolutionClient;
  verifyProvider?: ProviderVerifier;
  previewSecret?: string;
  now?: () => Date;
  previewTtlMs?: number;
  createId?: () => string;
  faultInjector?: (
    stage: PurchaseResolutionFaultStage,
  ) => void | Promise<void>;
};

type PreviewTokenPayload = {
  version: 1;
  issueId: string;
  issueType: PurchaseReconciliationIssueType;
  issueSnapshotHash: string;
  providerVerificationHash: string;
  currentBalance: number;
  expectedCredits: number | null;
  recordedCredits: number | null;
  proposedCreditDelta: number;
  resultingBalance: number;
  automaticResolutionSupported: boolean;
  confirmationPhrase: string;
  expiresAtMs: number;
};

type EvaluatedIssue = {
  evidence: PurchaseReconciliationEvidence;
  automaticResolutionSupported: boolean;
  manualInvestigationReason: string | null;
  expectedCredits: number | null;
  recordedCredits: number | null;
  proposedCreditDelta: number;
  resultingBalance: number;
  providerVerificationStatus: "verified" | "not_required" | "failed";
  providerVerificationHash: string;
  verification: VerificationResult | null;
  safeProviderPayload: Record<string, unknown>;
  issueSnapshotHash: string;
};

export class PurchaseReconciliationActionError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeProviderValue(
  value: unknown,
  transientSecrets: readonly string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((nested) =>
      sanitizeProviderValue(nested, transientSecrets),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/(token|receipt|secret|credential)/i.test(key))
        .map(([key, nested]) => [
          key,
          sanitizeProviderValue(nested, transientSecrets),
        ]),
    );
  }
  if (
    typeof value === "string" &&
    transientSecrets.some((secret) => secret && value.includes(secret))
  ) {
    return "[redacted]";
  }
  return value;
}

function safeProviderPayload(
  value: Record<string, unknown>,
  transientSecrets: readonly string[],
) {
  const sanitized = sanitizeProviderValue(value, transientSecrets);
  return typeof sanitized === "object" && sanitized !== null
    ? (sanitized as Record<string, unknown>)
    : {};
}

function getPreviewSecret(override?: string) {
  const secret =
    override?.trim() ||
    process.env.AUTH_SESSION_SECRET?.trim() ||
    process.env.INTERNAL_API_TOKEN?.trim() ||
    process.env.MONETIZATION_ADMIN_TOKEN?.trim();
  if (!secret) {
    throw new PurchaseReconciliationActionError(
      "preview_signing_unavailable",
      "Purchase resolution preview signing is unavailable.",
      500,
    );
  }
  return secret;
}

function encodePreviewToken(payload: PreviewTokenPayload, secret: string) {
  const encodedPayload = Buffer.from(stableJson(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function decodePreviewToken(value: string, secret: string) {
  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    throw new PurchaseReconciliationActionError(
      "invalid_preview",
      "The purchase resolution preview is invalid.",
      409,
    );
  }
  const expected = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new PurchaseReconciliationActionError(
      "invalid_preview",
      "The purchase resolution preview is invalid.",
      409,
    );
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as PreviewTokenPayload;
    if (
      payload.version !== 1 ||
      typeof payload.issueId !== "string" ||
      typeof payload.issueSnapshotHash !== "string" ||
      typeof payload.providerVerificationHash !== "string" ||
      typeof payload.expiresAtMs !== "number"
    ) {
      throw new Error("invalid");
    }
    return payload;
  } catch {
    throw new PurchaseReconciliationActionError(
      "invalid_preview",
      "The purchase resolution preview is invalid.",
      409,
    );
  }
}

function confirmationPhrase(issueId: string) {
  return `RESOLVE PURCHASE ISSUE ${issueId.slice(0, 8).toUpperCase()}`;
}

function issueSnapshotHash(evidence: PurchaseReconciliationEvidence) {
  return sha256(
    stableJson({
      issueId: evidence.issue.id,
      issueType: evidence.issue.issueType,
      purchaseRowId: evidence.purchaseRowId,
      ledgerEntryId: evidence.ledgerEntryId,
      provider: evidence.issue.provider,
      providerTransactionHash: sha256(evidence.providerTransactionId),
      userIdHash: sha256(evidence.userId),
      productId: evidence.productId,
      purchaseStatus: evidence.purchaseStatus,
      purchaseVerifiedAt: evidence.purchaseVerifiedAt,
      purchaseGrantedCredits: evidence.purchaseGrantedCredits,
      recordedCredits: evidence.recordedCredits,
      ledgerOwnerHash: evidence.ledgerOwnerId
        ? sha256(evidence.ledgerOwnerId)
        : null,
      ledgerIdempotencyScope: evidence.ledgerIdempotencyScope,
      ledgerIdempotencyKeyHash: evidence.ledgerIdempotencyKey
        ? sha256(evidence.ledgerIdempotencyKey)
        : null,
      currentBalance: evidence.issue.currentBalance,
      balanceExists: evidence.balanceExists,
      blockingIssueTypes: evidence.blockingIssueTypes,
    }),
  );
}

function isDeterministicPurchaseLedger(
  evidence: PurchaseReconciliationEvidence,
) {
  return (
    evidence.ledgerIdempotencyScope === "purchase-credit-grant" &&
    evidence.ledgerIdempotencyKey ===
      `${evidence.issue.provider}:${evidence.providerTransactionId}`
  );
}

function providerTransactionMatches(
  evidence: PurchaseReconciliationEvidence,
  verification: VerificationResult,
  googlePurchaseToken: string,
) {
  if (
    verification.providerTransactionId === evidence.providerTransactionId
  ) {
    return true;
  }
  return (
    evidence.issue.provider === "google_play" &&
    buildLegacyGooglePurchaseTransactionIdForLookup(googlePurchaseToken) ===
      evidence.providerTransactionId
  );
}

async function reverifyIssue(
  evidence: PurchaseReconciliationEvidence,
  googlePurchaseToken: string,
  verifier: ProviderVerifier,
) {
  const provider = evidence.issue.provider;
  if (provider === "unknown") {
    throw new PurchaseReconciliationActionError(
      "provider_unavailable",
      "The purchase provider cannot be resolved safely.",
      409,
    );
  }
  let verification: VerificationResult;
  try {
    if (provider === "google_play") {
      const token = googlePurchaseToken.trim();
      if (!token) {
        throw new PurchaseReconciliationActionError(
          "google_purchase_token_required",
          "A Google purchase token is required for provider reverification.",
          400,
        );
      }
      if (token.length > MAX_GOOGLE_TOKEN_LENGTH) {
        throw new PurchaseReconciliationActionError(
          "google_purchase_token_invalid",
          "The Google purchase token is invalid.",
          400,
        );
      }
      verification = await verifier(provider, {
        purchaseToken: token,
        expectedProductId: evidence.productId,
      });
    } else {
      verification = await verifier(provider, {
        transactionId: evidence.providerTransactionId,
        expectedProductId: evidence.productId,
      });
    }
  } catch (error) {
    if (error instanceof PurchaseReconciliationActionError) {
      throw error;
    }
    throw new PurchaseReconciliationActionError(
      "provider_reverification_failed",
      "The purchase could not be freshly verified with the provider.",
      409,
    );
  }

  if (
    verification.provider !== provider ||
    verification.state !== "purchased" ||
    verification.revokedAt !== null ||
    verification.productId !== evidence.productId ||
    !providerTransactionMatches(evidence, verification, googlePurchaseToken) ||
    verification.riskFlags.some((flag) =>
      /(cancel|fraud|refund|revok)/i.test(flag),
    )
  ) {
    throw new PurchaseReconciliationActionError(
      "provider_facts_conflict",
      "Fresh provider verification does not match the reconciliation issue.",
      409,
    );
  }
  const expectedCredits = getCreditsForProduct(
    provider,
    verification.productId,
  );
  if (!expectedCredits) {
    throw new PurchaseReconciliationActionError(
      "product_credit_value_unavailable",
      "The verified product does not have a configured credit value.",
      409,
    );
  }
  const payload = safeProviderPayload(
    verification.payload,
    googlePurchaseToken ? [googlePurchaseToken] : [],
  );
  const providerVerificationHash = sha256(
    stableJson({
      provider: verification.provider,
      providerTransactionIdHash: sha256(
        verification.providerTransactionId,
      ),
      providerOriginalTransactionIdHash:
        verification.providerOriginalTransactionId
          ? sha256(verification.providerOriginalTransactionId)
          : null,
      productId: verification.productId,
      state: verification.state,
      purchasedAt: verification.purchasedAt,
      revokedAt: verification.revokedAt,
      riskFlags: verification.riskFlags,
      payload,
    }),
  );
  return {
    verification,
    expectedCredits,
    providerVerificationHash,
    safeProviderPayload: payload,
  };
}

async function evaluateIssue(
  evidence: PurchaseReconciliationEvidence,
  googlePurchaseToken: string,
  verifier: ProviderVerifier,
): Promise<EvaluatedIssue> {
  const issueType = evidence.issue.issueType;
  const currentBalance = evidence.issue.currentBalance;
  const snapshotHash = issueSnapshotHash(evidence);
  if (!SUPPORTED_ISSUE_TYPES.has(issueType)) {
    return {
      evidence,
      automaticResolutionSupported: false,
      manualInvestigationReason: "Manual investigation required",
      expectedCredits: evidence.purchaseGrantedCredits,
      recordedCredits: evidence.recordedCredits,
      proposedCreditDelta: 0,
      resultingBalance: currentBalance,
      providerVerificationStatus: "not_required",
      providerVerificationHash: sha256(`manual:${snapshotHash}`),
      verification: null,
      safeProviderPayload: {},
      issueSnapshotHash: snapshotHash,
    };
  }

  if (evidence.blockingIssueTypes.length > 0) {
    return {
      evidence,
      automaticResolutionSupported: false,
      manualInvestigationReason:
        "Manual investigation required because this transaction also has an ownership, duplicate-grant, or product/transaction conflict.",
      expectedCredits: evidence.purchaseGrantedCredits,
      recordedCredits: evidence.recordedCredits,
      proposedCreditDelta: 0,
      resultingBalance: currentBalance,
      providerVerificationStatus: "not_required",
      providerVerificationHash: sha256(`blocked:${snapshotHash}`),
      verification: null,
      safeProviderPayload: {},
      issueSnapshotHash: snapshotHash,
    };
  }

  if (
    issueType !== "purchase_missing_grant" &&
    !isDeterministicPurchaseLedger(evidence)
  ) {
    return {
      evidence,
      automaticResolutionSupported: false,
      manualInvestigationReason:
        "Manual investigation required because the ledger relationship is not deterministic.",
      expectedCredits: evidence.purchaseGrantedCredits,
      recordedCredits: evidence.recordedCredits,
      proposedCreditDelta: 0,
      resultingBalance: currentBalance,
      providerVerificationStatus: "not_required",
      providerVerificationHash: sha256(`legacy:${snapshotHash}`),
      verification: null,
      safeProviderPayload: {},
      issueSnapshotHash: snapshotHash,
    };
  }

  if (issueType === "missing_purchase_ledger_link") {
    const expectedCredits = evidence.purchaseGrantedCredits;
    const recordedCredits = evidence.recordedCredits;
    const exact =
      evidence.purchaseRowId &&
      evidence.ledgerEntryId &&
      evidence.purchaseStatus === "verified" &&
      evidence.ledgerOwnerId === evidence.userId &&
      expectedCredits !== null &&
      expectedCredits === recordedCredits;
    return {
      evidence,
      automaticResolutionSupported: Boolean(exact),
      manualInvestigationReason: exact
        ? null
        : "Manual investigation required because the purchase and ledger facts are not an exact match.",
      expectedCredits,
      recordedCredits,
      proposedCreditDelta: 0,
      resultingBalance: currentBalance,
      providerVerificationStatus: "not_required",
      providerVerificationHash: sha256(`not-required:${snapshotHash}`),
      verification: null,
      safeProviderPayload: {},
      issueSnapshotHash: snapshotHash,
    };
  }

  if (
    evidence.issue.provider === "google_play" &&
    evidence.providerTransactionId.startsWith("token:")
  ) {
    return {
      evidence,
      automaticResolutionSupported: false,
      manualInvestigationReason:
        "Manual investigation required because this legacy record contains a plaintext provider token identifier that must not be copied into new financial records.",
      expectedCredits: evidence.purchaseGrantedCredits,
      recordedCredits: evidence.recordedCredits,
      proposedCreditDelta: 0,
      resultingBalance: currentBalance,
      providerVerificationStatus: "not_required",
      providerVerificationHash: sha256(`legacy-secret:${snapshotHash}`),
      verification: null,
      safeProviderPayload: {},
      issueSnapshotHash: snapshotHash,
    };
  }

  let verified: Awaited<ReturnType<typeof reverifyIssue>>;
  try {
    verified = await reverifyIssue(
      evidence,
      googlePurchaseToken,
      verifier,
    );
  } catch (error) {
    if (
      error instanceof PurchaseReconciliationActionError &&
      error.code !== "google_purchase_token_required" &&
      error.code !== "google_purchase_token_invalid"
    ) {
      return {
        evidence,
        automaticResolutionSupported: false,
        manualInvestigationReason:
          "Manual investigation required because fresh provider verification did not prove a safe correction.",
        expectedCredits: evidence.purchaseGrantedCredits,
        recordedCredits: evidence.recordedCredits,
        proposedCreditDelta: 0,
        resultingBalance: currentBalance,
        providerVerificationStatus: "failed",
        providerVerificationHash: sha256(`provider-failed:${snapshotHash}`),
        verification: null,
        safeProviderPayload: {},
        issueSnapshotHash: snapshotHash,
      };
    }
    throw error;
  }
  let recordedCredits = evidence.recordedCredits ?? 0;
  let supported = true;
  let manualReason: string | null = null;
  if (
    issueType === "purchase_missing_grant" &&
    (evidence.purchaseStatus !== "verified" ||
      evidence.purchaseGrantedCredits !== verified.expectedCredits)
  ) {
    supported = false;
    manualReason =
      "Manual investigation required because the stored purchase amount or status conflicts with fresh verification.";
  }
  if (
    issueType === "grant_missing_purchase" &&
    (!evidence.balanceExists ||
      evidence.ledgerOwnerId !== evidence.userId ||
      recordedCredits !== verified.expectedCredits)
  ) {
    supported = false;
    manualReason =
      "Manual investigation required because the existing grant does not match fresh verification.";
  }
  if (
    issueType === "credit_amount_mismatch" &&
    (!evidence.balanceExists ||
      evidence.purchaseStatus !== "verified" ||
      evidence.purchaseGrantedCredits !== verified.expectedCredits)
  ) {
    supported = false;
    manualReason =
      "Manual investigation required because the purchase record does not match the freshly verified product value.";
  }
  if (issueType === "purchase_missing_grant") {
    recordedCredits = 0;
  }
  const delta =
    issueType === "grant_missing_purchase"
      ? 0
      : verified.expectedCredits - recordedCredits;
  const resultingBalance = currentBalance + delta;
  if (delta < 0 && resultingBalance < 0) {
    supported = false;
    manualReason =
      "Manual investigation required because the available balance cannot safely absorb the correction.";
  }
  return {
    evidence,
    automaticResolutionSupported: supported,
    manualInvestigationReason: manualReason,
    expectedCredits: verified.expectedCredits,
    recordedCredits,
    proposedCreditDelta: delta,
    resultingBalance,
    providerVerificationStatus: "verified",
    providerVerificationHash: verified.providerVerificationHash,
    verification: verified.verification,
    safeProviderPayload: verified.safeProviderPayload,
    issueSnapshotHash: snapshotHash,
  };
}

export async function previewPurchaseReconciliationResolution(
  input: { issueId: string; googlePurchaseToken?: string | null },
  options: ActionOptions = {},
): Promise<PurchaseResolutionPreview> {
  const issueId = input.issueId.trim();
  if (!issueId) {
    throw new PurchaseReconciliationActionError(
      "issue_id_required",
      "issueId is required.",
      400,
    );
  }
  const client = options.client ?? getTursoClient();
  const evidence = await findPurchaseReconciliationEvidence(issueId, {
    client,
    now: options.now,
  });
  if (!evidence) {
    throw new PurchaseReconciliationActionError(
      "issue_not_found",
      "The reconciliation issue no longer exists.",
      409,
    );
  }
  const evaluated = await evaluateIssue(
    evidence,
    input.googlePurchaseToken?.trim() ?? "",
    options.verifyProvider ?? verifyProviderPurchase,
  );
  const now = (options.now ?? (() => new Date()))();
  const expiresAtMs =
    now.getTime() + (options.previewTtlMs ?? PREVIEW_TTL_MS);
  const phrase = evaluated.automaticResolutionSupported
    ? confirmationPhrase(issueId)
    : "";
  const tokenPayload: PreviewTokenPayload = {
    version: 1,
    issueId,
    issueType: evidence.issue.issueType,
    issueSnapshotHash: evaluated.issueSnapshotHash,
    providerVerificationHash: evaluated.providerVerificationHash,
    currentBalance: evidence.issue.currentBalance,
    expectedCredits: evaluated.expectedCredits,
    recordedCredits: evaluated.recordedCredits,
    proposedCreditDelta: evaluated.proposedCreditDelta,
    resultingBalance: evaluated.resultingBalance,
    automaticResolutionSupported: evaluated.automaticResolutionSupported,
    confirmationPhrase: phrase,
    expiresAtMs,
  };
  return {
    issueId,
    issueType: evidence.issue.issueType,
    maskedProviderTransactionId:
      evidence.issue.maskedProviderTransactionId,
    userId: evidence.issue.userId,
    provider: evidence.issue.provider,
    productId: evidence.productId,
    currentBalance: evidence.issue.currentBalance,
    expectedCredits: evaluated.expectedCredits,
    recordedCredits: evaluated.recordedCredits,
    proposedCreditDelta: evaluated.proposedCreditDelta,
    resultingBalance: evaluated.resultingBalance,
    providerVerificationStatus: evaluated.providerVerificationStatus,
    automaticResolutionSupported: evaluated.automaticResolutionSupported,
    manualInvestigationReason: evaluated.manualInvestigationReason,
    requiredConfirmationPhrase: phrase,
    previewFingerprint: encodePreviewToken(
      tokenPayload,
      getPreviewSecret(options.previewSecret),
    ),
    previewExpiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function isBusyError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
}

async function beginWriteTransaction(client: ResolutionClient) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await client.transaction("write");
    } catch (error) {
      if (!isBusyError(error) || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, 10 * (attempt + 1))),
      );
    }
  }
  throw new Error("Could not begin reconciliation transaction.");
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

async function loadExistingAudit(
  client: Pick<ResolutionClient, "execute">,
  idempotencyKey: string,
) {
  const result = await client.execute({
    sql: `SELECT
            id, issue_type, preview_fingerprint, balance_before,
            balance_after, credit_delta, status, metadata_json
          FROM purchase_reconciliation_actions
          WHERE idempotency_key = ?
          LIMIT 1`,
    args: [idempotencyKey],
  });
  return result.rows[0] as Record<string, unknown> | undefined;
}

function replayResultFromAudit(
  row: Record<string, unknown>,
  issueId: string,
): PurchaseResolutionResult {
  return {
    status: "replayed",
    actionId: asString(row.id),
    issueId,
    issueType: asString(row.issue_type) as PurchaseReconciliationIssueType,
    creditDelta: asInteger(row.credit_delta),
    balanceBefore: asInteger(row.balance_before),
    balanceAfter: asInteger(row.balance_after),
  };
}

function auditMetadata(
  evaluated: EvaluatedIssue,
  resolutionKind: string,
) {
  return {
    resolutionKind,
    issueId: evaluated.evidence.issue.id,
    provider: evaluated.evidence.issue.provider,
    productId: evaluated.evidence.productId,
    providerTransactionHash: sha256(
      evaluated.evidence.providerTransactionId,
    ),
  };
}

async function resolveMissingLink(
  evaluated: EvaluatedIssue,
  token: PreviewTokenPayload,
  context: {
    client: ResolutionClient;
    actor: string;
    reason: string;
    previewFingerprint: string;
    idempotencyKey: string;
    providerVerificationHash: string;
    nowIso: string;
    createId: () => string;
    faultInjector?: ActionOptions["faultInjector"];
  },
) {
  const evidence = evaluated.evidence;
  const transaction = await beginWriteTransaction(context.client);
  try {
    const facts = await transaction.execute({
      sql: `SELECT
              purchase.row_id,
              purchase.provider,
              purchase.provider_transaction_id,
              purchase.anon_user_id,
              purchase.product_id,
              purchase.status,
              purchase.granted_credits,
              ledger.entry_id,
              ledger.anon_user_id AS ledger_owner,
              ledger.event_type,
              ledger.amount,
              ledger.idempotency_scope,
              ledger.idempotency_key,
              balance.available_credits
            FROM credit_purchase_transactions AS purchase
            JOIN credit_ledger_entries AS ledger ON ledger.entry_id = ?
            LEFT JOIN credit_balances AS balance
              ON balance.anon_user_id = purchase.anon_user_id
            WHERE purchase.row_id = ?`,
      args: [evidence.ledgerEntryId!, evidence.purchaseRowId!],
    });
    const row = facts.rows[0] as Record<string, unknown> | undefined;
    const expectedKey = `${evidence.issue.provider}:${evidence.providerTransactionId}`;
    if (
      !row ||
      asString(row.provider) !== evidence.issue.provider ||
      asString(row.provider_transaction_id) !== evidence.providerTransactionId ||
      asString(row.anon_user_id) !== evidence.userId ||
      asString(row.product_id) !== evidence.productId ||
      asString(row.status) !== "verified" ||
      asInteger(row.granted_credits) !== token.expectedCredits ||
      asString(row.ledger_owner) !== evidence.userId ||
      asString(row.event_type) !== "purchase_grant" ||
      asInteger(row.amount) !== token.recordedCredits ||
      asString(row.idempotency_scope) !== "purchase-credit-grant" ||
      asString(row.idempotency_key) !== expectedKey ||
      asInteger(row.available_credits) !== token.currentBalance
    ) {
      throw new PurchaseReconciliationActionError(
        "issue_changed",
        "The reconciliation issue changed after preview.",
        409,
      );
    }
    const existingLinks = await transaction.execute({
      sql: `SELECT id
            FROM credit_purchase_ledger_links
            WHERE (purchase_transaction_id = ? AND link_kind = 'base_grant')
               OR ledger_entry_id = ?`,
      args: [evidence.purchaseRowId!, evidence.ledgerEntryId!],
    });
    if (existingLinks.rows.length > 0) {
      throw new PurchaseReconciliationActionError(
        "issue_changed",
        "The reconciliation issue changed after preview.",
        409,
      );
    }
    const associationCandidates = await transaction.execute({
      sql: `SELECT entry_id
            FROM credit_ledger_entries
            WHERE event_type = 'purchase_grant'
              AND (
                (idempotency_scope = 'purchase-credit-grant'
                  AND idempotency_key = ?)
                OR (
                  json_valid(metadata_json)
                  AND json_extract(metadata_json, '$.provider') = ?
                  AND json_extract(metadata_json, '$.providerTransactionId') = ?
                )
              )`,
      args: [
        expectedKey,
        evidence.issue.provider,
        evidence.providerTransactionId,
      ],
    });
    if (
      associationCandidates.rows.length !== 1 ||
      asString(associationCandidates.rows[0]?.entry_id) !==
        evidence.ledgerEntryId
    ) {
      throw new PurchaseReconciliationActionError(
        "issue_changed",
        "The reconciliation issue became ambiguous after preview.",
        409,
      );
    }
    await transaction.execute({
      sql: `INSERT INTO credit_purchase_ledger_links (
              id, purchase_transaction_id, ledger_entry_id,
              link_kind, created_at
            ) VALUES (?, ?, ?, 'base_grant', ?)`,
      args: [
        context.createId(),
        evidence.purchaseRowId!,
        evidence.ledgerEntryId!,
        context.nowIso,
      ],
    });
    await context.faultInjector?.("after_financial_write");
    const actionId = context.createId();
    await insertCompletedPurchaseReconciliationAudit(transaction, {
      actionId,
      issueType: evidence.issue.issueType,
      purchaseTransactionId: evidence.purchaseRowId,
      ledgerEntryId: evidence.ledgerEntryId,
      adminActor: context.actor,
      reason: context.reason,
      previewFingerprint: context.previewFingerprint,
      idempotencyKey: context.idempotencyKey,
      balanceBefore: token.currentBalance,
      balanceAfter: token.resultingBalance,
      creditDelta: token.proposedCreditDelta,
      providerVerificationHash: context.providerVerificationHash,
      completedAt: context.nowIso,
      metadata: auditMetadata(evaluated, "create_base_grant_link"),
    });
    await context.faultInjector?.("after_audit_insert");
    await transaction.commit();
    return actionId;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function resolveAmountMismatch(
  evaluated: EvaluatedIssue,
  token: PreviewTokenPayload,
  context: {
    client: ResolutionClient;
    actor: string;
    reason: string;
    previewFingerprint: string;
    idempotencyKey: string;
    providerVerificationHash: string;
    nowIso: string;
    createId: () => string;
    faultInjector?: ActionOptions["faultInjector"];
  },
) {
  const evidence = evaluated.evidence;
  const transaction = await beginWriteTransaction(context.client);
  try {
    const facts = await transaction.execute({
      sql: `SELECT
              purchase.row_id,
              purchase.provider,
              purchase.provider_transaction_id,
              purchase.anon_user_id,
              purchase.product_id,
              purchase.status,
              purchase.granted_credits,
              ledger.entry_id,
              ledger.anon_user_id AS ledger_owner,
              ledger.event_type,
              ledger.amount,
              ledger.idempotency_scope,
              ledger.idempotency_key,
              balance.available_credits,
              balance.pending_credits
            FROM credit_purchase_transactions AS purchase
            JOIN credit_purchase_ledger_links AS base_link
              ON base_link.purchase_transaction_id = purchase.row_id
             AND base_link.link_kind = 'base_grant'
            JOIN credit_ledger_entries AS ledger
              ON ledger.entry_id = base_link.ledger_entry_id
            JOIN credit_balances AS balance
              ON balance.anon_user_id = purchase.anon_user_id
            WHERE purchase.row_id = ?
              AND ledger.entry_id = ?`,
      args: [evidence.purchaseRowId!, evidence.ledgerEntryId!],
    });
    const row = facts.rows[0] as Record<string, unknown> | undefined;
    const expectedKey = `${evidence.issue.provider}:${evidence.providerTransactionId}`;
    const adjustments = await transaction.execute({
      sql: `SELECT
              COALESCE(SUM(ledger.amount), 0) AS adjustment_total,
              COALESCE(SUM(CASE
                WHEN ledger.anon_user_id <> ?
                  OR ledger.event_type <> 'purchase_adjustment'
                  OR (
                    json_valid(ledger.metadata_json)
                    AND COALESCE(json_extract(ledger.metadata_json, '$.provider'), '') <> ''
                    AND json_extract(ledger.metadata_json, '$.provider') <> ?
                  )
                  OR (
                    json_valid(ledger.metadata_json)
                    AND COALESCE(json_extract(ledger.metadata_json, '$.productId'), '') <> ''
                    AND json_extract(ledger.metadata_json, '$.productId') <> ?
                  )
                  OR (
                    json_valid(ledger.metadata_json)
                    AND COALESCE(json_extract(ledger.metadata_json, '$.providerTransactionId'), '') <> ''
                    AND json_extract(ledger.metadata_json, '$.providerTransactionId') <> ?
                  )
                THEN 1 ELSE 0 END), 0) AS invalid_count
            FROM credit_purchase_ledger_links AS link
            JOIN credit_ledger_entries AS ledger
              ON ledger.entry_id = link.ledger_entry_id
            WHERE link.purchase_transaction_id = ?
              AND link.link_kind = 'repair_adjustment'`,
      args: [
        evidence.userId,
        evidence.issue.provider,
        evidence.productId,
        evidence.providerTransactionId,
        evidence.purchaseRowId!,
      ],
    });
    const recordedCredits =
      asInteger(row?.amount) +
      asInteger(adjustments.rows[0]?.adjustment_total);
    if (
      !row ||
      asString(row.provider) !== evidence.issue.provider ||
      asString(row.provider_transaction_id) !== evidence.providerTransactionId ||
      asString(row.anon_user_id) !== evidence.userId ||
      asString(row.product_id) !== evidence.productId ||
      asString(row.status) !== "verified" ||
      asInteger(row.granted_credits) !== token.expectedCredits ||
      asString(row.ledger_owner) !== evidence.userId ||
      asString(row.event_type) !== "purchase_grant" ||
      asString(row.idempotency_scope) !== "purchase-credit-grant" ||
      asString(row.idempotency_key) !== expectedKey ||
      asInteger(adjustments.rows[0]?.invalid_count) !== 0 ||
      recordedCredits !== token.recordedCredits ||
      asInteger(row.available_credits) !== token.currentBalance ||
      token.proposedCreditDelta !==
        (token.expectedCredits ?? 0) - recordedCredits ||
      token.resultingBalance < 0
    ) {
      throw new PurchaseReconciliationActionError(
        "issue_changed",
        "The reconciliation issue changed after preview.",
        409,
      );
    }
    const associationCandidates = await transaction.execute({
      sql: `SELECT entry_id
            FROM credit_ledger_entries
            WHERE event_type = 'purchase_grant'
              AND (
                (idempotency_scope = 'purchase-credit-grant'
                  AND idempotency_key = ?)
                OR (
                  json_valid(metadata_json)
                  AND json_extract(metadata_json, '$.provider') = ?
                  AND json_extract(metadata_json, '$.providerTransactionId') = ?
                )
              )`,
      args: [
        expectedKey,
        evidence.issue.provider,
        evidence.providerTransactionId,
      ],
    });
    if (
      associationCandidates.rows.length !== 1 ||
      asString(associationCandidates.rows[0]?.entry_id) !==
        evidence.ledgerEntryId
    ) {
      throw new PurchaseReconciliationActionError(
        "issue_changed",
        "The reconciliation issue became ambiguous after preview.",
        409,
      );
    }
    const adjustmentId = context.createId();
    const balanceUpdate = await transaction.execute({
      sql: `UPDATE credit_balances
            SET available_credits = available_credits + ?,
                updated_at = ?
            WHERE anon_user_id = ?
              AND available_credits + ? >= 0
            RETURNING available_credits, pending_credits`,
      args: [
        token.proposedCreditDelta,
        context.nowIso,
        evidence.userId,
        token.proposedCreditDelta,
      ],
    });
    if (
      balanceUpdate.rows.length !== 1 ||
      asInteger(balanceUpdate.rows[0]?.available_credits) !==
        token.resultingBalance
    ) {
      throw new PurchaseReconciliationActionError(
        "insufficient_balance",
        "The available balance cannot safely absorb this correction.",
        409,
      );
    }
    await transaction.execute({
      sql: `INSERT INTO credit_ledger_entries (
              entry_id, anon_user_id, event_type, amount,
              balance_available_after, balance_pending_after,
              reservation_id, idempotency_scope, idempotency_key,
              actor, metadata_json, created_at
            ) VALUES (?, ?, 'purchase_adjustment', ?, ?, ?, NULL,
              'purchase-reconciliation-adjustment', ?,
              'admin_purchase_reconciliation', ?, ?)`,
      args: [
        adjustmentId,
        evidence.userId,
        token.proposedCreditDelta,
        token.resultingBalance,
        asInteger(row.pending_credits),
        context.idempotencyKey,
        stableJson({
          reason: "Audited purchase reconciliation adjustment.",
          issueId: evidence.issue.id,
          provider: evidence.issue.provider,
          productId: evidence.productId,
          providerTransactionHash: sha256(
            evidence.providerTransactionId,
          ),
          providerVerificationHash: context.providerVerificationHash,
        }),
        context.nowIso,
      ],
    });
    await transaction.execute({
      sql: `INSERT INTO credit_purchase_ledger_links (
              id, purchase_transaction_id, ledger_entry_id,
              link_kind, created_at
            ) VALUES (?, ?, ?, 'repair_adjustment', ?)`,
      args: [
        context.createId(),
        evidence.purchaseRowId!,
        adjustmentId,
        context.nowIso,
      ],
    });
    await context.faultInjector?.("after_financial_write");
    const actionId = context.createId();
    await insertCompletedPurchaseReconciliationAudit(transaction, {
      actionId,
      issueType: evidence.issue.issueType,
      purchaseTransactionId: evidence.purchaseRowId,
      ledgerEntryId: adjustmentId,
      adminActor: context.actor,
      reason: context.reason,
      previewFingerprint: context.previewFingerprint,
      idempotencyKey: context.idempotencyKey,
      balanceBefore: token.currentBalance,
      balanceAfter: token.resultingBalance,
      creditDelta: token.proposedCreditDelta,
      providerVerificationHash: context.providerVerificationHash,
      completedAt: context.nowIso,
      metadata: {
        ...auditMetadata(evaluated, "credit_amount_adjustment"),
        baseLedgerEntryId: evidence.ledgerEntryId,
      },
    });
    await context.faultInjector?.("after_audit_insert");
    await transaction.commit();
    return actionId;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}

async function resolveWithAtomicSettlement(
  evaluated: EvaluatedIssue,
  token: PreviewTokenPayload,
  context: {
    client: ResolutionClient;
    actor: string;
    reason: string;
    previewFingerprint: string;
    idempotencyKey: string;
    nowIso: string;
    createId: () => string;
    faultInjector?: ActionOptions["faultInjector"];
  },
) {
  const evidence = evaluated.evidence;
  const verification = evaluated.verification;
  if (!verification || token.expectedCredits === null) {
    throw new PurchaseReconciliationActionError(
      "provider_reverification_required",
      "Fresh provider verification is required for this resolution.",
      409,
    );
  }
  const actionId = context.createId();
  const result = await settleVerifiedPurchase(
    {
      provider: verification.provider,
      providerTransactionId: evidence.providerTransactionId,
      providerOriginalTransactionId:
        verification.providerOriginalTransactionId,
      canonicalAnonUserId: evidence.userId,
      productId: evidence.productId,
      verifiedCredits: token.expectedCredits,
      verifiedAt: verification.purchasedAt ?? context.nowIso,
      settlementIdempotencyKey: `${verification.provider}:${evidence.providerTransactionId}`,
      providerVerificationPayload: evaluated.safeProviderPayload,
      providerVerificationHash: evaluated.providerVerificationHash,
      providerMetadata: {
        verificationState: verification.state,
        reconciliationIssueId: evidence.issue.id,
      },
      riskFlags: verification.riskFlags,
      existingProviderTransactionIdHint:
        verification.providerTransactionId !== evidence.providerTransactionId
          ? evidence.providerTransactionId
          : null,
      expectedBalanceBefore: token.currentBalance,
      reconciliationAudit: {
        actionId,
        issueType: evidence.issue.issueType,
        adminActor: context.actor,
        reason: context.reason,
        previewFingerprint: context.previewFingerprint,
        idempotencyKey: context.idempotencyKey,
        balanceBefore: token.currentBalance,
        balanceAfter: token.resultingBalance,
        creditDelta: token.proposedCreditDelta,
        providerVerificationHash: evaluated.providerVerificationHash,
        metadata: auditMetadata(
          evaluated,
          evidence.issue.issueType === "purchase_missing_grant"
            ? "recover_missing_grant"
            : "recover_missing_purchase",
        ),
      },
    },
    {
      client: context.client,
      ensureSchemas: async () => {},
      now: () => new Date(context.nowIso),
      createId: context.createId,
      faultInjector: async (stage) => {
        if (stage === "after_reconciliation_audit_insert") {
          await context.faultInjector?.("after_audit_insert");
        } else if (
          stage === "after_ledger_insert" ||
          stage === "after_balance_update" ||
          stage === "after_link_insert"
        ) {
          await context.faultInjector?.("after_financial_write");
        }
      },
    },
  );
  if (result.status !== "recovered") {
    throw new PurchaseReconciliationActionError(
      "issue_changed",
      "The reconciliation issue changed after preview.",
      409,
    );
  }
  return actionId;
}

export async function resolvePurchaseReconciliationIssue(
  input: {
    issueId: string;
    previewFingerprint: string;
    confirmation: string;
    reason: string;
    idempotencyKey: string;
    adminActor: string;
    googlePurchaseToken?: string | null;
  },
  options: ActionOptions = {},
): Promise<PurchaseResolutionResult> {
  const issueId = input.issueId.trim();
  const previewFingerprint = input.previewFingerprint.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const reason = input.reason.trim();
  const actor = input.adminActor.trim();
  if (!issueId || !previewFingerprint || !idempotencyKey || !actor) {
    throw new PurchaseReconciliationActionError(
      "resolution_facts_required",
      "The purchase resolution request is incomplete.",
      400,
    );
  }
  if (reason.length < 10 || reason.length > MAX_REASON_LENGTH) {
    throw new PurchaseReconciliationActionError(
      "admin_reason_required",
      "An admin reason of 10 to 500 characters is required.",
      400,
    );
  }
  const client = options.client ?? getTursoClient();
  const existingAudit = await loadExistingAudit(client, idempotencyKey);
  if (existingAudit) {
    if (
      asString(existingAudit.status) === "completed" &&
      asString(existingAudit.preview_fingerprint) === previewFingerprint
    ) {
      return replayResultFromAudit(existingAudit, issueId);
    }
    throw new PurchaseReconciliationActionError(
      "idempotency_conflict",
      "The idempotency key was already used for another resolution.",
      409,
    );
  }

  const secret = getPreviewSecret(options.previewSecret);
  const previewToken = decodePreviewToken(previewFingerprint, secret);
  const now = (options.now ?? (() => new Date()))();
  if (previewToken.expiresAtMs <= now.getTime()) {
    throw new PurchaseReconciliationActionError(
      "preview_expired",
      "The purchase resolution preview expired. Generate a new preview.",
      409,
    );
  }
  if (
    previewToken.issueId !== issueId ||
    !previewToken.automaticResolutionSupported
  ) {
    throw new PurchaseReconciliationActionError(
      "automatic_resolution_unsupported",
      "Manual investigation is required for this issue.",
      409,
    );
  }
  if (input.confirmation !== previewToken.confirmationPhrase) {
    throw new PurchaseReconciliationActionError(
      "confirmation_mismatch",
      "The typed confirmation does not match the required phrase.",
      400,
    );
  }

  const evidence = await findPurchaseReconciliationEvidence(issueId, {
    client,
    now: options.now,
  });
  if (!evidence) {
    throw new PurchaseReconciliationActionError(
      "issue_changed",
      "The reconciliation issue changed or no longer exists.",
      409,
    );
  }
  const evaluated = await evaluateIssue(
    evidence,
    input.googlePurchaseToken?.trim() ?? "",
    options.verifyProvider ?? verifyProviderPurchase,
  );
  if (
    !evaluated.automaticResolutionSupported ||
    previewToken.issueType !== evidence.issue.issueType ||
    previewToken.issueSnapshotHash !== evaluated.issueSnapshotHash ||
    previewToken.providerVerificationHash !==
      evaluated.providerVerificationHash ||
    previewToken.currentBalance !== evidence.issue.currentBalance ||
    previewToken.expectedCredits !== evaluated.expectedCredits ||
    previewToken.recordedCredits !== evaluated.recordedCredits ||
    previewToken.proposedCreditDelta !== evaluated.proposedCreditDelta ||
    previewToken.resultingBalance !== evaluated.resultingBalance
  ) {
    throw new PurchaseReconciliationActionError(
      "issue_changed",
      "The reconciliation issue or provider result changed after preview.",
      409,
    );
  }

  const nowIso = now.toISOString();
  const context = {
    client,
    actor,
    reason,
    previewFingerprint,
    idempotencyKey,
    providerVerificationHash: evaluated.providerVerificationHash,
    nowIso,
    createId: options.createId ?? randomUUID,
    faultInjector: options.faultInjector,
  };
  let actionId: string;
  try {
    if (evidence.issue.issueType === "missing_purchase_ledger_link") {
      actionId = await resolveMissingLink(
        evaluated,
        previewToken,
        context,
      );
    } else if (evidence.issue.issueType === "credit_amount_mismatch") {
      actionId = await resolveAmountMismatch(
        evaluated,
        previewToken,
        context,
      );
    } else {
      actionId = await resolveWithAtomicSettlement(
        evaluated,
        previewToken,
        context,
      );
    }
  } catch (error) {
    const racedAudit = await loadExistingAudit(client, idempotencyKey);
    if (
      racedAudit &&
      asString(racedAudit.status) === "completed" &&
      asString(racedAudit.preview_fingerprint) === previewFingerprint
    ) {
      return replayResultFromAudit(racedAudit, issueId);
    }
    throw error;
  }
  return {
    status: "resolved",
    actionId,
    issueId,
    issueType: evidence.issue.issueType,
    creditDelta: previewToken.proposedCreditDelta,
    balanceBefore: previewToken.currentBalance,
    balanceAfter: previewToken.resultingBalance,
  };
}
