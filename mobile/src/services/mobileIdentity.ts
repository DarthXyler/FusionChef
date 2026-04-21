import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

const MOBILE_ANON_ID_KEY = "flavor_fusion_mobile_anon_id";
const MOBILE_ANON_ID_BACKUP_KEY = "flavor_fusion_mobile_anon_id_backup";
const MOBILE_ANON_ID_SECURE_KEY = "flavor_fusion_mobile_anon_id_secure";
const COOKBOOK_SUMMARY_CACHE_PREFIX = "flavor_fusion_mobile_cookbook_summaries_v1:";
const COOKBOOK_DETAIL_CACHE_PREFIX = "flavor_fusion_mobile_cookbook_detail_v1:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_IN_KEY_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

let resolvedMobileAnonymousId: string | null = null;
let resolvingMobileAnonymousId: Promise<string> | null = null;

function generateUuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = character === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });
}

function isValidAnonymousId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

async function readSecureAnonymousId() {
  try {
    return (await SecureStore.getItemAsync(MOBILE_ANON_ID_SECURE_KEY))?.trim() ?? null;
  } catch {
    return null;
  }
}

async function writeSecureAnonymousId(id: string) {
  try {
    await SecureStore.setItemAsync(MOBILE_ANON_ID_SECURE_KEY, id);
  } catch {
    // AsyncStorage remains primary fallback if SecureStore is unavailable.
  }
}

async function persistAnonymousId(id: string) {
  await AsyncStorage.multiSet([
    [MOBILE_ANON_ID_KEY, id],
    [MOBILE_ANON_ID_BACKUP_KEY, id],
  ]);
  await writeSecureAnonymousId(id);
}

async function recoverIdFromCookbookCacheKeys() {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const candidateIds = new Set<string>();

    for (const key of allKeys) {
      if (
        !key.startsWith(COOKBOOK_SUMMARY_CACHE_PREFIX) &&
        !key.startsWith(COOKBOOK_DETAIL_CACHE_PREFIX)
      ) {
        continue;
      }

      const match = key.match(UUID_IN_KEY_PATTERN);
      const possibleId = match?.[1]?.trim();
      if (isValidAnonymousId(possibleId)) {
        candidateIds.add(possibleId);
      }
    }

    if (candidateIds.size === 0) {
      return null;
    }

    // If multiple IDs are present, keep the most recently used summary cache.
    const ranked = await Promise.all(
      [...candidateIds].map(async (id) => {
        const summaryKey = `${COOKBOOK_SUMMARY_CACHE_PREFIX}${id}`;
        const summaryRaw = await AsyncStorage.getItem(summaryKey);
        let fetchedAt = 0;
        if (summaryRaw) {
          try {
            const parsed = JSON.parse(summaryRaw) as { fetchedAt?: unknown };
            if (typeof parsed.fetchedAt === "string") {
              fetchedAt = Date.parse(parsed.fetchedAt);
            }
          } catch {
            fetchedAt = 0;
          }
        }

        return { id, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
      }),
    );

    ranked.sort((left, right) => right.fetchedAt - left.fetchedAt);
    return ranked[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function resolveMobileAnonymousId() {
  const storedPrimary = (await AsyncStorage.getItem(MOBILE_ANON_ID_KEY))?.trim();
  if (isValidAnonymousId(storedPrimary)) {
    await persistAnonymousId(storedPrimary);
    return storedPrimary;
  }

  const storedBackup = (await AsyncStorage.getItem(MOBILE_ANON_ID_BACKUP_KEY))?.trim();
  if (isValidAnonymousId(storedBackup)) {
    await persistAnonymousId(storedBackup);
    return storedBackup;
  }

  const secureStored = await readSecureAnonymousId();
  if (isValidAnonymousId(secureStored)) {
    await persistAnonymousId(secureStored);
    return secureStored;
  }

  const recoveredFromCache = await recoverIdFromCookbookCacheKeys();
  if (isValidAnonymousId(recoveredFromCache)) {
    await persistAnonymousId(recoveredFromCache);
    return recoveredFromCache;
  }

  const nextId = generateUuidV4();
  await persistAnonymousId(nextId);
  return nextId;
}

export async function getMobileAnonymousId() {
  if (resolvedMobileAnonymousId) {
    return resolvedMobileAnonymousId;
  }

  if (!resolvingMobileAnonymousId) {
    resolvingMobileAnonymousId = resolveMobileAnonymousId()
      .then((id) => {
        resolvedMobileAnonymousId = id;
        return id;
      })
      .finally(() => {
        resolvingMobileAnonymousId = null;
      });
  }

  return resolvingMobileAnonymousId;
}
