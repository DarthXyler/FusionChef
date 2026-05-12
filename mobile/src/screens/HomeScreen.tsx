import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  ImageBackground,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppCreditHeader } from "../components/AppCreditHeader";
import { PrimaryButton } from "../components/PrimaryButton";
import {
  CUISINE_OPTIONS,
  DIETARY_OPTIONS,
  MEAL_TYPE_OPTIONS,
  SPICE_LEVEL_OPTIONS,
} from "../config/recipeOptions";
import { useResponsiveFlags } from "../hooks/useResponsiveFlags";
import type { HomeStackParamList } from "../navigation/types";
import { sampleGeneratedRecipeRecord } from "../data/sampleGeneratedRecipe";
import { clearMobileAuthToken, loginWithGoogleForMobile } from "../services/auth";
import {
  fetchMonetizationAccountSnapshot,
  getAvailableAppleProductIds,
  getConfiguredAppleProductIds,
  purchaseAppleCredits,
} from "../services/monetization";
import { fetchOcrExtractedText } from "../services/ocr";
import type { ImportedRecipePhoto } from "../types/importedRecipePhoto";
import type { DietaryStyle, FuseRequest, MealType, SpiceLevel } from "../types/recipe";
import { styles } from "../styles/appStyles";
import fusionPassBackground from "../../assets/fusion-pass-bg.png";
import googleGLogo from "../../assets/google-g-logo.png";

/**
 * Home screen:
 * - collects fusion inputs
 * - supports recipe-photo import + OCR review/edit
 * - navigates to RecipeWorkspace with a pending fuse request
 */
const DEFAULT_MOBILE_FUSION_CUISINE = CUISINE_OPTIONS[0] ?? "Japanese";
const PRIVACY_POLICY_URL = "https://flavor-fusion-chef.vercel.app/privacy";
const SUPPORT_URL = "https://flavor-fusion-chef.vercel.app/support";
const MAX_OCR_IMAGE_DATA_URL_CHARS = 3_700_000;
const OCR_IMAGE_VARIANTS_BALANCED = [
  { maxDimension: 1600, compress: 0.65 },
  { maxDimension: 1280, compress: 0.55 },
  { maxDimension: 960, compress: 0.45 },
] as const;
const OCR_IMAGE_VARIANTS_AGGRESSIVE = [
  { maxDimension: 840, compress: 0.4 },
  { maxDimension: 720, compress: 0.35 },
  { maxDimension: 640, compress: 0.3 },
] as const;
const SPICE_LEVEL_STYLES: Record<
  SpiceLevel,
  {
    backgroundColor: string;
    borderColor: string;
    textColor: string;
  }
> = {
  1: { backgroundColor: "#ecfdf5", borderColor: "#10b981", textColor: "#065f46" },
  2: { backgroundColor: "#f7fee7", borderColor: "#84cc16", textColor: "#3f6212" },
  3: { backgroundColor: "#fffbeb", borderColor: "#f59e0b", textColor: "#92400e" },
  4: { backgroundColor: "#fff7ed", borderColor: "#f97316", textColor: "#9a3412" },
  5: { backgroundColor: "#fef2f2", borderColor: "#ef4444", textColor: "#991b1b" },
};

function generateRequestId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = character === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });
}

type CreditPackOption = {
  productId: string;
  credits: number;
  label: string;
  displayPriceUsd: number;
  packageKey: string;
  active: boolean;
};

type CreditGateAuthState = "checking" | "unauthenticated" | "authenticated";

function inferCreditsFromProductId(productId: string) {
  const match = productId.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPriceUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

function getRecommendedPackId(options: CreditPackOption[]) {
  if (options.length === 0) {
    return "";
  }
  const middleIndex = Math.floor(options.length / 2);
  return options[middleIndex]?.productId ?? options[0]?.productId ?? "";
}

type ImageManipulatorModule = {
  manipulateAsync: (
    uri: string,
    actions: Array<{ resize: { width?: number; height?: number } }>,
    options: { compress: number; base64: true; format: "jpeg" | "png" | "webp" },
  ) => Promise<{ base64?: string }>;
  SaveFormat: { JPEG: "jpeg"; PNG: "png"; WEBP: "webp" };
};

let imageManipulatorModulePromise: Promise<ImageManipulatorModule | null> | null = null;

async function loadImageManipulatorModule(): Promise<ImageManipulatorModule | null> {
  if (!imageManipulatorModulePromise) {
    imageManipulatorModulePromise = import("expo-image-manipulator")
      .then((module) => ({
        manipulateAsync: module.manipulateAsync as ImageManipulatorModule["manipulateAsync"],
        SaveFormat: module.SaveFormat as ImageManipulatorModule["SaveFormat"],
      }))
      .catch(() => null);
  }
  return imageManipulatorModulePromise;
}

async function createOcrImageDataUrl(
  uri: string,
  sourceWidth: number,
  sourceHeight: number,
  mimeType: string,
  fallbackBase64: string | undefined,
  variants: ReadonlyArray<{ maxDimension: number; compress: number }>,
) {
  // Create the smallest acceptable OCR payload while preserving enough text detail.
  const imageManipulator = await loadImageManipulatorModule();

  if (!imageManipulator) {
    if (typeof fallbackBase64 === "string" && fallbackBase64.trim().length > 0) {
      const fallbackDataUrl = `data:${mimeType};base64,${fallbackBase64}`;
      if (fallbackDataUrl.length <= MAX_OCR_IMAGE_DATA_URL_CHARS) {
        return fallbackDataUrl;
      }
    }
    return undefined;
  }

  for (const variant of variants) {
    const resizeAction =
      sourceWidth > 0 && sourceHeight > 0
        ? sourceWidth >= sourceHeight
          ? [{ resize: { width: Math.min(sourceWidth, variant.maxDimension) } }]
          : [{ resize: { height: Math.min(sourceHeight, variant.maxDimension) } }]
        : [];

    const processed = await imageManipulator.manipulateAsync(uri, resizeAction, {
      compress: variant.compress,
      format: imageManipulator.SaveFormat.JPEG,
      base64: true,
    });

    if (typeof processed.base64 !== "string" || processed.base64.trim().length === 0) {
      continue;
    }

    const imageDataUrl = `data:image/jpeg;base64,${processed.base64}`;
    if (imageDataUrl.length <= MAX_OCR_IMAGE_DATA_URL_CHARS) {
      return imageDataUrl;
    }
  }

  return undefined;
}

function isLikelyImageSizeError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("request is too large") ||
    normalized.includes("invalid imagedataurl") ||
    normalized.includes("too large")
  );
}

