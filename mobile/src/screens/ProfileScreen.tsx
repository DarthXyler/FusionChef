import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import * as ImagePicker from "expo-image-picker";
import Constants from "expo-constants";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandHeader } from "../components/BrandHeader";
import { CreditPill } from "../components/CreditPill";
import { useMobileCookbook } from "../context/mobileCookbook";
import type { RootTabParamList } from "../navigation/types";
import {
  clearMobileAuthToken,
  getMobileAuthSession,
  loginWithGoogleForMobile,
  type MobileAuthSession,
} from "../services/auth";
import {
  fetchMonetizationAccountSnapshot,
  getAvailableAppleProductIds,
  getConfiguredAppleProductIds,
  purchaseAppleCredits,
  subscribeToMonetizationAccountSnapshot,
  type MonetizationAccountSnapshot,
} from "../services/monetization";
import {
  readMobileProfileOverrides,
  saveMobileProfileOverrides,
  type MobileProfileOverrides,
} from "../services/profile";
import { styles } from "../styles/appStyles";

const SUPPORT_URL = "https://flavor-fusion-chef.vercel.app/support";
const FAQ_URL = "https://flavor-fusion-chef.vercel.app/faq";
const PRIVACY_POLICY_URL = "https://flavor-fusion-chef.vercel.app/privacy";
const TERMS_URL = "https://flavor-fusion-chef.vercel.app/terms";
const REFUND_POLICY_URL = "https://flavor-fusion-chef.vercel.app/refund-policy";

type ProfileLinkRowProps = {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  tone?: "default" | "danger";
  onPress: () => void;
};

type CreditPackOption = {
  productId: string;
  credits: number;
  label: string;
  displayPriceUsd: number;
  packageKey: string;
  active: boolean;
};

function inferCreditsFromProductId(productId: string) {
  const match = productId.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPriceUsd(value: number) {
  return value > 0 ? `$${value.toFixed(2)}` : "";
}

function formatCreditCount(value: number) {
  return `${value} credit${value === 1 ? "" : "s"}`;
}

function getRecommendedPackId(options: CreditPackOption[]) {
  if (options.length === 0) {
    return "";
  }
  const middleIndex = Math.floor(options.length / 2);
  return options[middleIndex]?.productId ?? options[0]?.productId ?? "";
}

function getInitials(nameOrEmail: string) {
  const cleaned = nameOrEmail.trim();
  if (!cleaned) {
    return "FC";
  }
  const parts = cleaned
    .replace(/@.*/, "")
    .split(/\s+|[._-]+/)
    .filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "FC";
}

function ProfileLinkRow({ icon, label, tone = "default", onPress }: ProfileLinkRowProps) {
  const isDanger = tone === "danger";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.profileRow, pressed && styles.profileRowPressed]}
    >
      <View style={[styles.profileRowIcon, isDanger && styles.profileRowIconDanger]}>
        <MaterialIcons color={isDanger ? "#b91c1c" : "#047857"} name={icon} size={18} />
      </View>
      <Text style={[styles.profileRowText, isDanger && styles.profileRowTextDanger]}>{label}</Text>
      <MaterialIcons color="#9ca3af" name="chevron-right" size={22} />
    </Pressable>
  );
}

function ProfileAvatar({
  displayName,
  email,
  photoUri,
  size = "large",
}: {
  displayName: string;
  email: string;
  photoUri: string;
  size?: "large" | "medium";
}) {
  const isLarge = size === "large";
  return (
    <View style={[styles.profileAvatar, !isLarge && styles.profileAvatarMedium]}>
      {photoUri ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: photoUri }}
          style={[styles.profileAvatarImage, !isLarge && styles.profileAvatarImageMedium]}
        />
      ) : (
        <Text style={[styles.profileAvatarInitials, !isLarge && styles.profileAvatarInitialsMedium]}>
          {getInitials(displayName || email)}
        </Text>
      )}
    </View>
  );
}

