import type { NavigatorScreenParams } from "@react-navigation/native";
import type {
  CookbookRecipeRecord,
  CookbookRecipeSummary,
  FuseRequest,
  GeneratedRecipeRecord,
} from "../types/recipe";

export type HomeStackParamList = {
  Home:
    | {
        resetToken?: string;
      }
    | undefined;
  RecipeWorkspace:
    | {
        initialRecord?: GeneratedRecipeRecord;
        pendingRequest?: {
          input: FuseRequest;
          requestId: string;
        };
      }
    | undefined;
};

export type RootTabParamList = {
  Explore: NavigatorScreenParams<HomeStackParamList> | undefined;
  Cookbook: undefined;
};

export type CookbookStackParamList = {
  CookbookList: undefined;
  CookbookDetail: { recipeId: string };
};

export type MobileCookbookContextValue = {
  summaries: CookbookRecipeSummary[];
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
  deleteRecord: (recipeId: string) => Promise<void>;
};
