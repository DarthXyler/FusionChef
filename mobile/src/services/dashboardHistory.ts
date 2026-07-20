import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CookbookRecipeSummary, GeneratedRecipeRecord } from "../types/recipe";
import { getMobileAuthRequestContext } from "./auth";
import {
  isMobileSessionIdentityCurrent,
  type MobileSessionIdentity,
} from "./authSession";

const DASHBOARD_HISTORY_KEY = "flavor_fusion_dashboard_history_v1";
const DASHBOARD_HISTORY_ACCOUNT_PREFIX = "flavor_fusion_dashboard_history_v2:";
const MAX_DASHBOARD_HISTORY_ITEMS = 12;

// Local safety net for recipes the user generated but may not have saved yet.
// This is device-only history, separate from the Turso-backed Cookbook.
export type DashboardFusionSummary = {
  id: string;
  title: string;
  baseCuisine: string;
  fusionCuisine: string;
  createdAt: string;
  imageUrl?: string;
  usageCount?: number;
  isFavorite?: boolean;
  isToTry?: boolean;
  record?: GeneratedRecipeRecord;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDashboardFusionSummary(value: unknown): value is DashboardFusionSummary {
  if (!isObjectRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.baseCuisine === "string" &&
    typeof value.fusionCuisine === "string" &&
    typeof value.createdAt === "string"
  );
}

function sortHistory(items: DashboardFusionSummary[]) {
  return [...items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function isLocalImageSnapshot(value: unknown) {
  return typeof value === "string" && value.trim().startsWith("data:image/");
}

type DashboardHistoryScope = {
  key: string;
  identity: MobileSessionIdentity;
};

async function getDashboardHistoryScope(): Promise<DashboardHistoryScope | null> {
  const authContext = await getMobileAuthRequestContext();
  if (!authContext.session || !isMobileSessionIdentityCurrent(authContext.identity)) {
    return null;
  }
  return {
    key: `${DASHBOARD_HISTORY_ACCOUNT_PREFIX}${authContext.session.userId}`,
    identity: authContext.identity,
  };
}

async function readDashboardFusionHistoryForScope(scope: DashboardHistoryScope) {
  try {
    if (!isMobileSessionIdentityCurrent(scope.identity)) {
      return [];
    }
    const raw = await AsyncStorage.getItem(scope.key);
    if (!raw || !isMobileSessionIdentityCurrent(scope.identity)) {
      return [];
    }
    const payload = JSON.parse(raw) as unknown;
    if (!Array.isArray(payload)) {
      return [];
    }
    return sortHistory(payload.filter(isDashboardFusionSummary)).slice(0, MAX_DASHBOARD_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

export async function readDashboardFusionHistory() {
  const scope = await getDashboardHistoryScope();
  return scope ? readDashboardFusionHistoryForScope(scope) : [];
}

async function saveDashboardFusionHistoryForScope(
  items: DashboardFusionSummary[],
  scope: DashboardHistoryScope,
) {
  if (!isMobileSessionIdentityCurrent(scope.identity)) {
    return [];
  }
  const next = sortHistory(items).slice(0, MAX_DASHBOARD_HISTORY_ITEMS);
  await AsyncStorage.setItem(scope.key, JSON.stringify(next));
  return next;
}

export async function saveDashboardFusionHistory(items: DashboardFusionSummary[]) {
  const scope = await getDashboardHistoryScope();
  return scope ? saveDashboardFusionHistoryForScope(items, scope) : [];
}

export async function clearDashboardFusionHistory() {
  const allKeys = await AsyncStorage.getAllKeys();
  const historyKeys = allKeys.filter(
    (key) => key === DASHBOARD_HISTORY_KEY || key.startsWith(DASHBOARD_HISTORY_ACCOUNT_PREFIX),
  );
  if (historyKeys.length > 0) {
    await AsyncStorage.multiRemove(historyKeys);
  }
}

export async function upsertDashboardFusionHistory(record: GeneratedRecipeRecord) {
  const scope = await getDashboardHistoryScope();
  if (!scope) {
    return [];
  }
  const current = await readDashboardFusionHistoryForScope(scope);
  const existing = current.find((item) => item.id === record.recipe.id);
  const preservedImageUrl = isLocalImageSnapshot(existing?.record?.recipe.imageUrl)
    ? existing?.record?.recipe.imageUrl
    : isLocalImageSnapshot(existing?.imageUrl)
      ? existing?.imageUrl
      : record.recipe.imageUrl;
  const nextRecord: GeneratedRecipeRecord = {
    ...record,
    recipe: {
      ...record.recipe,
      imageUrl: preservedImageUrl,
    },
  };
  // Store the full generated record so the user can reopen and save it later.
  // Older app versions stored only the small summary fields.
  const nextItem: DashboardFusionSummary = {
    id: nextRecord.recipe.id,
    title: nextRecord.recipe.title,
    baseCuisine: nextRecord.recipe.baseCuisine,
    fusionCuisine: nextRecord.recipe.fusionCuisine,
    createdAt: nextRecord.createdAt,
    imageUrl: nextRecord.recipe.imageUrl,
    record: nextRecord,
  };
  return saveDashboardFusionHistoryForScope(
    [nextItem, ...current.filter((item) => item.id !== nextItem.id)],
    scope,
  );
}

export function cookbookSummaryToDashboardFusion(
  summary: CookbookRecipeSummary,
): DashboardFusionSummary {
  return {
    id: summary.recipeId,
    title: summary.title,
    baseCuisine: summary.baseCuisine,
    fusionCuisine: summary.fusionCuisine,
    createdAt: summary.savedAt,
    imageUrl: summary.imageUrl,
    isFavorite: summary.isFavorite === true,
    isToTry: summary.isToTry === true,
  };
}
