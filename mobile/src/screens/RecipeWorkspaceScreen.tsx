import { BlurView } from "expo-blur";
import * as Sharing from "expo-sharing";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  type LayoutChangeEvent,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import { SectionHeader } from "../components/SectionHeader";
import { useMobileCookbook } from "../context/mobileCookbook";
import { sampleGeneratedRecipeRecord } from "../data/sampleGeneratedRecipe";
import { useResponsiveFlags } from "../hooks/useResponsiveFlags";
import type { HomeStackParamList } from "../navigation/types";
import { DIETARY_OPTIONS } from "../config/recipeOptions";
import { fetchLiveRecipeRecord } from "../services/fuse";
import { fetchRecipeImagePreview } from "../services/fuseImage";
import { styles } from "../styles/appStyles";
import type { FuseRequest, GeneratedRecipeRecord } from "../types/recipe";
import { buildShoppingItemKey, toTitleCase } from "../utils/recipeUi";
import { formatRecipeShareText, formatShoppingListShareText } from "../utils/recipeShare";

export function RecipeWorkspaceScreen({
  navigation,
  route,
}: NativeStackScreenProps<HomeStackParamList, "RecipeWorkspace">) {
  const { isCompactScreen, isVeryCompactScreen } = useResponsiveFlags();
  const { saveRecord } = useMobileCookbook();
  const recipeCardRef = useRef<View>(null);
  const [captureCardSize, setCaptureCardSize] = useState({ width: 0, height: 0 });
  const [isSharingImage, setIsSharingImage] = useState(false);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [shoppingChecks, setShoppingChecks] = useState<Record<string, boolean>>({});
  const [liveRecipeRecord, setLiveRecipeRecord] = useState<GeneratedRecipeRecord | null>(null);
  const [pendingSourceInput, setPendingSourceInput] = useState<FuseRequest | null>(null);
  const [isInitialFusePending, setIsInitialFusePending] = useState(false);
  const [pendingEllipsisCount, setPendingEllipsisCount] = useState(1);
  const [isLoadingLiveRecipe, setIsLoadingLiveRecipe] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [imageError, setImageError] = useState("");
  const [isSavingCookbook, setIsSavingCookbook] = useState(false);
  const activeRecord = liveRecipeRecord ?? sampleGeneratedRecipeRecord;
  const activeRecipe = activeRecord.recipe;
  const activeSourceInput =
    liveRecipeRecord?.sourceInput ?? pendingSourceInput ?? activeRecord.sourceInput;
  const usingLiveRecipe = liveRecipeRecord !== null;
  const shouldShowSpiceLevel =
    activeSourceInput.mealType !== "dessert" && activeSourceInput.mealType !== "beverage";
  const shareMessage = useMemo(() => formatRecipeShareText(activeRecipe), [activeRecipe]);
  const shoppingListShareMessage = useMemo(
    () => formatShoppingListShareText(activeRecipe),
    [activeRecipe],
  );
  const featuredIngredients = useMemo(() => activeRecipe.ingredients.slice(0, 4), [activeRecipe]);
  const featuredSteps = useMemo(() => activeRecipe.steps.slice(0, 3), [activeRecipe]);
  const pendingEllipsis = ".".repeat(pendingEllipsisCount);

  useEffect(() => {
    setShoppingChecks({});
  }, [activeRecipe.id]);

  useEffect(() => {
    if (!isInitialFusePending) {
      setPendingEllipsisCount(1);
      return;
    }

    const intervalId = setInterval(() => {
      setPendingEllipsisCount((current) => (current >= 3 ? 1 : current + 1));
    }, 350);

    return () => {
      clearInterval(intervalId);
    };
  }, [isInitialFusePending]);

  useEffect(() => {
    const nextRecord = route.params?.initialRecord;
    if (!nextRecord) {
      return;
    }

    setLiveRecipeRecord(nextRecord);
    setPendingSourceInput(nextRecord.sourceInput);
    setIsInitialFusePending(false);
    setIsLoadingLiveRecipe(false);
    setPreviewImageUrl(nextRecord.recipe.imageUrl ?? null);
    setImageError("");
  }, [route.params?.initialRecord]);

  useEffect(() => {
    const pendingRequest = route.params?.pendingRequest;
    if (!pendingRequest) {
      return;
    }

    let cancelled = false;
    setPendingSourceInput(pendingRequest.input);
    setLiveRecipeRecord(null);
    setPreviewImageUrl(null);
    setImageError("");
    setIsInitialFusePending(true);
    setIsLoadingLiveRecipe(true);

    async function generateFromHome() {
      try {
        const nextRecord = await fetchLiveRecipeRecord(pendingRequest!.input);
        if (cancelled) {
          return;
        }

        setLiveRecipeRecord(nextRecord);
        setPendingSourceInput(nextRecord.sourceInput);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Could not generate a recipe right now.";
        Alert.alert("Generation failed", message);
      } finally {
        if (!cancelled) {
          setIsLoadingLiveRecipe(false);
          setIsInitialFusePending(false);
        }
      }
    }

    void generateFromHome();

    return () => {
      cancelled = true;
    };
  }, [route.params?.pendingRequest]);

  useEffect(() => {
    if (isInitialFusePending && !liveRecipeRecord) {
      setPreviewImageUrl(null);
      setImageError("");
      setIsImageLoading(false);
      return;
    }

    const builtInImageUrl = activeRecipe.imageUrl?.trim() ?? "";
    if (builtInImageUrl) {
      setPreviewImageUrl(builtInImageUrl);
      setImageError("");
      setIsImageLoading(false);
      return;
    }

    let cancelled = false;

    async function loadImage() {
      setPreviewImageUrl(null);
      setImageError("");
      setIsImageLoading(true);
      try {
        const imageUrl = await fetchRecipeImagePreview({
          title: activeRecipe.title,
          baseCuisine: activeRecipe.baseCuisine,
          fusionCuisine: activeRecipe.fusionCuisine,
          mealType: activeSourceInput.mealType,
        });
        if (!cancelled) {
          setPreviewImageUrl(imageUrl);
          setLiveRecipeRecord((current) =>
            current && current.recipe.id === activeRecipe.id
              ? {
                  ...current,
                  recipe: {
                    ...current.recipe,
                    imageUrl,
                  },
                }
              : current,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setImageError(
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Image unavailable",
          );
        }
      } finally {
        if (!cancelled) {
          setIsImageLoading(false);
        }
      }
    }

    void loadImage();

    return () => {
      cancelled = true;
    };
  }, [
    activeRecipe.baseCuisine,
    activeRecipe.fusionCuisine,
    activeRecipe.id,
    activeRecipe.imageUrl,
    activeRecipe.title,
    activeSourceInput.mealType,
    isInitialFusePending,
    liveRecipeRecord,
  ]);

  async function handleShareRecipe() {
    try {
      setIsActionsMenuOpen(false);
      await Share.share({
        message: shareMessage,
        title: activeRecipe.title,
      });
    } catch {
      Alert.alert("Share unavailable", "Could not open the share sheet right now.");
    }
  }

  async function handleShareShoppingList() {
    try {
      setIsActionsMenuOpen(false);
      await Share.share({
        message: shoppingListShareMessage,
        title: `${activeRecipe.title} shopping list`,
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
    if (!recipeCardRef.current || isSharingImage) {
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
        dialogTitle: `${activeRecipe.title} recipe card`,
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

  async function handleLoadLiveRecipe() {
    if (isLoadingLiveRecipe) {
      return;
    }

    setIsLoadingLiveRecipe(true);
    try {
      const nextRecord = await fetchLiveRecipeRecord(activeRecord.sourceInput);
      setLiveRecipeRecord(nextRecord);
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not load a live recipe right now.";
      setLiveRecipeRecord(null);
      Alert.alert("Live recipe unavailable", message);
    } finally {
      setIsLoadingLiveRecipe(false);
    }
  }

  function handleBackToEdit() {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.navigate("Home");
  }

  async function handleSaveToCookbook() {
    if (isSavingCookbook) {
      return;
    }

    setIsSavingCookbook(true);
    try {
      const recordToSave =
        previewImageUrl && !activeRecord.recipe.imageUrl
          ? {
              ...activeRecord,
              recipe: {
                ...activeRecord.recipe,
                imageUrl: previewImageUrl,
              },
            }
          : activeRecord;
      await saveRecord(recordToSave);
      if (previewImageUrl && !activeRecord.recipe.imageUrl) {
        setLiveRecipeRecord((current) =>
          current && current.recipe.id === activeRecord.recipe.id
            ? {
                ...current,
                recipe: {
                  ...current.recipe,
                  imageUrl: previewImageUrl,
                },
              }
            : current,
        );
      }
      Alert.alert("Saved", "Recipe added to your cookbook.");
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not save recipe right now.";
      Alert.alert("Save failed", message);
    } finally {
      setIsSavingCookbook(false);
    }
  }

  function handleOpenImageViewer() {
    if (!previewImageUrl) {
      return;
    }

    setIsImageViewerOpen(true);
  }

  function handleToggleShoppingItem(key: string) {
    setShoppingChecks((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function handleOpenActionsMenu() {
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Text style={styles.brand}>Flavor Fusion Chef</Text>
          {isInitialFusePending && !usingLiveRecipe ? (
            <View style={styles.menuButtonSpacer} />
          ) : (
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
          )}
        </View>

        <TouchableWithoutFeedback onPress={() => setIsActionsMenuOpen(false)}>
          <ScrollView
            contentContainerStyle={[styles.content, isVeryCompactScreen && styles.contentCompact]}
          >
            <View style={styles.hero}>
              <Text style={styles.kicker}>
                {isInitialFusePending ? "Fusing Recipe" : usingLiveRecipe ? "Fused Recipe" : "Recipe"}
              </Text>
              {!isInitialFusePending ? (
                <Text
                  style={[
                    styles.title,
                    isCompactScreen && styles.titleCompact,
                    isVeryCompactScreen && styles.titleVeryCompact,
                  ]}
                >
                  {activeRecipe.title}
                </Text>
              ) : null}
              {isInitialFusePending ? (
                <Text style={styles.pendingCopy}>{`Preparing your recipe${pendingEllipsis}`}</Text>
              ) : null}
              {!isInitialFusePending ? (
                <Text style={styles.meta}>
                  {`${activeRecipe.baseCuisine} + ${activeRecipe.fusionCuisine}`}
                </Text>
              ) : null}
            </View>

            <Pressable
              disabled={!previewImageUrl}
              onPress={handleOpenImageViewer}
              style={({ pressed }) => [
                styles.heroImageCard,
                previewImageUrl && pressed && styles.heroImageCardPressed,
              ]}
            >
              {previewImageUrl ? (
                <Image source={{ uri: previewImageUrl }} style={styles.heroImage} />
              ) : isImageLoading ? (
                <View style={styles.heroImageState}>
                  <ActivityIndicator color="#10b981" size="small" style={styles.heroImageSpinner} />
                  <Text style={styles.heroImageStateText}>Generating image...</Text>
                </View>
              ) : (
                <View style={styles.heroImageState}>
                  <Text style={styles.heroImageStateText}>{imageError || "Image unavailable"}</Text>
                </View>
              )}
            </Pressable>

            {isInitialFusePending && !usingLiveRecipe ? null : (
              <View
                style={[
                  styles.resultActionsRow,
                  isCompactScreen && styles.resultActionsRowCompact,
                ]}
              >
                <Pressable
                  onPress={handleSaveToCookbook}
                  disabled={isSavingCookbook}
                  style={({ pressed }) => [
                    styles.resultActionPrimary,
                    isCompactScreen && styles.resultActionCompact,
                    (pressed || isSavingCookbook) && styles.resultActionPressed,
                  ]}
                >
                  <View style={styles.resultActionContent}>
                    {isSavingCookbook ? <ActivityIndicator color="#ffffff" size="small" /> : null}
                    <Text
                      style={[
                        styles.resultActionPrimaryText,
                        isCompactScreen && styles.resultActionTextCompact,
                      ]}
                    >
                      {isSavingCookbook ? "Saving..." : "Save"}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={handleLoadLiveRecipe}
                  disabled={isLoadingLiveRecipe}
                  style={({ pressed }) => [
                    styles.resultActionPrimary,
                    isCompactScreen && styles.resultActionCompact,
                    (pressed || isLoadingLiveRecipe) && styles.resultActionPressed,
                  ]}
                >
                  <View style={styles.resultActionContent}>
                    {isLoadingLiveRecipe ? <ActivityIndicator color="#ffffff" size="small" /> : null}
                    <Text
                      style={[
                        styles.resultActionPrimaryText,
                        isCompactScreen && styles.resultActionTextCompact,
                      ]}
                    >
                      {isLoadingLiveRecipe ? "Rerolling..." : "Reroll"}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={handleBackToEdit}
                  style={({ pressed }) => [
                    styles.resultActionSecondary,
                    isCompactScreen && styles.resultActionCompact,
                    pressed && styles.resultActionSecondaryPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.resultActionSecondaryText,
                      isCompactScreen && styles.resultActionTextCompact,
                    ]}
                  >
                    Back to Edit
                  </Text>
                </Pressable>
              </View>
            )}

            {isInitialFusePending && !usingLiveRecipe ? null : (
              <View style={styles.visibleCard}>
                <Text style={styles.sectionTitle}>Quick Details</Text>
                <View style={styles.badgeRow}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{activeRecipe.servings} servings</Text>
                  </View>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{activeRecipe.timeMinutes} min</Text>
                  </View>
                  {shouldShowSpiceLevel ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>Spice {activeRecipe.spiceLevel}/5</Text>
                    </View>
                  ) : null}
                  {activeRecipe.dietaryStyle !== "none" ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>
                        {DIETARY_OPTIONS.find(
                          (option) => option.value === activeRecipe.dietaryStyle,
                        )?.label ?? activeRecipe.dietaryStyle}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <View style={styles.divider} />

                <SectionHeader iconName="inventory-2" title="Ingredients" />
                {activeRecipe.ingredients.map((ingredient) => (
                  <View key={`${ingredient.item}-${ingredient.quantity}`} style={styles.listRow}>
                    <Text style={styles.listPrimary}>
                      {ingredient.quantity} {toTitleCase(ingredient.item)}
                    </Text>
                    <Text style={styles.listSecondary}>{ingredient.notes}</Text>
                  </View>
                ))}

                <View style={styles.divider} />

                <SectionHeader iconName="format-list-numbered" title="Steps" />
                {activeRecipe.steps.map((step, index) => (
                  <View key={`${index + 1}-${step}`} style={styles.stepRow}>
                    <Text style={styles.stepIndex}>{index + 1}</Text>
                    <Text style={styles.stepText}>{step}</Text>
                  </View>
                ))}

                <View style={styles.divider} />

                <SectionHeader iconName="autorenew" title="Ingredient Swaps" />
                {activeRecipe.swaps.length > 0 ? (
                  activeRecipe.swaps.map((swap) => (
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
                {activeRecipe.shoppingList.length > 0 ? (
                  activeRecipe.shoppingList.map((item, index) => {
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
                          <Text
                            style={[styles.listSecondary, checked && styles.checkedSecondaryText]}
                          >
                            {item.category}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })
                ) : (
                  <Text style={styles.emptySectionCopy}>
                    Shopping list items will appear here when available.
                  </Text>
                )}

                <View style={styles.divider} />

                <SectionHeader iconName="spa" title="Nutrition Notes" />
                <View style={styles.nutritionCard}>
                  <Text style={styles.nutritionCopy}>
                    {activeRecipe.nutritionNotes.trim().length > 0
                      ? activeRecipe.nutritionNotes
                      : "No nutrition notes are available for this recipe yet."}
                  </Text>
                </View>
              </View>
            )}
          </ScrollView>
        </TouchableWithoutFeedback>
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
              {activeRecipe.baseCuisine} + {activeRecipe.fusionCuisine}
            </Text>
            <Text style={styles.captureTitle}>{activeRecipe.title}</Text>
            <Text style={styles.captureSubtitle}>
              A practical fusion recipe with shopping list, swaps, and easy sharing from your
              phone.
            </Text>
            <View style={styles.badgeRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{activeRecipe.servings} servings</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{activeRecipe.timeMinutes} min</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Spice {activeRecipe.spiceLevel}/5</Text>
              </View>
            </View>
          </View>

          {previewImageUrl ? (
            <Image source={{ uri: previewImageUrl }} style={styles.captureHeroImage} />
          ) : (
            <View style={styles.captureHeroImageFallback}>
              <Text style={styles.captureHeroImageFallbackText}>
                {isImageLoading ? "Generating recipe image..." : "Recipe image unavailable"}
              </Text>
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
              {activeRecipe.ingredients.map((ingredient) => (
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
              <Text style={styles.captureNoteText}>{activeRecipe.nutritionNotes}</Text>
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

      <Modal
        animationType="fade"
        presentationStyle="overFullScreen"
        transparent
        visible={isImageViewerOpen}
        onRequestClose={() => setIsImageViewerOpen(false)}
      >
        <Pressable style={styles.imageViewerOverlay} onPress={() => setIsImageViewerOpen(false)}>
          <SafeAreaView style={styles.imageViewerSafeArea}>
            {previewImageUrl ? (
              <Pressable onPress={() => {}} style={styles.imageViewerBody}>
                <Image source={{ uri: previewImageUrl }} style={styles.imageViewerImage} />
              </Pressable>
            ) : null}
          </SafeAreaView>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
