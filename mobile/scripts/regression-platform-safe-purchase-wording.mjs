import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const monetizationSource = readFileSync(
  new URL("../src/services/monetization.ts", import.meta.url),
  "utf8",
);
const homeScreenSource = readFileSync(
  new URL("../src/screens/HomeScreen.tsx", import.meta.url),
  "utf8",
);
const profileScreenSource = readFileSync(
  new URL("../src/screens/ProfileScreen.tsx", import.meta.url),
  "utf8",
);
const recipeWorkspaceSource = readFileSync(
  new URL("../src/screens/RecipeWorkspaceScreen.tsx", import.meta.url),
  "utf8",
);
const forbiddenAndroidWording = /\b(?:Apple|App Store|iOS|iPhone)\b/i;

function extractBetween(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  assert.notEqual(startIndex, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(endIndex, -1, `Missing end marker: ${endMarker}`);
  return source.slice(startIndex, endIndex);
}

function assertPlatformSafeAndroidBlock(name, source) {
  assert.doesNotMatch(source, forbiddenAndroidWording, `${name} contains Apple-only wording`);
}

assert.match(
  monetizationSource,
  /"In-app purchases are unavailable in this build\. Update the app and try again\."/,
);
assert.match(
  monetizationSource,
  /"This purchase method is unavailable on this device\."/,
);
assert.doesNotMatch(
  monetizationSource,
  /Install the latest iOS development build|currently enabled for iOS only/,
);
assert.match(
  profileScreenSource,
  /Alert\.alert\(\s*"Purchase support",\s*"Consumable credit packs are verified/,
);
assert.doesNotMatch(profileScreenSource, /Alert\.alert\(\s*"Restore purchases"/);

assertPlatformSafeAndroidBlock(
  "Google verification",
  extractBetween(
    monetizationSource,
    "async function verifyGooglePurchase",
    "async function ensureIapConnected",
  ),
);
assertPlatformSafeAndroidBlock(
  "Google connection",
  extractBetween(
    monetizationSource,
    "async function ensureGoogleIapConnected",
    "async function waitForApplePurchase",
  ),
);
assertPlatformSafeAndroidBlock(
  "Google purchase listener",
  extractBetween(
    monetizationSource,
    "function waitForGooglePurchase",
    "export async function purchaseGoogleCredits",
  ),
);
assertPlatformSafeAndroidBlock(
  "Google purchase",
  extractBetween(
    monetizationSource,
    "export async function purchaseGoogleCredits",
    "export async function purchaseCreditsForPlatform",
  ),
);
assertPlatformSafeAndroidBlock(
  "platform purchase wrapper Android branch",
  extractBetween(
    monetizationSource,
    'if (Platform.OS === "android") {',
    "return purchaseAppleCredits",
  ),
);
assertPlatformSafeAndroidBlock(
  "Home purchase handler",
  extractBetween(
    homeScreenSource,
    "async function handleCreditGateContinue",
    "async function handleCreditGateGoogleLogin",
  ),
);
assertPlatformSafeAndroidBlock(
  "Profile purchase handler",
  extractBetween(
    profileScreenSource,
    "const handlePurchaseSelectedPack",
    "const handleSignOut",
  ),
);
assertPlatformSafeAndroidBlock(
  "Recipe Workspace purchase handler",
  extractBetween(
    recipeWorkspaceSource,
    "const handleCreditRecoveryPurchase",
    "const handleBackToEdit",
  ),
);

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "platform_neutral_purchase_fallbacks",
      "purchase_support_alert_title",
      "android_verification_wording",
      "android_purchase_service_wording",
      "shared_purchase_caller_wording",
    ],
  }),
);
