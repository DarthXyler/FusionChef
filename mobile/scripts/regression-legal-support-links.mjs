import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MOBILE_LINKS } from "../src/config/links.ts";

const EXPECTED_MOBILE_LINKS = {
  privacy: "https://www.flavorfusionchef.com/privacy",
  faq: "https://www.flavorfusionchef.com/faq",
  terms: "https://www.flavorfusionchef.com/terms",
  refundPolicy: "https://www.flavorfusionchef.com/refund-policy",
  support: "https://www.flavorfusionchef.com/support",
  purchaseSupport: "https://www.flavorfusionchef.com/support?topic=purchase",
  deleteAccountSupport:
    "https://www.flavorfusionchef.com/support?topic=delete-account",
};
const homeScreenSource = readFileSync(
  new URL("../src/screens/HomeScreen.tsx", import.meta.url),
  "utf8",
);
const profileScreenSource = readFileSync(
  new URL("../src/screens/ProfileScreen.tsx", import.meta.url),
  "utf8",
);
const linksConfigSource = readFileSync(
  new URL("../src/config/links.ts", import.meta.url),
  "utf8",
);
const hardCodedLegalUrlPattern =
  /https?:\/\/(?:www\.)?flavorfusionchef\.com\/(?:privacy|faq|terms|refund-policy|support)/i;

function collectMobileLinkKeys(source) {
  return [...source.matchAll(/MOBILE_LINKS\.([A-Za-z]+)/g)]
    .map((match) => match[1])
    .sort();
}

assert.deepEqual(MOBILE_LINKS, EXPECTED_MOBILE_LINKS);
assert.equal(MOBILE_LINKS.privacy, EXPECTED_MOBILE_LINKS.privacy);
assert.equal(MOBILE_LINKS.faq, EXPECTED_MOBILE_LINKS.faq);
assert.notEqual(MOBILE_LINKS.privacy, MOBILE_LINKS.faq);

assert.match(
  homeScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*void\s+openCreditGateLink\(\s*MOBILE_LINKS\.privacy\s*,\s*"Privacy Policy"\s*\)\s*\}/,
);
assert.match(
  homeScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*void\s+openCreditGateLink\(\s*MOBILE_LINKS\.support\s*,\s*"Support"\s*\)\s*\}/,
);
assert.deepEqual(collectMobileLinkKeys(homeScreenSource), [
  "privacy",
  "support",
]);

assert.match(
  profileScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*openLink\(\s*MOBILE_LINKS\.privacy\s*,\s*"privacy policy"\s*\)\s*\}/,
);
assert.match(
  profileScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*openLink\(\s*MOBILE_LINKS\.faq\s*,\s*"FAQ"\s*\)\s*\}/,
);
assert.match(
  profileScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*openLink\(\s*MOBILE_LINKS\.terms\s*,\s*"terms"\s*\)\s*\}/,
);
assert.match(
  profileScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*openLink\(\s*MOBILE_LINKS\.refundPolicy\s*,\s*"refund policy"\s*\)\s*\}/,
);
assert.match(
  profileScreenSource,
  /onPress=\{\s*\(\)\s*=>\s*openLink\(\s*MOBILE_LINKS\.support\s*,\s*"support"\s*\)\s*\}/,
);
assert.match(
  profileScreenSource,
  /onPress:\s*\(\)\s*=>\s*\{\s*void\s+openLink\(\s*MOBILE_LINKS\.purchaseSupport\s*,\s*"purchase support"\s*\);\s*\}/,
);
assert.match(
  profileScreenSource,
  /onPress:\s*\(\)\s*=>\s*\{\s*void\s+openLink\(\s*MOBILE_LINKS\.deleteAccountSupport\s*,\s*"delete account support"\s*\);\s*\}/,
);
assert.deepEqual(collectMobileLinkKeys(profileScreenSource), [
  "deleteAccountSupport",
  "faq",
  "privacy",
  "purchaseSupport",
  "refundPolicy",
  "support",
  "terms",
]);

assert.doesNotMatch(homeScreenSource, hardCodedLegalUrlPattern);
assert.doesNotMatch(profileScreenSource, hardCodedLegalUrlPattern);
assert.doesNotMatch(linksConfigSource, /\bPlatform(?:\.OS)?\b/);
assert.doesNotMatch(linksConfigSource, /\b(?:android|ios)\b/i);

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "canonical_mobile_link_map",
      "home_privacy_and_support_wiring",
      "profile_legal_and_support_wiring",
      "privacy_and_faq_cannot_be_swapped",
      "screens_contain_no_hard_coded_legal_urls",
      "shared_links_have_no_platform_substitution",
    ],
  }),
);
