import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { SafeAreaView } from "react-native-safe-area-context";
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
import { fetchOcrExtractedText } from "../services/ocr";
import type { ImportedRecipePhoto } from "../types/importedRecipePhoto";
import type { DietaryStyle, FuseRequest, MealType, SpiceLevel } from "../types/recipe";
import { styles } from "../styles/appStyles";

const DEFAULT_MOBILE_FUSION_CUISINE = CUISINE_OPTIONS[0] ?? "Japanese";
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

export function HomeScreen({
  navigation,
  route,
}: NativeStackScreenProps<HomeStackParamList, "Home">) {
  const { isCompactScreen, isVeryCompactScreen } = useResponsiveFlags();
  const [baseRecipe, setBaseRecipe] = useState(sampleGeneratedRecipeRecord.sourceInput.baseRecipe);
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
  const shouldShowSpiceLevel = mealType !== "dessert" && mealType !== "beverage";

  function resetHomeForm() {
    setBaseRecipe(sampleGeneratedRecipeRecord.sourceInput.baseRecipe);
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
  }

  useEffect(() => {
    if (!route.params?.resetToken) {
      return;
    }

    resetHomeForm();
  }, [route.params?.resetToken]);

  function buildImportedRecipePhoto(
    asset: ImagePicker.ImagePickerAsset,
    sourceLabel: ImportedRecipePhoto["sourceLabel"],
  ): ImportedRecipePhoto {
    const mimeType =
      typeof asset.mimeType === "string" && asset.mimeType.startsWith("image/")
        ? asset.mimeType
        : "image/jpeg";
    const imageDataUrl =
      typeof asset.base64 === "string" && asset.base64.trim().length > 0
        ? `data:${mimeType};base64,${asset.base64}`
        : undefined;

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
    if (!photo.imageDataUrl) {
      Alert.alert(
        "Extraction unavailable",
        "Could not read image data from this photo. Try importing again.",
      );
      return;
    }

    setIsExtractingText(true);
    try {
      const extractedText = await fetchOcrExtractedText({
        imageDataUrl: photo.imageDataUrl,
      });
      setMockExtractedText(extractedText);
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
        const nextPhoto = buildImportedRecipePhoto(result.assets[0], "Camera");
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
        const nextPhoto = buildImportedRecipePhoto(result.assets[0], "Photo Library");
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

  function handleGenerateRecipe() {
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
    navigation.navigate("RecipeWorkspace", {
      pendingRequest: {
        input: pendingInput,
        requestId: new Date().toISOString(),
      },
    });
    setIsGenerating(false);
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
          <View style={styles.homeHeroCard}>
            <Text style={styles.brand}>Flavor Fusion Chef</Text>
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
                onPress={handleGenerateRecipe}
              />
            </View>
          </View>
        </ScrollView>

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
                <View style={styles.modalSheet}>
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
