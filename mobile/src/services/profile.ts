import AsyncStorage from "@react-native-async-storage/async-storage";
import { getMobileAuthSession } from "./auth";

const MOBILE_PROFILE_OVERRIDES_KEY = "flavor_fusion_mobile_profile_overrides_v1";
const MOBILE_PROFILE_OVERRIDES_ACCOUNT_PREFIX = "flavor_fusion_mobile_profile_overrides_v2:";

export type MobileProfileOverrides = {
  displayName: string;
  photoUri: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProfileOverrides(value: unknown): MobileProfileOverrides {
  if (!isObjectRecord(value)) {
    return { displayName: "", photoUri: "" };
  }
  return {
    displayName: typeof value.displayName === "string" ? value.displayName.trim() : "",
    photoUri: typeof value.photoUri === "string" ? value.photoUri.trim() : "",
  };
}

async function getProfileOverridesKeyForCurrentAccount() {
  const session = await getMobileAuthSession();
  const userId = session?.userId?.trim() ?? "";
  return userId ? `${MOBILE_PROFILE_OVERRIDES_ACCOUNT_PREFIX}${userId}` : null;
}

export async function readMobileProfileOverrides() {
  try {
    const accountKey = await getProfileOverridesKeyForCurrentAccount();
    if (!accountKey) {
      return { displayName: "", photoUri: "" };
    }

    const raw = await AsyncStorage.getItem(accountKey);
    if (raw) {
      return normalizeProfileOverrides(JSON.parse(raw));
    }

    const legacyRaw = await AsyncStorage.getItem(MOBILE_PROFILE_OVERRIDES_KEY);
    if (legacyRaw) {
      const legacy = normalizeProfileOverrides(JSON.parse(legacyRaw));
      if (legacy.displayName || legacy.photoUri) {
        await AsyncStorage.setItem(accountKey, JSON.stringify(legacy));
      }
      return legacy;
    }

    if (!raw) {
      return { displayName: "", photoUri: "" };
    }
    return { displayName: "", photoUri: "" };
  } catch {
    return { displayName: "", photoUri: "" };
  }
}

export async function saveMobileProfileOverrides(overrides: MobileProfileOverrides) {
  const normalized = normalizeProfileOverrides(overrides);
  const accountKey = await getProfileOverridesKeyForCurrentAccount();
  if (accountKey) {
    await AsyncStorage.setItem(accountKey, JSON.stringify(normalized));
  }
  return normalized;
}

export async function migrateLegacyProfileOverridesToCurrentAccount() {
  const accountKey = await getProfileOverridesKeyForCurrentAccount();
  if (!accountKey) {
    return { displayName: "", photoUri: "" };
  }

  const existingRaw = await AsyncStorage.getItem(accountKey);
  if (existingRaw) {
    await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
    return normalizeProfileOverrides(JSON.parse(existingRaw));
  }

  const legacyRaw = await AsyncStorage.getItem(MOBILE_PROFILE_OVERRIDES_KEY);
  if (!legacyRaw) {
    return { displayName: "", photoUri: "" };
  }

  const legacy = normalizeProfileOverrides(JSON.parse(legacyRaw));
  if (legacy.displayName || legacy.photoUri) {
    await AsyncStorage.setItem(accountKey, JSON.stringify(legacy));
  }
  await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
  return legacy;
}

export async function clearLegacyMobileProfileOverrides() {
  await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
}
