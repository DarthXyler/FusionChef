import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBaseUrl } from "../config/api";
import { selectAccountOwnedValue } from "./accountOwnership";
import { getMobileAuthRequestContext } from "./auth";
import {
  assertMobileSessionIdentityCurrent,
  assertSameMobileSessionIdentity,
  isMobileSessionIdentityCurrent,
  type MobileSessionIdentity,
} from "./authSession";
import {
  classifyMobileProfileResponse,
  getMobileProfileResponseError,
} from "./profileResponse";
import { clearInvalidMobileSession } from "./sessionInvalidation";

const MOBILE_PROFILE_OVERRIDES_KEY = "flavor_fusion_mobile_profile_overrides_v1";
const MOBILE_PROFILE_OVERRIDES_ACCOUNT_PREFIX = "flavor_fusion_mobile_profile_overrides_v2:";
const EMPTY_PROFILE_OVERRIDES: MobileProfileOverrides = {
  displayName: "",
  photoUri: "",
};

export type MobileProfileOverrides = {
  displayName: string;
  photoUri: string;
};

type ServerProfilePayload = {
  profile?: {
    name?: unknown;
    avatarUrl?: unknown;
  };
  error?: unknown;
  reason?: unknown;
};

type ProfileAccountScope = {
  key: string;
  token: string;
  identity: MobileSessionIdentity;
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

async function getProfileAccountScope(
  expectedIdentity?: MobileSessionIdentity,
): Promise<ProfileAccountScope | null> {
  const authContext = await getMobileAuthRequestContext();
  if (expectedIdentity) {
    assertSameMobileSessionIdentity(expectedIdentity, authContext.identity);
  }
  if (!authContext.session || !isMobileSessionIdentityCurrent(authContext.identity)) {
    return null;
  }
  return {
    key: `${MOBILE_PROFILE_OVERRIDES_ACCOUNT_PREFIX}${authContext.session.userId}`,
    token: authContext.token,
    identity: authContext.identity,
  };
}

async function readMobileProfileOverridesForScope(scope: ProfileAccountScope) {
  try {
    if (!isMobileSessionIdentityCurrent(scope.identity)) {
      return EMPTY_PROFILE_OVERRIDES;
    }

    const raw = await AsyncStorage.getItem(scope.key);
    if (!isMobileSessionIdentityCurrent(scope.identity)) {
      return EMPTY_PROFILE_OVERRIDES;
    }
    await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
    if (!isMobileSessionIdentityCurrent(scope.identity)) {
      return EMPTY_PROFILE_OVERRIDES;
    }
    if (raw) {
      return normalizeProfileOverrides(JSON.parse(raw));
    }

    return selectAccountOwnedValue<MobileProfileOverrides>(null, EMPTY_PROFILE_OVERRIDES);
  } catch {
    return EMPTY_PROFILE_OVERRIDES;
  }
}

async function readProfileResponsePayload(
  response: Response,
  expectedIdentity: MobileSessionIdentity,
): Promise<ServerProfilePayload> {
  let payload: unknown = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  assertMobileSessionIdentityCurrent(expectedIdentity);
  return isObjectRecord(payload) ? (payload as ServerProfilePayload) : {};
}

async function invalidateRejectedProfileSession(
  scope: ProfileAccountScope,
  payload: ServerProfilePayload,
) {
  const didInvalidate = await clearInvalidMobileSession(scope.identity);
  if (!didInvalidate) {
    assertMobileSessionIdentityCurrent(scope.identity);
  }
  await AsyncStorage.removeItem(scope.key).catch(() => {});
  throw new Error(
    getMobileProfileResponseError(
      payload,
      "Your session is no longer active. Sign in again to continue.",
    ),
  );
}

export async function readMobileProfileOverrides() {
  const scope = await getProfileAccountScope();
  return scope
    ? readMobileProfileOverridesForScope(scope)
    : EMPTY_PROFILE_OVERRIDES;
}

async function readServerProfileOverrides(scope: ProfileAccountScope) {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/auth/profile`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${scope.token}`,
      },
    });
  } catch {
    assertMobileSessionIdentityCurrent(scope.identity);
    return null;
  }

  assertMobileSessionIdentityCurrent(scope.identity);
  const payload = await readProfileResponsePayload(response, scope.identity);
  const disposition = classifyMobileProfileResponse(
    "get",
    response.status,
    response.ok,
    payload,
  );
  if (disposition === "invalid_session") {
    await invalidateRejectedProfileSession(scope, payload);
  }
  if (disposition !== "success") {
    return null;
  }

  const profile = payload.profile;
  if (!profile) {
    return null;
  }
  return {
    displayName: typeof profile.name === "string" ? profile.name.trim() : "",
    photoUri: typeof profile.avatarUrl === "string" ? profile.avatarUrl.trim() : "",
  } satisfies MobileProfileOverrides;
}