export function HomeScreen({
  navigation,
  route,
}: NativeStackScreenProps<HomeStackParamList, "CreateFusion">) {
  const insets = useSafeAreaInsets();
  const { isCompactScreen, isVeryCompactScreen, isShortScreen } = useResponsiveFlags();
  const [baseRecipe, setBaseRecipe] = useState("");
  const [mealType, setMealType] = useState<MealType>(sampleGeneratedRecipeRecord.sourceInput.mealType);
  const [fusionCuisine, setFusionCuisine] = useState<string>(DEFAULT_MOBILE_FUSION_CUISINE);
  const [dietaryStyle, setDietaryStyle] = useState<DietaryStyle>(
    sampleGeneratedRecipeRecord.sourceInput.dietaryStyle,
  );
  const [spiceLevel, setSpiceLevel] = useState<SpiceLevel>(
    sampleGeneratedRecipeRecord.sourceInput.spiceLevel,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [importedRecipePhoto, setImportedRecipePhoto] = useState<ImportedRecipePhoto | null>(null);
  const [isImportingPhoto, setIsImportingPhoto] = useState(false);
  const [isExtractingText, setIsExtractingText] = useState(false);
  const [mockExtractedText, setMockExtractedText] = useState("");
  const [isExtractionModalOpen, setIsExtractionModalOpen] = useState(false);
  const [isCreditGateOpen, setIsCreditGateOpen] = useState(false);
  const [isCreditGateBusy, setIsCreditGateBusy] = useState(false);
  const [creditGateMessage, setCreditGateMessage] = useState("");
  const [pendingCreditGateInput, setPendingCreditGateInput] = useState<FuseRequest | null>(null);
  const [creditPackOptions, setCreditPackOptions] = useState<CreditPackOption[]>([]);
  const [selectedCreditPackId, setSelectedCreditPackId] = useState("");
  const [creditGateAuthState, setCreditGateAuthState] = useState<CreditGateAuthState>("checking");
  const shouldShowSpiceLevel = mealType !== "dessert" && mealType !== "beverage";

  useEffect(() => {
    // Warm up credit/account snapshot so Fuse tap can use cached state instantly.
    void fetchMonetizationAccountSnapshot({ preferCache: true }).catch(() => {
      // Ignore prefetch failures; runtime flow has fallback checks.
    });
  }, []);

  useEffect(() => {
    if (creditPackOptions.length === 0) {
      setSelectedCreditPackId("");
      return;
    }
    if (creditPackOptions.some((option) => option.productId === selectedCreditPackId)) {
      return;
    }
    setSelectedCreditPackId(getRecommendedPackId(creditPackOptions));
  }, [creditPackOptions, selectedCreditPackId]);

  function resetHomeForm() {
    // Full reset used when user taps Home tab again.
    setBaseRecipe("");
    setMealType(sampleGeneratedRecipeRecord.sourceInput.mealType);
    setFusionCuisine(DEFAULT_MOBILE_FUSION_CUISINE);
    setDietaryStyle(sampleGeneratedRecipeRecord.sourceInput.dietaryStyle);
    setSpiceLevel(sampleGeneratedRecipeRecord.sourceInput.spiceLevel);
    setImportedRecipePhoto(null);
    setMockExtractedText("");
    setIsExtractionModalOpen(false);
    setIsImportingPhoto(false);
    setIsExtractingText(false);
    setIsGenerating(false);
    setIsCreditGateOpen(false);
    setIsCreditGateBusy(false);
    setCreditGateMessage("");
    setPendingCreditGateInput(null);
    setCreditPackOptions([]);
    setSelectedCreditPackId("");
    setCreditGateAuthState("checking");
  }

  useEffect(() => {
    // Home tab re-tap signals a reset via navigation param token.
    if (!route.params?.resetToken) {
      return;
    }

    resetHomeForm();
  }, [route.params?.resetToken]);

  useEffect(() => {
    if (!route.params?.importPhotoOnOpen) {
      return;
    }

    void handleChoosePhoto();
    navigation.setParams({ importPhotoOnOpen: undefined });
  }, [navigation, route.params?.importPhotoOnOpen]);

  useEffect(() => {
    const creditGateToken = route.params?.creditGateToken;
    const creditGateInput = route.params?.creditGateInput;
    const creditGateReason = route.params?.creditGateReason;
    if (!creditGateToken || !creditGateInput) {
      return;
    }

    let cancelled = false;
    setBaseRecipe(creditGateInput.baseRecipe);
    setMealType(creditGateInput.mealType);
    setFusionCuisine(creditGateInput.fusionCuisine);
    setDietaryStyle(creditGateInput.dietaryStyle);
    setSpiceLevel(creditGateInput.spiceLevel);
    setPendingCreditGateInput(creditGateInput);
    setCreditGateMessage(
      creditGateReason === "insufficient_credits_402"
        ? "Credits exhausted. Your free tries and credits are used up. Choose a pack to continue."
        : "",
    );

    async function openCreditGateFromRoute() {
      const account = await fetchMonetizationAccountSnapshot({ preferCache: true });
      if (cancelled) {
        return;
      }
      setCreditGateAuthState(account.authenticated ? "authenticated" : "unauthenticated");
      const options = await getAppleCreditPackOptions();
      if (cancelled) {
        return;
      }
      setCreditPackOptions(options);
      setSelectedCreditPackId((current) => current || getRecommendedPackId(options));
      setIsCreditGateOpen(true);
    }

    void openCreditGateFromRoute().catch(() => {
      if (!cancelled) {
        setCreditGateAuthState("unauthenticated");
        setIsCreditGateOpen(true);
      }
    });

    navigation.setParams({
      creditGateToken: undefined,
      creditGateInput: undefined,
      creditGateReason: undefined,
    });

    return () => {
      cancelled = true;
    };
  }, [
    navigation,
    route.params?.creditGateInput,
    route.params?.creditGateReason,
    route.params?.creditGateToken,
  ]);

  async function buildImportedRecipePhoto(
    asset: ImagePicker.ImagePickerAsset,
    sourceLabel: ImportedRecipePhoto["sourceLabel"],
  ): Promise<ImportedRecipePhoto> {
    // Balanced compression first; aggressive compression is fallback if payload stays too large.
    const sourceWidth = asset.width ?? 0;
    const sourceHeight = asset.height ?? 0;
    const mimeType =
      typeof asset.mimeType === "string" && asset.mimeType.startsWith("image/")
        ? asset.mimeType
        : "image/jpeg";
    const fallbackBase64 =
      typeof asset.base64 === "string" && asset.base64.trim().length > 0 ? asset.base64 : undefined;
    const imageDataUrl =
      (await createOcrImageDataUrl(
        asset.uri,
        sourceWidth,
        sourceHeight,
        mimeType,
        fallbackBase64,
        OCR_IMAGE_VARIANTS_BALANCED,
      )) ??
      (await createOcrImageDataUrl(
        asset.uri,
        sourceWidth,
        sourceHeight,
        mimeType,
        fallbackBase64,
        OCR_IMAGE_VARIANTS_AGGRESSIVE,
      ));

    return {
      uri: asset.uri,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
      aspectRatio:
        asset.width && asset.height && asset.height > 0 ? asset.width / asset.height : 3 / 4,
      sourceLabel,
      imageDataUrl,
    };
  }

  async function runOcrExtraction(photo: ImportedRecipePhoto) {
    // OCR can fail on large payloads; retry once with more aggressive compression.
    setIsExtractingText(true);
    try {
      let workingPhoto = photo;
      let hasRetriedWithAggressiveCompression = false;

      while (true) {
        if (!workingPhoto.imageDataUrl) {
          const fallbackDataUrl = await createOcrImageDataUrl(
            workingPhoto.uri,
            workingPhoto.width,
            workingPhoto.height,
            "image/jpeg",
            undefined,
            OCR_IMAGE_VARIANTS_AGGRESSIVE,
          );
          if (!fallbackDataUrl) {
            Alert.alert(
              "Extraction unavailable",
              "Could not process this image for extraction. Try a clearer photo.",
            );
            return;
          }
          workingPhoto = { ...workingPhoto, imageDataUrl: fallbackDataUrl };
          setImportedRecipePhoto((current) =>
            current && current.uri === workingPhoto.uri
              ? { ...current, imageDataUrl: fallbackDataUrl }
              : current,
          );
          hasRetriedWithAggressiveCompression = true;
        }

        try {
          const extractedText = await fetchOcrExtractedText({
            imageDataUrl: workingPhoto.imageDataUrl,
          });
          setMockExtractedText(extractedText);
          return;
        } catch (error) {
          const message =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not extract recipe text right now.";

          if (!hasRetriedWithAggressiveCompression && isLikelyImageSizeError(message)) {
            const retryDataUrl = await createOcrImageDataUrl(
              workingPhoto.uri,
              workingPhoto.width,
              workingPhoto.height,
              "image/jpeg",
              undefined,
              OCR_IMAGE_VARIANTS_AGGRESSIVE,
            );
            if (retryDataUrl && retryDataUrl !== workingPhoto.imageDataUrl) {
              workingPhoto = { ...workingPhoto, imageDataUrl: retryDataUrl };
              setImportedRecipePhoto((current) =>
                current && current.uri === workingPhoto.uri
                  ? { ...current, imageDataUrl: retryDataUrl }
                  : current,
              );
              hasRetriedWithAggressiveCompression = true;
              continue;
            }
          }

          Alert.alert("Extraction failed", message);
          return;
        }
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not extract recipe text right now.";
      Alert.alert("Extraction failed", message);
    } finally {
      setIsExtractingText(false);
    }
  }

  async function handleTakePhoto() {
    if (isImportingPhoto) {
      return;
    }

    setIsImportingPhoto(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Camera access needed",
          "Allow camera access so you can photograph a recipe and import it into Flavor Fusion Chef.",
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: "images",
        base64: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        // Import flow always goes through review modal so user can edit OCR text.
        const nextPhoto = await buildImportedRecipePhoto(result.assets[0], "Camera");
        setImportedRecipePhoto(nextPhoto);
        setMockExtractedText("");
        await runOcrExtraction(nextPhoto);
      }
    } catch {
      Alert.alert("Import failed", "Could not open the camera right now.");
    } finally {
      setIsImportingPhoto(false);
    }
  }

  async function handleChoosePhoto() {
    if (isImportingPhoto) {
      return;
    }

    setIsImportingPhoto(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Photos access needed",
          "Allow photo library access so you can choose a recipe image from your iPhone.",
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        base64: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const nextPhoto = await buildImportedRecipePhoto(result.assets[0], "Photo Library");
        setImportedRecipePhoto(nextPhoto);
        setMockExtractedText("");
        await runOcrExtraction(nextPhoto);
      }
    } catch {
      Alert.alert("Import failed", "Could not open the photo library right now.");
    } finally {
      setIsImportingPhoto(false);
    }
  }

  function handleUseImportedPhoto() {
    if (!importedRecipePhoto) {
      return;
    }

    setIsExtractionModalOpen(true);
  }

  function handleOpenImportOptions() {
    if (isImportingPhoto) {
      return;
    }

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "Take Photo", "Choose from Library"],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) {
            void handleTakePhoto();
          }
          if (buttonIndex === 2) {
            void handleChoosePhoto();
          }
        },
      );
      return;
    }

    Alert.alert("Import recipe photo", "Choose how you want to import your recipe.", [
      { text: "Cancel", style: "cancel" },
      { text: "Take Photo", onPress: () => void handleTakePhoto() },
      { text: "Choose from Library", onPress: () => void handleChoosePhoto() },
    ]);
  }

  async function handleRegenerateMockExtraction() {
    if (!importedRecipePhoto) {
      return;
    }

    await runOcrExtraction(importedRecipePhoto);
  }

  function handleContinueWithExtractedText() {
    const trimmedText = mockExtractedText.trim();
    if (!trimmedText) {
      Alert.alert("Nothing extracted yet", "Refresh the draft or type in some recipe text first.");
      return;
    }

    setBaseRecipe(trimmedText);
    setIsExtractionModalOpen(false);
  }

  function shouldRequireCreditsForFuse(params: {
    enabled: boolean;
    enforcementMode: "off" | "observe" | "enforce";
    freeRemainingFuse: number;
    availableCredits: number;
  }) {
    if (!params.enabled || params.enforcementMode !== "enforce") {
      return false;
    }
    if (params.freeRemainingFuse > 0) {
      return false;
    }
    return params.availableCredits < 1;
  }

  async function getAppleCreditPackOptions() {
    const configuredFallback = getConfiguredAppleProductIds().map((productId) => ({
      productId,
      credits: inferCreditsFromProductId(productId),
      label: `${inferCreditsFromProductId(productId)} Credits`,
      displayPriceUsd: 0,
      packageKey: `fallback_${productId}`,
      active: true,
    }));

    let baseOptions = configuredFallback;
    try {
      const account = await fetchMonetizationAccountSnapshot({ preferCache: true });
      const pricingPacks = account.pricingPackages
        .filter((pack) => pack.active)
        .map((pack) => ({
          productId: pack.appleProductId,
          credits: pack.credits,
          label: pack.label,
          displayPriceUsd: pack.displayPriceUsd,
          packageKey: pack.packageKey,
          active: pack.active,
        }))
        .sort((left, right) => left.credits - right.credits);
      if (pricingPacks.length > 0) {
        baseOptions = pricingPacks;
      } else {
        const applePacks = account.products
          .filter((product) => product.provider === "apple_app_store")
          .map((product) => ({
            productId: product.productId,
            credits: product.credits,
            label: `${product.credits} Credits`,
            displayPriceUsd: 0,
            packageKey: `product_${product.productId}`,
            active: true,
          }))
          .sort((left, right) => left.credits - right.credits);
        if (applePacks.length > 0) {
          baseOptions = applePacks;
        }
      }
    } catch {
      // Fallback remains available.
    }

    try {
      const availableProductIds = await getAvailableAppleProductIds(
        baseOptions.map((option) => option.productId),
      );
      if (availableProductIds.length === 0) {
        return [];
      }

      const availableSet = new Set(availableProductIds);
      return baseOptions.filter((option) => availableSet.has(option.productId));
    } catch {
      return baseOptions;
    }
  }

  function startFuseNavigation(input: FuseRequest) {
    Keyboard.dismiss();
    navigation.navigate("RecipeWorkspace", {
      pendingRequest: {
        input,
        requestId: generateRequestId(),
      },
    });
  }

  async function handleCreditGateContinue() {
    if (!pendingCreditGateInput || isCreditGateBusy) {
      return;
    }
    if (creditGateAuthState !== "authenticated") {
      setCreditGateMessage("Login first to continue with paid credits.");
      return;
    }

    setIsCreditGateBusy(true);
    try {
      const account = await fetchMonetizationAccountSnapshot({ forceRefresh: true });

      if (
        !shouldRequireCreditsForFuse({
          enabled: account.enabled,
          enforcementMode: account.enforcementMode,
          freeRemainingFuse: account.freeRemaining.fuse,
          availableCredits: account.balance.availableCredits,
        })
      ) {
        setIsCreditGateOpen(false);
        startFuseNavigation(pendingCreditGateInput);
        return;
      }

      let options = creditPackOptions;
      if (options.length === 0) {
        options = await getAppleCreditPackOptions();
        setCreditPackOptions(options);
      }
      if (options.length === 0) {
        setCreditGateMessage("No credit packs are available from App Store yet.");
        return;
      }

      const selectedPack =
        options.find((option) => option.productId === selectedCreditPackId) ?? options[0] ?? null;
      if (!selectedPack) {
        setCreditGateMessage("Choose a credit pack to continue.");
        return;
      }

      const purchase = await purchaseAppleCredits(selectedPack.productId);
      if (purchase.verification.grantedCredits < 1) {
        setCreditGateMessage("Purchase verified, but credits were not added yet. Try again.");
        return;
      }

      setIsCreditGateOpen(false);
      startFuseNavigation(pendingCreditGateInput);
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not complete credit setup right now.";
      setCreditGateMessage(message);
    } finally {
      setIsCreditGateBusy(false);
    }
  }

  async function handleCreditGateGoogleLogin() {
    if (isCreditGateBusy) {
      return;
    }

    setIsCreditGateBusy(true);
    setCreditGateMessage("");
    try {
      const loggedIn = await loginWithGoogleForMobile();
      if (!loggedIn) {
        setCreditGateMessage("Login was cancelled. Try again to continue.");
        setCreditGateAuthState("unauthenticated");
        return;
      }
      const account = await fetchMonetizationAccountSnapshot({ forceRefresh: true });
      setCreditGateAuthState(account.authenticated ? "authenticated" : "unauthenticated");
      if (!account.authenticated) {
        setCreditGateMessage("Login succeeded, but account verification failed. Try again.");
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not complete Google login right now.";
      setCreditGateMessage(message);
      setCreditGateAuthState("unauthenticated");
    } finally {
      setIsCreditGateBusy(false);
    }
  }

  function handleCreditGateAppleLogin() {
    setCreditGateMessage("Apple login will be enabled next.");
  }

  async function handleCreditGateLogout() {
    if (isCreditGateBusy) {
      return;
    }
    await clearMobileAuthToken();
    setCreditGateAuthState("unauthenticated");
    setCreditGateMessage("Logged out. Login to continue with paid credits.");
  }

  async function handleGenerateRecipe() {
    const trimmedRecipe = baseRecipe.trim();
    if (!trimmedRecipe) {
      Alert.alert("Recipe required", "Enter a base recipe or dish idea before generating.");
      return;
    }

    const pendingInput: FuseRequest = {
      baseRecipe: trimmedRecipe,
      mealType,
      fusionCuisine,
      spiceLevel: shouldShowSpiceLevel ? spiceLevel : 1,
      dietaryStyle,
    };

    Keyboard.dismiss();
    setIsGenerating(true);
    try {
      const account = await fetchMonetizationAccountSnapshot({ preferCache: true });
      const needsCredits = shouldRequireCreditsForFuse({
        enabled: account.enabled,
        enforcementMode: account.enforcementMode,
        freeRemainingFuse: account.freeRemaining.fuse,
        availableCredits: account.balance.availableCredits,
      });

      if (needsCredits) {
        const options = await getAppleCreditPackOptions();
        setCreditPackOptions(options);
        setSelectedCreditPackId((current) => current || getRecommendedPackId(options));
        setPendingCreditGateInput(pendingInput);
        setCreditGateAuthState(account.authenticated ? "authenticated" : "unauthenticated");
        if (options.length === 0) {
          setCreditGateMessage(
            "No credit packs are available in App Store for this build yet. Check App Store Connect product setup.",
          );
        } else {
          setCreditGateMessage("");
        }
        setIsCreditGateOpen(true);
        return;
      }
    } catch {
      // If account snapshot fails, server-side enforcement still protects us.
    } finally {
      setIsGenerating(false);
    }

    startFuseNavigation(pendingInput);
  }

  function handleUseSampleRecipe() {
    setBaseRecipe(sampleGeneratedRecipeRecord.sourceInput.baseRecipe);
    setMealType(sampleGeneratedRecipeRecord.sourceInput.mealType);
    setFusionCuisine(DEFAULT_MOBILE_FUSION_CUISINE);
    setDietaryStyle(sampleGeneratedRecipeRecord.sourceInput.dietaryStyle);
    setSpiceLevel(sampleGeneratedRecipeRecord.sourceInput.spiceLevel);
    setImportedRecipePhoto(null);
    setMockExtractedText("");
    setIsExtractionModalOpen(false);
    setIsExtractingText(false);
  }

  async function openCreditGateLink(url: string, label: string) {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Link unavailable", `Could not open ${label} right now.`);
    }
  }

  const recommendedCreditPackId = getRecommendedPackId(creditPackOptions);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            isVeryCompactScreen && styles.contentCompact,
          ]}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          <AppCreditHeader />
          <View style={styles.homeHeroCard}>
            <Text style={styles.kicker}>AI Recipe Studio</Text>
            <Text
              style={[
                styles.title,
                isCompactScreen && styles.titleCompact,
                isVeryCompactScreen && styles.titleVeryCompact,
              ]}
            >
              Fuse any base recipe into a new cuisine.
            </Text>
            <Text style={styles.summary}>
              Paste a recipe or import it from a photo, choose your target cuisine and
              preferences, then generate a practical fusion version.
            </Text>
          </View>

          <View style={styles.homeHowItWorksCard}>
            <Text style={styles.homeHowItWorksTitle}>How it works</Text>
            <View style={styles.homeHowItWorksList}>
              <View style={styles.homeHowItWorksRow}>
                <View style={styles.homeHowItWorksStep}>
                  <Text style={styles.homeHowItWorksStepText}>1</Text>
                </View>
                <Text style={styles.homeHowItWorksCopy}>
                  Start with a recipe you already have.
                </Text>
              </View>
              <View style={styles.homeHowItWorksRow}>
                <View style={styles.homeHowItWorksStep}>
                  <Text style={styles.homeHowItWorksStepText}>2</Text>
                </View>
                <Text style={styles.homeHowItWorksCopy}>
                  Choose the cuisine you want to blend into.
                </Text>
              </View>
              <View style={styles.homeHowItWorksRow}>
                <View style={styles.homeHowItWorksStep}>
                  <Text style={styles.homeHowItWorksStepText}>3</Text>
                </View>
                <Text style={styles.homeHowItWorksCopy}>
                  Get a practical fusion version with steps, swaps, and a shopping list.
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.homeCard}>
            <View style={styles.formGroup}>
              <View style={styles.fieldLabelRow}>
                <Text style={styles.fieldLabel}>Base recipe</Text>
                <Pressable
                  accessibilityLabel="Fill the form with a sample recipe"
                  onPress={handleUseSampleRecipe}
                  style={({ pressed }) => [
                    styles.helperActionChip,
                    pressed && styles.menuButtonPressed,
                  ]}
                >
                  <Text style={styles.helperActionText}>Try sample</Text>
                </Pressable>
              </View>
              <View style={styles.recipeInputWrap}>
                <TextInput
                  multiline
                  onChangeText={setBaseRecipe}
                  placeholder="Example: chicken rice bowl, mushroom pasta, lentil soup"
                  style={styles.recipeInput}
                  textAlignVertical="top"
                  value={baseRecipe}
                />
                <Pressable
                  accessibilityLabel="Import recipe from camera or photo library"
                  onPress={handleOpenImportOptions}
                  style={({ pressed }) => [
                    styles.recipeInputIconButton,
                    pressed && styles.menuButtonPressed,
                  ]}
                >
                  <MaterialIcons
                    color={isImportingPhoto ? "#9ca3af" : "#065f46"}
                    name="document-scanner"
                    size={20}
                  />
                </Pressable>
              </View>

              {importedRecipePhoto ? (
                <View style={styles.compactImportCard}>
                  <View style={styles.compactImportHeader}>
                    <Image
                      source={{ uri: importedRecipePhoto.uri }}
                      style={[
                        styles.compactImportImage,
                        isCompactScreen && styles.compactImportImageCompact,
                        { aspectRatio: importedRecipePhoto.aspectRatio },
                      ]}
                    />
                    <View style={styles.compactImportTextBlock}>
                      <Text style={styles.previewTitle}>Recipe Photo</Text>
                    </View>
                  </View>
                  <View style={styles.previewActions}>
                    <PrimaryButton label="Review Text" onPress={handleUseImportedPhoto} />
                  </View>
                </View>
              ) : null}
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.fieldLabel}>Meal type</Text>
              <View style={styles.optionGrid}>
                {MEAL_TYPE_OPTIONS.map((option) => (
                  <Pressable
                    key={option.value}
                    onPress={() => setMealType(option.value)}
                    style={[
                      styles.choiceChip,
                      mealType === option.value && styles.choiceChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        mealType === option.value && styles.choiceChipTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.fieldLabel}>Fusion cuisine</Text>
              <View style={styles.optionGrid}>
                {CUISINE_OPTIONS.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => setFusionCuisine(option)}
                    style={[
                      styles.choiceChip,
                      fusionCuisine === option && styles.choiceChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        fusionCuisine === option && styles.choiceChipTextSelected,
                      ]}
                    >
                      {option}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.fieldLabel}>Dietary style</Text>
              <View style={styles.optionGrid}>
                {DIETARY_OPTIONS.map((option) => (
                  <Pressable
                    key={option.value}
                    onPress={() => setDietaryStyle(option.value)}
                    style={[
                      styles.choiceChip,
                      dietaryStyle === option.value && styles.choiceChipSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        dietaryStyle === option.value && styles.choiceChipTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {shouldShowSpiceLevel ? (
              <View style={styles.formGroup}>
                <Text style={styles.fieldLabel}>Spice level</Text>
                <View style={styles.optionRow}>
                  {SPICE_LEVEL_OPTIONS.map((option) => {
                    const isSelected = spiceLevel === option.value;
                    const selectedColors = SPICE_LEVEL_STYLES[option.value];

                    return (
                      <Pressable
                        key={option.value}
                        onPress={() => setSpiceLevel(option.value)}
                        style={[
                          styles.levelChip,
                          isSelected && {
                            backgroundColor: selectedColors.backgroundColor,
                            borderColor: selectedColors.borderColor,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.levelChipText,
                            isSelected && { color: selectedColors.textColor },
                          ]}
                        >
                          {option.value}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={styles.homeActionGroup}>
              <PrimaryButton
                disabled={isGenerating}
                label={isGenerating ? "Fusing Recipe..." : "Fuse Recipe"}
                onPress={() => void handleGenerateRecipe()}
              />
            </View>
          </View>
        </ScrollView>

        <Modal
          animationType="slide"
          presentationStyle="fullScreen"
          visible={isCreditGateOpen}
          onRequestClose={() => {
            if (!isCreditGateBusy) {
              setIsCreditGateOpen(false);
            }
          }}
        >
          <View style={styles.creditGateRoot}>
            <ImageBackground
              imageStyle={styles.creditGateBackgroundImage}
              source={fusionPassBackground}
              style={styles.creditGateBackground}
            >
              <View style={styles.creditGateOverlay}>
                <View pointerEvents="none" style={styles.creditGateTopScrim} />
                <View
                  style={[
                    styles.modalSheet,
                    styles.creditGateSheet,
                    isShortScreen && styles.creditGateSheetCompact,
                    {
                      paddingTop: Math.max(insets.top + 12, 28),
                      paddingBottom: Math.max(insets.bottom + 16, 24),
                    },
                  ]}
                >
                  <View style={styles.creditGateMainContent}>
                    <View
                      style={[
                        styles.modalHeader,
                        isCompactScreen && styles.modalHeaderCompact,
                      ]}
                    >
                      <View style={styles.modalHeaderTextBlock}>
                        <Text
                          style={[
                            styles.modalTitle,
                            styles.creditGateHeaderTitle,
                            isCompactScreen && styles.creditGateHeaderTitleCompact,
                            isVeryCompactScreen && styles.creditGateHeaderTitleVeryCompact,
                          ]}
                        >
                          Fusion Pass
                        </Text>
                        <Text
                          style={[
                            styles.modalSubtitle,
                            styles.creditGateHeaderSubtitle,
                            isCompactScreen && styles.creditGateHeaderSubtitleCompact,
                            isVeryCompactScreen && styles.creditGateHeaderSubtitleVeryCompact,
                          ]}
                        >
                          Unlock more fusions instantly with flexible credit packs.
                        </Text>
                      </View>
                      <Pressable
                        accessibilityLabel="Close credit setup"
                        onPress={() => !isCreditGateBusy && setIsCreditGateOpen(false)}
                        style={({ pressed }) => [
                          styles.modalCloseButton,
                          isCompactScreen && styles.modalCloseButtonCompact,
                          pressed && styles.menuButtonPressed,
                        ]}
                      >
                        <Text style={styles.modalCloseLabel}>Close</Text>
                      </Pressable>
                    </View>

                    <View
                      style={[
                        styles.creditGateIntroCard,
                        isCompactScreen && styles.creditGateIntroCardCompact,
                      ]}
                    >
                      <Text
                        style={[
                          styles.modalSectionLabel,
                          styles.creditGateIntroTitle,
                          isCompactScreen && styles.creditGateIntroTitleCompact,
                          isVeryCompactScreen && styles.creditGateIntroTitleVeryCompact,
                        ]}
                      >
                        Choose a credit pack
                      </Text>
                      <View style={styles.creditGateIntroPoints}>
                        <Text style={styles.creditGateIntroPoint}>
                          <Text style={styles.creditGateCheckMark}>{"\u2713 "}</Text>
                          One-time credits, no subscription
                        </Text>
                        <Text style={styles.creditGateIntroPoint}>
                          <Text style={styles.creditGateCheckMark}>{"\u2713 "}</Text>
                          Purchase only when needed
                        </Text>
                        <Text style={styles.creditGateIntroPoint}>
                          <Text style={styles.creditGateCheckMark}>{"\u2713 "}</Text>
                          Continue your fusion right after purchase
                        </Text>
                      </View>
                    </View>

                    <View
                      style={[
                        styles.creditPackList,
                        isCompactScreen && styles.creditPackListCompact,
                        isVeryCompactScreen && styles.creditPackListVeryCompact,
                      ]}
                    >
                      {creditPackOptions.map((option) => {
                        const isSelected = option.productId === selectedCreditPackId;
                        const isRecommended = option.productId === recommendedCreditPackId;
                        return (
                          <Pressable
                            key={option.productId}
                            accessibilityLabel={`Select ${option.label}`}
                            disabled={isCreditGateBusy}
                            onPress={() => setSelectedCreditPackId(option.productId)}
                            style={({ pressed }) => [
                              styles.creditPackCard,
                              isCompactScreen && styles.creditPackCardCompact,
                              isVeryCompactScreen && styles.creditPackCardVeryCompact,
                              isSelected && styles.creditPackCardSelected,
                              pressed && styles.creditPackCardPressed,
                            ]}
                          >
                            <View style={styles.creditPackHeaderRow}>
                              <Text
                                adjustsFontSizeToFit
                                minimumFontScale={0.85}
                                numberOfLines={1}
                                style={[
                                  styles.creditPackLabel,
                                  isCompactScreen && styles.creditPackLabelCompact,
                                  isVeryCompactScreen && styles.creditPackLabelVeryCompact,
                                  isSelected && styles.creditPackLabelSelected,
                                ]}
                              >
                                {option.label}
                              </Text>
                            </View>

                            <View style={styles.creditPackMetaRow}>
                              <Text
                                adjustsFontSizeToFit
                                minimumFontScale={0.9}
                                numberOfLines={1}
                                style={[
                                  styles.creditPackCredits,
                                  isCompactScreen && styles.creditPackCreditsCompact,
                                  isVeryCompactScreen && styles.creditPackCreditsVeryCompact,
                                  isSelected && styles.creditPackCreditsSelected,
                                ]}
                              >
                                {option.credits} credits
                              </Text>
                              <Text
                                style={[
                                  styles.creditPackPrice,
                                  isCompactScreen && styles.creditPackPriceCompact,
                                  isVeryCompactScreen && styles.creditPackPriceVeryCompact,
                                  isSelected && styles.creditPackPriceSelected,
                                ]}
                              >
                                {formatPriceUsd(option.displayPriceUsd)}
                              </Text>
                              {isRecommended ? (
                                <View
                                  style={[
                                    styles.creditPackRecommendedBadge,
                                    isCompactScreen && styles.creditPackRecommendedBadgeCompact,
                                    isVeryCompactScreen && styles.creditPackRecommendedBadgeVeryCompact,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.creditPackRecommendedText,
                                      isCompactScreen && styles.creditPackRecommendedTextCompact,
                                      isVeryCompactScreen && styles.creditPackRecommendedTextVeryCompact,
                                    ]}
                                  >
                                    Best Value
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>

                    {creditGateMessage ? (
                      <View style={styles.emptyImportState}>
                        <Text style={styles.emptyImportCopy}>{creditGateMessage}</Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.creditGateFooter}>
                    {creditGateAuthState !== "authenticated" ? (
                      <View
                        style={[
                          styles.creditGateAuthActions,
                          isShortScreen && styles.creditGateAuthActionsCompact,
                        ]}
                      >
                        <Pressable
                          accessibilityRole="button"
                          disabled={isCreditGateBusy}
                          onPress={handleCreditGateAppleLogin}
                          style={({ pressed }) => [
                            styles.creditGateAppleButton,
                            isCompactScreen && styles.creditGateAuthButtonCompact,
                            pressed && styles.creditGateAuthButtonPressed,
                          ]}
                        >
                          <MaterialIcons name="apple" size={24} style={styles.creditGateAppleIcon} />
                          <Text
                            style={[
                              styles.creditGateAppleButtonText,
                              isCompactScreen && styles.creditGateAuthButtonTextCompact,
                            ]}
                          >
                            Continue with Apple
                          </Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          disabled={isCreditGateBusy}
                          onPress={() => void handleCreditGateGoogleLogin()}
                          style={({ pressed }) => [
                            styles.creditGateGoogleButton,
                            isCompactScreen && styles.creditGateAuthButtonCompact,
                            pressed && styles.creditGateAuthButtonPressed,
                          ]}
                        >
                          <Image source={googleGLogo} style={styles.creditGateGoogleIconImage} />
                          <Text
                            style={[
                              styles.creditGateGoogleButtonText,
                              isCompactScreen && styles.creditGateAuthButtonTextCompact,
                            ]}
                          >
                            Continue with Google
                          </Text>
                        </Pressable>
                      </View>
                    ) : (
                      <View style={styles.creditGateAuthActionsSpacer} />
                    )}

                    <View
                      style={[
                        styles.creditGateHelperSpacer,
                        isShortScreen && styles.creditGateHelperSpacerCompact,
                      ]}
                    />
                    <View style={styles.modalActions}>
                      <PrimaryButton
                        disabled={
                          isCreditGateBusy ||
                          !pendingCreditGateInput ||
                          creditGateAuthState !== "authenticated"
                        }
                        label={isCreditGateBusy ? "Preparing..." : "Continue"}
                        onPress={() => void handleCreditGateContinue()}
                      />
                    </View>
                    {creditGateAuthState === "authenticated" ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={isCreditGateBusy}
                        onPress={() => void handleCreditGateLogout()}
                        style={({ pressed }) => [
                          styles.creditGateLogoutButton,
                          pressed && styles.creditGateAuthButtonPressed,
                        ]}
                      >
                        <Text style={styles.creditGateLogoutText}>Log Out</Text>
                      </Pressable>
                    ) : null}
                    <View
                      style={[
                        styles.creditGateLegalRow,
                        isShortScreen && styles.creditGateLegalRowCompact,
                      ]}
                    >
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => void openCreditGateLink(PRIVACY_POLICY_URL, "Privacy Policy")}
                      >
                        <Text
                          style={[
                            styles.creditGateLegalLink,
                            isShortScreen && styles.creditGateLegalLinkCompact,
                          ]}
                        >
                          Privacy Policy
                        </Text>
                      </Pressable>
                      <Text style={styles.creditGateLegalDivider}>{"\u2022"}</Text>
                      <Pressable
                        accessibilityRole="link"
                        onPress={() => void openCreditGateLink(SUPPORT_URL, "Support")}
                      >
                        <Text
                          style={[
                            styles.creditGateLegalLink,
                            isShortScreen && styles.creditGateLegalLinkCompact,
                          ]}
                        >
                          Support
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </View>
            </ImageBackground>
          </View>
        </Modal>

        <Modal
          animationType="slide"
          presentationStyle="fullScreen"
          visible={isExtractionModalOpen}
          onRequestClose={() => setIsExtractionModalOpen(false)}
        >
          <SafeAreaView style={styles.modalSafeArea}>
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              style={styles.modalKeyboardWrap}
            >
              <ScrollView
                style={styles.modalScrollView}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.modalScrollContent}
              >
                <View
                  style={[
                    styles.modalSheet,
                    { paddingTop: Math.max(insets.top + 12, 28) },
                  ]}
                >
                  <View
                    style={[
                      styles.modalHeader,
                      isCompactScreen && styles.modalHeaderCompact,
                    ]}
                  >
                    <View style={styles.modalHeaderTextBlock}>
                      <Text style={styles.modalTitle}>Review Recipe Text</Text>
                      <Text style={styles.modalSubtitle}>
                        Edit the imported recipe before fusing it.
                      </Text>
                    </View>
                    <Pressable
                      accessibilityLabel="Close extracted text review"
                      onPress={() => setIsExtractionModalOpen(false)}
                      style={({ pressed }) => [
                        styles.modalCloseButton,
                        pressed && styles.menuButtonPressed,
                      ]}
                    >
                      <Text style={styles.modalCloseLabel}>Close</Text>
                    </Pressable>
                  </View>

                  {importedRecipePhoto ? (
                    <View style={styles.modalPreviewCard}>
                      <Text style={styles.modalSectionLabel}>Imported Photo</Text>
                      <Image
                        source={{ uri: importedRecipePhoto.uri }}
                        style={[
                          styles.modalPreviewImage,
                          { aspectRatio: importedRecipePhoto.aspectRatio },
                        ]}
                      />
                    </View>
                  ) : null}

                  <View style={styles.modalEditorCard}>
                    <Text style={styles.modalSectionLabel}>Recipe Text</Text>
                    <TextInput
                      multiline
                      onChangeText={setMockExtractedText}
                      placeholder="Recipe text will appear here..."
                      style={styles.extractedTextInput}
                      textAlignVertical="top"
                      value={mockExtractedText}
                    />
                  </View>

                  <View style={styles.modalActions}>
                    <PrimaryButton
                      disabled={isExtractingText}
                      label={isExtractingText ? "Extracting..." : "Refresh Text"}
                      onPress={() => void handleRegenerateMockExtraction()}
                    />
                    <PrimaryButton
                      disabled={isExtractingText}
                      label="Use This Text"
                      onPress={handleContinueWithExtractedText}
                    />
                  </View>
                </View>
              </ScrollView>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Modal>
      </View>
    </SafeAreaView>
  );
}
