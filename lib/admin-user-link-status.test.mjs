import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_ADMIN_USER_LINK_SELECTION,
  buildAdminUsersQuery,
  getAdminUserAccountSetupLabel,
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
  linkSelection: DEFAULT_ADMIN_USER_LINK_SELECTION,
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
      search: "  chef@example.com  ",
      userType: "free_only",
      activityStatus: "active",
      linkSelection: { linked: true, unlinked: false },
    }),
  );
  assert.equal(listQuery.get("limit"), "100");
  assert.equal(listQuery.get("search"), "chef@example.com");
  assert.equal(listQuery.get("userType"), "free_only");
  assert.equal(listQuery.get("activityStatus"), "active");
  assert.equal(listQuery.get("linkStatus"), "linked");

  const exportQuery = new URLSearchParams(
    buildAdminUsersQuery({
      ...baseFilters,
      cursor: "next-page",
      limit: 500,
      userType: "paying",
      activityStatus: "inactive",
      linkSelection: { linked: false, unlinked: true },
    }),
  );
  assert.equal(exportQuery.get("limit"), "500");
  assert.equal(exportQuery.get("cursor"), "next-page");
  assert.equal(exportQuery.get("userType"), "paying");
  assert.equal(exportQuery.get("activityStatus"), "inactive");
  assert.equal(exportQuery.get("linkStatus"), "unlinked");
});

test("row status keeps compatible API values and maps to account setup labels", () => {
  assert.equal(getAdminUserLinkStatus("credit-user-id"), "linked");
  assert.equal(getAdminUserLinkStatus(""), "unlinked");
  assert.equal(getAdminUserLinkStatus("   "), "unlinked");
  assert.equal(getAdminUserAccountSetupLabel("linked"), "Complete");
  assert.equal(getAdminUserAccountSetupLabel("unlinked"), "Needs attention");
});

test("the normal admin UI uses account setup terminology", () => {
  const panelSource = readFileSync(
    new URL("../components/AdminMonetizationConfigPanel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(panelSource, /Technical diagnostics/);
  assert.match(
    panelSource,
    /Shows whether the signed-in account is correctly connected to its app data\./,
  );
  assert.ok((panelSource.match(/Account Setup/g) ?? []).length >= 3);
  assert.doesNotMatch(panelSource, /\bLink Status\b|\bLinked\b|\bUnlinked\b/);
});
