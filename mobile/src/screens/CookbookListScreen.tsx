import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppCreditHeader } from "../components/AppCreditHeader";
import { PrimaryButton } from "../components/PrimaryButton";
import { useMobileCookbook } from "../context/mobileCookbook";
import { useResponsiveFlags } from "../hooks/useResponsiveFlags";
import type { CookbookStackParamList } from "../navigation/types";
import type { CookbookRecipeSummary } from "../types/recipe";
import { styles } from "../styles/appStyles";

/**
 * Cookbook list screen:
 * - server-backed paginated list
 * - local search + sort on loaded rows
 * - pull-to-refresh + infinite load
 */
type CookbookSortOption = "newest" | "oldest" | "title";
type CookbookFilterOption = "all" | "favorites" | "toTry";

export function CookbookListScreen({
  navigation,
  route,
}: NativeStackScreenProps<CookbookStackParamList, "CookbookList">) {
  const { isCompactScreen, isVeryCompactScreen } = useResponsiveFlags();
  const {
    summaries,
    stats,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasLoaded,
    hasMore,
    isShowingCachedSummaries,
    summarySyncError,
    loadSummaries,
    refreshSummaries,
    loadMoreSummaries,
    deleteRecord,
  } = useMobileCookbook();
  const [deletingRecipeId, setDeletingRecipeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<CookbookSortOption>("newest");
  const [filterBy, setFilterBy] = useState<CookbookFilterOption>("all");

  useEffect(() => {
    const requestedFilter = route.params?.initialFilter;
    if (
      requestedFilter === "all" ||
      requestedFilter === "favorites" ||
      requestedFilter === "toTry"
    ) {
      setFilterBy(requestedFilter);
    }
  }, [route.params?.initialFilter]);

  useEffect(() => {
    // First mount load; subsequent tab returns use context cache/state.
    if (hasLoaded) {
      return;
    }

    let cancelled = false;
    void loadSummaries().catch(() => {
      if (cancelled) {
        return;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hasLoaded, loadSummaries]);

  const filteredSummaries = useMemo(() => {
    // Keep filtering/sorting client-side for already fetched pages.
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const categoryFiltered =
      filterBy === "favorites"
        ? summaries.filter((summary) => summary.isFavorite)
        : filterBy === "toTry"
          ? summaries.filter((summary) => summary.isToTry)
          : summaries;
    const baseList =
      normalizedQuery.length === 0
        ? categoryFiltered
        : categoryFiltered.filter((summary) => {
            const searchableText = [
              summary.title,
              summary.baseCuisine,
              summary.fusionCuisine,
              `${summary.baseCuisine} ${summary.fusionCuisine}`,
            ]
              .join(" ")
              .toLowerCase();
            return searchableText.includes(normalizedQuery);
          });

    const next = [...baseList];
    if (sortBy === "oldest") {
      next.sort((left, right) => Date.parse(left.savedAt) - Date.parse(right.savedAt));
      return next;
    }

    if (sortBy === "title") {
      next.sort((left, right) => left.title.localeCompare(right.title));
      return next;
    }

    next.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
    return next;
  }, [filterBy, searchQuery, sortBy, summaries]);

  function handleOpenSortOptions() {
    const setSelection = (value: CookbookSortOption) => setSortBy(value);

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Newest First", "Oldest First", "Title A-Z"],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) {
            setSelection("newest");
          }
          if (buttonIndex === 2) {
            setSelection("oldest");
          }
          if (buttonIndex === 3) {
            setSelection("title");
          }
        },
      );
      return;
    }

    Alert.alert("Sort recipes", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Newest First", onPress: () => setSelection("newest") },
      { text: "Oldest First", onPress: () => setSelection("oldest") },
      { text: "Title A-Z", onPress: () => setSelection("title") },
    ]);
  }

  function handleDeleteFromList(summary: CookbookRecipeSummary) {
    // Optimistic local removal is handled inside the mobileCookbook context.
    if (deletingRecipeId) {
      return;
    }

    Alert.alert("Delete Recipe", "Remove this recipe from your cookbook?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setDeletingRecipeId(summary.recipeId);
            try {
              await deleteRecord(summary.recipeId);
            } catch (error) {
              const message =
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "Could not delete recipe.";
              Alert.alert("Delete failed", message);
            } finally {
              setDeletingRecipeId((current) => (current === summary.recipeId ? null : current));
            }
          })();
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <FlatList
          data={filteredSummaries}
          keyExtractor={(item) => item.recipeId}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onEndReached={() => {
            // Infinite pagination: fetch the next cursor page when list nears the end.
            void loadMoreSummaries().catch((error) => {
              const message =
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "Could not load more recipes.";
              Alert.alert("Load more failed", message);
            });
          }}
          onEndReachedThreshold={0.5}
          refreshing={isRefreshing}
          onRefresh={() => {
            // Pull-to-refresh resets to freshest head page from API.
            void refreshSummaries().catch((error) => {
              const message =
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "Could not refresh cookbook.";
              if (summaries.length === 0) {
                Alert.alert("Refresh failed", message);
              }
            });
          }}
          contentContainerStyle={[styles.content, isVeryCompactScreen && styles.contentCompact]}
          ListHeaderComponent={
            <>
              <AppCreditHeader />
              <View style={styles.homeHeroCard}>
                <Text style={styles.kicker}>Cookbook</Text>
                <Text
                  style={[
                    styles.title,
                    isCompactScreen && styles.titleCompact,
                    isVeryCompactScreen && styles.titleVeryCompact,
                  ]}
                >
                  Your saved recipes.
                </Text>
                <Text style={styles.summary}>
                  Revisit saved fusion recipes and open any card to see the full ingredients,
                  swaps, shopping list, and notes.
                </Text>
              </View>

              <View style={styles.cookbookSectionHeader}>
                <Text style={styles.sectionTitle}>Recipes</Text>
              </View>

              <View style={styles.cookbookFilterRow}>
                {[
                  ["all", "All", stats.totalRecipes],
                  ["favorites", "Favorites", stats.favoriteRecipes],
                  ["toTry", "To Try", stats.toTryRecipes],
                ].map(([value, label, count]) => {
                  const active = filterBy === value;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      key={String(value)}
                      onPress={() => setFilterBy(value as CookbookFilterOption)}
                      style={({ pressed }) => [
                        styles.cookbookFilterChip,
                        active && styles.cookbookFilterChipActive,
                        pressed && styles.menuButtonPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.cookbookFilterChipText,
                          active && styles.cookbookFilterChipTextActive,
                        ]}
                      >
                        {label} {count}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.cookbookControlsRow}>
                <View style={styles.cookbookSearchWrap}>
                  <MaterialIcons color="#6b7280" name="search" size={18} />
                  <TextInput
                    onChangeText={setSearchQuery}
                    placeholder="Search"
                    placeholderTextColor="#9ca3af"
                    style={styles.cookbookSearchInput}
                    value={searchQuery}
                  />
                  {searchQuery.length > 0 ? (
                    <Pressable
                      accessibilityLabel="Clear search"
                      onPress={() => setSearchQuery("")}
                      style={({ pressed }) => [
                        styles.cookbookSearchClearButton,
                        pressed && styles.menuButtonPressed,
                      ]}
                    >
                      <MaterialIcons color="#6b7280" name="close" size={16} />
                    </Pressable>
                  ) : null}
                </View>
                <Pressable
                  accessibilityLabel="Sort recipes"
                  onPress={handleOpenSortOptions}
                  style={({ pressed }) => [
                    styles.cookbookSortButton,
                    sortBy !== "newest" && styles.cookbookSortButtonActive,
                    pressed && styles.menuButtonPressed,
                  ]}
                >
                  <MaterialIcons
                    color={sortBy === "newest" ? "#065f46" : "#047857"}
                    name="sort"
                    size={20}
                  />
                </Pressable>
              </View>

              {summarySyncError && summaries.length > 0 ? (
                <View style={styles.offlineNoticeCard}>
                  <Text style={styles.offlineNoticeTitle}>
                    {isShowingCachedSummaries
                      ? "Offline: showing saved cookbook data"
                      : "Cookbook sync issue"}
                  </Text>
                  <Text style={styles.offlineNoticeCopy}>
                    {isShowingCachedSummaries
                      ? "You're viewing recipes saved on this device while we reconnect."
                      : summarySyncError}
                  </Text>
                </View>
              ) : null}
            </>
          }
          renderItem={({ item: summary }) => (
            <View style={styles.cookbookCard}>
              <View style={styles.cookbookCardRow}>
                <Pressable
                  onPress={() =>
                    navigation.navigate("CookbookDetail", {
                      recipeId: summary.recipeId,
                      initialSummary: summary,
                    })
                  }
                  style={({ pressed }) => [
                    styles.cookbookCardMainPressable,
                    pressed && styles.menuButtonPressed,
                  ]}
                >
                  <View style={styles.cookbookCardContentRow}>
                    {summary.imageUrl ? (
                      <Image
                        source={{ uri: summary.imageUrl }}
                        style={[
                          styles.cookbookCardImage,
                          isCompactScreen && styles.cookbookCardImageCompact,
                        ]}
                      />
                    ) : (
                      <View
                        style={[
                          styles.cookbookCardImagePlaceholder,
                          isCompactScreen && styles.cookbookCardImageCompact,
                        ]}
                      >
                        <MaterialCommunityIcons color="#6b7280" name="chef-hat" size={26} />
                      </View>
                    )}
                    <View style={styles.cookbookCardBody}>
                      <Text
                        style={[
                          styles.cookbookCardTitle,
                          isCompactScreen && styles.cookbookCardTitleCompact,
                        ]}
                      >
                        {summary.title}
                      </Text>
                      <Text style={styles.cookbookCardMeta}>
                        {summary.baseCuisine} + {summary.fusionCuisine}
                      </Text>
                    </View>
                  </View>
                </Pressable>
                <View
                  style={[
                    styles.cookbookCardActions,
                    isCompactScreen && styles.cookbookCardActionsCompact,
                  ]}
                >
                  <Text style={styles.cookbookCardDate}>
                    {new Date(summary.savedAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </Text>
                  <Pressable
                    accessibilityLabel={`Delete ${summary.title}`}
                    disabled={deletingRecipeId === summary.recipeId}
                    onPress={() => handleDeleteFromList(summary)}
                    style={({ pressed }) => [
                      styles.cookbookDeleteButton,
                      (pressed || deletingRecipeId === summary.recipeId) &&
                        styles.cookbookDeleteButtonPressed,
                    ]}
                  >
                    {deletingRecipeId === summary.recipeId ? (
                      <ActivityIndicator color="#b91c1c" size="small" />
                    ) : (
                      <MaterialIcons color="#b91c1c" name="delete-outline" size={18} />
                    )}
                  </Pressable>
                </View>
              </View>
            </View>
          )}
          ListEmptyComponent={
            isLoading ? (
              <Text style={styles.homeBody}>Loading your saved recipes...</Text>
            ) : summarySyncError ? (
              <View style={styles.emptyCookbookCard}>
                <Text style={styles.emptyCookbookTitle}>Could not load your cookbook</Text>
                <Text style={styles.emptyCookbookCopy}>
                  Check your connection and try again. If you have previously opened the cookbook on
                  this device, it will appear here automatically when cached data is available.
                </Text>
                <PrimaryButton
                  label="Try Again"
                  onPress={() => {
                    void loadSummaries().catch((error) => {
                      const message =
                        error instanceof Error && error.message.trim().length > 0
                          ? error.message
                          : "Could not load cookbook.";
                      Alert.alert("Cookbook unavailable", message);
                    });
                  }}
                />
              </View>
            ) : summaries.length === 0 ? (
              <View style={styles.emptyCookbookCard}>
                <Text style={styles.emptyCookbookTitle}>No saved recipes yet</Text>
                <Text style={styles.emptyCookbookCopy}>
                  Save a fused recipe and it will appear here in your cookbook.
                </Text>
              </View>
            ) : filteredSummaries.length === 0 ? (
              <View style={styles.emptyCookbookCard}>
                <Text style={styles.emptyCookbookTitle}>No matching recipes</Text>
                <Text style={styles.emptyCookbookCopy}>
                  Try a different title or cuisine search.
                </Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            hasMore || isLoadingMore ? (
              <View style={styles.cookbookListFooter}>
                {isLoadingMore ? <ActivityIndicator color="#10b981" size="small" /> : null}
              </View>
            ) : null
          }
        />
      </View>
    </SafeAreaView>
  );
}
