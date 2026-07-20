import { BlurView } from "expo-blur";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
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
import { AppCreditHeader } from "../components/AppCreditHeader";
import { PrimaryButton } from "../components/PrimaryButton";
import { SectionHeader } from "../components/SectionHeader";
import { useMobileCookbook } from "../context/mobileCookbook";
import { useMobileSessionIdentity } from "../hooks/useMobileSessionIdentity";
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
  const recordRevisionRef = useRef(0);
  const flagRequestRevisionRef = useRef({ favorite: 0, toTry: 0 });
  const sessionIdentity = useMobileSessionIdentity();
  const mountedSessionRevisionRef = useRef(sessionIdentity.revision);
  const { getRecord, loadRecord, refreshRecord, updateRecipeFlags, deleteRecord } = useMobileCookbook();
  const getRecordRef = useRef(getRecord);
  const loadRecordRef = useRef(loadRecord);
  const refreshRecordRef = useRef(refreshRecord);
  const [captureCardSize, setCaptureCardSize] = useState({ width: 0, height: 0 });
  const [isCaptureCardMounted, setIsCaptureCardMounted] = useState(false);
  const [isSharingImage, setIsSharingImage] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [shoppingChecks, setShoppingChecks] = useState<Record<string, boolean>>({});
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [storedRecord, setStoredRecord] = useState<CookbookRecipeRecord | null>(
    () => getRecord(route.params.recipeId) ?? null,
  );
  const [recordOwnerRevision, setRecordOwnerRevision] = useState(sessionIdentity.revision);
  const record =
    recordOwnerRevision === sessionIdentity.revision ? storedRecord : null;
  const [isLoading, setIsLoading] = useState(storedRecord === null);
  const [loadError, setLoadError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isShowingCachedRecord, setIsShowingCachedRecord] = useState(storedRecord !== null);
  const [detailSyncError, setDetailSyncError] = useState("");

  const recipe = record?.recipe ?? null;
  const initialSummary =
    recordOwnerRevision === sessionIdentity.revision ? route.params.initialSummary : undefined;
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
    getRecordRef.current = getRecord;
    loadRecordRef.current = loadRecord;
    refreshRecordRef.current = refreshRecord;
  }, [getRecord, loadRecord, refreshRecord]);

  useEffect(() => {
    if (mountedSessionRevisionRef.current === sessionIdentity.revision) {
      return;
    }
    mountedSessionRevisionRef.current = sessionIdentity.revision;
    recordRevisionRef.current += 1;
    flagRequestRevisionRef.current = { favorite: 0, toTry: 0 };
    setStoredRecord(null);
    setRecordOwnerRevision(sessionIdentity.revision);
    setIsLoading(false);
    setLoadError("");
    setDetailSyncError("");
    setIsShowingCachedRecord(false);
    setIsImageViewerOpen(false);
    setIsActionsMenuOpen(false);
    setIsCaptureCardMounted(false);
    navigation.popToTop();
  }, [navigation, sessionIdentity.revision]);

  useEffect(() => {
    // Fast path: render cached record immediately, then refresh in background.
    const recipeId = route.params.recipeId;
    const cachedRecord = getRecordRef.current(recipeId);
    if (cachedRecord) {
      const refreshRevision = recordRevisionRef.current;
      setStoredRecord(cachedRecord);
      setIsLoading(false);
      setLoadError("");
      setIsShowingCachedRecord(true);
      void refreshRecordRef.current(recipeId)
        .then((nextRecord) => {
          if (recordRevisionRef.current !== refreshRevision) {
            return;
          }
          setStoredRecord(nextRecord);
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
    void loadRecordRef.current(recipeId)
      .then((nextRecord) => {
        if (cancelled) {
          return;
        }
        setStoredRecord(nextRecord);
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
  }, [route.params.recipeId]);

  useEffect(() => {
    // Shopping checklist state is local to each recipe detail session.
    setShoppingChecks({});
  }, [recipe?.id]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("blur", () => {
      setIsImageViewerOpen(false);
      setIsActionsMenuOpen(false);
    });

    return unsubscribe;
  }, [navigation]);

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

  async function waitForCaptureCardMount() {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  async function handleShareRecipeCardImage() {
    if (!recipe || isSharingImage) {
      return;
    }

    if (!isCaptureCardMounted) {
      setIsCaptureCardMounted(true);
      await waitForCaptureCardMount();
    }

    if (!recipeCardRef.current) {
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
      setIsCaptureCardMounted(false);
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

  function handleToggleFlag(flag: "favorite" | "toTry") {
    if (!record) {
      return;
    }
    const nextFlags =
      flag === "favorite"
        ? { isFavorite: record.isFavorite !== true }
        : { isToTry: record.isToTry !== true };

    recordRevisionRef.current += 1;
    flagRequestRevisionRef.current[flag] += 1;
    const requestRevision = flagRequestRevisionRef.current[flag];
    const rollbackRecord = record;
    const optimisticRecord = { ...record, ...nextFlags };
    setStoredRecord(optimisticRecord);

    void updateRecipeFlags(record.recipe.id, nextFlags)
      .then((updatedRecord) => {
        if (flagRequestRevisionRef.current[flag] !== requestRevision) {
          return;
        }
        recordRevisionRef.current += 1;
        setStoredRecord((current) => (current ? { ...current, ...updatedRecord } : updatedRecord));
      })
      .catch((error) => {
        if (flagRequestRevisionRef.current[flag] !== requestRevision) {
          return;
        }
        recordRevisionRef.current += 1;
        setStoredRecord(rollbackRecord);
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Could not update recipe.";
        Alert.alert("Update failed", message);
      });
  }

  if ((isLoading || !record || !recipe) && initialSummary) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.screen}>
          <ScrollView
            contentContainerStyle={[styles.content, isVeryCompactScreen && styles.contentCompact]}
          >
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
                {initialSummary.title}
              </Text>
              <Text style={styles.meta}>
                {initialSummary.baseCuisine} + {initialSummary.fusionCuisine}
              </Text>
              <Text style={styles.summary}>
                Saved{" "}
                {new Date(initialSummary.savedAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </Text>
            </View>

            <Pressable disabled style={styles.heroImageCard}>
              {initialSummary.imageUrl ? (
                <Image source={{ uri: initialSummary.imageUrl }} style={styles.heroImage} />
              ) : (
                <View style={styles.heroImageState}>
                  <Text style={styles.heroImageStateText}>Saved image unavailable</Text>
                </View>
              )}
            </Pressable>

            <View style={styles.visibleCard}>
              <Text style={styles.sectionTitle}>Recipe Details</Text>
              <Text style={styles.summary}>{loadError || "Loading full recipe details..."}</Text>
              {loadError ? (
                <PrimaryButton
                  label="Try Again"
                  onPress={() => {
                    setStoredRecord(null);
                    setLoadError("");
                    setIsLoading(true);
                    void loadRecord(route.params.recipeId)
                      .then((nextRecord) => {
                        setStoredRecord(nextRecord);
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
              ) : null}
            </View>
          </ScrollView>
        </View>
      </SafeAreaView>
    );
  }

  if (isLoading || !record || !recipe) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.screen}>
          <ScrollView
            contentContainerStyle={[styles.content, isVeryCompactScreen && styles.contentCompact]}
          >
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
                Loading recipe...
              </Text>
              <Text style={styles.summary}>{loadError || "Opening your saved recipe."}</Text>
            </View>

            {loadError ? (
              <View style={styles.homeCard}>
                <PrimaryButton
                  label="Try Again"
                  onPress={() => {
                    setStoredRecord(null);
                    setLoadError("");
                    setIsLoading(true);
                    void loadRecord(route.params.recipeId)
                      .then((nextRecord) => {
                        setStoredRecord(nextRecord);
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
          <AppCreditHeader />
          <View style={styles.homeHeroCard}>
            <View style={styles.fieldLabelRow}>
              <Text style={styles.kicker}>Cookbook</Text>
              <View style={styles.menuAnchor}>
                <Pressable
                  accessibilityLabel="Open actions menu"
                  accessibilityRole="button"
                  onPress={handleOpenActionsMenu}
                  style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
                >
                  <MaterialIcons color="#047857" name="ios-share" size={23} />
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
              onPress={() => handleToggleFlag("favorite")}
              style={({ pressed }) => [
                styles.resultActionSecondary,
                record.isFavorite && styles.resultActionPrimary,
                isCompactScreen && styles.resultActionCompact,
                pressed && styles.resultActionPressed,
              ]}
            >
              <View style={styles.resultActionContent}>
                <Text
                  style={[
                    record.isFavorite ? styles.resultActionPrimaryText : styles.resultActionSecondaryText,
                    isCompactScreen && styles.resultActionTextCompact,
                  ]}
                >
                  Favorite
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => handleToggleFlag("toTry")}
              style={({ pressed }) => [
                styles.resultActionSecondary,
                record.isToTry && styles.resultActionPrimary,
                isCompactScreen && styles.resultActionCompact,
                pressed && styles.resultActionPressed,
              ]}
            >
              <View style={styles.resultActionContent}>
                <Text
                  style={[
                    record.isToTry ? styles.resultActionPrimaryText : styles.resultActionSecondaryText,
                    isCompactScreen && styles.resultActionTextCompact,
                  ]}
                >
                  Mark To Try
                </Text>
              </View>
            </Pressable>
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
            {recipe.ingredients.map((ingredient, index) => (
              <View
                key={`ingredient-${index}-${ingredient.item}-${ingredient.quantity}`}
                style={styles.listRow}
              >
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
              recipe.swaps.map((swap, index) => (
                <View
                  key={`swap-${index}-${swap.original}-${swap.replacement}`}
                  style={styles.swapCard}
                >
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
                  key={shoppingKey}
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

      {isCaptureCardMounted ? (
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
                  {featuredIngredients.map((ingredient, index) => (
                    <View
                      key={`featured-ingredient-${index}-${ingredient.item}-${ingredient.quantity}`}
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
                {recipe.ingredients.map((ingredient, index) => (
                  <View
                    key={`capture-ingredient-${index}-${ingredient.item}-${ingredient.quantity}`}
                    style={styles.listRow}
                  >
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
      ) : null}
    </SafeAreaView>
  );
}
