import { BlurView } from "expo-blur";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  type LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import { BrandHeader } from "../components/BrandHeader";
import { PrimaryButton } from "../components/PrimaryButton";
import { SectionHeader } from "../components/SectionHeader";
import { useMobileCookbook } from "../context/mobileCookbook";
import { useResponsiveFlags } from "../hooks/useResponsiveFlags";
import type { CookbookStackParamList } from "../navigation/types";
import { styles } from "../styles/appStyles";
import type { CookbookRecipeRecord } from "../types/recipe";
import { buildShoppingItemKey, toTitleCase } from "../utils/recipeUi";
import { formatRecipeShareText, formatShoppingListShareText } from "../utils/recipeShare";

/**
 * Cookbook detail screen:
 * - opens one saved recipe
 * - refreshes from API while showing cached data when available
 * - supports checklist interactions and delete
 */
export function CookbookDetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<CookbookStackParamList, "CookbookDetail">) {
  const { isCompactScreen, isVeryCompactScreen } = useResponsiveFlags();
  const recipeCardRef = useRef<View>(null);
  const { getRecord, loadRecord, refreshRecord, deleteRecord } = useMobileCookbook();
  const [captureCardSize, setCaptureCardSize] = useState({ width: 0, height: 0 });
  const [isSharingImage, setIsSharingImage] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [shoppingChecks, setShoppingChecks] = useState<Record<string, boolean>>({});
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [record, setRecord] = useState<CookbookRecipeRecord | null>(
    () => getRecord(route.params.recipeId) ?? null,
  );
  const [isLoading, setIsLoading] = useState(record === null);
  const [loadError, setLoadError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isShowingCachedRecord, setIsShowingCachedRecord] = useState(record !== null);
  const [detailSyncError, setDetailSyncError] = useState("");

  const recipe = record?.recipe ?? null;
  const shareMessage = useMemo(
    () => (recipe ? formatRecipeShareText(recipe) : ""),
    [recipe],
  );
  const shoppingListShareMessage = useMemo(
    () => (recipe ? formatShoppingListShareText(recipe) : ""),
    [recipe],
  );
  const featuredIngredients = useMemo(
    () => (recipe ? recipe.ingredients.slice(0, 4) : []),
    [recipe],
  );
  const featuredSteps = useMemo(() => (recipe ? recipe.steps.slice(0, 3) : []), [recipe]);

  useEffect(() => {
    // Fast path: render cached record immediately, then refresh in background.
    const cachedRecord = getRecord(route.params.recipeId);
    if (cachedRecord) {
      setRecord(cachedRecord);
      setIsLoading(false);
      setLoadError("");
      setIsShowingCachedRecord(true);
      void refreshRecord(route.params.recipeId)
        .then((nextRecord) => {
          setRecord(nextRecord);
          setIsShowingCachedRecord(false);
          setDetailSyncError("");
        })
        .catch((error) => {
          const message =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not refresh saved recipe.";
          setDetailSyncError(message);
        });
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    // Cold path: no cache available, load full detail from API.
    void loadRecord(route.params.recipeId)
      .then((nextRecord) => {
        if (cancelled) {
          return;
        }
        setRecord(nextRecord);
        setLoadError("");
        setIsShowingCachedRecord(false);
        setDetailSyncError("");
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Could not load recipe.";
        setLoadError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getRecord, loadRecord, refreshRecord, route.params.recipeId]);

  useEffect(() => {
    // Shopping checklist state is local to each recipe detail session.
    setShoppingChecks({});
  }, [recipe?.id]);

  useEffect(() => {
    setIsImageViewerOpen(false);
  }, [recipe?.imageUrl]);

  async function handleShareRecipe() {
    if (!recipe) {
      return;
    }

    try {
      setIsActionsMenuOpen(false);
      await Share.share({
        message: shareMessage,
        title: recipe.title,
      });
    } catch {
      Alert.alert("Share unavailable", "Could not open the share sheet right now.");
    }
  }

  async function handleShareShoppingList() {
    if (!recipe) {
      return;
    }

    try {
      setIsActionsMenuOpen(false);
      await Share.share({
        message: shoppingListShareMessage,
        title: `${recipe.title} shopping list`,
      });
    } catch {
      Alert.alert("Share unavailable", "Could not open the share sheet right now.");
    }
  }

  async function captureRecipeCardImage() {
    if (!recipeCardRef.current) {
      throw new Error("Recipe card is not ready for capture.");
    }

    const baseOptions = {
      format: "png" as const,
      quality: 1,
      result: "tmpfile" as const,
    };

    const hasMeasuredSize = captureCardSize.width > 0 && captureCardSize.height > 0;
    if (!hasMeasuredSize) {
      return captureRef(recipeCardRef, baseOptions);
    }

    const scale = 3;
    try {
      return await captureRef(recipeCardRef, {
        ...baseOptions,
        width: Math.round(captureCardSize.width * scale),
        height: Math.round(captureCardSize.height * scale),
      });
    } catch {
      return captureRef(recipeCardRef, baseOptions);
    }
  }

  async function handleShareRecipeCardImage() {
    if (!recipe || !recipeCardRef.current || isSharingImage) {
      return;
    }

    setIsSharingImage(true);
    try {
      setIsActionsMenuOpen(false);
      const sharingAvailable = await Sharing.isAvailableAsync();
      if (!sharingAvailable) {
        Alert.alert("Share unavailable", "Image sharing is not available on this device.");
        return;
      }

      const uri = await captureRecipeCardImage();
      await Sharing.shareAsync(uri, {
        dialogTitle: `${recipe.title} recipe card`,
      });
    } catch {
      Alert.alert("Share unavailable", "Could not share the recipe card image right now.");
    } finally {
      setIsSharingImage(false);
    }
  }

  function handleCaptureCardLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setCaptureCardSize({ width, height });
    }
  }

  function handleOpenActionsMenu() {
    if (!recipe) {
      return;
    }

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [
            "Cancel",
            "Share Recipe Text",
            "Share Shopping List",
            isSharingImage ? "Sharing Image..." : "Share Recipe Card Image",
          ],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) void handleShareRecipe();
          if (buttonIndex === 2) void handleShareShoppingList();
          if (buttonIndex === 3 && !isSharingImage) void handleShareRecipeCardImage();
        },
      );
      return;
    }

    setIsActionsMenuOpen((open) => !open);
  }

  function handleToggleShoppingItem(key: string) {
    setShoppingChecks((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function handleDeleteRecipe() {
    if (!record || isDeleting) {
      return;
    }

    Alert.alert("Delete Recipe", "Remove this recipe from your cookbook?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          // Delete from API + local cache, then return to list.
          void (async () => {
            setIsDeleting(true);
            try {
              await deleteRecord(record.recipe.id);
              navigation.goBack();
            } catch (error) {
              const message =
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "Could not delete recipe.";
              Alert.alert("Delete failed", message);
            } finally {
              setIsDeleting(false);
            }
          })();
        },
      },
    ]);
  }

  if (isLoading || !record || !recipe) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.screen}>
          <ScrollView
            contentContainerStyle={[styles.content, isVeryCompactScreen && styles.contentCompact]}
          >
            <View style={styles.homeHeroCard}>
              <View style={styles.fieldLabelRow}>
                <BrandHeader compact />
                <View style={styles.menuButtonSpacer} />
              </View>
              <Text style={styles.kicker}>Cookbook</Text>
              <Text
                style={[
                  styles.title,
                  isCompactScreen && styles.titleCompact,
                  isVeryCompactScreen && styles.titleVeryCompact,
                ]}
              >
                Loading recipe...
              </Text>
              <Text style={styles.summary}>{loadError || "Opening your saved recipe."}</Text>
            </View>

            {loadError ? (
              <View style={styles.homeCard}>
                <PrimaryButton
                  label="Try Again"
                  onPress={() => {
                    setRecord(null);
                    setLoadError("");
                    setIsLoading(true);
                    void loadRecord(route.params.recipeId)
                      .then((nextRecord) => {
                        setRecord(nextRecord);
                        setLoadError("");
                      })
                      .catch((error) => {
                        const message =
                          error instanceof Error && error.message.trim().length > 0
                            ? error.message
                            : "Could not load recipe.";
                        setLoadError(message);
                      })
                      .finally(() => {
                        setIsLoading(false);
                      });
                  }}
                />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={[styles.content, isVeryCompactScreen && styles.contentCompact]}
          onScrollBeginDrag={() => setIsActionsMenuOpen(false)}
        >
          <View style={styles.homeHeroCard}>
            <View style={styles.fieldLabelRow}>
              <BrandHeader compact />
              <View style={styles.menuAnchor}>
                <Pressable
                  accessibilityLabel="Open actions menu"
                  accessibilityRole="button"
                  onPress={handleOpenActionsMenu}
                  style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
                >
                  <Text style={styles.menuDots}>{"\u22EE"}</Text>
                </Pressable>

                {Platform.OS !== "ios" && isActionsMenuOpen ? (
                  <BlurView intensity={42} tint="light" style={styles.menuSheet}>
                    <View style={styles.menuGlassTint}>
                      <Pressable onPress={handleShareRecipe} style={styles.menuItem}>
                        <Text style={styles.menuItemText}>Share Recipe Text</Text>
                      </Pressable>
                      <Pressable onPress={handleShareShoppingList} style={styles.menuItem}>
                        <Text style={styles.menuItemText}>Share Shopping List</Text>
                      </Pressable>
                      <Pressable onPress={handleShareRecipeCardImage} style={styles.menuItem}>
                        <Text style={styles.menuItemText}>
                          {isSharingImage ? "Sharing Image..." : "Share Recipe Card Image"}
                        </Text>
                      </Pressable>
                    </View>
                  </BlurView>
                ) : null}
              </View>
            </View>
            <Text style={styles.kicker}>Cookbook</Text>
            <Text
              style={[
                styles.title,
                isCompactScreen && styles.titleCompact,
                isVeryCompactScreen && styles.titleVeryCompact,
              ]}
            >
              {recipe.title}
            </Text>
            <Text style={styles.meta}>
              {recipe.baseCuisine} + {recipe.fusionCuisine}
            </Text>
            <Text style={styles.summary}>
              Saved{" "}
              {new Date(record.savedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </Text>
          </View>

          {detailSyncError ? (
            <View style={styles.offlineNoticeCard}>
              <Text style={styles.offlineNoticeTitle}>
                {isShowingCachedRecord ? "Offline: showing saved recipe from this device" : "Recipe sync issue"}
              </Text>
              <Text style={styles.offlineNoticeCopy}>
                {isShowingCachedRecord
                  ? "You can keep reading this saved recipe while we reconnect."
                  : detailSyncError}
              </Text>
            </View>
          ) : null}

          <View
            style={[
              styles.resultActionsRow,
              isCompactScreen && styles.resultActionsRowCompact,
            ]}
          >
            <Pressable
              onPress={handleDeleteRecipe}
              disabled={isDeleting}
              style={({ pressed }) => [
                styles.resultActionSecondary,
                styles.deleteActionButton,
                isCompactScreen && styles.resultActionCompact,
                (pressed || isDeleting) && styles.resultActionPressed,
              ]}
            >
              <View style={styles.resultActionContent}>
                {isDeleting ? <ActivityIndicator color="#b91c1c" size="small" /> : null}
                <Text
                  style={[
                    styles.deleteActionText,
                    isCompactScreen && styles.resultActionTextCompact,
                  ]}
                >
                  {isDeleting ? "Deleting..." : "Delete"}
                </Text>
              </View>
            </Pressable>
          </View>

          <Pressable
            disabled={!recipe.imageUrl}
            onPress={() => setIsImageViewerOpen(true)}
            style={({ pressed }) => [
              styles.heroImageCard,
              recipe.imageUrl && pressed && styles.heroImageCardPressed,
            ]}
          >
            {recipe.imageUrl ? (
              <Image source={{ uri: recipe.imageUrl }} style={styles.heroImage} />
            ) : (
              <View style={styles.heroImageState}>
                <Text style={styles.heroImageStateText}>Saved image unavailable</Text>
              </View>
            )}
          </Pressable>

          <View style={styles.visibleCard}>
            <Text style={styles.sectionTitle}>Quick Details</Text>
            <View style={styles.badgeRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{recipe.servings} servings</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{recipe.timeMinutes} min</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Spice {recipe.spiceLevel}/5</Text>
              </View>
            </View>

            <View style={styles.divider} />

            <SectionHeader iconName="inventory-2" title="Ingredients" />
            {recipe.ingredients.map((ingredient) => (
              <View key={`${ingredient.item}-${ingredient.quantity}`} style={styles.listRow}>
                <Text style={styles.listPrimary}>
                  {ingredient.quantity} {toTitleCase(ingredient.item)}
                </Text>
                <Text style={styles.listSecondary}>{ingredient.notes}</Text>
              </View>
            ))}

            <View style={styles.divider} />

            <SectionHeader iconName="format-list-numbered" title="Steps" />
            {recipe.steps.map((step, index) => (
              <View key={`${index + 1}-${step}`} style={styles.stepRow}>
                <Text style={styles.stepIndex}>{index + 1}</Text>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}

            <View style={styles.divider} />

            <SectionHeader iconName="autorenew" title="Ingredient Swaps" />
            {recipe.swaps.length > 0 ? (
              recipe.swaps.map((swap) => (
                <View key={`${swap.original}-${swap.replacement}`} style={styles.swapCard}>
                  <Text style={styles.swapTitle}>
                    {toTitleCase(swap.original)} {"\u2192"} {toTitleCase(swap.replacement)}
                  </Text>
                  <Text style={styles.swapReason}>{swap.reason}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.emptySectionCopy}>
                No ingredient swap suggestions for this recipe yet.
              </Text>
            )}

            <View style={styles.divider} />

            <SectionHeader iconName="shopping-cart" title="Shopping List" />
            {recipe.shoppingList.map((item, index) => {
              const shoppingKey = buildShoppingItemKey(item, index);
              const checked = shoppingChecks[shoppingKey] ?? false;

              return (
                <Pressable
                  key={`${item.category}-${item.item}-${item.quantity}`}
                  onPress={() => handleToggleShoppingItem(shoppingKey)}
                  style={[styles.shoppingRow, checked && styles.shoppingRowChecked]}
                >
                  <View
                    style={[styles.shoppingCheckbox, checked && styles.shoppingCheckboxChecked]}
                  >
                    {checked ? <Text style={styles.shoppingCheckboxTick}>{"\u2713"}</Text> : null}
                  </View>
                  <View style={styles.shoppingTextBlock}>
                    <Text style={[styles.listPrimary, checked && styles.checkedPrimaryText]}>
                      {item.quantity} {item.item}
                    </Text>
                    <Text style={[styles.listSecondary, checked && styles.checkedSecondaryText]}>
                      {item.category}
                    </Text>
                  </View>
                </Pressable>
              );
            })}

            <View style={styles.divider} />

            <SectionHeader iconName="spa" title="Nutrition Notes" />
            <View style={styles.nutritionCard}>
              <Text style={styles.nutritionCopy}>{recipe.nutritionNotes}</Text>
            </View>
          </View>
        </ScrollView>

        <Modal
          animationType="fade"
          presentationStyle="overFullScreen"
          transparent
          visible={isImageViewerOpen}
          onRequestClose={() => setIsImageViewerOpen(false)}
        >
          <Pressable style={styles.imageViewerOverlay} onPress={() => setIsImageViewerOpen(false)}>
            <SafeAreaView style={styles.imageViewerSafeArea}>
              {recipe.imageUrl ? (
                <Pressable onPress={() => {}} style={styles.imageViewerBody}>
                  <Image source={{ uri: recipe.imageUrl }} style={styles.imageViewerImage} />
                </Pressable>
              ) : null}
            </SafeAreaView>
          </Pressable>
        </Modal>
      </View>

      <View pointerEvents="none" style={styles.hiddenCaptureHost}>
        <View
          collapsable={false}
          onLayout={handleCaptureCardLayout}
          ref={recipeCardRef}
          style={styles.captureCard}
        >
          <View style={styles.captureHeader}>
            <View style={styles.captureBrandRow}>
              <Text style={styles.captureBrand}>Flavor Fusion Chef</Text>
              <Text style={styles.captureStamp}>Recipe Card</Text>
            </View>
            <Text style={styles.captureEyebrow}>
              {recipe.baseCuisine} + {recipe.fusionCuisine}
            </Text>
            <Text style={styles.captureTitle}>{recipe.title}</Text>
            <Text style={styles.captureSubtitle}>
              A practical fusion recipe with shopping list, swaps, and easy sharing from your
              phone.
            </Text>
            <View style={styles.badgeRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{recipe.servings} servings</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{recipe.timeMinutes} min</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Spice {recipe.spiceLevel}/5</Text>
              </View>
            </View>
          </View>

          {recipe.imageUrl ? (
            <Image source={{ uri: recipe.imageUrl }} style={styles.captureHeroImage} />
          ) : (
            <View style={styles.captureHeroImageFallback}>
              <Text style={styles.captureHeroImageFallbackText}>Recipe image unavailable</Text>
            </View>
          )}

          <View style={styles.card}>
            <View style={styles.capturePanel}>
              <Text style={styles.capturePanelTitle}>What you&apos;ll need</Text>
              <View style={styles.captureTagGrid}>
                {featuredIngredients.map((ingredient) => (
                  <View
                    key={`${ingredient.item}-${ingredient.quantity}-tag`}
                    style={styles.captureTag}
                  >
                    <Text style={styles.captureTagLabel}>
                      {ingredient.quantity} {toTitleCase(ingredient.item)}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.capturePanel}>
              <Text style={styles.capturePanelTitle}>Ingredient highlights</Text>
              {recipe.ingredients.map((ingredient) => (
                <View key={`${ingredient.item}-${ingredient.quantity}`} style={styles.listRow}>
                  <Text style={styles.listPrimary}>
                    {ingredient.quantity} {toTitleCase(ingredient.item)}
                  </Text>
                  <Text style={styles.listSecondary}>{ingredient.notes}</Text>
                </View>
              ))}
            </View>

            <View style={styles.divider} />

            <View style={styles.capturePanel}>
              <Text style={styles.capturePanelTitle}>How it comes together</Text>
              {featuredSteps.map((step, index) => (
                <View key={`${index + 1}-${step}`} style={styles.stepRow}>
                  <Text style={styles.stepIndex}>{index + 1}</Text>
                  <Text style={styles.stepText}>{step}</Text>
                </View>
              ))}
            </View>

            <View style={styles.captureNote}>
              <Text style={styles.captureNoteLabel}>Nutrition note</Text>
              <Text style={styles.captureNoteText}>{recipe.nutritionNotes}</Text>
            </View>

            <View style={styles.captureFooter}>
              <Text style={styles.captureFooterTitle}>Shared from Flavor Fusion Chef</Text>
              <Text style={styles.captureFooterText}>
                Discover fusion recipes, shopping lists, and easy rerolls right from your phone.
              </Text>
            </View>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
