import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppCreditHeader } from "../components/AppCreditHeader";
import { useMobileCookbook } from "../context/mobileCookbook";
import { useMobileSessionIdentity } from "../hooks/useMobileSessionIdentity";
import type { HomeStackParamList, RootTabParamList } from "../navigation/types";
import { getMobileAuthRequestContext } from "../services/auth";
import { isMobileSessionIdentityCurrent } from "../services/authSession";
import {
  cookbookSummaryToDashboardFusion,
  readDashboardFusionHistory,
  type DashboardFusionSummary,
} from "../services/dashboardHistory";
import { fetchMonetizationAccountSnapshot } from "../services/monetization";
import { readMobileProfileOverrides } from "../services/profile";
import { styles } from "../styles/appStyles";

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 18) {
    return "Good afternoon";
  }
  return "Good evening";
}

function getFirstName(nameOrEmail: string) {
  const cleaned = nameOrEmail.trim();
  if (!cleaned) {
    return "Chef";
  }
  const withoutEmailDomain = cleaned.replace(/@.*/, "");
  return withoutEmailDomain.split(/\s+|[._-]+/).filter(Boolean)[0] ?? "Chef";
}

function getRecipeFallbackIcon(index: number) {
  return index % 2 === 0 ? "noodles" : "rice";
}

