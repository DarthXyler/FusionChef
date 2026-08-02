import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  IdentityResolutionError,
  buildIdentityUnavailableResponse,
  createRetryableIdentityInitializer,
  failClosedIdentityResolution,
  resolveCookbookIdentityCore,
} from "./cookbook-identity-core.ts";

const BASE_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const AUTH_CANONICAL_ID = "33333333-3333-4333-8333-333333333333";
const NEW_ID = "44444444-4444-4444-8444-444444444444";
const AUTH_USER_ID = "auth-user-1";
const DEVICE_KEY = "55555555-5555-4555-8555-555555555555";

function createDependencies(overrides = {}) {
  return {
    getBaseIdentity: () => ({
      anonUserId: BASE_ID,
      shouldSetCookie: false,
    }),
    ensureSchema: async () => {},
    readCanonicalIdForDevice: async () => DEVICE_ID,
    readCanonicalIdForAuthUser: async () => AUTH_CANONICAL_ID,
    resolveAliasCanonicalId: async (anonUserId) => anonUserId,
    filterDeletedIdentityCandidates: async (candidateIds) => candidateIds,
    filterCandidatesForAuthUser: async (candidateIds) => candidateIds,
    filterCandidatesForSignedOutUser: async (candidateIds) => candidateIds,
    pickCanonicalAnonId: async (candidateIds) => candidateIds[0],
    mergeCookbookAnonymousUsers: async () => {},
    upsertAliasForAnonId: async () => {},
    upsertCanonicalIdForDevice: async () => {},
    upsertCanonicalIdForAuthUser: async () => {},
    createAnonymousId: () => NEW_ID,
    ...overrides,
  };
}

async function assertStageFailure(stage, overrides, params = {}) {
  await assert.rejects(
    resolveCookbookIdentityCore(
      {
        authUserId: AUTH_USER_ID,
        deviceKey: DEVICE_KEY,
        ...params,
      },
      createDependencies(overrides),
    ),
    (error) => {
      assert.ok(error instanceof IdentityResolutionError);
      assert.equal(error.code, "identity_unavailable");
      assert.equal(error.stage, stage);
      return true;
    },
  );
}

test("authenticated resolution succeeds with the verified auth-user context", async () => {
  const authWrites = [];
  const identity = await resolveCookbookIdentityCore(
    {
      authUserId: AUTH_USER_ID,
      deviceKey: DEVICE_KEY,
    },
    createDependencies({
      upsertCanonicalIdForAuthUser: async (...args) => {
        authWrites.push(args);
      },
    }),
  );

  assert.deepEqual(identity, {
    anonUserId: AUTH_CANONICAL_ID,
    shouldSetCookie: false,
  });
  assert.deepEqual(authWrites, [[AUTH_USER_ID, AUTH_CANONICAL_ID]]);
});

test("normal guest resolution succeeds without authentication", async () => {
  let schemaAttempts = 0;
  const identity = await resolveCookbookIdentityCore(
    {
      authUserId: null,
      deviceKey: null,
    },
    createDependencies({
      ensureSchema: async () => {
        schemaAttempts += 1;
      },
    }),
  );

  assert.deepEqual(identity, {
    anonUserId: BASE_ID,
    shouldSetCookie: false,
  });
  assert.equal(schemaAttempts, 1);

  const deviceGuestIdentity = await resolveCookbookIdentityCore(
    {
      authUserId: null,
      deviceKey: DEVICE_KEY,
    },
    createDependencies(),
  );
  assert.equal(deviceGuestIdentity.anonUserId, DEVICE_ID);
});

