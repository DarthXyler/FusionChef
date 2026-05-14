import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CookbookRecipeSummary, GeneratedRecipeRecord } from "../types/recipe";

const DASHBOARD_HISTORY_KEY = "flavor_fusion_dashboard_history_v1";
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

export async function readDashboardFusionHistory() {
  try {
    const raw = await AsyncStorage.getItem(DASHBOARD_HISTORY_KEY);
    if (!raw) {
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

export async function saveDashboardFusionHistory(items: DashboardFusionSummary[]) {
  const next = sortHistory(items).slice(0, MAX_DASHBOARD_HISTORY_ITEMS);
  await AsyncStorage.setItem(DASHBOARD_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export async function clearDashboardFusionHistory() {
  await AsyncStorage.removeItem(DASHBOARD_HISTORY_KEY);
}

export async function upsertDashboardFusionHistory(record: GeneratedRecipeRecord) {
  const current = await readDashboardFusionHistory();
  // Store the full generated record so the user can reopen and save it later.
  // Older app versions stored only the small summary fields.
  const nextItem: DashboardFusionSummary = {
    id: record.recipe.id,
    title: record.recipe.title,
    baseCuisine: record.recipe.baseCuisine,
    fusionCuisine: record.recipe.fusionCuisine,
    createdAt: record.createdAt,
    imageUrl: record.recipe.imageUrl,
    record,
  };
  return saveDashboardFusionHistory([
    nextItem,
    ...current.filter((item) => item.id !== nextItem.id),
  ]);
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