export function ProfileScreen({ route }: BottomTabScreenProps<RootTabParamList, "Profile">) {
  const { summaries } = useMobileCookbook();
  const [session, setSession] = useState<MobileAuthSession | null>(null);
  const [profileOverrides, setProfileOverrides] = useState<MobileProfileOverrides>({
    displayName: "",
    photoUri: "",
  });
  const [accountSnapshot, setAccountSnapshot] = useState<MonetizationAccountSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isLoadingCreditPacks, setIsLoadingCreditPacks] = useState(false);
  const [isPurchasingCredits, setIsPurchasingCredits] = useState(false);
  const [isCreditSheetOpen, setIsCreditSheetOpen] = useState(false);
  const [creditPackOptions, setCreditPackOptions] = useState<CreditPackOption[]>([]);
  const [selectedCreditPackId, setSelectedCreditPackId] = useState("");
  const [creditPurchaseMessage, setCreditPurchaseMessage] = useState("");
  const [isCreditInfoExpanded, setIsCreditInfoExpanded] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftPhotoUri, setDraftPhotoUri] = useState("");

  const displayName = profileOverrides.displayName || session?.name || "Welcome, Chef";
  const email = session?.email ?? "";
  const isSignedIn = session !== null;
  const availableCredits = accountSnapshot?.balance.availableCredits ?? 0;
  const freeFuseRemaining = accountSnapshot?.freeRemaining.fuse ?? 0;
  const freeRerollRemaining = accountSnapshot?.freeRemaining.reroll ?? 0;
  const fuseCreditCost = accountSnapshot?.actionCosts.fuse ?? 2;
  const rerollCreditCost = accountSnapshot?.actionCosts.reroll ?? 1;
  const fuseCreditCostLabel = formatCreditCount(fuseCreditCost);
  const rerollCreditCostLabel = formatCreditCount(rerollCreditCost);
  const appVersion =
    Constants.expoConfig?.version || Constants.manifest2?.extra?.expoClient?.version || "2.0.0";

  const loadProfile = useCallback(async () => {
    setIsLoading(true);
    try {
      const [nextSession, nextOverrides] = await Promise.all([
        getMobileAuthSession(),
        readMobileProfileOverrides(),
      ]);
      setSession(nextSession);
      setProfileOverrides(nextOverrides);
      if (nextSession) {
        try {
          const snapshot = await fetchMonetizationAccountSnapshot({ preferCache: true });
          setAccountSnapshot(snapshot);
        } catch {
          setAccountSnapshot(null);
        }
      } else {
        setAccountSnapshot(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(
    () =>
      subscribeToMonetizationAccountSnapshot((snapshot) => {
        setAccountSnapshot(snapshot);
      }),
    [],
  );

  const openLink = useCallback(async (url: string, label: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert("Link unavailable", `Could not open ${label} right now.`);
    }
  }, []);

  const getAppleCreditPackOptions = useCallback(async () => {
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

    const availableProductIds = await getAvailableAppleProductIds(
      baseOptions.map((option) => option.productId),
    );
    if (availableProductIds.length === 0) {
      return [];
    }

    const availableSet = new Set(availableProductIds);
    return baseOptions.filter((option) => availableSet.has(option.productId));
  }, []);

  const handleSignIn = useCallback(async () => {
    setIsSigningIn(true);
    try {
      const didLogin = await loginWithGoogleForMobile();
      if (didLogin) {
        await loadProfile();
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not sign in right now.";
      Alert.alert("Sign in failed", message);
    } finally {
      setIsSigningIn(false);
    }
  }, [loadProfile]);

  const handleOpenCreditSheet = useCallback(async () => {
    setCreditPurchaseMessage("");
    if (!isSignedIn) {
      setIsSigningIn(true);
      try {
        const didLogin = await loginWithGoogleForMobile();
        if (!didLogin) {
          setCreditPurchaseMessage("Sign in was cancelled. Sign in to purchase credits.");
          return;
        }
        await loadProfile();
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Could not sign in right now.";
        setCreditPurchaseMessage(message);
        return;
      } finally {
        setIsSigningIn(false);
      }
    }

    setIsCreditSheetOpen(true);
    setIsLoadingCreditPacks(true);
    try {
      const options = await getAppleCreditPackOptions();
      setCreditPackOptions(options);
      setSelectedCreditPackId((current) =>
        options.some((option) => option.productId === current)
          ? current
          : getRecommendedPackId(options),
      );
      if (options.length === 0) {
        setCreditPurchaseMessage("No credit packs are available from App Store yet.");
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not load credit packs right now.";
      setCreditPurchaseMessage(message);
      setCreditPackOptions([]);
    } finally {
      setIsLoadingCreditPacks(false);
    }
  }, [getAppleCreditPackOptions, isSignedIn, loadProfile]);

  useEffect(() => {
    if (route.params?.openCreditSheetToken) {
      void handleOpenCreditSheet();
    }
  }, [handleOpenCreditSheet, route.params?.openCreditSheetToken]);

  const handlePurchaseSelectedPack = useCallback(async () => {
    if (isPurchasingCredits) {
      return;
    }

    const selectedPack =
      creditPackOptions.find((option) => option.productId === selectedCreditPackId) ??
      creditPackOptions[0] ??
      null;
    if (!selectedPack) {
      setCreditPurchaseMessage("Choose a credit pack to continue.");
      return;
    }

    setIsPurchasingCredits(true);
    setCreditPurchaseMessage("Opening App Store...");
    try {
      const purchase = await purchaseAppleCredits(selectedPack.productId, {
        onStatus: setCreditPurchaseMessage,
      });
      const nextSnapshot = await fetchMonetizationAccountSnapshot({ forceRefresh: true });
      setAccountSnapshot(
        purchase.verification.balance
          ? {
              ...nextSnapshot,
              balance: purchase.verification.balance,
            }
          : nextSnapshot,
      );
      setIsCreditSheetOpen(false);
      Alert.alert(
        "Credits added",
        purchase.verification.grantedCredits > 0
          ? `${purchase.verification.grantedCredits} credits were added to your account.`
          : "Purchase verified. Your credits are ready.",
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Could not complete purchase right now.";
      if (message === "Purchase canceled.") {
        setCreditPurchaseMessage("");
      } else {
        setCreditPurchaseMessage(message);
      }
    } finally {
      setIsPurchasingCredits(false);
    }
  }, [creditPackOptions, isPurchasingCredits, selectedCreditPackId]);

  const handleSignOut = useCallback(() => {
    Alert.alert("Sign out?", "You can sign back in any time with Google.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => {
          void clearMobileAuthToken().then(() => {
            setSession(null);
            setAccountSnapshot(null);
          });
        },
      },
    ]);
  }, []);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      "Delete account",
      "Account deletion needs a confirmation flow before it removes your saved data. For now, support can help with deletion requests.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Contact Support",
          onPress: () => {
            void openLink(SUPPORT_URL, "support");
          },
        },
      ],
    );
  }, [openLink]);

  const handleRestorePurchases = useCallback(() => {
    Alert.alert(
      "Restore purchases",
      "Consumable credit packs are verified when each purchase completes. If a completed purchase did not add credits, contact support and include the purchase time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Contact Support",
          onPress: () => {
            void openLink(SUPPORT_URL, "support");
          },
        },
      ],
    );
  }, [openLink]);

  const handleOpenEdit = useCallback(() => {
    setDraftName(displayName === "Welcome, Chef" ? "" : displayName);
    setDraftPhotoUri(profileOverrides.photoUri);
    setIsEditOpen(true);
  }, [displayName, profileOverrides.photoUri]);

  const handleChoosePhoto = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow photo library access to choose a profile photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ["images"],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      const nextPhotoUri = result.assets[0].uri;
      if (isEditOpen) {
        setDraftPhotoUri(nextPhotoUri);
        return;
      }
      const nextOverrides = await saveMobileProfileOverrides({
        ...profileOverrides,
        photoUri: nextPhotoUri,
      });
      setProfileOverrides(nextOverrides);
    }
  }, [isEditOpen, profileOverrides]);

  const handleTakePhoto = useCallback(async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera access needed", "Allow camera access to take a profile photo.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      const nextPhotoUri = result.assets[0].uri;
      if (isEditOpen) {
        setDraftPhotoUri(nextPhotoUri);
        return;
      }
      const nextOverrides = await saveMobileProfileOverrides({
        ...profileOverrides,
        photoUri: nextPhotoUri,
      });
      setProfileOverrides(nextOverrides);
    }
  }, [isEditOpen, profileOverrides]);

  const handleSaveProfile = useCallback(async () => {
    const nextOverrides = await saveMobileProfileOverrides({
      displayName: draftName.trim(),
      photoUri: draftPhotoUri.trim(),
    });
    setProfileOverrides(nextOverrides);
    setIsEditOpen(false);
  }, [draftName, draftPhotoUri]);

  const accountRows = useMemo(
    () => (
      <>
        <ProfileLinkRow icon="manage-accounts" label="Manage profile" onPress={handleOpenEdit} />
        <ProfileLinkRow
          icon="delete-outline"
          label="Delete account"
          onPress={handleDeleteAccount}
          tone="danger"
        />
        {isSignedIn ? (
          <>
            <ProfileLinkRow
              icon="restore"
              label="Purchase support"
              onPress={handleRestorePurchases}
            />
            <ProfileLinkRow icon="logout" label="Sign out" onPress={handleSignOut} />
          </>
        ) : (
          <ProfileLinkRow icon="login" label="Sign in with Google" onPress={handleSignIn} />
        )}
      </>
    ),
    [
      handleDeleteAccount,
      handleOpenEdit,
      handleRestorePurchases,
      handleSignIn,
      handleSignOut,
      isSignedIn,
    ],
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.profileContent}>
          <View style={styles.profileTopBar}>
            <BrandHeader compact />
            <CreditPill credits={availableCredits} onPress={handleOpenCreditSheet} />
          </View>

          <View style={styles.profileHeroCard}>
              <View style={styles.profileHeroHeader}>
              <Pressable
                accessibilityLabel="Choose profile photo"
                accessibilityRole="button"
                disabled={!isSignedIn}
                onPress={handleChoosePhoto}
                style={({ pressed }) => [
                  styles.profileAvatarWrap,
                  pressed && styles.profileRowPressed,
                ]}
              >
                <ProfileAvatar
                  displayName={displayName}
                  email={email}
                  photoUri={profileOverrides.photoUri}
                />
                <View style={styles.profileAvatarEditButton}>
                  <MaterialIcons color="#ffffff" name="photo-camera" size={17} />
                </View>
              </Pressable>
              <View style={styles.profileHeroText}>
                <Text style={styles.profileTitle}>{displayName}</Text>
                <Text style={styles.profileSubtitle}>
                  {email || "Sign in to sync your cookbook and credits."}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={isSignedIn ? handleOpenEdit : handleSignIn}
                  style={({ pressed }) => [
                    styles.profileEditButton,
                    pressed && styles.profileRowPressed,
                  ]}
                >
                  {isSigningIn ? (
                    <ActivityIndicator color="#047857" size="small" />
                  ) : (
                    <Text style={styles.profileEditButtonText}>
                      {isSignedIn ? "Edit Profile" : "Continue with Google"}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>

          <View style={styles.profileSectionHeader}>
            <Text style={styles.profileSectionTitle}>Credits and Free Usage</Text>
            {isLoading ? <ActivityIndicator color="#10b981" size="small" /> : null}
          </View>
          <View style={styles.profileUsageGrid}>
            <Pressable
              accessibilityLabel="Buy credits"
              accessibilityRole="button"
              onPress={handleOpenCreditSheet}
              style={({ pressed }) => [
                styles.profileUsageCard,
                pressed && styles.profileRowPressed,
              ]}
            >
              <View style={styles.profileUsageIcon}>
                <MaterialCommunityIcons color="#047857" name="database" size={22} />
              </View>
              <Text style={styles.profileUsageValue}>{availableCredits}</Text>
              <Text style={styles.profileUsageLabel}>Credits</Text>
            </Pressable>
            <View style={[styles.profileUsageCard, styles.profileUsageCardWarm]}>
              <View style={[styles.profileUsageIcon, styles.profileUsageIconWarm]}>
                <MaterialIcons color="#c2410c" name="auto-awesome" size={22} />
              </View>
              <Text style={styles.profileUsageValue}>{freeFuseRemaining}</Text>
              <Text style={[styles.profileUsageLabel, styles.profileUsageLabelWarm]}>
                Free today
              </Text>
            </View>
            <View style={[styles.profileUsageCard, styles.profileUsageCardBlue]}>
              <View style={[styles.profileUsageIcon, styles.profileUsageIconBlue]}>
                <MaterialIcons color="#1d4ed8" name="refresh" size={22} />
              </View>
              <Text style={styles.profileUsageValue}>{freeRerollRemaining}</Text>
              <Text style={[styles.profileUsageLabel, styles.profileUsageLabelBlue]}>
                Free rerolls
              </Text>
            </View>
          </View>

          <View style={styles.profileCreditPurchaseCard}>
            <View style={styles.profileCreditPurchaseTextWrap}>
              <Text style={styles.profileCreditPurchaseTitle}>Need more credits?</Text>
              <Text style={styles.profileCreditPurchaseCopy}>
                Add a one-time credit pack for fusions and rerolls.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={handleOpenCreditSheet}
              style={({ pressed }) => [
                styles.profileBuyCreditsButton,
                pressed && styles.profileRowPressed,
              ]}
            >
              {isSigningIn || isLoadingCreditPacks ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.profileBuyCreditsButtonText}>Buy Credits</Text>
              )}
            </Pressable>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: isCreditInfoExpanded }}
            onPress={() => setIsCreditInfoExpanded((current) => !current)}
            style={({ pressed }) => [
              styles.profileCreditInfoCard,
              pressed && styles.profileCreditInfoCardPressed,
            ]}
          >
            <View style={styles.profileCreditInfoHeader}>
              <View style={styles.profileCreditInfoTitleRow}>
                <View style={styles.profileCreditInfoIcon}>
                  <MaterialIcons color="#047857" name="info-outline" size={18} />
                </View>
                <View style={styles.profileCreditInfoTextWrap}>
                  <Text style={styles.profileCreditInfoTitle}>How credits are used</Text>
                  <Text style={styles.profileCreditInfoSummary}>
                    Generation {fuseCreditCostLabel}, reroll {rerollCreditCostLabel}.
                  </Text>
                </View>
              </View>
              <MaterialIcons
                color="#6b7280"
                name={isCreditInfoExpanded ? "expand-less" : "expand-more"}
                size={24}
              />
            </View>
            {isCreditInfoExpanded ? (
              <View style={styles.profileCreditInfoDetails}>
                <View style={styles.profileCreditInfoDetailRow}>
                  <Text style={styles.profileCreditInfoDetailLabel}>Recipe generation</Text>
                  <Text style={styles.profileCreditInfoDetailValue}>{fuseCreditCostLabel}</Text>
                </View>
                <View style={styles.profileCreditInfoDetailRow}>
                  <Text style={styles.profileCreditInfoDetailLabel}>Reroll</Text>
                  <Text style={styles.profileCreditInfoDetailValue}>{rerollCreditCostLabel}</Text>
                </View>
                <Text style={styles.profileCreditInfoNote}>
                  Free actions are used first when available. Credits are charged only after a
                  successful result.
                </Text>
              </View>
            ) : null}
          </Pressable>
          {creditPurchaseMessage && !isCreditSheetOpen ? (
            <Text style={styles.profileCreditPurchaseMessage}>{creditPurchaseMessage}</Text>
          ) : null}

          <View style={styles.profileStatsShadow}>
            <View style={styles.profileStatsCard}>
              <Text style={styles.profileStatsValue}>{summaries.length}</Text>
              <View style={styles.profileStatsTextWrap}>
                <Text style={styles.profileStatsTitle}>Saved recipes</Text>
                <Text style={styles.profileStatsCopy}>Favorites and to-try stats can join this row later.</Text>
              </View>
            </View>
          </View>

          <View style={styles.profileSectionHeader}>
            <Text style={styles.profileSectionTitle}>Account</Text>
          </View>
          <View style={styles.profileRowsCard}>{accountRows}</View>

          <View style={styles.profileSectionHeader}>
            <Text style={styles.profileSectionTitle}>Help and Legal</Text>
          </View>
          <View style={styles.profileRowsCard}>
            <ProfileLinkRow
              icon="support-agent"
              label="Support"
              onPress={() => openLink(SUPPORT_URL, "support")}
            />
            <ProfileLinkRow icon="help-outline" label="FAQ" onPress={() => openLink(FAQ_URL, "FAQ")} />
            <ProfileLinkRow
              icon="privacy-tip"
              label="Privacy Policy"
              onPress={() => openLink(PRIVACY_POLICY_URL, "privacy policy")}
            />
            <ProfileLinkRow icon="article" label="Terms" onPress={() => openLink(TERMS_URL, "terms")} />
            <ProfileLinkRow
              icon="receipt-long"
              label="Purchases & Refunds"
              onPress={() => openLink(REFUND_POLICY_URL, "purchases and refunds")}
            />
          </View>

          <Text style={styles.profileVersionText}>App version {appVersion}</Text>
        </ScrollView>

        <Modal animationType="slide" transparent visible={isEditOpen}>
          <View style={styles.profileModalBackdrop}>
            <View style={styles.profileEditSheet}>
              <View style={styles.profileEditTopRow}>
                <Text style={styles.profileEditTitle}>Edit Profile</Text>
                <Pressable
                  accessibilityLabel="Close edit profile"
                  accessibilityRole="button"
                  onPress={() => setIsEditOpen(false)}
                  style={({ pressed }) => [
                    styles.profileEditCloseButton,
                    pressed && styles.profileRowPressed,
                  ]}
                >
                  <MaterialIcons color="#374151" name="close" size={22} />
                </Pressable>
              </View>

              <View style={styles.profileEditAvatarArea}>
                <Pressable
                  accessibilityLabel="Choose profile photo"
                  accessibilityRole="button"
                  onPress={handleChoosePhoto}
                  style={({ pressed }) => [styles.profileAvatarWrap, pressed && styles.profileRowPressed]}
                >
                  <ProfileAvatar
                    displayName={draftName || displayName}
                    email={email}
                    photoUri={draftPhotoUri}
                    size="large"
                  />
                  <View style={styles.profileAvatarEditButton}>
                    <MaterialIcons color="#ffffff" name="photo-camera" size={17} />
                  </View>
                </Pressable>
              </View>

              <Text style={styles.profileFieldLabel}>Display name</Text>
              <TextInput
                autoCapitalize="words"
                onChangeText={setDraftName}
                placeholder={session?.name || "Your name"}
                placeholderTextColor="#9ca3af"
                style={styles.profileNameInput}
                value={draftName}
              />

              <Text style={styles.profileFieldLabel}>Email</Text>
              <View style={styles.profileReadonlyField}>
                <Text style={styles.profileReadonlyFieldText}>{email || "Not signed in"}</Text>
              </View>

              <View style={styles.profileRowsCard}>
                <ProfileLinkRow icon="photo-camera" label="Take photo" onPress={handleTakePhoto} />
                <ProfileLinkRow icon="photo-library" label="Choose from library" onPress={handleChoosePhoto} />
                <ProfileLinkRow
                  icon="delete-outline"
                  label="Remove photo"
                  onPress={() => setDraftPhotoUri("")}
                  tone="danger"
                />
              </View>

              <Pressable
                accessibilityRole="button"
                onPress={handleSaveProfile}
                style={({ pressed }) => [styles.profileSaveButton, pressed && styles.profileRowPressed]}
              >
                <Text style={styles.profileSaveButtonText}>Save Changes</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal animationType="slide" transparent visible={isCreditSheetOpen}>
          <View style={styles.profileModalBackdrop}>
            <View style={styles.profileEditSheet}>
              <View style={styles.profileEditTopRow}>
                <View>
                  <Text style={styles.profileEditTitle}>Buy Credits</Text>
                  <Text style={styles.profileCreditSheetSubtitle}>
                    One-time credit packs for recipe generation and rerolls.
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Close buy credits"
                  accessibilityRole="button"
                  disabled={isPurchasingCredits}
                  onPress={() => setIsCreditSheetOpen(false)}
                  style={({ pressed }) => [
                    styles.profileEditCloseButton,
                    pressed && styles.profileRowPressed,
                  ]}
                >
                  <MaterialIcons color="#374151" name="close" size={22} />
                </Pressable>
              </View>

              {isLoadingCreditPacks ? (
                <View style={styles.profileCreditSheetLoading}>
                  <ActivityIndicator color="#10b981" />
                  <Text style={styles.profileCreditSheetSubtitle}>Loading App Store packs...</Text>
                </View>
              ) : (
                <View style={styles.profileCreditPackList}>
                  {creditPackOptions.map((option) => {
                    const isSelected = option.productId === selectedCreditPackId;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        key={option.productId}
                        onPress={() => setSelectedCreditPackId(option.productId)}
                        style={({ pressed }) => [
                          styles.profileCreditPackCard,
                          isSelected && styles.profileCreditPackCardSelected,
                          pressed && styles.profileRowPressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.profileCreditPackLabel,
                            isSelected && styles.profileCreditPackLabelSelected,
                          ]}
                        >
                          {option.label}
                        </Text>
                        <Text style={styles.profileCreditPackCredits}>{option.credits} credits</Text>
                        <Text
                          style={[
                            styles.profileCreditPackPrice,
                            isSelected && styles.profileCreditPackPriceSelected,
                          ]}
                        >
                          {formatPriceUsd(option.displayPriceUsd) || "App Store"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {creditPurchaseMessage ? (
                <Text style={styles.profileCreditPurchaseMessage}>{creditPurchaseMessage}</Text>
              ) : null}

              <Pressable
                accessibilityRole="button"
                disabled={isLoadingCreditPacks || isPurchasingCredits || creditPackOptions.length === 0}
                onPress={handlePurchaseSelectedPack}
                style={({ pressed }) => [
                  styles.profileSaveButton,
                  (isLoadingCreditPacks || isPurchasingCredits || creditPackOptions.length === 0) &&
                    styles.profileBuyCreditsButtonDisabled,
                  pressed && styles.profileRowPressed,
                ]}
              >
                {isPurchasingCredits ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.profileSaveButtonText}>Continue</Text>
                )}
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}