test("identity faults never return the raw authenticated request identity", async () => {
  await assertStageFailure("schema_readiness", {
    ensureSchema: async () => {
      throw new Error("schema unavailable");
    },
  });
  await assertStageFailure("device_link_lookup", {
    readCanonicalIdForDevice: async () => {
      throw new Error("device lookup unavailable");
    },
  });
  await assertStageFailure("auth_link_lookup", {
    readCanonicalIdForAuthUser: async () => {
      throw new Error("auth lookup unavailable");
    },
  });
  await assertStageFailure("alias_resolution", {
    resolveAliasCanonicalId: async () => {
      throw new Error("alias unavailable");
    },
  });
  await assertStageFailure("tombstone_filtering", {
    filterDeletedIdentityCandidates: async () => {
      throw new Error("tombstone schema unavailable");
    },
  });
  await assertStageFailure("ownership_filtering", {
    filterCandidatesForAuthUser: async () => {
      throw new Error("ownership unavailable");
    },
  });
  await assertStageFailure("cookbook_merge", {
    mergeCookbookAnonymousUsers: async () => {
      throw new Error("merge unavailable");
    },
  });
  await assertStageFailure(
    "auth_link_write",
    {
      getBaseIdentity: () => ({
        anonUserId: AUTH_CANONICAL_ID,
        shouldSetCookie: false,
      }),
      readCanonicalIdForAuthUser: async () => AUTH_CANONICAL_ID,
      resolveAliasCanonicalId: async () => AUTH_CANONICAL_ID,
      upsertCanonicalIdForAuthUser: async () => {
        throw new Error("auth write unavailable");
      },
    },
    { deviceKey: null },
  );
});

