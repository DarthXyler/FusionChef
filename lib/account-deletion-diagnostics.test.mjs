import assert from "node:assert/strict";
import test from "node:test";
import {
  getAccountDeletionStorageApiFailure,
  logUnexpectedAccountDeletionFailure,
} from "./account-deletion-diagnostics.ts";
import {
  AccountDeletionStorageError,
  collectAccountDeletionStorageObjects,
} from "./account-deletion-storage.ts";

const PUBLIC_BASE = "https://cdn.example.test";

function rejectedStorageReference() {
  try {
    collectAccountDeletionStorageObjects({
      graph: {
        storageReferences: [
          {
            category: "cookbook_image",
            value: `${PUBLIC_BASE}/recipe-images/${"a".repeat(60)}.webp`,
          },
        ],
      },
      publicBaseUrl: PUBLIC_BASE,
    });
  } catch (error) {
    return error;
  }
  throw new Error("fixture must reject the storage reference");
}

function rejectedNoncanonicalStorageReference() {
  const reference = `${PUBLIC_BASE}/recipe-images%2Fprivate@example.test`;
  try {
    collectAccountDeletionStorageObjects({
      graph: {
        storageReferences: [{ category: "cookbook_image", value: reference }],
      },
      publicBaseUrl: PUBLIC_BASE,
    });
  } catch (error) {
    return { error, reference };
  }
  throw new Error("fixture must reject the noncanonical storage reference");
}

test("storage classification failures map to a stable typed API response", () => {
  const error = rejectedStorageReference();
  assert.ok(error instanceof AccountDeletionStorageError);
  assert.deepEqual(getAccountDeletionStorageApiFailure(error), {
    statusCode: 409,
    body: {
      error: "An account deletion storage reference requires manual review.",
      code: "storage_reference_sensitive",
    },
  });
  assert.equal(getAccountDeletionStorageApiFailure(new Error("other")), null);
  assert.doesNotMatch(
    JSON.stringify(getAccountDeletionStorageApiFailure(error)),
    /a{20}|cdn\.example|recipe-images/,
  );
});

test("noncanonical storage references map to a safe typed response", () => {
  const { error, reference } = rejectedNoncanonicalStorageReference();
  assert.ok(error instanceof AccountDeletionStorageError);
  assert.deepEqual(getAccountDeletionStorageApiFailure(error), {
    statusCode: 409,
    body: {
      error: "An account deletion storage reference is invalid.",
      code: "storage_reference_invalid",
    },
  });
  const serialized = JSON.stringify(getAccountDeletionStorageApiFailure(error));
  assert.doesNotMatch(serialized, /private@example|recipe-images|cdn\.example|%2F/);
  assert.ok(!serialized.includes(reference));
});

test("unexpected failure diagnostics contain only allowlisted operational fields", () => {
  const sensitiveValues = [
    "private@example.test",
    "recipe-images/private-object.webp",
    "private-reason",
    "private-identity",
    "private-token",
  ];
  const error = new Error(sensitiveValues.join(" "));
  error.code = sensitiveValues.join("-");
  error.url = sensitiveValues[1];
  const output = [];
  const diagnostic = logUnexpectedAccountDeletionFailure({
    requestId: sensitiveValues[3],
    stage: "target_resolution",
    error,
    logger(value) {
      output.push(value);
    },
  });
  assert.deepEqual(diagnostic, {
    event: "account_deletion_failed",
    requestId: "unavailable",
    stage: "target_resolution",
    errorClass: "Error",
    code: "unexpected_account_deletion_failure",
  });
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]), diagnostic);
  for (const sensitiveValue of sensitiveValues) {
    assert.doesNotMatch(output[0], new RegExp(sensitiveValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("unexpected failure diagnostics retain safe request IDs and stable error codes", () => {
  const error = new Error("private details that must never be logged");
  error.code = "SQLITE_BUSY";
  const diagnostic = logUnexpectedAccountDeletionFailure({
    requestId: "11111111-1111-4111-8111-111111111111",
    stage: "preview_persistence",
    error,
    logger() {},
  });
  assert.deepEqual(diagnostic, {
    event: "account_deletion_failed",
    requestId: "11111111-1111-4111-8111-111111111111",
    stage: "preview_persistence",
    errorClass: "Error",
    code: "account_deletion_database_unavailable",
  });
  assert.doesNotThrow(() =>
    logUnexpectedAccountDeletionFailure({
      requestId: "11111111-1111-4111-8111-111111111111",
      stage: "preview_status",
      error,
      logger() {
        throw new Error("diagnostic transport unavailable");
      },
    }),
  );
});
