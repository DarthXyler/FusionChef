import type { NavigatorScreenParams } from "@react-navigation/native";
import type {
  CookbookRecipeRecord,
  CookbookRecipeSummary,
  CookbookStats,
  FuseRequest,
  GeneratedRecipeRecord,
} from "../types/recipe";
import type { MobileSessionIdentity } from "../services/authSession";

export type HomeStackParamList = {
  DashboardHome: undefined;
  RecentFusions: undefined;
  CreateFusion:
    | {
        resetToken?: string;
        importPhotoOnOpen?: boolean;
        creditGateToken?: string;
        creditGateInput?: FuseRequest;
        creditGateReason?: "insufficient_credits_402" | "login_required";
      }
    | undefined;
  RecipeWorkspace:
    | {
        initialRecord?: GeneratedRecipeRecord;
        initialRecordOwner?: MobileSessionIdentity;
        pendingRequest?: {
          input: FuseRequest;
          requestId: string;
          owner?: MobileSessionIdentity;
        };
      }
    | undefined;
};

export type RootTabParamList = {
  Explore: NavigatorScreenParams<HomeStackParamList> | undefined;
  Cookbook: NavigatorScreenParams<CookbookStackParamList> | undefined;
  Create: NavigatorScreenParams<HomeStackParamList> | undefined;
  Profile:
    | {
        openCreditSheetToken?: string;
      }
    | undefined;
};

export type CookbookStackParamList = {
  CookbookList:
    | {
        initialFilter?: "all" | "favorites" | "toTry";
      }
    | undefined;
  CookbookDetail: { recipeId: string; initialSummary?: CookbookRecipeSummary };
};

export type MobileCookbookContextValue = {
  summaries: CookbookRecipeSummary[];
  stats: CookbookStats;
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  hasLoaded: boolean;
  hasMore: boolean;
  isShowingCachedSummaries: boolean;
  summarySyncError: string;
  loadSummaries: () => Promise<void>;
  refreshSummaries: () => Promise<void>;
  loadMoreSummaries: () => Promise<void>;
  saveRecord: (record: GeneratedRecipeRecord) => Promise<CookbookRecipeRecord>;
  getRecord: (recipeId: string) => CookbookRecipeRecord | undefined;
  loadRecord: (recipeId: string) => Promise<CookbookRecipeRecord>;
  refreshRecord: (recipeId: string) => Promise<CookbookRecipeRecord>;
  updateRecipeFlags: (
    recipeId: string,
    flags: { isFavorite?: boolean; isToTry?: boolean },
  ) => Promise<CookbookRecipeRecord>;
  deleteRecord: (recipeId: string) => Promise<void>;
  resetLocalState: () => void;
};
