import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppCreditHeader } from "../components/AppCreditHeader";
import { useMobileCookbook } from "../context/mobileCookbook";
import type { HomeStackParamList, RootTabParamList } from "../navigation/types";
import {
  cookbookSummaryToDashboardFusion,
  readDashboardFusionHistory,
  type DashboardFusionSummary,
} from "../services/dashboardHistory";
import { styles } from "../styles/appStyles";

type RecentAction = "save" | "favorite" | "toTry";

function formatRecentDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recent";
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function RecentFusionsScreen({
  navigation,
}: NativeStackScreenProps<HomeStackParamList, "RecentFusions">) {
  const { summaries, saveRecord, updateRecipeFlags } = useMobileCookbook();
  const [history, setHistory] = useState<DashboardFusionSummary[]>([]);
  const [busyActionById, setBusyActionById] = useState<Record<string, RecentAction | undefined>>({});

  const savedById = useMemo(() => {
    const map = new Map(summaries.map((summary) => [summary.recipeId, summary]));
    return map;
  }, [summaries]);

  const recentFusionItems = useMemo(() => {
    const byId = new Map<string, DashboardFusionSummary>();
    for (const item of [...history, ...summaries.map(cookbookSummaryToDashboardFusion)]) {
      byId.set(item.id, item);
    }
    return [...byId.values()]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 12);
  }, [history, summaries]);

  const loadHistory = useCallback(async () => {
    const nextHistory = await readDashboardFusionHistory();
    setHistory(nextHistory);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadHistory().catch(() => {});
    }, [loadHistory]),
  );

  function openCookbookDetail(recipeId: string) {
    const parentNavigation = navigation.getParent<NavigationProp<RootTabParamList>>();
    parentNavigation?.navigate("Cookbook", {
      screen: "CookbookDetail",
      params: { recipeId },
    });
  }

  function openRecentFusion(item: DashboardFusionSummary) {
    if (savedById.has(item.id)) {
      openCookbookDetail(item.id);
      return;
    }

    if (item.record) {
      navigation.navigate("RecipeWorkspace", {
        initialRecord: item.record,
      });
      return;
    }

    Alert.alert(
      "Recipe details unavailable",
      "This older recent fusion only has a summary on this device. New recent fusions can be reopened and saved from here.",
    );
  }

  async function handleRecentAction(item: DashboardFusionSummary, action: RecentAction) {
    if (busyActionById[item.id]) {
      return;
    }

    const savedSummary = savedById.get(item.id);
    if (!savedSummary && !item.record) {
      Alert.alert(
        "Recipe details unavailable",
        "This older recent fusion only has a summary on this device. Create or reroll a recipe again to save it from Recent Fusions.",
      );
      return;
    }

    setBusyActionById((current) => ({ ...current, [item.id]: action }));
    try {
      if (!savedSummary && item.record) {
        await saveRecord(item.record);
      }

      if (action === "favorite") {
        await updateRecipeFlags(item.id, { isFavorite: !(savedSummary?.isFavorite === true) });
      }
      if (action === "toTry") {
        await updateRecipeFlags(item.id, { isToTry: !(savedSummary?.isToTry === true) });
      }

      if (action === "save") {
        Alert.alert("Saved", "Recipe added to your cookbook.");
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not update this recipe.";
      Alert.alert("Update failed", message);
    } finally {
      setBusyActionById((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <AppCreditHeader />

          <View style={styles.homeHeroCard}>
            <Text style={styles.kicker}>Recent Fusions</Text>
            <Text style={styles.title}>Your recent recipe ideas.</Text>
            <Text style={styles.summary}>
              Reopen recent generations, save forgotten favorites, or mark saved recipes as Favorite
              and To Try.
            </Text>
          </View>

          <View style={styles.visibleCard}>
            {recentFusionItems.length > 0 ? (
              recentFusionItems.map((item) => {
                const savedSummary = savedById.get(item.id);
                const busyAction = busyActionById[item.id];
                const isSaved = Boolean(savedSummary);
                const isFavorite = savedSummary?.isFavorite === true;
                const isToTry = savedSummary?.isToTry === true;

                return (
                  <View key={item.id} style={styles.recentFusionCard}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openRecentFusion(item)}
                      style={({ pressed }) => [
                        styles.recentFusionMain,
                        pressed && styles.profileRowPressed,
                      ]}
                    >
                      {item.imageUrl ? (
                        <Image
                          accessibilityIgnoresInvertColors
                          source={{ uri: item.imageUrl }}
                          style={styles.recentFusionImage}
                        />
                      ) : (
                        <View style={styles.recentFusionImagePlaceholder}>
                          <MaterialIcons color="#047857" name="ramen-dining" size={38} />
                        </View>
                      )}

                      <View style={styles.recentFusionBody}>
                        <Text numberOfLines={2} style={styles.cookbookCardTitle}>
                          {item.title}
                        </Text>
                        <Text style={styles.cookbookCardMeta}>
                          {item.baseCuisine} + {item.fusionCuisine}
                        </Text>
                        <View style={styles.cookbookFlagRow}>
                          {isSaved ? (
                            <View style={styles.cookbookFlagPill}>
                              <MaterialCommunityIcons color="#047857" name="book-check" size={13} />
                              <Text style={styles.cookbookFlagPillText}>Saved</Text>
                            </View>
                          ) : null}
                          {isFavorite ? (
                            <View style={styles.cookbookFlagPill}>
                              <MaterialIcons color="#ef4444" name="favorite" size={13} />
                              <Text style={styles.cookbookFlagPillText}>Favorite</Text>
                            </View>
                          ) : null}
                          {isToTry ? (
                            <View style={styles.cookbookFlagPill}>
                              <MaterialCommunityIcons
                                color="#b45309"
                                name="silverware-fork-knife"
                                size={13}
                              />
                              <Text style={styles.cookbookFlagPillText}>To Try</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                    </Pressable>

                    <View style={styles.recentFusionActionRow}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={Boolean(busyAction) || isSaved}
                        onPress={() => void handleRecentAction(item, "save")}
                        style={({ pressed }) => [
                          styles.recentFusionActionButton,
                          styles.recentFusionSaveButton,
                          isSaved && styles.recentFusionActionButtonActive,
                          pressed && styles.resultActionPressed,
                        ]}
                      >
                        {busyAction === "save" ? (
                          <ActivityIndicator color="#047857" size="small" />
                        ) : (
                          <MaterialCommunityIcons
                            color={isSaved ? "#ffffff" : "#047857"}
                            name="content-save-check"
                            size={18}
                          />
                        )}
                        <Text
                          style={[
                            styles.recentFusionActionText,
                            isSaved && styles.recentFusionActionTextActive,
                          ]}
                        >
                          {isSaved ? "Saved" : "Save"}
                        </Text>
                      </Pressable>

                      <Pressable
                        accessibilityRole="button"
                        disabled={Boolean(busyAction)}
                        onPress={() => void handleRecentAction(item, "favorite")}
                        style={({ pressed }) => [
                          styles.recentFusionIconButton,
                          isFavorite && styles.cookbookFlagButtonActive,
                          pressed && styles.resultActionPressed,
                        ]}
                      >
                        {busyAction === "favorite" ? (
                          <ActivityIndicator color={isFavorite ? "#ffffff" : "#ef4444"} size="small" />
                        ) : (
                          <MaterialIcons
                            color={isFavorite ? "#ffffff" : "#ef4444"}
                            name={isFavorite ? "favorite" : "favorite-border"}
                            size={20}
                          />
                        )}
                      </Pressable>

                      <Pressable
                        accessibilityRole="button"
                        disabled={Boolean(busyAction)}
                        onPress={() => void handleRecentAction(item, "toTry")}
                        style={({ pressed }) => [
                          styles.recentFusionIconButton,
                          isToTry && styles.cookbookFlagButtonActiveWarm,
                          pressed && styles.resultActionPressed,
                        ]}
                      >
                        {busyAction === "toTry" ? (
                          <ActivityIndicator color={isToTry ? "#ffffff" : "#b45309"} size="small" />
                        ) : (
                          <MaterialCommunityIcons
                            color={isToTry ? "#ffffff" : "#b45309"}
                            name="silverware-fork-knife"
                            size={19}
                          />
                        )}
                      </Pressable>

                      <View style={styles.recentFusionActionSpacer} />
                      <Text numberOfLines={1} style={styles.recentFusionActionDate}>
                        {formatRecentDate(item.createdAt)}
                      </Text>
                    </View>
                  </View>
                );
              })
            ) : (
              <View style={styles.emptyCookbookCard}>
                <Text style={styles.emptyCookbookTitle}>No recent fusions yet</Text>
                <Text style={styles.emptyCookbookCopy}>
                  Create or reroll a recipe and your recent ideas will appear here.
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
