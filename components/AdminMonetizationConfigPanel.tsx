"use client";

import { useEffect, useState } from "react";

type EnforcementMode = "off" | "observe" | "enforce";
type PackageKey = "pack_1" | "pack_2" | "pack_3";

type PricingPackageConfig = {
  packageKey: PackageKey;
  label: string;
  credits: number;
  displayPriceUsd: number;
  appleProductId: string;
  googleProductId: string;
  active: boolean;
};

type SeasonalOfferConfig = {
  offerId: string;
  name: string;
  startDate: string;
  endDate: string;
  discountPercentByPackage: Record<PackageKey, number>;
  active: boolean;
};

type RuntimeConfig = {
  enabled: boolean;
  enforcementMode: EnforcementMode;
  freeDailyFuseActions: number;
  freeDailyRerollActions: number;
  fuseCreditCost: number;
  rerollCreditCost: number;
  allowCompActions: boolean;
  pricingPackages: PricingPackageConfig[];
  seasonalOffers: SeasonalOfferConfig[];
  updatedAt: string;
  updatedBy: string;
};

type ReconciliationPreviewItem = {
  reservationId: string;
  anonUserId: string;
  actionKind: "fuse" | "reroll";
  amount: number;
  expiresAt: string;
};

type ReconciliationSummary = {
  scanned: number;
  released: number;
  alreadyFinalized: number;
  failed: number;
};

type ObserveRuntime = {
  enabled: boolean;
  enforcementMode: EnforcementMode;
  freeDailyFuseActions: number;
  freeDailyRerollActions: number;
  fuseCreditCost: number;
  rerollCreditCost: number;
};

type ObserveSnapshot24h = {
  fuseActions: number;
  rerollActions: number;
  totalActions: number;
  uniqueUsers: number;
};

type ObserveTodayEstimate = {
  overQuotaActions: number;
  estimatedBlockedActions: number;
  wouldBlockPercentage: number;
};

type ObserveTrendRow = {
  dayKey: string;
  fuseActions: number;
  rerollActions: number;
  totalActions: number;
  uniqueUsers: number;
  overQuotaActions: number;
  estimatedBlockedActions: number;
  wouldBlockPercentage: number;
};

type ObserveTopUserRow = {
  anonUserId: string;
  fuseCount: number;
  rerollCount: number;
  totalActions: number;
  availableCredits: number;
  overQuotaActions: number;
  estimatedBlockedActions: number;
  wouldBlockNow: boolean;
};

type AdminUserRow = {
  authUserId: string;
  email: string;
  normalizedEmail: string;
  name: string;
  role: string;
  canonicalAnonUserId: string;
  availableCredits: number;
  pendingCredits: number;
  purchaseCount: number;
  cookbookCount: number;
  lastLoginAt: string;
  createdAt: string;
};

type AdminUsersPayload = {
  users: AdminUserRow[];
  hasMore: boolean;
  nextCursor: string | null;
};

type BatchGrantTarget = {
  input: string;
  status: "ready" | "missing" | "ambiguous" | "duplicate_input" | "duplicate_target";
  message: string;
  user: AdminUserRow | null;
};

type BatchGrantResult = {
  mode: "dry_run" | "commit";
  allowCompActions: boolean;
  amount: number;
  summary: {
    totalInputs: number;
    ready: number;
    missing: number;
    ambiguous: number;
    duplicateInputs: number;
    duplicateTargets: number;
    totalCredits: number;
    granted: number;
  };
  targets: BatchGrantTarget[];
  previewTruncated: boolean;
};

type AccountDeletionCounts = {
  authUsers: number;
  identityLinks: number;
  mobileDeviceLinks: number;
  mobileAliases: number;
  cookbookRecipes: number;
  creditBalanceRows: number;
  creditReservations: number;
  creditLedgerEntries: number;
  dailyUsageRows: number;
  purchaseTransactionsPreserved: number;
};

type AccountDeleteTarget = {
  input: string;
  status:
    | "ready"
    | "missing"
    | "ambiguous"
    | "duplicate_input"
    | "duplicate_target"
    | "blocked_shared_identity";
  message: string;
  user: AdminUserRow | null;
  linkedAuthUsers: Array<{ authUserId: string; email: string }>;
  counts: AccountDeletionCounts;
};

type AccountDeleteResult = {
  operation: "account_delete";
  mode: "dry_run" | "commit";
  summary: {
    totalInputs: number;
    ready: number;
    missing: number;
    ambiguous: number;
    blockedSharedIdentity: number;
    duplicateInputs: number;
    duplicateTargets: number;
    deleted: number;
    counts: AccountDeletionCounts;
  };
  targets: AccountDeleteTarget[];
  previewTruncated: boolean;
};

type PanelKey =
  | "adminAccess"
  | "quickPresets"
  | "pricing"
  | "users"
  | "observeAnalytics"
  | "reconciliation"
  | "runtimeSettings";

type PanelNoticeState = {
  error: string;
  success: string;
};

type AdminTab =
  | "access"
  | "presets"
  | "pricing"
  | "users"
  | "analytics"
  | "runtime"
  | "reconciliation";

const TOKEN_STORAGE_KEY = "flavor-fusion-admin-token:v1";
const ACTOR_STORAGE_KEY = "flavor-fusion-admin-actor:v1";
const ACTIVE_TAB_STORAGE_KEY = "flavor-fusion-admin-active-tab:v1";
const PACKAGE_KEYS: PackageKey[] = ["pack_1", "pack_2", "pack_3"];

const DEFAULT_PRICING_PACKAGES: PricingPackageConfig[] = [
  {
    packageKey: "pack_1",
    label: "Starter Pack",
    credits: 20,
    displayPriceUsd: 2.99,
    appleProductId: "com.flavorfusion.credits.20",
    googleProductId: "credits_20",
    active: true,
  },
  {
    packageKey: "pack_2",
    label: "Chef Pack",
    credits: 50,
    displayPriceUsd: 6.99,
    appleProductId: "com.flavorfusion.credits.50",
    googleProductId: "credits_50",
    active: true,
  },
  {
    packageKey: "pack_3",
    label: "Pro Pack",
    credits: 120,
    displayPriceUsd: 14.99,
    appleProductId: "com.flavorfusion.credits.120",
    googleProductId: "credits_120",
    active: true,
  },
];

const DEFAULT_FORM: RuntimeConfig = {
  enabled: false,
  enforcementMode: "off",
  freeDailyFuseActions: 0,
  freeDailyRerollActions: 0,
  fuseCreditCost: 2,
  rerollCreditCost: 1,
  allowCompActions: true,
  pricingPackages: DEFAULT_PRICING_PACKAGES,
  seasonalOffers: [],
  updatedAt: "",
  updatedBy: "",
};

const DEFAULT_OBSERVE_RUNTIME: ObserveRuntime = {
  enabled: false,
  enforcementMode: "off",
  freeDailyFuseActions: 0,
  freeDailyRerollActions: 0,
  fuseCreditCost: 2,
  rerollCreditCost: 1,
};

const DEFAULT_OBSERVE_SNAPSHOT: ObserveSnapshot24h = {
  fuseActions: 0,
  rerollActions: 0,
  totalActions: 0,
  uniqueUsers: 0,
};

const DEFAULT_OBSERVE_TODAY: ObserveTodayEstimate = {
  overQuotaActions: 0,
  estimatedBlockedActions: 0,
  wouldBlockPercentage: 0,
};

const DEFAULT_PANEL_NOTICES: Record<PanelKey, PanelNoticeState> = {
  adminAccess: { error: "", success: "" },
  quickPresets: { error: "", success: "" },
  pricing: { error: "", success: "" },
  users: { error: "", success: "" },
  observeAnalytics: { error: "", success: "" },
  reconciliation: { error: "", success: "" },
  runtimeSettings: { error: "", success: "" },
};

const ADMIN_TABS: Array<{ key: AdminTab; label: string }> = [
  { key: "access", label: "Access" },
  { key: "presets", label: "Presets" },
  { key: "pricing", label: "Pricing" },
  { key: "users", label: "Users" },
  { key: "analytics", label: "Analytics" },
  { key: "runtime", label: "Policy" },
  { key: "reconciliation", label: "Reconciliation" },
];

function isAdminTab(value: unknown): value is AdminTab {
  return (
    value === "access" ||
    value === "presets" ||
    value === "pricing" ||
    value === "users" ||
    value === "analytics" ||
    value === "runtime" ||
    value === "reconciliation"
  );
}

