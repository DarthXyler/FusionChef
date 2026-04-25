import { BlurView } from "expo-blur";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
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
import { fetchLiveRecipeRecord, FuseRequestError } from "../services/fuse";
import { fetchRecipeImagePreview } from "../services/fuseImage";
import {
  fetchMonetizationAccountSnapshot,
  getConfiguredAppleProductIds,
  purchaseAppleCredits,
} from "../services/monetization";
import { loginWithGoogleForMobile } from "../services/auth";
import { styles } from "../styles/appStyles";
import type { FuseRequest, GeneratedRecipeRecord } from "../types/recipe";
import { buildShoppingItemKey, toTitleCase } from "../utils/recipeUi";
import { formatRecipeShareText, formatShoppingListShareText } from "../utils/recipeShare";

/**
 * Recipe workspace screen:
 * - displays pending/live fused recipe state
 * - loads recipe image asynchronously with retries
 * - supports save/reroll/share actions
 */
const LOADING_MESSAGES = [
  "Collecting ingredients",
  "Calculating serving time",
  "Balancing fusion flavors",
  "Finalizing your fusion recipe",
] as const;
const IMAGE_FETCH_MAX_ATTEMPTS = 3;
const IMAGE_FETCH_RETRY_DELAYS_MS = [1200, 2200] as const;

type CreditPackOption = {
  productId: string;
  credits: number;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isInsufficientCreditsError(error: unknown): error is FuseRequestError {
  return (
    error instanceof FuseRequestError &&
    error.status === 402 &&
    error.reason === "insufficient_credits"
  );
}

async function selectAppleCreditPack(options: CreditPackOption[]) {
  if (options.length === 0) {
    return null;
  }

  if (Platform.OS === "ios") {
    return new Promise<CreditPackOption | null>((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", ...options.map((option) => `${option.credits} credits`)],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            resolve(null);
            return;
          }
          const selected = options[buttonIndex - 1];
          resolve(selected ?? null);
        },
      );
    });
  }

  return new Promise<CreditPackOption | null>((resolve) => {
    Alert.alert("Buy credits", "Choose a credit pack to continue.", [
      { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
      ...options.map((option) => ({
        text: `${option.credits} credits`,
        onPress: () => resolve(option),
      })),
    ]);
  });
}

async function promptLoginForCredits() {
  if (Platform.OS === "ios") {
    return new Promise<boolean>((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Continue with Google"],
          cancelButtonIndex: 0,
        },
        async (buttonIndex) => {
          if (buttonIndex !== 1) {
            resolve(false);
            return;
          }
          try {
            const loggedIn = await loginWithGoogleForMobile();
            resolve(loggedIn);
          } catch {
            resolve(false);
          }
        },
      );
    });
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Login required",
      "Please login to purchase credits and continue fusing.",
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: "Continue with Google",
          onPress: async () => {
            try {
              const loggedIn = await loginWithGoogleForMobile();
              resolve(loggedIn);
            } catch {
              resolve(false);
            }
          },
        },
      ],
    );
  });
}