export async function readMobileProfile() {
  const scope = await getProfileAccountScope();
  if (!scope) {
    return EMPTY_PROFILE_OVERRIDES;
  }
  const [localProfile, serverProfile] = await Promise.all([
    readMobileProfileOverridesForScope(scope),
    readServerProfileOverrides(scope),
  ]);
  if (!isMobileSessionIdentityCurrent(scope.identity)) {
    return EMPTY_PROFILE_OVERRIDES;
  }
  return {
    displayName: localProfile.displayName || serverProfile?.displayName || "",
    photoUri: localProfile.photoUri || serverProfile?.photoUri || "",
  } satisfies MobileProfileOverrides;
}

async function saveMobileProfileOverridesForScope(
  overrides: MobileProfileOverrides,
  scope: ProfileAccountScope,
) {
  const normalized = normalizeProfileOverrides(overrides);
  assertMobileSessionIdentityCurrent(scope.identity);
  await AsyncStorage.setItem(scope.key, JSON.stringify(normalized));
  assertMobileSessionIdentityCurrent(scope.identity);
  return normalized;
}

export async function saveMobileProfileOverrides(
  overrides: MobileProfileOverrides,
  expectedIdentity: MobileSessionIdentity,
) {
  const scope = await getProfileAccountScope(expectedIdentity);
  if (!scope) {
    throw new Error("Sign in to save profile changes.");
  }
  return saveMobileProfileOverridesForScope(overrides, scope);
}

export async function saveMobileProfile(
  overrides: MobileProfileOverrides,
  expectedIdentity: MobileSessionIdentity,
) {
  const scope = await getProfileAccountScope(expectedIdentity);
  const normalized = normalizeProfileOverrides(overrides);
  if (!scope) {
    throw new Error("Sign in to save profile changes.");
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}/api/auth/profile`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${scope.token}`,
      },
      body: JSON.stringify({
        name: normalized.displayName,
        avatarUrl: normalized.photoUri,
      }),
    });
  } catch {
    assertMobileSessionIdentityCurrent(expectedIdentity);
    return saveMobileProfileOverridesForScope(normalized, scope);
  }

  assertMobileSessionIdentityCurrent(expectedIdentity);
  const payload = await readProfileResponsePayload(response, expectedIdentity);
  const disposition = classifyMobileProfileResponse(
    "patch",
    response.status,
    response.ok,
    payload,
  );
  if (disposition === "invalid_session") {
    await invalidateRejectedProfileSession(scope, payload);
  }
  if (disposition !== "success") {
    throw new Error(
      getMobileProfileResponseError(payload, "Could not save profile changes."),
    );
  }

  const serverProfile = payload.profile;
  const nextOverrides = serverProfile
    ? {
        displayName:
          typeof serverProfile.name === "string"
            ? serverProfile.name.trim()
            : normalized.displayName,
        photoUri:
          typeof serverProfile.avatarUrl === "string"
            ? serverProfile.avatarUrl.trim()
            : normalized.photoUri,
      }
    : normalized;
  return saveMobileProfileOverridesForScope(nextOverrides, scope);
}

export async function migrateLegacyProfileOverridesToCurrentAccount() {
  const scope = await getProfileAccountScope();
  await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
  if (!scope || !isMobileSessionIdentityCurrent(scope.identity)) {
    return EMPTY_PROFILE_OVERRIDES;
  }
  const existingRaw = await AsyncStorage.getItem(scope.key);
  if (!isMobileSessionIdentityCurrent(scope.identity)) {
    return EMPTY_PROFILE_OVERRIDES;
  }
  return existingRaw
    ? normalizeProfileOverrides(JSON.parse(existingRaw))
    : EMPTY_PROFILE_OVERRIDES;
}

export async function clearLegacyMobileProfileOverrides() {
  await AsyncStorage.removeItem(MOBILE_PROFILE_OVERRIDES_KEY);
}