test("guest resolver failures also fail closed", async () => {
  await assert.rejects(
    resolveCookbookIdentityCore(
      {
        authUserId: null,
        deviceKey: null,
      },
      createDependencies({
        getBaseIdentity: () => {
          throw new Error("guest identity unavailable");
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof IdentityResolutionError);
      assert.equal(error.stage, "base_identity");
      return true;
    },
  );

  await assert.rejects(
    resolveCookbookIdentityCore(
      {
        authUserId: null,
        deviceKey: DEVICE_KEY,
      },
      createDependencies({
        filterCandidatesForSignedOutUser: async () => {
          throw new Error("guest ownership unavailable");
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof IdentityResolutionError);
      assert.equal(error.stage, "ownership_filtering");
      return true;
    },
  );
});

test("a rejected schema initializer is cleared so the next request can retry", async () => {
  let attempts = 0;
  const ensureReady = createRetryableIdentityInitializer(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("temporary schema failure");
    }
  });

  await assert.rejects(ensureReady(), /temporary schema failure/);
  await ensureReady();
  await ensureReady();
  assert.equal(attempts, 2);
});

test("identity failure response is stable, retryable, and contains no identity update", async () => {
  const directResponse = buildIdentityUnavailableResponse();
  assert.equal(directResponse.status, 503);
  assert.equal(directResponse.headers.get("cache-control"), "no-store");
  assert.equal(directResponse.headers.get("retry-after"), "1");
  assert.equal(directResponse.headers.get("x-flavor-fusion-anon-id"), null);
  assert.equal(directResponse.headers.get("set-cookie"), null);
  assert.deepEqual(await directResponse.json(), {
    error: "Identity is temporarily unavailable. Please retry.",
    code: "identity_unavailable",
  });

  const routeOperations = [
    "fuse POST",
    "cookbook GET",
    "cookbook POST",
    "cookbook detail GET",
    "cookbook detail DELETE",
    "cookbook detail PATCH",
    "monetization account GET",
    "purchase verification POST",
  ];
  for (const route of routeOperations) {
    const counters = {
      cookbook: 0,
      credits: 0,
      usage: 0,
      purchaseSettlement: 0,
    };
    const resolution = await failClosedIdentityResolution(async () => {
      throw new IdentityResolutionError("ownership_filtering");
    });
    if (resolution.ok) {
      counters.cookbook += 1;
      counters.credits += 1;
      counters.usage += 1;
      counters.purchaseSettlement += 1;
    }
    assert.equal(resolution.ok, false, route);
    assert.deepEqual(counters, {
      cookbook: 0,
      credits: 0,
      usage: 0,
      purchaseSettlement: 0,
    });
    assert.equal(resolution.response.status, 503);
    assert.equal(resolution.response.headers.get("x-flavor-fusion-anon-id"), null);
    assert.equal(resolution.response.headers.get("set-cookie"), null);
  }
});

test("invalid or expired authentication keeps the existing 401 response", () => {
  const source = readFileSync(new URL("./auth-api.ts", import.meta.url), "utf8");
  const invalidResponseStart = source.indexOf(
    'error: "Your sign-in session has expired. Please sign in again."',
  );
  const invalidResponseEnd = source.indexOf(");", invalidResponseStart);
  const invalidResponseSource = source.slice(
    invalidResponseStart,
    invalidResponseEnd,
  );
  assert.ok(invalidResponseStart >= 0);
  assert.match(invalidResponseSource, /reason: "auth_invalid"/);
  assert.match(invalidResponseSource, /status: 401/);
});

function readRoute(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function getHandler(source, method) {
  const marker = `export async function ${method}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${method} handler is present`);
  const next = source.indexOf("\nexport async function ", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

test("every affected handler returns the shared identity guard before product operations", () => {
  const routeCases = [
    {
      path: "app/api/fuse/route.ts",
      handlers: [{ method: "POST", firstProductOperation: "preflightFuseMonetization(" }],
    },
    {
      path: "app/api/cookbook/route.ts",
      handlers: [
        { method: "GET", firstProductOperation: "listCookbookRecipeSummaries(" },
        { method: "POST", firstProductOperation: "beginIdempotentRequest(" },
      ],
    },
    {
      path: "app/api/cookbook/[id]/route.ts",
      handlers: [
        { method: "GET", firstProductOperation: "getCookbookRecord(" },
        { method: "DELETE", firstProductOperation: "deleteCookbookRecordAndReturnImageUrl(" },
        { method: "PATCH", firstProductOperation: "updateCookbookRecipeFlags(" },
      ],
    },
    {
      path: "app/api/monetization/account/route.ts",
      handlers: [{ method: "GET", firstProductOperation: "getCreditBalance(" }],
    },
    {
      path: "app/api/monetization/purchases/verify/route.ts",
      handlers: [{ method: "POST", firstProductOperation: "beginIdempotentRequest(" }],
    },
  ];

  for (const routeCase of routeCases) {
    const source = readRoute(routeCase.path);
    assert.doesNotMatch(source, /await resolveCookbookIdentity\(/);
    for (const handlerCase of routeCase.handlers) {
      const handler = getHandler(source, handlerCase.method);
      const authValidationIndex = handler.indexOf(
        "getActiveAuthSessionFromRequest(request)",
      );
      const identityIndex = handler.indexOf(
        "await resolveCookbookIdentityForProductRequest",
      );
      const inactiveAuthIndex = handler.indexOf("buildInactiveAuthResponse");
      const failClosedReturnIndex = handler.indexOf(
        "return identityResolution.response",
      );
      const productOperationIndex = handler.indexOf(
        handlerCase.firstProductOperation,
      );
      assert.ok(authValidationIndex >= 0, `${routeCase.path} ${handlerCase.method}`);
      assert.ok(inactiveAuthIndex > authValidationIndex, `${routeCase.path} ${handlerCase.method}`);
      assert.ok(identityIndex > authValidationIndex, `${routeCase.path} ${handlerCase.method}`);
      const identityCallSource = handler.slice(identityIndex, failClosedReturnIndex);
      assert.match(identityCallSource, /authUserId:/, `${routeCase.path} ${handlerCase.method}`);
      assert.match(identityCallSource, /requestId/, `${routeCase.path} ${handlerCase.method}`);
      assert.ok(failClosedReturnIndex > identityIndex, `${routeCase.path} ${handlerCase.method}`);
      assert.ok(
        productOperationIndex > failClosedReturnIndex,
        `${routeCase.path} ${handlerCase.method}`,
      );
    }
  }
});

test("resolver failure logs only stage, request id, and error name", () => {
  const source = readFileSync(
    new URL("./cookbook-identity.ts", import.meta.url),
    "utf8",
  );
  const loggerStart = source.indexOf("function logIdentityResolutionFailure");
  const resolverStart = source.indexOf("export async function resolveCookbookIdentity", loggerStart);
  const loggerSource = source.slice(loggerStart, resolverStart);
  assert.match(loggerSource, /stage: error\.stage/);
  assert.match(loggerSource, /requestId: safeRequestId/);
  assert.match(loggerSource, /errorName:/);
  assert.doesNotMatch(
    loggerSource,
    /token|receipt|email|cookbook contents|anonUserId|authUserId/i,
  );
});
