import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_ADMIN_USER_LINK_SELECTION,
  buildAdminUsersQuery,
  getAdminUserLinkFilter,
  getAdminUserLinkStatus,
  parseAdminUserLinkStatus,
  toggleAdminUserLinkSelection,
} from "./admin-user-link-status.ts";

const baseFilters = {
  search: "",
  role: "all",
  payment: "all",
  cookbook: "all",
  userType: "all",
  activityStatus: "all",
  accountSetup: "all",
  issueReason: "all",
  minCredits: "",
  maxCredits: "",
  lastLoginSince: "",
};

test("the default and omitted API filter select all authenticated users", () => {
  assert.deepEqual(DEFAULT_ADMIN_USER_LINK_SELECTION, {
    linked: true,
    unlinked: true,
  });
  assert.equal(getAdminUserLinkFilter(DEFAULT_ADMIN_USER_LINK_SELECTION), "all");
  assert.equal(parseAdminUserLinkStatus(null), "all");
  assert.equal(parseAdminUserLinkStatus("invalid"), "all");
});

test("linked-only and unlinked-only selections map to their API filters", () => {
  assert.equal(
    getAdminUserLinkFilter({ linked: true, unlinked: false }),
    "linked",
  );
  assert.equal(
    getAdminUserLinkFilter({ linked: false, unlinked: true }),
    "unlinked",
  );
  assert.equal(parseAdminUserLinkStatus("linked"), "linked");
  assert.equal(parseAdminUserLinkStatus("unlinked"), "unlinked");
});

test("toggling never permits both link-status checkboxes to be unchecked", () => {
  const linkedOnly = { linked: true, unlinked: false };
  const unlinkedOnly = { linked: false, unlinked: true };

  assert.strictEqual(
    toggleAdminUserLinkSelection(linkedOnly, "linked"),
    linkedOnly,
  );
  assert.strictEqual(
    toggleAdminUserLinkSelection(unlinkedOnly, "unlinked"),
    unlinkedOnly,
  );
  assert.deepEqual(
    toggleAdminUserLinkSelection(DEFAULT_ADMIN_USER_LINK_SELECTION, "linked"),
    unlinkedOnly,
  );
});

test("list and paginated export queries preserve search, filters, and cursor", () => {
  const listQuery = new URLSearchParams(
    buildAdminUsersQuery({
      ...baseFilters,
      includeSummary: true,
      search: "  chef@example.com  ",
      userType: "free_only",
      activityStatus: "active",
      accountSetup: "needs_attention",
      issueReason: "split_data",
    }),
  );
  assert.equal(listQuery.get("limit"), "100");
  assert.equal(listQuery.get("search"), "chef@example.com");
  assert.equal(listQuery.get("userType"), "free_only");
  assert.equal(listQuery.get("activityStatus"), "active");
  assert.equal(listQuery.get("accountSetup"), "needs_attention");
  assert.equal(listQuery.get("issueReason"), "split_data");
  assert.equal(listQuery.has("linkStatus"), false);
  assert.equal(listQuery.get("includeSummary"), "true");

  const exportQuery = new URLSearchParams(
    buildAdminUsersQuery({
      ...baseFilters,
      cursor: "next-page",
      limit: 500,
      userType: "paying",
      activityStatus: "inactive",
      accountSetup: "complete",
      issueReason: "all",
    }),
  );
  assert.equal(exportQuery.get("limit"), "500");
  assert.equal(exportQuery.get("cursor"), "next-page");
  assert.equal(exportQuery.get("userType"), "paying");
  assert.equal(exportQuery.get("activityStatus"), "inactive");
  assert.equal(exportQuery.get("accountSetup"), "complete");
  assert.equal(exportQuery.get("issueReason"), "all");
  assert.equal(exportQuery.has("includeSummary"), false);
});

test("row status keeps compatible internal API values", () => {
  assert.equal(getAdminUserLinkStatus("credit-user-id"), "linked");
  assert.equal(getAdminUserLinkStatus(""), "unlinked");
  assert.equal(getAdminUserLinkStatus("   "), "unlinked");
});

test("the normal admin UI uses account setup terminology", () => {
  const panelSource = readFileSync(
    new URL("../components/AdminMonetizationConfigPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(panelSource, /Technical diagnostics/);
  assert.match(
    panelSource,
    /Shows whether the signed-in account is safely connected to one consistent set of app data\./,
  );
  assert.ok((panelSource.match(/Account Setup/g) ?? []).length >= 3);
  assert.doesNotMatch(panelSource, /\bLink Status\b|\bLinked\b|\bUnlinked\b/);
  assert.match(panelSource, /Account setup issues/);
  assert.match(panelSource, /Account Setup Issue/);

  const historicalNoticeIndex = panelSource.indexOf(
    "Activity classifications are authoritative",
  );
  const summaryIndex = panelSource.indexOf("Overall user summary");
  const applyFiltersIndex = panelSource.indexOf("Apply Filters");
  assert.ok(historicalNoticeIndex >= 0);
  assert.ok(summaryIndex > historicalNoticeIndex);
  assert.ok(applyFiltersIndex > summaryIndex);
});
