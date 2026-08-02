import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyMobileProfileResponse,
  getMobileProfileResponseError,
} from "../src/services/profileResponse.ts";

const profileSource = readFileSync(
  new URL("../src/services/profile.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const profileScreenSource = readFileSync(
  new URL("../src/screens/ProfileScreen.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function verifyResponseClassification() {
  for (const operation of ["get", "patch"]) {
    for (const reason of ["auth_invalid", "account_deleted"]) {
      assert.equal(
        classifyMobileProfileResponse(operation, 401, false, { reason }),
        "invalid_session",
      );
    }
  }

  assert.equal(
    classifyMobileProfileResponse("get", 500, false, { error: "Unavailable" }),
    "fallback",
  );
  assert.equal(
    classifyMobileProfileResponse("patch", 500, false, { error: "Unavailable" }),
    "error",
  );
  assert.equal(classifyMobileProfileResponse("get", 200, true, { profile: {} }), "success");
  assert.equal(classifyMobileProfileResponse("patch", 200, true, { profile: {} }), "success");
  assert.equal(
    getMobileProfileResponseError({ error: "Session expired." }, "Fallback"),
    "Session expired.",
  );
}

function verifyProductionWiring() {
  assert.match(
    profileSource,
    /const payload = await readProfileResponsePayload\(response,\s*scope\.identity\)/,
  );
  assert.match(
    profileSource,
    /classifyMobileProfileResponse\(\s*"get",\s*response\.status,\s*response\.ok,\s*payload/,
  );
  assert.match(
    profileSource,
    /classifyMobileProfileResponse\(\s*"patch",\s*response\.status,\s*response\.ok,\s*payload/,
  );
  assert.match(
    profileSource,
    /if \(disposition === "invalid_session"\) \{\s*await invalidateRejectedProfileSession\(scope, payload\)/,
  );
  assert.match(
    profileSource,
    /const didInvalidate = await clearInvalidMobileSession\(scope\.identity\)/,
  );
  assert.match(profileSource, /await AsyncStorage\.removeItem\(scope\.key\)\.catch/);
  assert.match(
    profileSource,
    /if \(disposition !== "success"\) \{\s*throw new Error\(/,
  );
  assert.doesNotMatch(
    profileSource,
    /if \(!response\.ok\) \{\s*return normalized/,
  );

  const fetchCatchIndex = profileSource.indexOf(
    "return saveMobileProfileOverridesForScope(normalized, scope);",
  );
  const patchDispositionIndex = profileSource.indexOf(
    'classifyMobileProfileResponse(\n    "patch"',
  );
  const confirmedSaveIndex = profileSource.lastIndexOf(
    "return saveMobileProfileOverridesForScope(nextOverrides, scope);",
  );
  assert.ok(fetchCatchIndex >= 0);
  assert.ok(patchDispositionIndex > fetchCatchIndex);
  assert.ok(confirmedSaveIndex > patchDispositionIndex);

  assert.match(
    profileScreenSource,
    /finally\s*\{\s*if \(isMobileSessionIdentityCurrent\(expectedIdentity\)\) \{\s*setIsLoading\(false\)/,
  );
  assert.match(
    profileScreenSource,
    /finally\s*\{\s*if \(isMobileSessionIdentityCurrent\(expectedIdentity\)\) \{\s*setIsSavingProfile\(false\)/,
  );
  assert.match(
    profileScreenSource,
    /setIsSavingProfile\(false\);[\s\S]*void loadProfile\(\)\.catch/,
  );
}

verifyResponseClassification();
verifyProductionWiring();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "get_auth_invalid",
      "get_account_deleted",
      "patch_auth_invalid_rejected",
      "patch_account_deleted_rejected",
      "stale_session_invalidation_scoped",
      "successful_get_and_patch",
      "network_and_server_failure_distinguished",
      "loading_and_saving_state_clear",
      "production_profile_wiring",
    ],
  }),
);
