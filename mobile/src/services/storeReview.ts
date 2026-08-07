import AsyncStorage from "@react-native-async-storage/async-storage";
import * as StoreReview from "expo-store-review";

const STORE_REVIEW_STORAGE_KEY = "flavor_fusion_store_review_v1";
const REQUIRED_SUCCESSFUL_SAVES = 3;
const REVIEW_REQUEST_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;

type StoreReviewState = {
  successfulSaveCount: number;
  lastRequestAt: number | null;
};

let reviewTaskQueue: Promise<void> = Promise.resolve();

function parseStoreReviewState(value: string | null): StoreReviewState {
  if (!value) {
    return { successfulSaveCount: 0, lastRequestAt: null };
  }

  const parsed = JSON.parse(value) as Partial<StoreReviewState>;
  const successfulSaveCount =
    typeof parsed.successfulSaveCount === "number" &&
    Number.isFinite(parsed.successfulSaveCount)
      ? Math.min(REQUIRED_SUCCESSFUL_SAVES, Math.max(0, Math.floor(parsed.successfulSaveCount)))
      : 0;
  const lastRequestAt =
    typeof parsed.lastRequestAt === "number" && Number.isFinite(parsed.lastRequestAt)
      ? parsed.lastRequestAt
      : null;

  return { successfulSaveCount, lastRequestAt };
}

async function recordSuccessfulSaveAndRequestReviewIfEligible() {
  try {
    const storedState = parseStoreReviewState(
      await AsyncStorage.getItem(STORE_REVIEW_STORAGE_KEY),
    );
    const nextState: StoreReviewState = {
      successfulSaveCount: Math.min(
        REQUIRED_SUCCESSFUL_SAVES,
        storedState.successfulSaveCount + 1,
      ),
      lastRequestAt: storedState.lastRequestAt,
    };

    await AsyncStorage.setItem(STORE_REVIEW_STORAGE_KEY, JSON.stringify(nextState));

    const now = Date.now();
    const isCooldownComplete =
      nextState.lastRequestAt === null ||
      now - nextState.lastRequestAt >= REVIEW_REQUEST_COOLDOWN_MS;
    if (nextState.successfulSaveCount < REQUIRED_SUCCESSFUL_SAVES || !isCooldownComplete) {
      return;
    }

    if (!(await StoreReview.isAvailableAsync())) {
      return;
    }

    await AsyncStorage.setItem(
      STORE_REVIEW_STORAGE_KEY,
      JSON.stringify({ ...nextState, lastRequestAt: now }),
    );
    await StoreReview.requestReview();
  } catch {
    // Review eligibility and prompts must never affect cookbook save success.
  }
}

export function recordSuccessfulCookbookSaveForReview(): Promise<void> {
  reviewTaskQueue = reviewTaskQueue.then(
    recordSuccessfulSaveAndRequestReviewIfEligible,
    recordSuccessfulSaveAndRequestReviewIfEligible,
  );
  return reviewTaskQueue;
}