export function DashboardHomeScreen({
  navigation,
}: NativeStackScreenProps<HomeStackParamList, "DashboardHome">) {
  const { summaries, stats, loadSummaries, hasLoaded } = useMobileCookbook();
  const sessionIdentity = useMobileSessionIdentity();
  const [displayName, setDisplayName] = useState("Chef");
  const [recentFusions, setRecentFusions] = useState<DashboardFusionSummary[]>([]);
  const [dashboardRevision, setDashboardRevision] = useState(sessionIdentity.revision);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const ownsDashboardState = dashboardRevision === sessionIdentity.revision;
  const visibleDisplayName = ownsDashboardState ? displayName : "Chef";

  const loadDashboard = useCallback(
    async (options?: { forceRefreshCredits?: boolean }) => {
      const authContext = await getMobileAuthRequestContext();
      const session = authContext.session;
      const expectedIdentity = authContext.identity;
      const [overrides, history] = await Promise.all([
        readMobileProfileOverrides(),
        readDashboardFusionHistory(),
      ]);
      if (!isMobileSessionIdentityCurrent(expectedIdentity)) {
        return;
      }
      const nextName = overrides.displayName || session?.name || session?.email || "Chef";
      setDisplayName(getFirstName(nextName));
      setRecentFusions(history);
      setDashboardRevision(expectedIdentity.revision);

      if (!hasLoaded) {
        void loadSummaries().catch(() => {});
      }

      try {
        await fetchMonetizationAccountSnapshot(
          options?.forceRefreshCredits ? { forceRefresh: true } : { preferCache: true },
        );
      } catch {}
    },
    [hasLoaded, loadSummaries],
  );

  useEffect(() => {
    setDisplayName("Chef");
    setRecentFusions([]);
    setDashboardRevision(sessionIdentity.revision);
    setIsRefreshing(false);
  }, [sessionIdentity.revision]);

  useFocusEffect(
    useCallback(() => {
      void loadDashboard().catch(() => {});
    }, [loadDashboard]),
  );

  const handleRefresh = useCallback(async () => {
    const expectedIdentity = sessionIdentity;
    setIsRefreshing(true);
    try {
      await Promise.all([loadDashboard({ forceRefreshCredits: true }), loadSummaries()]);
    } finally {
      if (isMobileSessionIdentityCurrent(expectedIdentity)) {
        setIsRefreshing(false);
      }
    }
  }, [loadDashboard, loadSummaries, sessionIdentity]);

  const dashboardRecipes = useMemo(() => {
    const cookbookItems = summaries.slice(0, 4).map(cookbookSummaryToDashboardFusion);
    const currentRecentFusions = ownsDashboardState ? recentFusions : [];
    const byId = new Map<string, DashboardFusionSummary>();
    for (const item of [...currentRecentFusions, ...cookbookItems]) {
      byId.set(item.id, item);
    }
    return [...byId.values()]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 2);
  }, [ownsDashboardState, recentFusions, summaries]);

  function openCreate(params?: { importPhoto?: boolean }) {
    const parentNavigation = navigation.getParent<NavigationProp<RootTabParamList>>();
    parentNavigation?.navigate("Create", {
      screen: "CreateFusion",
      params: {
        resetToken: String(Date.now()),
        importPhotoOnOpen: params?.importPhoto === true,
      },
    });
  }

  function openCookbook(filter: "all" | "favorites" | "toTry" = "all") {
    const parentNavigation = navigation.getParent<NavigationProp<RootTabParamList>>();
    parentNavigation?.navigate("Cookbook", {
      screen: "CookbookList",
      params: {
        initialFilter: filter,
      },
    });
  }

  function openRecentFusions() {
    navigation.navigate("RecentFusions");
  }

  function openRecentFusion(item: DashboardFusionSummary) {
    const parentNavigation = navigation.getParent<NavigationProp<RootTabParamList>>();
    const savedSummary = summaries.find((summary) => summary.recipeId === item.id);
    if (savedSummary) {
      parentNavigation?.navigate("Cookbook", {
        screen: "CookbookDetail",
        params: {
          recipeId: savedSummary.recipeId,
        },
      });
      return;
    }

    if (item.record) {
      navigation.navigate("RecipeWorkspace", {
        initialRecord: item.record,
        initialRecordOwner: sessionIdentity,
      });
      return;
    }

    Alert.alert(
      "Recipe not saved",
      "This older recent fusion only has a summary on this device. New recent fusions can be reopened and saved from here.",
      [
        { text: "Open Cookbook", onPress: () => openCookbook("all") },
        { text: "Create New", onPress: () => openCreate() },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={styles.dashboardContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              tintColor="#10b981"
              onRefresh={handleRefresh}
            />
          }
        >
          <AppCreditHeader />

          <View style={styles.dashboardGreetingBlock}>
            <Text style={styles.dashboardGreeting}>
              {getGreeting()}, {visibleDisplayName}!
            </Text>
            <Text style={styles.dashboardGreetingCopy}>Let&apos;s create something amazing today.</Text>
          </View>

          <View style={styles.dashboardActionRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => openCreate()}
              style={({ pressed }) => [
                styles.dashboardPrimaryAction,
                pressed && styles.profileRowPressed,
              ]}
            >
              <View style={styles.dashboardPrimaryIcon}>
                <MaterialIcons color="#ffffff" name="add" size={25} />
              </View>
              <View style={styles.dashboardActionTextWrap}>
                <Text numberOfLines={1} adjustsFontSizeToFit style={styles.dashboardPrimaryActionTitle}>
                  New Fusion
                </Text>
                <Text numberOfLines={1} adjustsFontSizeToFit style={styles.dashboardPrimaryActionCopy}>
                  Create a fusion recipe
                </Text>
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => openCreate({ importPhoto: true })}
              style={({ pressed }) => [
                styles.dashboardSecondaryAction,
                pressed && styles.profileRowPressed,
              ]}
            >
              <View style={styles.dashboardSecondaryIcon}>
                <MaterialIcons color="#047857" name="image" size={25} />
              </View>
              <View style={styles.dashboardActionTextWrap}>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={styles.dashboardSecondaryActionTitle}
                >
                  Import Photo
                </Text>
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  style={styles.dashboardSecondaryActionCopy}
                >
                  From your gallery
                </Text>
              </View>
            </Pressable>
          </View>

          <View style={styles.dashboardSectionHeader}>
            <Text style={styles.dashboardSectionTitle}>Recent Fusions</Text>
            <Pressable
              accessibilityRole="button"
              onPress={openRecentFusions}
              style={({ pressed }) => [pressed && styles.profileRowPressed]}
            >
              <Text style={styles.dashboardViewAll}>View all</Text>
            </Pressable>
          </View>
          <View style={styles.dashboardRecipeRow}>
            {dashboardRecipes.length > 0 ? (
              dashboardRecipes.map((item, index) => (
                <Pressable
                  accessibilityRole="button"
                  key={item.id}
                  onPress={() => openRecentFusion(item)}
                  style={({ pressed }) => [
                    styles.dashboardRecipeCard,
                    pressed && styles.profileRowPressed,
                  ]}
                >
                  <View style={styles.dashboardRecipeImageWrap}>
                    {item.imageUrl ? (
                      <Image
                        accessibilityIgnoresInvertColors
                        source={{ uri: item.imageUrl }}
                        style={styles.dashboardRecipeImage}
                      />
                    ) : (
                <View style={styles.dashboardRecipeFallback}>
                        <MaterialIcons
                          color="#047857"
                          name={getRecipeFallbackIcon(index) === "noodles" ? "ramen-dining" : "rice-bowl"}
                          size={44}
                        />
                      </View>
                    )}
                    {item.isFavorite || item.isToTry ? (
                      <View style={styles.dashboardRecipeBadgeRow}>
                        {item.isFavorite ? (
                          <View style={styles.dashboardRecipeStateBadge}>
                            <MaterialIcons color="#ef4444" name="favorite" size={18} />
                          </View>
                        ) : null}
                        {item.isToTry ? (
                          <View style={styles.dashboardRecipeStateBadge}>
                            <MaterialCommunityIcons
                              color="#b45309"
                              name="silverware-fork-knife"
                              size={17}
                            />
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.dashboardRecipeBody}>
                    <Text numberOfLines={2} style={styles.dashboardRecipeTitle}>
                      {item.title}
                    </Text>
                    <Text style={styles.dashboardRecipeMeta}>
                      {item.baseCuisine} x {item.fusionCuisine}
                    </Text>
                    {typeof item.usageCount === "number" && item.usageCount > 0 ? (
                      <View style={styles.dashboardUsedPill}>
                        <MaterialCommunityIcons color="#047857" name="database" size={13} />
                        <Text style={styles.dashboardUsedPillText}>Used {item.usageCount}</Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              ))
            ) : (
              <View style={styles.dashboardEmptyRecentCard}>
                <MaterialCommunityIcons color="#047857" name="chef-hat" size={32} />
                <Text style={styles.dashboardEmptyTitle}>No fusions yet</Text>
                <Text style={styles.dashboardEmptyCopy}>
                  Create your first recipe fusion and it will appear here.
                </Text>
              </View>
            )}
          </View>

          <View style={styles.dashboardSectionHeader}>
            <Text style={styles.dashboardSectionTitle}>My Cookbook</Text>
          </View>
          <View style={styles.dashboardCookbookGrid}>
            <Pressable
              accessibilityRole="button"
              onPress={() => openCookbook("all")}
              style={({ pressed }) => [
                styles.dashboardCookbookTile,
                pressed && styles.profileRowPressed,
              ]}
            >
              <MaterialCommunityIcons color="#047857" name="book-open-variant" size={25} />
              <Text style={styles.dashboardCookbookTileTitle}>All Recipes</Text>
              <Text style={styles.dashboardCookbookTileMeta}>{stats.totalRecipes} recipes</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => openCookbook("favorites")}
              style={({ pressed }) => [
                styles.dashboardCookbookTile,
                pressed && styles.profileRowPressed,
              ]}
            >
              <MaterialIcons color="#ef4444" name="favorite-border" size={27} />
              <Text style={styles.dashboardCookbookTileTitle}>Favorites</Text>
              <Text style={styles.dashboardCookbookTileMeta}>{stats.favoriteRecipes} recipes</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => openCookbook("toTry")}
              style={({ pressed }) => [
                styles.dashboardCookbookTile,
                pressed && styles.profileRowPressed,
              ]}
            >
              <MaterialCommunityIcons color="#b45309" name="silverware-fork-knife" size={25} />
              <Text style={styles.dashboardCookbookTileTitle}>To Try</Text>
              <Text style={styles.dashboardCookbookTileMeta}>{stats.toTryRecipes} recipes</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