function inferCreditsFromProductId(productId: string) {
  const match = productId.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

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
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [isLoadingLiveRecipe, setIsLoadingLiveRecipe] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [imageError, setImageError] = useState("");
  const [imageReloadVersion, setImageReloadVersion] = useState(0);
  const [isSavingCookbook, setIsSavingCookbook] = useState(false);
  const [isPurchasingCredits, setIsPurchasingCredits] = useState(false);
  const isPurchasingCreditsRef = useRef(false);
  const loaderSpin = useRef(new Animated.Value(0)).current;
  const loaderPulse = useRef(new Animated.Value(1)).current;
  const loaderGlowOpacity = useRef(new Animated.Value(0.35)).current;
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
  const pendingMessage = `${LOADING_MESSAGES[loadingMessageIndex]}${pendingEllipsis}`;
  const isHeroCardBusy = isInitialFusePending || isImageLoading;
  const heroCardWaitingMessage = isInitialFusePending
    ? "Preparing your fusion recipe..."
    : isImageLoading
      ? "Adding final presentation details..."
      : "Preparing your fusion recipe...";
  const loaderSpinInterpolate = loaderSpin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const getAppleCreditPackOptions = useCallback(async () => {
    const configuredFallback = getConfiguredAppleProductIds().map((productId) => ({
      productId,
      credits: inferCreditsFromProductId(productId),
    }));

    try {
      const account = await fetchMonetizationAccountSnapshot();
      const applePacks = account.products
        .filter((product) => product.provider === "apple_app_store")
        .map((product) => ({ productId: product.productId, credits: product.credits }))
        .sort((left, right) => left.credits - right.credits);
      if (applePacks.length > 0) {
        return applePacks;
      }
    } catch {
      // Fall back to configured product ids when account endpoint is unavailable.
    }

    return configuredFallback;
  }, []);

  const handleCreditRecoveryPurchase = useCallback(async () => {
    if (isPurchasingCreditsRef.current) {
      return false;
    }

    isPurchasingCreditsRef.current = true;
    setIsPurchasingCredits(true);
    try {
      const account = await fetchMonetizationAccountSnapshot();
      if (!account.authenticated) {
        const loggedIn = await promptLoginForCredits();
        if (!loggedIn) {
          Alert.alert("Login required", "Please login first to purchase credits.");
          return false;
        }
      }

      const options = await getAppleCreditPackOptions();
      if (options.length === 0) {
        Alert.alert("Credits unavailable", "No credit packs are configured yet.");
        return false;
      }

      const selectedPack = await selectAppleCreditPack(options);
      if (!selectedPack) {
        return false;
      }

      const purchase = await purchaseAppleCredits(selectedPack.productId);
      const grantedCredits = purchase.verification.grantedCredits;
      Alert.alert(
        "Credits added",
        grantedCredits > 0
          ? `${grantedCredits} credits were added to your account.`
          : "Purchase verified. Your credits are ready.",
      );
      return true;
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not complete purchase right now.";
      if (message === "Purchase canceled.") {
        return false;
      }
      Alert.alert("Purchase failed", message);
      return false;
    } finally {
      isPurchasingCreditsRef.current = false;
      setIsPurchasingCredits(false);
    }
  }, [getAppleCreditPackOptions]);

  const handleBackToEdit = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }

    navigation.navigate("Home");
  }, [navigation]);

  useEffect(() => {
    // Reset shopping checklist when recipe changes.
    setShoppingChecks({});
  }, [activeRecipe.id]);

  useEffect(() => {
    // Animate loader text while initial fuse request is pending.
    if (!isInitialFusePending) {
      setPendingEllipsisCount(1);
      setLoadingMessageIndex(0);
      return;
    }

    const ellipsisIntervalId = setInterval(() => {
      setPendingEllipsisCount((current) => (current >= 3 ? 1 : current + 1));
    }, 350);

    const messageIntervalId = setInterval(() => {
      setLoadingMessageIndex((current) =>
        current >= LOADING_MESSAGES.length - 1 ? 0 : current + 1,
      );
    }, 1600);

    return () => {
      clearInterval(ellipsisIntervalId);
      clearInterval(messageIntervalId);
    };
  }, [isInitialFusePending]);

  useEffect(() => {
    // Premium loader ring animation for pending/image-loading hero state.
    if (!isHeroCardBusy) {
      loaderSpin.stopAnimation();
      loaderPulse.stopAnimation();
      loaderGlowOpacity.stopAnimation();
      loaderSpin.setValue(0);
      loaderPulse.setValue(1);
      loaderGlowOpacity.setValue(0.35);
      return;
    }

    const spinLoop = Animated.loop(
      Animated.timing(loaderSpin, {
        toValue: 1,
        duration: 1150,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(loaderPulse, {
          toValue: 1.08,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(loaderPulse, {
          toValue: 0.96,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(loaderGlowOpacity, {
          toValue: 0.6,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(loaderGlowOpacity, {
          toValue: 0.25,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    spinLoop.start();
    pulseLoop.start();
    glowLoop.start();

    return () => {
      spinLoop.stop();
      pulseLoop.stop();
      glowLoop.stop();
    };
  }, [isHeroCardBusy, loaderGlowOpacity, loaderPulse, loaderSpin]);

  useEffect(() => {
    // Route can pass a fully generated record (e.g., reroll complete).
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
    // Initial generation path: fetch live recipe from Home form input.
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
        const nextRecord = await fetchLiveRecipeRecord(pendingRequest!.input, "fuse");
        if (cancelled) {
          return;
        }

        setLiveRecipeRecord(nextRecord);
        setPendingSourceInput(nextRecord.sourceInput);
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (isInsufficientCreditsError(error)) {
          const purchasedCredits = await handleCreditRecoveryPurchase();
          if (purchasedCredits && !cancelled) {
            try {
              const retriedRecord = await fetchLiveRecipeRecord(pendingRequest!.input, "fuse");
              if (!cancelled) {
                setLiveRecipeRecord(retriedRecord);
                setPendingSourceInput(retriedRecord.sourceInput);
              }
              return;
            } catch (retryError) {
              const retryMessage =
                retryError instanceof Error && retryError.message.trim().length > 0
                  ? retryError.message
                  : "Could not generate a recipe right now.";
              Alert.alert("Generation failed", retryMessage);
              return;
            }
          }

          Alert.alert(
            "Need credits",
            "You need credits to continue fusing recipes. We sent you back so you can edit or try later.",
          );
          handleBackToEdit();
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
  }, [handleBackToEdit, handleCreditRecoveryPurchase, route.params?.pendingRequest]);

  useEffect(() => {
    // Image loading pipeline:
    // 1) use built-in recipe image when available
    // 2) else call /api/fuse-image with retry/backoff
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

      let lastErrorMessage = "Image unavailable";
      try {
        for (let attempt = 0; attempt < IMAGE_FETCH_MAX_ATTEMPTS; attempt += 1) {
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
            return;
          } catch (error) {
            lastErrorMessage =
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "Image unavailable";
            if (cancelled) {
              return;
            }
            if (attempt < IMAGE_FETCH_MAX_ATTEMPTS - 1) {
              const retryDelay = IMAGE_FETCH_RETRY_DELAYS_MS[attempt] ?? 2200;
              await delay(retryDelay);
            }
          }
        }

        if (!cancelled) {
          setImageError(lastErrorMessage);
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
    imageReloadVersion,
    isInitialFusePending,
    liveRecipeRecord,
  ]);

  function handleRetryRecipeVisual() {
    if (isImageLoading) {
      return;
    }

    setImageError("");
    setImageReloadVersion((current) => current + 1);
  }

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
    // Reroll path reuses the same source input and replaces active live record.
    if (isLoadingLiveRecipe || isPurchasingCredits) {
      return;
    }

    setIsLoadingLiveRecipe(true);
    try {
      const nextRecord = await fetchLiveRecipeRecord(activeRecord.sourceInput, "reroll");
      setLiveRecipeRecord(nextRecord);
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        const purchasedCredits = await handleCreditRecoveryPurchase();
        if (purchasedCredits) {
          try {
            const retriedRecord = await fetchLiveRecipeRecord(activeRecord.sourceInput, "reroll");
            setLiveRecipeRecord(retriedRecord);
            return;
          } catch (retryError) {
            const retryMessage =
              retryError instanceof Error && retryError.message.trim().length > 0
                ? retryError.message
                : "Could not load a live recipe right now.";
            Alert.alert("Reroll failed", retryMessage);
            return;
          }
        }
        Alert.alert("Need credits", "Add credits to continue rerolling recipes.");
        return;
      }

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

  async function handleSaveToCookbook() {
    // Ensure current preview image is persisted when user saves from workspace.
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
                <Text style={styles.pendingCopy}>{pendingMessage}</Text>
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
              ) : isHeroCardBusy ? (
                <View style={styles.heroImageState}>
                  <View style={styles.premiumLoaderWrap}>
                    <Animated.View
                      style={[
                        styles.premiumLoaderGlow,
                        { opacity: loaderGlowOpacity, transform: [{ scale: loaderPulse }] },
                      ]}
                    />
                    <Animated.View
                      style={[
                        styles.premiumLoaderRing,
                        { transform: [{ rotate: loaderSpinInterpolate }] },
                      ]}
                    />
                    <Animated.View
                      style={[
                        styles.premiumLoaderCore,
                        { transform: [{ scale: loaderPulse }] },
                      ]}
                    >
                      <View style={styles.premiumLoaderCoreDot} />
                    </Animated.View>
                  </View>
                  <Text style={styles.heroImageStateText}>{heroCardWaitingMessage}</Text>
                </View>
              ) : imageError ? (
                <View style={styles.heroImageState}>
                  <Text style={styles.heroImageStateText}>
                    Recipe is ready. We could not load the visual yet.
                  </Text>
                  <Pressable
                    onPress={handleRetryRecipeVisual}
                    style={({ pressed }) => [
                      styles.heroImageRetryButton,
                      pressed && styles.heroImageRetryButtonPressed,
                    ]}
                  >
                    <Text style={styles.heroImageRetryButtonText}>Retry Visual</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.heroImageState}>
                  <Text style={styles.heroImageStateText}>{heroCardWaitingMessage}</Text>
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
                  disabled={isSavingCookbook || isPurchasingCredits}
                  style={({ pressed }) => [
                    styles.resultActionPrimary,
                    isCompactScreen && styles.resultActionCompact,
                    (pressed || isSavingCookbook || isPurchasingCredits) &&
                      styles.resultActionPressed,
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
                  disabled={isLoadingLiveRecipe || isPurchasingCredits}
                  style={({ pressed }) => [
                    styles.resultActionPrimary,
                    isCompactScreen && styles.resultActionCompact,
                    (pressed || isLoadingLiveRecipe || isPurchasingCredits) &&
                      styles.resultActionPressed,
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
