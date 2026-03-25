import AsyncStorage from "@react-native-async-storage/async-storage";

const MOBILE_ANON_ID_KEY = "flavor_fusion_mobile_anon_id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generateUuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = character === "x" ? randomNibble : (randomNibble & 0x3) | 0x8;
    return value.toString(16);
  });
}

export async function getMobileAnonymousId() {
  const existing = (await AsyncStorage.getItem(MOBILE_ANON_ID_KEY))?.trim();
  if (existing && UUID_PATTERN.test(existing)) {
    return existing;
  }

  const nextId = generateUuidV4();
  await AsyncStorage.setItem(MOBILE_ANON_ID_KEY, nextId);
  return nextId;
}
