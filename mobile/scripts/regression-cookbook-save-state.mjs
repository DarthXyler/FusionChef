import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createCookbookSaveAttemptController,
  getCookbookSaveButtonState,
  isRecipeConfirmedSaved,
} from "../src/services/cookbookSaveState.ts";

const workspaceSource = readFileSync(
  new URL("../src/screens/RecipeWorkspaceScreen.tsx", import.meta.url),
  "utf8",
);
const cookbookContextSource = readFileSync(
  new URL("../src/context/mobileCookbook.tsx", import.meta.url),
  "utf8",
);

function extractBetween(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  assert.notEqual(startIndex, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(endIndex, -1, `Missing end marker: ${endMarker}`);
  return source.slice(startIndex, endIndex);
}

function getButtonState(recipeId, summaries, isSaving = false) {
  return getCookbookSaveButtonState({
    isSaving,
    isSaved: isRecipeConfirmedSaved(recipeId, summaries),
    isBlocked: false,
  });
}

function verifySuccessfulSave() {
  const controller = createCookbookSaveAttemptController();
  const summaries = [];
  const attempt = controller.begin("recipe-a", 1);

  assert.ok(attempt);
  assert.equal(controller.canConfirm(attempt, "recipe-a", 1), true);
  summaries.push({ recipeId: "recipe-a" });
  assert.equal(controller.finish(attempt), true);
  assert.deepEqual(getButtonState("recipe-a", summaries), {
    disabled: true,
    label: "Saved",
  });
}

function verifyFailedSave() {
  const controller = createCookbookSaveAttemptController();
  const attempt = controller.begin("recipe-a", 1);

  assert.ok(attempt);
  assert.equal(controller.finish(attempt), true);
  assert.deepEqual(getButtonState("recipe-a", []), {
    disabled: false,
    label: "Save",
  });
}

function verifyDuplicateTapIsRejected() {
  const controller = createCookbookSaveAttemptController();
  const firstAttempt = controller.begin("recipe-a", 1);
  const duplicateAttempt = controller.begin("recipe-a", 1);

  assert.ok(firstAttempt);
  assert.equal(duplicateAttempt, null);
  assert.deepEqual(getButtonState("recipe-a", [], true), {
    disabled: true,
    label: "Saving...",
  });
}

function verifyNewRecipeAndRerollReset() {
  const controller = createCookbookSaveAttemptController();
  const oldAttempt = controller.begin("recipe-a", 1);
  const summaries = [{ recipeId: "recipe-a" }];

  assert.ok(oldAttempt);
  assert.equal(controller.canConfirm(oldAttempt, "recipe-b", 1), false);
  controller.reset();
  assert.deepEqual(getButtonState("recipe-b", summaries), {
    disabled: false,
    label: "Save",
  });
  assert.ok(controller.begin("recipe-b", 1));
}

function verifyAccountSwitchRejectsSaveCompletion() {
  const controller = createCookbookSaveAttemptController();
  const accountAAttempt = controller.begin("recipe-a", 4);

  assert.ok(accountAAttempt);
  assert.equal(controller.canConfirm(accountAAttempt, "recipe-a", 5), false);
  controller.reset();
  assert.equal(controller.finish(accountAAttempt), false);
  assert.deepEqual(getButtonState("recipe-a", []), {
    disabled: false,
    label: "Save",
  });
}

function verifyAlreadySavedRecipe() {
  assert.deepEqual(
    getButtonState("recipe-a", [
      { recipeId: "recipe-b" },
      { recipeId: "recipe-a" },
    ]),
    {
      disabled: true,
      label: "Saved",
    },
  );
}

function verifyRecipeWorkspaceProductionWiring() {
  const saveFlowSource = extractBetween(
    workspaceSource,
    "async function handleSaveToCookbook",
    "function handleOpenImageViewer",
  );
  const clearWorkspaceSource = extractBetween(
    workspaceSource,
    "const clearOwnedWorkspace",
    "const getCreditPackOptions",
  );
  const saveButtonSource = extractBetween(
    workspaceSource,
    "onPress={handleSaveToCookbook}",
    "onPress={handleLoadLiveRecipe}",
  );

  assert.match(
    cookbookContextSource,
    /summaries:\s*isStateOwnedByCurrentSession\s*\?\s*cookbookSummaries\s*:\s*\[\]/,
  );
  assert.match(
    workspaceSource,
    /const\s*\{\s*saveRecord,\s*summaries\s*\}\s*=\s*useMobileCookbook\(\)/,
  );
  assert.match(
    workspaceSource,
    /usingLiveRecipe\s*&&\s*isRecipeConfirmedSaved\(\s*activeRecipe\.id,\s*summaries\s*\)/,
  );

  assert.match(
    saveFlowSource,
    /saveAttemptController\.begin\(\s*activeRecord\.recipe\.id,\s*sessionIdentity\.revision,?\s*\)/,
  );
  assert.match(
    saveFlowSource,
    /saveAttemptController\.canConfirm\(\s*saveAttempt,\s*activeRecipeIdRef\.current,\s*sessionRevisionRef\.current,?\s*\)/,
  );
  assert.match(
    saveFlowSource,
    /finally\s*\{\s*if\s*\(\s*saveAttemptController\.finish\(saveAttempt\)\s*\)\s*\{\s*setIsSavingCookbook\(false\)/,
  );
  const saveResponseIndex = saveFlowSource.indexOf(
    "const savedRecord = await saveRecord(recordToSave)",
  );
  const confirmationGuardIndex = saveFlowSource.indexOf(
    "saveAttemptController.canConfirm",
  );
  const successMessageIndex = saveFlowSource.indexOf(
    'Alert.alert("Saved", "Recipe added to your cookbook.")',
  );
  assert.ok(saveResponseIndex >= 0);
  assert.ok(confirmationGuardIndex > saveResponseIndex);
  assert.ok(successMessageIndex > confirmationGuardIndex);

  assert.match(
    workspaceSource,
    /useEffect\(\(\)\s*=>\s*\{\s*saveAttemptController\.reset\(\);\s*setIsSavingCookbook\(false\);\s*\},\s*\[\s*activeRecipe\.id,\s*saveAttemptController,\s*sessionIdentity\.revision\s*\]\s*\)/,
  );
  assert.match(clearWorkspaceSource, /saveAttemptController\.reset\(\)/);
  assert.match(clearWorkspaceSource, /setIsSavingCookbook\(false\)/);

  assert.match(
    workspaceSource,
    /getCookbookSaveButtonState\(\{\s*isSaving:\s*isSavingCookbook,\s*isSaved:\s*isActiveRecipeSaved,\s*isBlocked:\s*isPurchasingCredits/,
  );
  assert.match(saveButtonSource, /disabled=\{saveButtonState\.disabled\}/);
  assert.match(saveButtonSource, /\{saveButtonState\.label\}/);
  assert.doesNotMatch(saveButtonSource, />\s*Save\s*</);
  assert.doesNotMatch(saveButtonSource, /\{\s*"Save"\s*\}/);
}

verifySuccessfulSave();
verifyFailedSave();
verifyDuplicateTapIsRejected();
verifyNewRecipeAndRerollReset();
verifyAccountSwitchRejectsSaveCompletion();
verifyAlreadySavedRecipe();
verifyRecipeWorkspaceProductionWiring();

console.log(
  JSON.stringify({
    ok: true,
    scenarios: [
      "successful_save",
      "failed_save",
      "duplicate_tap",
      "new_recipe_and_reroll_reset",
      "account_switch_during_save",
      "already_saved_recipe",
      "recipe_workspace_production_wiring",
    ],
  }),
);
