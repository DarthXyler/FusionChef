import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandHeader } from "../components/BrandHeader";
import { CreditPill } from "../components/CreditPill";
import { useMobileCookbook } from "../context/mobileCookbook";
import type { HomeStackParamList, RootTabParamList } from "../navigation/types";
import { getMobileAuthSession } from "../services/auth";
import {
  cookbookSummaryToDashboardFusion,
  readDashboardFusionHistory,
  type DashboardFusionSummary,
} from "../services/dashboardHistory";
import {
  fetchMonetizationAccountSnapshot,
  subscribeToMonetizationAccountSnapshot,
} from "../services/monetization";
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
  const { summaries, loadSummaries, hasLoaded } = useMobileCookbook();
  const [displayName, setDisplayName] = useState("Chef");
  const [availableCredits, setAvailableCredits] = useState(0);
  const [recentFusions, setRecentFusions] = useState<DashboardFusionSummary[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadDashboard = useCallback(
    async (options?: { forceRefreshCredits?: boolean }) => {
      const [session, overrides, history] = await Promise.all([
        getMobileAuthSession(),
        readMobileProfileOverrides(),
        readDashboardFusionHistory(),
      ]);
      const nextName = overrides.displayName || session?.name || session?.email || "Chef";
      setDisplayName(getFirstName(nextName));
      setRecentFusions(history);

      if (!hasLoaded) {
        void loadSummaries().catch(() => {});
      }

      try {
        const snapshot = await fetchMonetizationAccountSnapshot(
          options?.forceRefreshCredits ? { forceRefresh: true } : { preferCache: true },
        );
        setAvailableCredits(snapshot.balance.availableCredits);
      } catch {
        setAvailableCredits(0);
      }
    },
    [hasLoaded, loadSummaries],
  );

  useEffect(
    () =>
      subscribeToMonetizationAccountSnapshot((snapshot) => {
        setAvailableCredits(snapshot.balance.availableCredits);
      }),
    [],
  );

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      void loadDashboard().catch(() => {
        if (!cancelled) {
          setAvailableCredits(0);
        }
      });

      return () => {
        cancelled = true;
      };
    }, [loadDashboard]),
  );

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([loadDashboard({ forceRefreshCredits: true }), loadSummaries()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadDashboard, loadSummaries]);

  const dashboardRecipes = useMemo(() => {
    const cookbookItems = summaries.slice(0, 4).map(cookbookSummaryToDashboardFusion);
    const byId = new Map<string, DashboardFusionSummary>();
    for (const item of [...recentFusions, ...cookbookItems]) {
      byId.set(item.id, item);
    }
    return [...byId.values()]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 2);
  }, [recentFusions, summaries]);

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

  function openBuyCredits() {
    const parentNavigation = navigation.getParent<NavigationProp<RootTabParamList>>();
    parentNavigation?.navigate("Profile", {
      openCreditSheetToken: String(Date.now()),
    });
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
          <View style={styles.dashboardTopBar}>
            <BrandHeader compact />
            <CreditPill credits={availableCredits} onPress={openBuyCredits} />
          </View>

          <View style={styles.dashboardGreetingBlock}>
            <Text style={styles.dashboardGreeting}>
              {getGreeting()}, {displayName}!
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
            <Text style={styles.dashboardViewAll}>View all</Text>
          </View>
          <View style={styles.dashboardRecipeRow}>
            {dashboardRecipes.length > 0 ? (
              dashboardRecipes.map((item, index) => (
                <View key={item.id} style={styles.dashboardRecipeCard}>
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
                    <View style={styles.dashboardHeartBadge}>
                      <MaterialIcons color="#ef4444" name="favorite-border" size={20} />
                    </View>
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
                </View>
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
            <View style={styles.dashboardCookbookTile}>
              <MaterialCommunityIcons color="#047857" name="book-open-variant" size={25} />
              <Text style={styles.dashboardCookbookTileTitle}>All Recipes</Text>
              <Text style={styles.dashboardCookbookTileMeta}>{summaries.length} recipes</Text>
            </View>
            <View style={styles.dashboardCookbookTile}>
              <MaterialIcons color="#ef4444" name="favorite-border" size={27} />
              <Text style={styles.dashboardCookbookTileTitle}>Favorites</Text>
              <Text style={styles.dashboardCookbookTileMeta}>Coming soon</Text>
            </View>
            <View style={styles.dashboardCookbookTile}>
              <MaterialCommunityIcons color="#b45309" name="silverware-fork-knife" size={25} />
              <Text style={styles.dashboardCookbookTileTitle}>To Try</Text>
              <Text style={styles.dashboardCookbookTileMeta}>Coming soon</Text>
            </View>
            <View style={styles.dashboardCookbookTile}>
              <MaterialCommunityIcons color="#047857" name="chef-hat" size={25} />
              <Text style={styles.dashboardCookbookTileTitle}>Created by Me</Text>
              <Text style={styles.dashboardCookbookTileMeta}>{summaries.length} recipes</Text>
            </View>
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