function generateIdempotencyKey(scope: string) {
  return `${scope}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    (candidate.enforcementMode === "off" ||
      candidate.enforcementMode === "observe" ||
      candidate.enforcementMode === "enforce") &&
    typeof candidate.freeDailyFuseActions === "number" &&
    Number.isFinite(candidate.freeDailyFuseActions) &&
    typeof candidate.freeDailyRerollActions === "number" &&
    Number.isFinite(candidate.freeDailyRerollActions) &&
    typeof candidate.fuseCreditCost === "number" &&
    Number.isFinite(candidate.fuseCreditCost) &&
    typeof candidate.rerollCreditCost === "number" &&
    Number.isFinite(candidate.rerollCreditCost) &&
    typeof candidate.allowCompActions === "boolean" &&
    Array.isArray(candidate.pricingPackages) &&
    candidate.pricingPackages.every(isPricingPackageConfig) &&
    Array.isArray(candidate.seasonalOffers) &&
    candidate.seasonalOffers.every(isSeasonalOfferConfig) &&
    typeof candidate.updatedAt === "string" &&
    typeof candidate.updatedBy === "string"
  );
}

function isPricingPackageConfig(value: unknown): value is PricingPackageConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.packageKey === "pack_1" ||
      candidate.packageKey === "pack_2" ||
      candidate.packageKey === "pack_3") &&
    typeof candidate.label === "string" &&
    typeof candidate.credits === "number" &&
    Number.isFinite(candidate.credits) &&
    typeof candidate.displayPriceUsd === "number" &&
    Number.isFinite(candidate.displayPriceUsd) &&
    typeof candidate.appleProductId === "string" &&
    typeof candidate.googleProductId === "string" &&
    typeof candidate.active === "boolean"
  );
}

function isSeasonalOfferConfig(value: unknown): value is SeasonalOfferConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.offerId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.startDate !== "string" ||
    typeof candidate.endDate !== "string" ||
    typeof candidate.active !== "boolean" ||
    typeof candidate.discountPercentByPackage !== "object" ||
    candidate.discountPercentByPackage === null ||
    Array.isArray(candidate.discountPercentByPackage)
  ) {
    return false;
  }
  const discountMap = candidate.discountPercentByPackage as Record<string, unknown>;
  return (
    typeof discountMap.pack_1 === "number" &&
    Number.isFinite(discountMap.pack_1) &&
    typeof discountMap.pack_2 === "number" &&
    Number.isFinite(discountMap.pack_2) &&
    typeof discountMap.pack_3 === "number" &&
    Number.isFinite(discountMap.pack_3)
  );
}

function isReconciliationPreviewItem(value: unknown): value is ReconciliationPreviewItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.reservationId === "string" &&
    typeof candidate.anonUserId === "string" &&
    (candidate.actionKind === "fuse" || candidate.actionKind === "reroll") &&
    typeof candidate.amount === "number" &&
    Number.isFinite(candidate.amount) &&
    typeof candidate.expiresAt === "string"
  );
}

function isReconciliationSummary(value: unknown): value is ReconciliationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.scanned === "number" &&
    Number.isFinite(candidate.scanned) &&
    typeof candidate.released === "number" &&
    Number.isFinite(candidate.released) &&
    typeof candidate.alreadyFinalized === "number" &&
    Number.isFinite(candidate.alreadyFinalized) &&
    typeof candidate.failed === "number" &&
    Number.isFinite(candidate.failed)
  );
}

function clampDailyLimit(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 20) {
    return 20;
  }
  return normalized;
}

function clampActionCreditCost(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 100) {
    return 100;
  }
  return normalized;
}

function clampReconciliationLimit(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 1000) {
    return 1000;
  }
  return normalized;
}

function clampPackageCredits(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }
  if (normalized > 100_000) {
    return 100_000;
  }
  return normalized;
}

function clampPackagePrice(value: number) {
  if (!Number.isFinite(value)) {
    return 0.49;
  }
  const normalized = Math.round(value * 100) / 100;
  if (normalized < 0.49) {
    return 0.49;
  }
  if (normalized > 999.99) {
    return 999.99;
  }
  return normalized;
}

function clampDiscountPercent(value: number) {
  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 90) {
    return 90;
  }
  return normalized;
}

function toNumber(value: unknown, fallback = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function toInteger(value: unknown, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

function maskAnonUserId(value: string) {
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isAdminUserRow(value: unknown): value is AdminUserRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.authUserId === "string" &&
    typeof candidate.email === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.canonicalAnonUserId === "string" &&
    typeof candidate.availableCredits === "number" &&
    typeof candidate.pendingCredits === "number" &&
    typeof candidate.purchaseCount === "number" &&
    typeof candidate.cookbookCount === "number" &&
    typeof candidate.lastLoginAt === "string"
  );
}

function isAdminUsersPayload(value: unknown): value is AdminUsersPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.users) &&
    candidate.users.every(isAdminUserRow) &&
    typeof candidate.hasMore === "boolean" &&
    (typeof candidate.nextCursor === "string" || candidate.nextCursor === null)
  );
}

function isBatchGrantResult(value: unknown): value is BatchGrantResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const summary = candidate.summary;
  return (
    (candidate.mode === "dry_run" || candidate.mode === "commit") &&
    typeof candidate.allowCompActions === "boolean" &&
    typeof candidate.amount === "number" &&
    typeof summary === "object" &&
    summary !== null &&
    !Array.isArray(summary) &&
    Array.isArray(candidate.targets)
  );
}

function isAccountDeleteResult(value: unknown): value is AccountDeleteResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const summary = candidate.summary;
  return (
    candidate.operation === "account_delete" &&
    (candidate.mode === "dry_run" || candidate.mode === "commit") &&
    typeof summary === "object" &&
    summary !== null &&
    !Array.isArray(summary) &&
    Array.isArray(candidate.targets)
  );
}

function toIsoLabel(value: string) {
  if (!value) {
    return "N/A";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function isObserveRuntime(value: unknown): value is ObserveRuntime {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    (candidate.enforcementMode === "off" ||
      candidate.enforcementMode === "observe" ||
      candidate.enforcementMode === "enforce") &&
    typeof candidate.freeDailyFuseActions === "number" &&
    Number.isFinite(candidate.freeDailyFuseActions) &&
    typeof candidate.freeDailyRerollActions === "number" &&
    Number.isFinite(candidate.freeDailyRerollActions) &&
    typeof candidate.fuseCreditCost === "number" &&
    Number.isFinite(candidate.fuseCreditCost) &&
    typeof candidate.rerollCreditCost === "number" &&
    Number.isFinite(candidate.rerollCreditCost)
  );
}

function isObserveSnapshot24h(value: unknown): value is ObserveSnapshot24h {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fuseActions === "number" &&
    typeof candidate.rerollActions === "number" &&
    typeof candidate.totalActions === "number" &&
    typeof candidate.uniqueUsers === "number"
  );
}

function isObserveTodayEstimate(value: unknown): value is ObserveTodayEstimate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.overQuotaActions === "number" &&
    typeof candidate.estimatedBlockedActions === "number" &&
    typeof candidate.wouldBlockPercentage === "number"
  );
}

function isObserveTrendRow(value: unknown): value is ObserveTrendRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.dayKey === "string" &&
    typeof candidate.fuseActions === "number" &&
    typeof candidate.rerollActions === "number" &&
    typeof candidate.totalActions === "number" &&
    typeof candidate.uniqueUsers === "number" &&
    typeof candidate.overQuotaActions === "number" &&
    typeof candidate.estimatedBlockedActions === "number" &&
    typeof candidate.wouldBlockPercentage === "number"
  );
}

function isObserveTopUserRow(value: unknown): value is ObserveTopUserRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.anonUserId === "string" &&
    typeof candidate.fuseCount === "number" &&
    typeof candidate.rerollCount === "number" &&
    typeof candidate.totalActions === "number" &&
    typeof candidate.availableCredits === "number" &&
    typeof candidate.overQuotaActions === "number" &&
    typeof candidate.estimatedBlockedActions === "number" &&
    typeof candidate.wouldBlockNow === "boolean"
  );
}

function isPresetActive(preset: Preset, current: RuntimeConfig) {
  if (preset.label === "Off") {
    return !current.enabled || current.enforcementMode === "off";
  }

  return (
    current.enabled === preset.config.enabled &&
    current.enforcementMode === preset.config.enforcementMode
  );
}

function isPresetExactMatch(preset: Preset, current: RuntimeConfig) {
  return (
    isPresetActive(preset, current) &&
    current.freeDailyFuseActions === preset.config.freeDailyFuseActions &&
    current.freeDailyRerollActions === preset.config.freeDailyRerollActions &&
    current.fuseCreditCost === preset.config.fuseCreditCost &&
    current.rerollCreditCost === preset.config.rerollCreditCost &&
    current.allowCompActions === preset.config.allowCompActions
  );
}

type Preset = {
  label: string;
  description: string;
  config: Pick<
    RuntimeConfig,
    | "enabled"
    | "enforcementMode"
    | "freeDailyFuseActions"
    | "freeDailyRerollActions"
    | "fuseCreditCost"
    | "rerollCreditCost"
    | "allowCompActions"
  >;
};

const PRESETS: Preset[] = [
  {
    label: "Off",
    description: "Credits fully disabled for all users.",
    config: {
      enabled: false,
      enforcementMode: "off",
      freeDailyFuseActions: 0,
      freeDailyRerollActions: 0,
      fuseCreditCost: 2,
      rerollCreditCost: 1,
      allowCompActions: true,
    },
  },
  {
    label: "Observe",
    description: "Track usage only, no blocking.",
    config: {
      enabled: true,
      enforcementMode: "observe",
      freeDailyFuseActions: 3,
      freeDailyRerollActions: 2,
      fuseCreditCost: 2,
      rerollCreditCost: 1,
      allowCompActions: true,
    },
  },
  {
    label: "Enforce",
    description: "Use free daily limits then require credits.",
    config: {
      enabled: true,
      enforcementMode: "enforce",
      freeDailyFuseActions: 3,
      freeDailyRerollActions: 2,
      fuseCreditCost: 2,
      rerollCreditCost: 1,
      allowCompActions: true,
    },
  },
];

type AdminMonetizationConfigPanelProps = {
  defaultActor?: string;
};

export function AdminMonetizationConfigPanel({
  defaultActor = "admin",
}: AdminMonetizationConfigPanelProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>("access");
  const [adminToken, setAdminToken] = useState("");
  const [adminActor, setAdminActor] = useState(defaultActor || "admin");
  const [form, setForm] = useState<RuntimeConfig>(DEFAULT_FORM);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingReconciliationPreview, setIsLoadingReconciliationPreview] = useState(false);
  const [isRunningReconciliation, setIsRunningReconciliation] = useState(false);
  const [reconciliationMaxCandidates, setReconciliationMaxCandidates] = useState(200);
  const [reconciliationPreview, setReconciliationPreview] = useState<ReconciliationPreviewItem[]>(
    [],
  );
  const [reconciliationSummary, setReconciliationSummary] = useState<ReconciliationSummary | null>(
    null,
  );
  const [isLoadingObserveReport, setIsLoadingObserveReport] = useState(false);
  const [observeGeneratedAt, setObserveGeneratedAt] = useState("");
  const [observeTimezone, setObserveTimezone] = useState("UTC");
  const [observeTodayDayKey, setObserveTodayDayKey] = useState("");
  const [observeRuntime, setObserveRuntime] = useState<ObserveRuntime>(DEFAULT_OBSERVE_RUNTIME);
  const [observeSnapshot24h, setObserveSnapshot24h] =
    useState<ObserveSnapshot24h>(DEFAULT_OBSERVE_SNAPSHOT);
  const [observeTodayEstimate, setObserveTodayEstimate] =
    useState<ObserveTodayEstimate>(DEFAULT_OBSERVE_TODAY);
  const [observeTrend, setObserveTrend] = useState<ObserveTrendRow[]>([]);
  const [observeTopUsers, setObserveTopUsers] = useState<ObserveTopUserRow[]>([]);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usersNextCursor, setUsersNextCursor] = useState<string | null>(null);
  const [usersHasMore, setUsersHasMore] = useState(false);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isExportingUsers, setIsExportingUsers] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("all");
  const [userPaymentFilter, setUserPaymentFilter] = useState("all");
  const [userCookbookFilter, setUserCookbookFilter] = useState("all");
  const [userLinkFilter, setUserLinkFilter] = useState("linked");
  const [userMinCredits, setUserMinCredits] = useState("");
  const [userMaxCredits, setUserMaxCredits] = useState("");
  const [userLastLoginSince, setUserLastLoginSince] = useState("");
  const [grantIdentifiersText, setGrantIdentifiersText] = useState("");
  const [grantAmount, setGrantAmount] = useState(20);
  const [grantReason, setGrantReason] = useState("");
  const [grantBatchLabel, setGrantBatchLabel] = useState("");
  const [grantDryRun, setGrantDryRun] = useState<BatchGrantResult | null>(null);
  const [isRunningGrantDryRun, setIsRunningGrantDryRun] = useState(false);
  const [isCommittingGrantBatch, setIsCommittingGrantBatch] = useState(false);
  const [deleteIdentifiersText, setDeleteIdentifiersText] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteDryRun, setDeleteDryRun] = useState<AccountDeleteResult | null>(null);
  const [isRunningDeleteDryRun, setIsRunningDeleteDryRun] = useState(false);
  const [isCommittingDelete, setIsCommittingDelete] = useState(false);
  const [panelNotices, setPanelNotices] =
    useState<Record<PanelKey, PanelNoticeState>>(DEFAULT_PANEL_NOTICES);
  const [hasHydratedClientState, setHasHydratedClientState] = useState(false);

  function clearPanelNotice(panelKey: PanelKey) {
    setPanelNotices((current) => ({
      ...current,
      [panelKey]: { error: "", success: "" },
    }));
  }

  async function logoutAdminSession() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });
    } finally {
      if (typeof window !== "undefined") {
        window.location.href = "/admin/monetization";
      }
    }
  }

  function setPanelError(panelKey: PanelKey, message: string) {
    setPanelNotices((current) => ({
      ...current,
      [panelKey]: { error: message, success: "" },
    }));
  }

  function setPanelSuccess(panelKey: PanelKey, message: string) {
    setPanelNotices((current) => ({
      ...current,
      [panelKey]: { error: "", success: message },
    }));
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedToken = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    const storedActor = window.sessionStorage.getItem(ACTOR_STORAGE_KEY);
    const storedActiveTab = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (storedToken) {
      setAdminToken(storedToken);
    }
    if (storedActor) {
      setAdminActor(storedActor);
    }
    if (isAdminTab(storedActiveTab)) {
      setActiveTab(storedActiveTab);
    }
    setHasHydratedClientState(true);
  }, []);

  function changeActiveTab(nextTab: AdminTab) {
    setActiveTab(nextTab);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, nextTab);
    }
  }

  useEffect(() => {
    if (hasHydratedClientState && activeTab === "users" && users.length === 0 && !isLoadingUsers) {
      void loadUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, hasHydratedClientState]);

  function buildAdminHeaders(options?: { includeActor?: boolean }) {
    const headers: Record<string, string> = {};
    const token = adminToken.trim();
    const actor = adminActor.trim();
    if (token) {
      headers["x-admin-token"] = token;
    }
    if (options?.includeActor && actor) {
      headers["x-admin-actor"] = actor;
    }
    return headers;
  }

  function buildUsersQuery(cursor?: string | null, limit = 100) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) {
      params.set("cursor", cursor);
    }
    if (userSearch.trim()) {
      params.set("search", userSearch.trim());
    }
    params.set("role", userRoleFilter);
    params.set("payment", userPaymentFilter);
    params.set("cookbook", userCookbookFilter);
    params.set("linkStatus", userLinkFilter);
    if (userMinCredits.trim()) {
      params.set("minCredits", userMinCredits.trim());
    }
    if (userMaxCredits.trim()) {
      params.set("maxCredits", userMaxCredits.trim());
    }
    if (userLastLoginSince.trim()) {
      params.set("lastLoginSince", userLastLoginSince.trim());
    }
    return params.toString();
  }

  async function loadUsers(options?: { append?: boolean; cursor?: string | null }) {
    setIsLoadingUsers(true);
    clearPanelNotice("users");
    try {
      const response = await fetch(`/api/admin/monetization/users?${buildUsersQuery(options?.cursor)}`, {
        method: "GET",
        headers: buildAdminHeaders(),
        cache: "no-store",
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(
          isObjectRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "Could not load users.",
        );
      }
      if (!isAdminUsersPayload(payload)) {
        throw new Error("Users response format was invalid.");
      }
      setUsers((current) => (options?.append ? [...current, ...payload.users] : payload.users));
      setUsersNextCursor(payload.nextCursor);
      setUsersHasMore(payload.hasMore);
    } catch (error) {
      setPanelError("users", error instanceof Error ? error.message : "Could not load users.");
    } finally {
      setIsLoadingUsers(false);
    }
  }

  async function exportUsersCsv() {
    setIsExportingUsers(true);
    clearPanelNotice("users");
    try {
      const headers = [
        "email",
        "name",
        "role",
        "authUserId",
        "canonicalAnonUserId",
        "availableCredits",
        "pendingCredits",
        "purchaseCount",
        "cookbookCount",
        "lastLoginAt",
        "createdAt",
      ];
      const rows: string[] = [headers.join(",")];
      let cursor: string | null = null;
      let pageCount = 0;
      let exported = 0;
      do {
        const response = await fetch(`/api/admin/monetization/users?${buildUsersQuery(cursor, 500)}`, {
          method: "GET",
          headers: buildAdminHeaders(),
          cache: "no-store",
        });
        const payload = (await response.json()) as unknown;
        if (!response.ok || !isAdminUsersPayload(payload)) {
          throw new Error("Could not export users.");
        }
        payload.users.forEach((user) => {
          rows.push(
            [
              user.email,
              user.name,
              user.role,
              user.authUserId,
              user.canonicalAnonUserId,
              user.availableCredits,
              user.pendingCredits,
              user.purchaseCount,
              user.cookbookCount,
              user.lastLoginAt,
              user.createdAt,
            ]
              .map(csvEscape)
              .join(","),
          );
        });
        exported += payload.users.length;
        cursor = payload.nextCursor;
        pageCount += 1;
      } while (cursor && pageCount < 200);

      const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `flavor-fusion-users-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setPanelSuccess("users", `Exported ${exported} user row(s).`);
    } catch (error) {
      setPanelError("users", error instanceof Error ? error.message : "Could not export users.");
    } finally {
      setIsExportingUsers(false);
    }
  }

  async function runGrantBatch(mode: "dry_run" | "commit") {
    if (mode === "dry_run") {
      setIsRunningGrantDryRun(true);
    } else {
      setIsCommittingGrantBatch(true);
    }
    clearPanelNotice("users");
    try {
      const response = await fetch("/api/admin/monetization/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAdminHeaders({ includeActor: true }),
          ...(mode === "commit" ? { "idempotency-key": generateIdempotencyKey("bulk-grant") } : {}),
        },
        body: JSON.stringify({
          mode,
          identifiersText: grantIdentifiersText,
          amount: grantAmount,
          reason: grantReason,
          batchLabel: grantBatchLabel,
        }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(
          isObjectRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "Could not run grant batch.",
        );
      }
      if (!isBatchGrantResult(payload)) {
        throw new Error("Grant batch response format was invalid.");
      }
      setGrantDryRun(payload);
      setPanelSuccess(
        "users",
        mode === "commit"
          ? `Granted ${payload.summary.granted} user(s), ${payload.summary.totalCredits} total credits.`
          : `Dry run ready: ${payload.summary.ready} user(s), ${payload.summary.totalCredits} total credits.`,
      );
      if (mode === "commit") {
        void loadUsers();
      }
    } catch (error) {
      setPanelError("users", error instanceof Error ? error.message : "Could not run grant batch.");
    } finally {
      setIsRunningGrantDryRun(false);
      setIsCommittingGrantBatch(false);
    }
  }

  async function runAccountDelete(mode: "dry_run" | "commit") {
    if (mode === "dry_run") {
      setIsRunningDeleteDryRun(true);
    } else {
      setIsCommittingDelete(true);
    }
    clearPanelNotice("users");
    try {
      const response = await fetch("/api/admin/monetization/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAdminHeaders({ includeActor: true }),
          ...(mode === "commit" ? { "idempotency-key": generateIdempotencyKey("account-delete") } : {}),
        },
        body: JSON.stringify({
          operation: "account_delete",
          mode,
          identifiersText: deleteIdentifiersText,
          reason: deleteReason,
          confirmation: deleteConfirmation,
        }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(
          isObjectRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "Could not run account deletion.",
        );
      }
      if (!isAccountDeleteResult(payload)) {
        throw new Error("Account deletion response format was invalid.");
      }
      setDeleteDryRun(payload);
      setPanelSuccess(
        "users",
        mode === "commit"
          ? `Deleted ${payload.summary.deleted} account(s). Purchase transaction rows were preserved for audit.`
          : `Dry run ready: ${payload.summary.ready} account(s), blocked: ${payload.summary.blockedSharedIdentity}.`,
      );
      if (mode === "commit") {
        setDeleteConfirmation("");
        void loadUsers();
      }
    } catch (error) {
      setPanelError("users", error instanceof Error ? error.message : "Could not run account deletion.");
    } finally {
      setIsRunningDeleteDryRun(false);
      setIsCommittingDelete(false);
    }
  }

  async function readConfig(
    origin: "adminAccess" | "runtimeSettings" | "pricing" = "adminAccess",
  ) {
    setIsLoading(true);
    clearPanelNotice(origin);

    try {
      const response = await fetch("/api/admin/monetization/config", {
        method: "GET",
        headers: buildAdminHeaders(),
        cache: "no-store",
      });
      const payload = (await response.json()) as { config?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not load config.",
        );
      }
      if (!isRuntimeConfig(payload.config)) {
        throw new Error("Config response format was invalid.");
      }

      setForm(payload.config);
      setPanelSuccess(origin, "Loaded current runtime config.");
      const token = adminToken.trim();
      if (token && typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
      await loadObserveReport({ silent: true });
    } catch (loadError) {
      setPanelError(origin, loadError instanceof Error ? loadError.message : "Could not load config.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!hasHydratedClientState) {
      return;
    }

    void readConfig("adminAccess");
    // Intentionally run once after browser storage is restored. The admin cookie is
    // enough for authenticated users, while token fallback users get restored first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHydratedClientState]);

  async function saveConfig(origin: "runtimeSettings" | "pricing" = "runtimeSettings") {
    setIsSaving(true);
    clearPanelNotice(origin);

    try {
      const response = await fetch("/api/admin/monetization/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...buildAdminHeaders({ includeActor: true }),
          "idempotency-key": generateIdempotencyKey("cfg"),
        },
        body: JSON.stringify({
          enabled: form.enabled,
          enforcementMode: form.enforcementMode,
          freeDailyFuseActions: clampDailyLimit(form.freeDailyFuseActions),
          freeDailyRerollActions: clampDailyLimit(form.freeDailyRerollActions),
          fuseCreditCost: clampActionCreditCost(form.fuseCreditCost),
          rerollCreditCost: clampActionCreditCost(form.rerollCreditCost),
          allowCompActions: form.allowCompActions,
          pricingPackages: form.pricingPackages,
          seasonalOffers: form.seasonalOffers,
        }),
      });

      const payload = (await response.json()) as { config?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not save config.",
        );
      }
      if (!isRuntimeConfig(payload.config)) {
        throw new Error("Config response format was invalid.");
      }

      setForm(payload.config);
      setPanelSuccess(origin, "Monetization runtime config saved.");
      const token = adminToken.trim();
      const actor = adminActor.trim();
      if (typeof window !== "undefined") {
        if (token) {
          window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        }
        if (actor) {
          window.sessionStorage.setItem(ACTOR_STORAGE_KEY, actor);
        }
      }
      await loadObserveReport({ silent: true });
    } catch (saveError) {
      setPanelError(
        origin,
        saveError instanceof Error ? saveError.message : "Could not save config.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function loadObserveReport(options?: { silent?: boolean }) {
    setIsLoadingObserveReport(true);
    if (!options?.silent) {
      clearPanelNotice("observeAnalytics");
    }

    try {
      const response = await fetch(
        "/api/admin/monetization/observe-report?trendDays=7&topUsersLimit=10",
        {
          method: "GET",
          headers: buildAdminHeaders(),
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as {
        runtime?: unknown;
        generatedAt?: unknown;
        timezone?: unknown;
        todayDayKey?: unknown;
        snapshot24h?: unknown;
        todayEstimate?: unknown;
        trend?: unknown;
        topUsers?: unknown;
        error?: unknown;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : "Could not load observe analytics.",
        );
      }
      if (
        !isObserveRuntime(payload.runtime) ||
        !isObserveSnapshot24h(payload.snapshot24h) ||
        !isObserveTodayEstimate(payload.todayEstimate)
      ) {
        throw new Error("Observe analytics response format was invalid.");
      }

      const trendRows = Array.isArray(payload.trend) ? payload.trend.filter(isObserveTrendRow) : [];
      const topUserRows = Array.isArray(payload.topUsers)
        ? payload.topUsers.filter(isObserveTopUserRow)
        : [];

      setObserveRuntime(payload.runtime);
      setObserveSnapshot24h(payload.snapshot24h);
      setObserveTodayEstimate(payload.todayEstimate);
      setObserveTrend(trendRows);
      setObserveTopUsers(topUserRows);
      setObserveGeneratedAt(typeof payload.generatedAt === "string" ? payload.generatedAt : "");
      setObserveTimezone(typeof payload.timezone === "string" ? payload.timezone : "UTC");
      setObserveTodayDayKey(typeof payload.todayDayKey === "string" ? payload.todayDayKey : "");

      const token = adminToken.trim();
      if (token && typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
      if (!options?.silent) {
        setPanelSuccess("observeAnalytics", "Observe analytics loaded.");
      }
    } catch (observeError) {
      if (!options?.silent) {
        setPanelError(
          "observeAnalytics",
          observeError instanceof Error
            ? observeError.message
            : "Could not load observe analytics.",
        );
      }
    } finally {
      setIsLoadingObserveReport(false);
    }
  }

  async function loadReconciliationPreview(options?: { silent?: boolean }) {
    const previewLimit = clampReconciliationLimit(reconciliationMaxCandidates);
    setIsLoadingReconciliationPreview(true);
    if (!options?.silent) {
      clearPanelNotice("reconciliation");
    }

    try {
      const response = await fetch(
        `/api/admin/monetization/reconciliation?previewLimit=${previewLimit}`,
        {
          method: "GET",
          headers: buildAdminHeaders(),
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as {
        preview?: unknown;
        expiredCount?: unknown;
        error?: unknown;
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not load reconciliation preview.",
        );
      }

      const previewRows = Array.isArray(payload.preview) ? payload.preview : [];
      const validRows = previewRows.filter(isReconciliationPreviewItem);
      setReconciliationPreview(validRows);
      setReconciliationSummary(null);
      if (!options?.silent) {
        setPanelSuccess("reconciliation", `Loaded preview: ${validRows.length} expired reservation(s).`);
      }
      const token = adminToken.trim();
      if (token && typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
    } catch (previewError) {
      if (!options?.silent) {
        setPanelError(
          "reconciliation",
          previewError instanceof Error ? previewError.message : "Could not load preview.",
        );
      }
    } finally {
      setIsLoadingReconciliationPreview(false);
    }
  }

  async function runReconciliationNow() {
    const maxCandidates = clampReconciliationLimit(reconciliationMaxCandidates);
    setIsRunningReconciliation(true);
    clearPanelNotice("reconciliation");

    try {
      const response = await fetch(
        `/api/admin/monetization/reconciliation?maxCandidates=${maxCandidates}`,
        {
          method: "POST",
          headers: {
            ...buildAdminHeaders({ includeActor: true }),
            "idempotency-key": generateIdempotencyKey("recon"),
          },
        },
      );
      const payload = (await response.json()) as { summary?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "Could not run reconciliation.",
        );
      }
      if (!isReconciliationSummary(payload.summary)) {
        throw new Error("Reconciliation response format was invalid.");
      }

      setReconciliationSummary(payload.summary);
      setPanelSuccess(
        "reconciliation",
        `Reconciliation complete. Released ${payload.summary.released} of ${payload.summary.scanned} scanned reservation(s).`,
      );
      const token = adminToken.trim();
      const actor = adminActor.trim();
      if (typeof window !== "undefined") {
        if (token) {
          window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
        }
        if (actor) {
          window.sessionStorage.setItem(ACTOR_STORAGE_KEY, actor);
        }
      }

      await loadReconciliationPreview({ silent: true });
    } catch (runError) {
      setPanelError(
        "reconciliation",
        runError instanceof Error ? runError.message : "Could not run reconciliation.",
      );
    } finally {
      setIsRunningReconciliation(false);
    }
  }

  function applyPreset(preset: Preset) {
    setForm((current) => ({
      ...current,
      ...preset.config,
    }));
    setPanelSuccess("quickPresets", `Preset applied: ${preset.label}`);
  }

  function updatePricingPackageField(
    packageKey: PackageKey,
    field: keyof Omit<PricingPackageConfig, "packageKey">,
    value: string | number | boolean,
  ) {
    setForm((current) => ({
      ...current,
      pricingPackages: current.pricingPackages.map((pack) => {
        if (pack.packageKey !== packageKey) {
          return pack;
        }
        if (field === "credits" && typeof value === "number") {
          return { ...pack, credits: clampPackageCredits(value) };
        }
        if (field === "displayPriceUsd" && typeof value === "number") {
          return { ...pack, displayPriceUsd: clampPackagePrice(value) };
        }
        if (field === "active" && typeof value === "boolean") {
          return { ...pack, active: value };
        }
        if (
          (field === "label" || field === "appleProductId" || field === "googleProductId") &&
          typeof value === "string"
        ) {
          return { ...pack, [field]: value };
        }
        return pack;
      }),
    }));
  }

  function createBlankSeasonalOffer(): SeasonalOfferConfig {
    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const endDate = startDate;
    return {
      offerId: `offer-${Date.now()}`,
      name: "New Seasonal Offer",
      startDate,
      endDate,
      discountPercentByPackage: {
        pack_1: 0,
        pack_2: 0,
        pack_3: 0,
      },
      active: true,
    };
  }

  function addSeasonalOffer() {
    setForm((current) => ({
      ...current,
      seasonalOffers: [...current.seasonalOffers, createBlankSeasonalOffer()],
    }));
    setPanelSuccess("pricing", "Added seasonal offer row. Fill values, then click Save in this panel.");
  }

  function removeSeasonalOffer(offerId: string) {
    setForm((current) => ({
      ...current,
      seasonalOffers: current.seasonalOffers.filter((offer) => offer.offerId !== offerId),
    }));
  }

  function updateSeasonalOfferField(
    offerId: string,
    field: "name" | "startDate" | "endDate" | "active",
    value: string | boolean,
  ) {
    setForm((current) => ({
      ...current,
      seasonalOffers: current.seasonalOffers.map((offer) => {
        if (offer.offerId !== offerId) {
          return offer;
        }
        if (field === "active" && typeof value === "boolean") {
          return { ...offer, active: value };
        }
        if ((field === "name" || field === "startDate" || field === "endDate") && typeof value === "string") {
          return { ...offer, [field]: value };
        }
        return offer;
      }),
    }));
  }

  function updateSeasonalOfferDiscount(
    offerId: string,
    packageKey: PackageKey,
    value: number,
  ) {
    setForm((current) => ({
      ...current,
      seasonalOffers: current.seasonalOffers.map((offer) => {
        if (offer.offerId !== offerId) {
          return offer;
        }
        return {
          ...offer,
          discountPercentByPackage: {
            ...offer.discountPercentByPackage,
            [packageKey]: clampDiscountPercent(value),
          },
        };
      }),
    }));
  }

  function applyAllPackageDiscount(offerId: string, value: number) {
    const clamped = clampDiscountPercent(value);
    setForm((current) => ({
      ...current,
      seasonalOffers: current.seasonalOffers.map((offer) => {
        if (offer.offerId !== offerId) {
          return offer;
        }
        return {
          ...offer,
          discountPercentByPackage: {
            pack_1: clamped,
            pack_2: clamped,
            pack_3: clamped,
          },
        };
      }),
    }));
  }

  function getUniformDiscountValue(offer: SeasonalOfferConfig) {
    const first = offer.discountPercentByPackage.pack_1;
    if (
      offer.discountPercentByPackage.pack_2 === first &&
      offer.discountPercentByPackage.pack_3 === first
    ) {
      return first;
    }
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl animate-rise-in space-y-6">
      <section className="space-y-2 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          Developer
        </p>
        <h1 className="font-serif text-3xl leading-tight text-zinc-900 md:text-4xl">
          Monetization Runtime Control
        </h1>
        <p className="text-zinc-700">
          Configure credits behavior without SQL. This updates runtime values in Turso through the
          secured admin API.
        </p>
      </section>

      <section className="space-y-3 rounded-3xl border border-zinc-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">Admin Console</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          {ADMIN_TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => changeActiveTab(tab.key)}
                className={[
                  "cursor-pointer rounded-xl border px-3 py-2 text-sm font-semibold transition",
                  isActive
                    ? "border-emerald-700 bg-emerald-600 text-white"
                    : "border-zinc-300 bg-zinc-50 text-zinc-800 hover:border-emerald-400 hover:bg-emerald-50",
                ].join(" ")}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </section>

      {activeTab === "access" ? (
      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Admin Access</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Admin Token
            <input
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="MONETIZATION_ADMIN_TOKEN"
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Actor
            <input
              type="text"
              value={adminActor}
              onChange={(event) => setAdminActor(event.target.value)}
              placeholder="kevin"
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void readConfig("adminAccess");
            }}
            disabled={isLoading}
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Loading..." : "Load Current Config"}
          </button>
          <button
            type="button"
            onClick={() => {
              void logoutAdminSession();
            }}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50"
          >
            Logout
          </button>
        </div>
        {panelNotices.adminAccess.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.adminAccess.error}
          </p>
        ) : null}
        {panelNotices.adminAccess.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.adminAccess.success}
          </p>
        ) : null}
      </section>
      ) : null}

      {activeTab === "presets" ? (
      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Quick Presets</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {PRESETS.map((preset) => {
            const active = isPresetActive(preset, form);
            const exactMatch = isPresetExactMatch(preset, form);
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                className={[
                  "cursor-pointer rounded-2xl border p-4 text-left transition",
                  active
                    ? "border-emerald-700 bg-emerald-600"
                    : "border-zinc-300 bg-zinc-50 hover:border-emerald-400 hover:bg-emerald-50",
                ].join(" ")}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className={active ? "font-semibold text-white" : "font-semibold text-zinc-900"}>
                    {preset.label}
                  </span>
                  {active ? (
                    <span className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-emerald-700">
                      Active
                    </span>
                  ) : null}
                </span>
                <p className={active ? "mt-1 text-sm text-emerald-50" : "mt-1 text-sm text-zinc-600"}>
                  {preset.description}
                </p>
                {active ? (
                  <p className="mt-3 text-xs font-semibold text-emerald-50">
                    {exactMatch ? "Preset values match exactly." : "Active with custom policy values."}
                  </p>
                ) : null}
              </button>
            );
          })}
        </div>
        {panelNotices.quickPresets.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.quickPresets.error}
          </p>
        ) : null}
        {panelNotices.quickPresets.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.quickPresets.success}
          </p>
        ) : null}
      </section>
      ) : null}

      {activeTab === "pricing" ? (
      <section className="space-y-5 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-emerald-900">Pricing and Seasonal Offers</h2>
          <p className="text-sm text-zinc-700">
            Manage the three credit packages and seasonal discounts without changing code.
          </p>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">
            Credit Packages
          </h3>
          <div className="space-y-3">
            {form.pricingPackages.map((pack) => (
              <div
                key={pack.packageKey}
                className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4"
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-sm font-semibold text-emerald-900">
                    Label
                    <input
                      type="text"
                      value={pack.label}
                      onChange={(event) =>
                        updatePricingPackageField(pack.packageKey, "label", event.target.value)
                      }
                      className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-emerald-900">
                    Credits
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={pack.credits}
                      onChange={(event) =>
                        updatePricingPackageField(
                          pack.packageKey,
                          "credits",
                          Number(event.target.value),
                        )
                      }
                      className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-emerald-900">
                    Price (USD)
                    <input
                      type="number"
                      min={0.49}
                      max={999.99}
                      step={0.01}
                      value={pack.displayPriceUsd}
                      onChange={(event) =>
                        updatePricingPackageField(
                          pack.packageKey,
                          "displayPriceUsd",
                          Number(event.target.value),
                        )
                      }
                      className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                    />
                  </label>
                  <label className="space-y-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={pack.active}
                        onChange={(event) =>
                          updatePricingPackageField(
                            pack.packageKey,
                            "active",
                            event.target.checked,
                          )
                        }
                        className="h-4 w-4 accent-emerald-600"
                      />
                      Package Active
                    </span>
                    <span className="block text-xs font-normal text-zinc-600">
                      Inactive packages are hidden from purchase options.
                    </span>
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-emerald-900">
                    Apple Product ID
                    <input
                      type="text"
                      value={pack.appleProductId}
                      onChange={(event) =>
                        updatePricingPackageField(
                          pack.packageKey,
                          "appleProductId",
                          event.target.value,
                        )
                      }
                      className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-emerald-900">
                    Google Product ID
                    <input
                      type="text"
                      value={pack.googleProductId}
                      onChange={(event) =>
                        updatePricingPackageField(
                          pack.packageKey,
                          "googleProductId",
                          event.target.value,
                        )
                      }
                      className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">
                Seasonal Offers
              </h3>
              <p className="text-sm text-zinc-700">
                Set date ranges and discount percentage by package. Use one offer per campaign.
              </p>
            </div>
            <button
              type="button"
              onClick={addSeasonalOffer}
              className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50"
            >
              Add Offer
            </button>
          </div>

          {form.seasonalOffers.length === 0 ? (
            <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              No seasonal offers yet.
            </p>
          ) : (
            <div className="space-y-3">
              {form.seasonalOffers.map((offer) => (
                <div
                  key={offer.offerId}
                  className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4"
                >
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm font-semibold text-emerald-900">
                      Offer Name
                      <input
                        type="text"
                        value={offer.name}
                        onChange={(event) =>
                          updateSeasonalOfferField(offer.offerId, "name", event.target.value)
                        }
                        className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                      />
                    </label>
                    <label className="space-y-1 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900">
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={offer.active}
                          onChange={(event) =>
                            updateSeasonalOfferField(offer.offerId, "active", event.target.checked)
                          }
                          className="h-4 w-4 accent-emerald-600"
                        />
                        Offer Active
                      </span>
                      <span className="block text-xs font-normal text-zinc-600">
                        Active offers apply only when today is inside the date range.
                      </span>
                    </label>
                    <label className="space-y-1 text-sm font-semibold text-emerald-900">
                      From Date
                      <input
                        type="date"
                        value={offer.startDate}
                        onChange={(event) =>
                          updateSeasonalOfferField(offer.offerId, "startDate", event.target.value)
                        }
                        className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                      />
                    </label>
                    <label className="space-y-1 text-sm font-semibold text-emerald-900">
                      To Date
                      <input
                        type="date"
                        value={offer.endDate}
                        onChange={(event) =>
                          updateSeasonalOfferField(offer.offerId, "endDate", event.target.value)
                        }
                        className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                    {PACKAGE_KEYS.map((packageKey) => (
                      <label
                        key={`${offer.offerId}-${packageKey}`}
                        className="space-y-1 text-sm font-semibold text-emerald-900"
                      >
                        {packageKey.replace("_", " ").toUpperCase()} % Off
                        <input
                          type="number"
                          min={0}
                          max={90}
                          value={offer.discountPercentByPackage[packageKey]}
                          onChange={(event) =>
                            updateSeasonalOfferDiscount(
                              offer.offerId,
                              packageKey,
                              Number(event.target.value),
                            )
                          }
                          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                        />
                      </label>
                    ))}
                    <label className="space-y-1 text-sm font-semibold text-emerald-900">
                      All Packages %
                      <input
                        type="number"
                        min={0}
                        max={90}
                        value={getUniformDiscountValue(offer) ?? ""}
                        onChange={(event) => {
                          const raw = event.target.value;
                          if (raw === "") {
                            return;
                          }
                          applyAllPackageDiscount(offer.offerId, Number(raw));
                        }}
                        className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                      />
                    </label>
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => removeSeasonalOffer(offer.offerId)}
                      className="cursor-pointer rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50"
                    >
                      Remove Offer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void saveConfig("pricing");
            }}
            disabled={isSaving}
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Save Pricing and Offers"}
          </button>
          <button
            type="button"
            onClick={() => {
              void readConfig("pricing");
            }}
            disabled={isLoading}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh
          </button>
        </div>

        {panelNotices.pricing.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.pricing.error}
          </p>
        ) : null}
        {panelNotices.pricing.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.pricing.success}
          </p>
        ) : null}
      </section>
      ) : null}

      {activeTab === "users" ? (
      <section className="space-y-5 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-emerald-900">Users</h2>
            <p className="text-sm text-zinc-700">
              Search logged-in users, export filtered lists in pages, and dry-run bulk credit grants before committing.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadUsers()}
              disabled={isLoadingUsers}
              className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoadingUsers ? "Loading..." : "Apply Filters"}
            </button>
            <button
              type="button"
              onClick={() => void exportUsersCsv()}
              disabled={isExportingUsers}
              className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isExportingUsers ? "Exporting..." : "Export CSV"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="space-y-1 text-sm font-semibold text-emerald-900 md:col-span-2">
            Search email, name, auth id, or credit id
            <input
              type="text"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            Payment
            <select
              value={userPaymentFilter}
              onChange={(event) => setUserPaymentFilter(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            >
              <option value="all">All users</option>
              <option value="paying">Paying users</option>
              <option value="non_paying">Non-paying users</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            Cookbook
            <select
              value={userCookbookFilter}
              onChange={(event) => setUserCookbookFilter(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            >
              <option value="all">Any cookbook</option>
              <option value="has_saved">Has saved recipes</option>
              <option value="none_saved">No saved recipes</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            Role
            <select
              value={userRoleFilter}
              onChange={(event) => setUserRoleFilter(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            >
              <option value="all">All roles</option>
              <option value="user">Users</option>
              <option value="admin">Admins</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            App Account
            <select
              value={userLinkFilter}
              onChange={(event) => setUserLinkFilter(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            >
              <option value="linked">Active app users</option>
              <option value="all">All signed-in users</option>
              <option value="unlinked">Signed in only</option>
            </select>
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            Min credits
            <input
              type="number"
              min={0}
              value={userMinCredits}
              onChange={(event) => setUserMinCredits(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            Max credits
            <input
              type="number"
              min={0}
              value={userMaxCredits}
              onChange={(event) => setUserMaxCredits(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
          <label className="space-y-1 text-sm font-semibold text-emerald-900">
            Last login since
            <input
              type="date"
              value={userLastLoginSince}
              onChange={(event) => setUserLastLoginSince(event.target.value)}
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
        </div>

        <div className="overflow-hidden rounded-2xl border border-zinc-200">
          <div className="max-h-[460px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Credits</th>
                  <th className="px-3 py-2">Purchases</th>
                  <th className="px-3 py-2">Cookbook</th>
                  <th className="px-3 py-2">Last Login</th>
                  <th className="px-3 py-2">Credit ID</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.authUserId} className="border-t border-zinc-100 text-zinc-800">
                    <td className="px-3 py-2">
                      <p className="font-semibold text-zinc-950">{user.email}</p>
                      <p className="text-xs text-zinc-500">{user.name || user.role}</p>
                    </td>
                    <td className="px-3 py-2 font-semibold">{user.availableCredits}</td>
                    <td className="px-3 py-2">{user.purchaseCount}</td>
                    <td className="px-3 py-2">{user.cookbookCount}</td>
                    <td className="px-3 py-2 text-xs">{toIsoLabel(user.lastLoginAt)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{maskAnonUserId(user.canonicalAnonUserId)}</td>
                  </tr>
                ))}
                {users.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-zinc-500" colSpan={6}>
                      No users loaded for the current filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        {usersHasMore ? (
          <button
            type="button"
            onClick={() => void loadUsers({ append: true, cursor: usersNextCursor })}
            disabled={isLoadingUsers}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Load More
          </button>
        ) : null}

        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">Batch Credit Grant</h3>
          <p className="mt-1 text-sm text-zinc-700">
            Paste emails, auth ids, or credit ids. Run dry run first; commit grants only ready matched logged-in users.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_0.6fr]">
            <label className="space-y-1 text-sm font-semibold text-emerald-900">
              Users
              <textarea
                value={grantIdentifiersText}
                onChange={(event) => setGrantIdentifiersText(event.target.value)}
                rows={7}
                className="w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                placeholder="one email or user id per line"
              />
            </label>
            <div className="space-y-3">
              <label className="space-y-1 text-sm font-semibold text-emerald-900">
                Credits per user
                <input
                  type="number"
                  min={1}
                  value={grantAmount}
                  onChange={(event) => setGrantAmount(clampPackageCredits(Number(event.target.value)))}
                  className="w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1 text-sm font-semibold text-emerald-900">
                Batch label
                <input
                  type="text"
                  value={grantBatchLabel}
                  onChange={(event) => setGrantBatchLabel(event.target.value)}
                  className="w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                />
              </label>
              <label className="space-y-1 text-sm font-semibold text-emerald-900">
                Reason
                <input
                  type="text"
                  value={grantReason}
                  onChange={(event) => setGrantReason(event.target.value)}
                  className="w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
                />
              </label>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runGrantBatch("dry_run")}
              disabled={isRunningGrantDryRun || isCommittingGrantBatch}
              className="cursor-pointer rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRunningGrantDryRun ? "Checking..." : "Dry Run"}
            </button>
            <button
              type="button"
              onClick={() => void runGrantBatch("commit")}
              disabled={
                isCommittingGrantBatch ||
                !grantDryRun ||
                grantDryRun.summary.ready < 1 ||
                grantDryRun.allowCompActions === false
              }
              className="cursor-pointer rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isCommittingGrantBatch ? "Granting..." : "Commit Grant"}
            </button>
          </div>
          {grantDryRun ? (
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-700">
              <p>
                Ready: <span className="font-semibold text-zinc-950">{grantDryRun.summary.ready}</span>
                {" | "}Missing: {grantDryRun.summary.missing}
                {" | "}Ambiguous: {grantDryRun.summary.ambiguous}
                {" | "}Duplicates: {grantDryRun.summary.duplicateInputs + grantDryRun.summary.duplicateTargets}
                {" | "}Total credits:{" "}
                <span className="font-semibold text-zinc-950">{grantDryRun.summary.totalCredits}</span>
              </p>
              {!grantDryRun.allowCompActions ? (
                <p className="mt-2 font-semibold text-red-700">
                  Manual credit grants are disabled in Policy.
                </p>
              ) : null}
              <div className="mt-3 max-h-44 overflow-auto">
                {grantDryRun.targets.slice(0, 40).map((target) => (
                  <p key={`${target.input}-${target.status}`} className="border-t border-zinc-100 py-1 text-xs">
                    <span className="font-mono">{target.input}</span> -{" "}
                    <span className={target.status === "ready" ? "text-emerald-700" : "text-amber-700"}>
                      {target.status}
                    </span>{" "}
                    {target.message}
                  </p>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-red-900">Account Deletion</h3>
          <p className="mt-1 text-sm text-zinc-700">
            Paste email, auth id, or credit id from the user search results. Dry run first. Commit removes account,
            cookbook, credits, usage, identity links, and device links. Purchase transaction rows are anonymized and
            preserved for financial audit.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_0.6fr]">
            <label className="space-y-1 text-sm font-semibold text-red-900">
              Users to delete
              <textarea
                value={deleteIdentifiersText}
                onChange={(event) => setDeleteIdentifiersText(event.target.value)}
                rows={6}
                className="w-full rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-red-500"
                placeholder="one email or user id per line"
              />
            </label>
            <div className="space-y-3">
              <label className="space-y-1 text-sm font-semibold text-red-900">
                Reason
                <input
                  type="text"
                  value={deleteReason}
                  onChange={(event) => setDeleteReason(event.target.value)}
                  className="w-full rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-red-500"
                  placeholder="user requested deletion"
                />
              </label>
              <label className="space-y-1 text-sm font-semibold text-red-900">
                Commit confirmation
                <input
                  type="text"
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  className="w-full rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm font-medium text-zinc-900 outline-none transition focus:border-red-500"
                  placeholder="type DELETE"
                />
              </label>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runAccountDelete("dry_run")}
              disabled={isRunningDeleteDryRun || isCommittingDelete}
              className="cursor-pointer rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-800 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRunningDeleteDryRun ? "Checking..." : "Dry Run Delete"}
            </button>
            <button
              type="button"
              onClick={() => void runAccountDelete("commit")}
              disabled={
                isCommittingDelete ||
                deleteConfirmation !== "DELETE" ||
                !deleteDryRun ||
                deleteDryRun.summary.ready < 1 ||
                deleteDryRun.summary.blockedSharedIdentity > 0
              }
              className="cursor-pointer rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isCommittingDelete ? "Deleting..." : "Commit Delete"}
            </button>
          </div>
          {deleteDryRun ? (
            <div className="mt-4 rounded-xl border border-red-100 bg-white p-3 text-sm text-zinc-700">
              <p>
                Ready: <span className="font-semibold text-zinc-950">{deleteDryRun.summary.ready}</span>
                {" | "}Missing: {deleteDryRun.summary.missing}
                {" | "}Ambiguous: {deleteDryRun.summary.ambiguous}
                {" | "}Blocked shared: {deleteDryRun.summary.blockedSharedIdentity}
                {" | "}Deleted: {deleteDryRun.summary.deleted}
              </p>
              <p className="mt-2 text-xs text-zinc-600">
                Deletes {deleteDryRun.summary.counts.cookbookRecipes} cookbook row(s),{" "}
                {deleteDryRun.summary.counts.creditLedgerEntries} ledger row(s),{" "}
                {deleteDryRun.summary.counts.dailyUsageRows} daily usage row(s), and preserves{" "}
                {deleteDryRun.summary.counts.purchaseTransactionsPreserved} anonymized purchase transaction row(s).
              </p>
              <div className="mt-3 max-h-52 overflow-auto">
                {deleteDryRun.targets.slice(0, 50).map((target) => (
                  <div key={`${target.input}-${target.status}`} className="border-t border-zinc-100 py-2 text-xs">
                    <p>
                      <span className="font-mono">{target.input}</span> -{" "}
                      <span className={target.status === "ready" ? "text-emerald-700" : "text-red-700"}>
                        {target.status}
                      </span>{" "}
                      {target.message}
                    </p>
                    {target.linkedAuthUsers.length > 1 ? (
                      <p className="mt-1 text-red-700">
                        Linked accounts: {target.linkedAuthUsers.map((linked) => linked.email).join(", ")}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {panelNotices.users.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.users.error}
          </p>
        ) : null}
        {panelNotices.users.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.users.success}
          </p>
        ) : null}
      </section>
      ) : null}

      {activeTab === "analytics" ? (
      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-emerald-900">Observe Analytics</h2>
            <p className="text-sm text-zinc-700">
              Readiness report for credits enforcement. In observe mode this does not block users.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadObserveReport();
            }}
            disabled={isLoadingObserveReport}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingObserveReport ? "Refreshing..." : "Refresh Analytics"}
          </button>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <p>
            Runtime Mode:{" "}
            <span className="font-semibold text-zinc-900">{observeRuntime.enforcementMode}</span>
            {" | "}Enabled:{" "}
            <span className="font-semibold text-zinc-900">
              {observeRuntime.enabled ? "true" : "false"}
            </span>
          </p>
          <p>
            Free Daily Limits:{" "}
            <span className="font-semibold text-zinc-900">
              Fuse {toInteger(observeRuntime.freeDailyFuseActions)} / Reroll{" "}
              {toInteger(observeRuntime.freeDailyRerollActions)}
            </span>
          </p>
          <p>
            Last Updated:{" "}
            <span className="font-semibold text-zinc-900">{toIsoLabel(observeGeneratedAt)}</span>
            {" | "}Timezone: <span className="font-semibold text-zinc-900">{observeTimezone}</span>
            {" | "}Day Key: <span className="font-semibold text-zinc-900">{observeTodayDayKey || "N/A"}</span>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Fuse (24h)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeSnapshot24h.fuseActions}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Reroll (24h)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeSnapshot24h.rerollActions}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Unique Users (24h)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeSnapshot24h.uniqueUsers}</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Estimated Paywall Hits % (Today)</p>
            <p className="text-2xl font-semibold text-emerald-900">{observeTodayEstimate.wouldBlockPercentage}%</p>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <p>
            Over-Quota Actions (Today):{" "}
            <span className="font-semibold text-zinc-900">{observeTodayEstimate.overQuotaActions}</span>
          </p>
          <p>
            Estimated Paywall Hits (Today):{" "}
            <span className="font-semibold text-zinc-900">{observeTodayEstimate.estimatedBlockedActions}</span>
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">
            Daily Trend
          </h3>
          <p className="text-sm text-zinc-700">
            Day-by-day action volume and estimated paywall pressure based on current free limits.
          </p>
          {observeTrend.length === 0 ? (
            <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              No trend data yet.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Day</th>
                    <th className="px-3 py-2 font-semibold">Fuse</th>
                    <th className="px-3 py-2 font-semibold">Reroll</th>
                    <th className="px-3 py-2 font-semibold">Total</th>
                    <th className="px-3 py-2 font-semibold">Users</th>
                    <th className="px-3 py-2 font-semibold">Over Quota</th>
                    <th className="px-3 py-2 font-semibold">Estimated Paywall Hits</th>
                    <th className="px-3 py-2 font-semibold">Paywall Hit %</th>
                  </tr>
                </thead>
                <tbody>
                  {observeTrend.map((row) => (
                    <tr key={row.dayKey} className="border-t border-zinc-100 text-zinc-800">
                      <td className="px-3 py-2 font-semibold">{row.dayKey}</td>
                      <td className="px-3 py-2">{row.fuseActions}</td>
                      <td className="px-3 py-2">{row.rerollActions}</td>
                      <td className="px-3 py-2">{row.totalActions}</td>
                      <td className="px-3 py-2">{row.uniqueUsers}</td>
                      <td className="px-3 py-2">{row.overQuotaActions}</td>
                      <td className="px-3 py-2">{row.estimatedBlockedActions}</td>
                      <td className="px-3 py-2">{row.wouldBlockPercentage}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900">
            Top Pressure Users (Today)
          </h3>
          <p className="text-sm text-zinc-700">
            Users most likely to hit credit limits today, useful for tuning free limits and support actions.
          </p>
          {observeTopUsers.length === 0 ? (
            <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
              No user pressure data yet.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    <th className="px-3 py-2 font-semibold">User</th>
                    <th className="px-3 py-2 font-semibold">Fuse</th>
                    <th className="px-3 py-2 font-semibold">Reroll</th>
                    <th className="px-3 py-2 font-semibold">Total</th>
                    <th className="px-3 py-2 font-semibold">Available Credits</th>
                    <th className="px-3 py-2 font-semibold">Over Quota</th>
                    <th className="px-3 py-2 font-semibold">Est. Paywall Hits</th>
                    <th className="px-3 py-2 font-semibold">Paywall Hit Now</th>
                  </tr>
                </thead>
                <tbody>
                  {observeTopUsers.map((row) => (
                    <tr key={row.anonUserId} className="border-t border-zinc-100 text-zinc-800">
                      <td className="px-3 py-2 font-mono text-xs">{maskAnonUserId(row.anonUserId)}</td>
                      <td className="px-3 py-2">{row.fuseCount}</td>
                      <td className="px-3 py-2">{row.rerollCount}</td>
                      <td className="px-3 py-2">{row.totalActions}</td>
                      <td className="px-3 py-2">{row.availableCredits}</td>
                      <td className="px-3 py-2">{row.overQuotaActions}</td>
                      <td className="px-3 py-2">{row.estimatedBlockedActions}</td>
                      <td className="px-3 py-2">
                        {row.wouldBlockNow ? (
                          <span className="rounded-lg bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
                            Yes
                          </span>
                        ) : (
                          <span className="rounded-lg bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-700">
                            No
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {panelNotices.observeAnalytics.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.observeAnalytics.error}
          </p>
        ) : null}
        {panelNotices.observeAnalytics.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.observeAnalytics.success}
          </p>
        ) : null}
      </section>
      ) : null}

      {activeTab === "runtime" ? (
      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Monetization Policy</h2>
        <p className="text-sm text-zinc-700">
          These settings apply globally to all users. Use them to control rollout behavior without redeploying.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-2 rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-900">
            <span className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                className="h-4 w-4 accent-emerald-600"
              />
              Credits Enabled
            </span>
            <span className="block text-xs font-normal text-zinc-600">
              Master switch for monetization. Off disables credit logic entirely. On follows the selected enforcement mode.
            </span>
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Enforcement Mode
            <select
              value={form.enforcementMode}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  enforcementMode: event.target.value as EnforcementMode,
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            >
              <option value="off">off (disabled)</option>
              <option value="observe">observe (track only)</option>
              <option value="enforce">enforce (block when no credits)</option>
            </select>
            <p className="text-xs font-normal text-zinc-600">
              `off`: no monetization behavior. `observe`: record usage and simulate paywall impact, no blocking. `enforce`: apply free limits, then require credits.
            </p>
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Free Daily Fuse Actions
            <input
              type="number"
              min={0}
              max={20}
              value={form.freeDailyFuseActions}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  freeDailyFuseActions: clampDailyLimit(Number(event.target.value)),
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
            <p className="text-xs font-normal text-zinc-600">
              Number of free Fuse actions each user gets per day before credit spend starts in enforce mode. Range: 0-20.
            </p>
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Free Daily Reroll Actions
            <input
              type="number"
              min={0}
              max={20}
              value={form.freeDailyRerollActions}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  freeDailyRerollActions: clampDailyLimit(Number(event.target.value)),
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
            <p className="text-xs font-normal text-zinc-600">
              Number of free Reroll actions each user gets per day before credit spend starts in enforce mode. Range: 0-20.
            </p>
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Recipe Generation Credit Cost
            <input
              type="number"
              min={1}
              max={100}
              value={form.fuseCreditCost}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  fuseCreditCost: clampActionCreditCost(Number(event.target.value)),
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
            <p className="text-xs font-normal text-zinc-600">
              Credits charged for one new recipe generation after free Fuse actions are used in enforce mode. Current production target: 2 credits.
            </p>
          </label>

          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Reroll Credit Cost
            <input
              type="number"
              min={1}
              max={100}
              value={form.rerollCreditCost}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  rerollCreditCost: clampActionCreditCost(Number(event.target.value)),
                }))
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
            <p className="text-xs font-normal text-zinc-600">
              Credits charged for one reroll after free Reroll actions are used in enforce mode. Keep this lower than generation if rerolls should feel lightweight.
            </p>
          </label>

          <label className="space-y-2 rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-900 md:col-span-2">
            <span className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={form.allowCompActions}
                onChange={(event) =>
                  setForm((current) => ({ ...current, allowCompActions: event.target.checked }))
                }
                className="h-4 w-4 accent-emerald-600"
              />
              Allow compensation actions (manual credit grants)
            </span>
            <span className="block text-xs font-normal text-zinc-600">
              Global safety switch for admin compensation flows. This does not grant free credits to all users by itself; it only allows/disables support-side grant actions.
            </span>
          </label>
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <p>
            Last updated: <span className="font-semibold text-zinc-900">{toIsoLabel(form.updatedAt)}</span>
          </p>
          <p>
            Updated by: <span className="font-semibold text-zinc-900">{form.updatedBy || "N/A"}</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void saveConfig("runtimeSettings");
            }}
            disabled={isSaving}
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? "Saving..." : "Save Config"}
          </button>
          <button
            type="button"
            onClick={() => {
              void readConfig("runtimeSettings");
            }}
            disabled={isLoading}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh
          </button>
        </div>
        {panelNotices.runtimeSettings.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.runtimeSettings.error}
          </p>
        ) : null}
        {panelNotices.runtimeSettings.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.runtimeSettings.success}
          </p>
        ) : null}
      </section>
      ) : null}

      {activeTab === "reconciliation" ? (
      <section className="space-y-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-emerald-900">Credit Reconciliation</h2>
        <p className="text-sm text-zinc-700">
          Run this manually when users report stuck credits. It releases expired reservations
          immediately, without waiting for scheduled cron.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-emerald-900">
            Max Candidates
            <input
              type="number"
              min={1}
              max={1000}
              value={reconciliationMaxCandidates}
              onChange={(event) =>
                setReconciliationMaxCandidates(
                  clampReconciliationLimit(Number(event.target.value)),
                )
              }
              className="w-full rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-base font-medium text-zinc-900 outline-none transition focus:border-emerald-500"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void loadReconciliationPreview();
            }}
            disabled={isLoadingReconciliationPreview}
            className="cursor-pointer rounded-xl border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingReconciliationPreview ? "Loading Preview..." : "Preview Expired Reservations"}
          </button>
          <button
            type="button"
            onClick={runReconciliationNow}
            disabled={isRunningReconciliation}
            className="cursor-pointer rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunningReconciliation ? "Running..." : "Run Reconciliation Now"}
          </button>
        </div>

        {reconciliationSummary ? (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
            <p className="font-semibold text-zinc-900">Last Run Summary</p>
            <p>Scanned: {reconciliationSummary.scanned}</p>
            <p>Released: {reconciliationSummary.released}</p>
            <p>Already Finalized: {reconciliationSummary.alreadyFinalized}</p>
            <p>Failed: {reconciliationSummary.failed}</p>
          </div>
        ) : null}

        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-zinc-900">
            Expired Reservation Preview ({reconciliationPreview.length})
          </p>
          {reconciliationPreview.length === 0 ? (
            <p className="text-sm text-zinc-700">No expired reservations found in the current preview.</p>
          ) : (
            <div className="max-h-56 overflow-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-zinc-50 text-zinc-700">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Reservation</th>
                    <th className="px-3 py-2 font-semibold">User</th>
                    <th className="px-3 py-2 font-semibold">Action</th>
                    <th className="px-3 py-2 font-semibold">Amount</th>
                    <th className="px-3 py-2 font-semibold">Expired At</th>
                  </tr>
                </thead>
                <tbody>
                  {reconciliationPreview.map((item) => (
                    <tr key={item.reservationId} className="border-t border-zinc-100 text-zinc-800">
                      <td className="px-3 py-2 font-mono text-xs">{item.reservationId}</td>
                      <td className="px-3 py-2 font-mono text-xs">{item.anonUserId}</td>
                      <td className="px-3 py-2">{item.actionKind}</td>
                      <td className="px-3 py-2">{item.amount}</td>
                      <td className="px-3 py-2">{toIsoLabel(item.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {panelNotices.reconciliation.error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {panelNotices.reconciliation.error}
          </p>
        ) : null}
        {panelNotices.reconciliation.success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {panelNotices.reconciliation.success}
          </p>
        ) : null}
      </section>
      ) : null}
    </div>
  );
}
