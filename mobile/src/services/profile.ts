import AsyncStorage from "@react-native-async-storage/async-storage";

const MOBILE_PROFILE_OVERRIDES_KEY = "flavor_fusion_mobile_profile_overrides_v1";

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

export async function readMobileProfileOverrides() {
  try {
    const raw = await AsyncStorage.getItem(MOBILE_PROFILE_OVERRIDES_KEY);
    if (!raw) {
      return { displayName: "", photoUri: "" };
    }
    return normalizeProfileOverrides(JSON.parse(raw));
  } catch {
    return { displayName: "", photoUri: "" };
  }
}

export async function saveMobileProfileOverrides(overrides: MobileProfileOverrides) {
  const normalized = normalizeProfileOverrides(overrides);
  await AsyncStorage.setItem(MOBILE_PROFILE_OVERRIDES_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function clearMobileProfileOverrides() {
  await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
}
