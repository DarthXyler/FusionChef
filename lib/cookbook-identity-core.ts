export const IDENTITY_UNAVAILABLE_CODE = "identity_unavailable";

export type CookbookIdentity = {
  anonUserId: string;
  shouldSetCookie: boolean;
};

export type IdentityResolutionStage =
  | "base_identity"
  | "schema_readiness"
  | "device_link_lookup"
  | "auth_link_lookup"
  | "alias_resolution"
  | "tombstone_filtering"
  | "ownership_filtering"
  | "canonical_selection"
  | "cookbook_merge"
  | "alias_write"
  | "device_link_write"
  | "auth_link_write"
  | "resolver_boundary";

export class IdentityResolutionError extends Error {
  readonly code = IDENTITY_UNAVAILABLE_CODE;
  readonly stage: IdentityResolutionStage;

  constructor(
    stage: IdentityResolutionStage,
    options?: { cause?: unknown },
  ) {
    super("Identity resolution is temporarily unavailable.", options);
    this.name = "IdentityResolutionError";
    this.stage = stage;
  }
}

export type CookbookIdentityCoreDependencies = {
  getBaseIdentity: () => CookbookIdentity;
  ensureSchema: () => Promise<void>;
  readCanonicalIdForDevice: (deviceKey: string) => Promise<string | null>;
  readCanonicalIdForAuthUser: (authUserId: string) => Promise<string | null>;
  resolveAliasCanonicalId: (anonUserId: string) => Promise<string>;
  filterDeletedIdentityCandidates: (
    candidateIds: string[],
  ) => Promise<string[]>;
  filterCandidatesForAuthUser: (
    candidateIds: string[],
    authUserId: string,
  ) => Promise<string[]>;
  filterCandidatesForSignedOutUser: (candidateIds: string[]) => Promise<string[]>;
  pickCanonicalAnonId: (
    candidateIds: string[],
    preferredId: string | null,
  ) => Promise<string>;
  mergeCookbookAnonymousUsers: (
    sourceAnonUserId: string,
    targetAnonUserId: string,
  ) => Promise<void>;
  upsertAliasForAnonId: (
    anonUserId: string,
    canonicalAnonUserId: string,
  ) => Promise<void>;
  upsertCanonicalIdForDevice: (
    deviceKey: string,
    canonicalAnonUserId: string,
  ) => Promise<void>;
  upsertCanonicalIdForAuthUser: (
    authUserId: string,
    canonicalAnonUserId: string,
  ) => Promise<void>;
  createAnonymousId: () => string;
};

type ResolveCookbookIdentityCoreParams = {
  authUserId: string | null;
  deviceKey: string | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function uniqueValidIds(ids: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (isValidUuid(id)) {
      seen.add(id.trim());
    }
  }
  return [...seen];
}

async function runIdentityStage<T>(
  stage: IdentityResolutionStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IdentityResolutionError) {
      throw error;
    }
    throw new IdentityResolutionError(stage, { cause: error });
  }
}

export function asIdentityResolutionError(
  error: unknown,
  fallbackStage: IdentityResolutionStage = "resolver_boundary",
) {
  return error instanceof IdentityResolutionError
    ? error
    : new IdentityResolutionError(fallbackStage, { cause: error });
}

export function createRetryableIdentityInitializer(
  initialize: () => Promise<void>,
) {
  let readyPromise: Promise<void> | null = null;

  return async function ensureReady() {
    if (!readyPromise) {
      readyPromise = Promise.resolve().then(initialize);
    }
    const attempt = readyPromise;
    try {
      await attempt;
    } catch (error) {
      if (readyPromise === attempt) {
        readyPromise = null;
      }
      throw error;
    }
  };
}

export async function resolveCookbookIdentityCore(
  params: ResolveCookbookIdentityCoreParams,
  dependencies: CookbookIdentityCoreDependencies,
): Promise<CookbookIdentity> {
  const baseIdentity = await runIdentityStage(
    "base_identity",
    dependencies.getBaseIdentity,
  );
  const authUserId = params.authUserId?.trim() ?? "";
  if (params.authUserId !== null && !authUserId) {
    throw new IdentityResolutionError("auth_link_lookup");
  }
  await runIdentityStage("schema_readiness", dependencies.ensureSchema);
  const deviceCanonical = params.deviceKey
    ? await runIdentityStage("device_link_lookup", () =>
        dependencies.readCanonicalIdForDevice(params.deviceKey!),
      )
    : null;
  const authCanonical = authUserId
    ? await runIdentityStage("auth_link_lookup", () =>
        dependencies.readCanonicalIdForAuthUser(authUserId),
      )
    : null;
  const aliasCanonical = await runIdentityStage("alias_resolution", () =>
    dependencies.resolveAliasCanonicalId(baseIdentity.anonUserId),
  );
  const rawCandidateIds = uniqueValidIds([
    deviceCanonical,
    authCanonical,
    aliasCanonical,
    baseIdentity.anonUserId,
  ]);
  const nonDeletedCandidateIds = await runIdentityStage(
    "tombstone_filtering",
    () => dependencies.filterDeletedIdentityCandidates(rawCandidateIds),
  );
  const candidateIds = await runIdentityStage("ownership_filtering", () =>
    authUserId
      ? dependencies.filterCandidatesForAuthUser(nonDeletedCandidateIds, authUserId)
      : dependencies.filterCandidatesForSignedOutUser(nonDeletedCandidateIds),
  );
  const safeAuthCanonical =
    authCanonical && nonDeletedCandidateIds.includes(authCanonical)
      ? authCanonical
      : null;
  const safeCandidateIds =
    candidateIds.length > 0
      ? candidateIds
      : uniqueValidIds([safeAuthCanonical, dependencies.createAnonymousId()]);
  if (safeCandidateIds.length < 1) {
    throw new IdentityResolutionError("canonical_selection");
  }
  const canonicalAnonUserId = safeAuthCanonical
    ? safeAuthCanonical
    : await runIdentityStage("canonical_selection", () =>
        dependencies.pickCanonicalAnonId(safeCandidateIds, deviceCanonical),
      );

  for (const candidateId of safeCandidateIds) {
    if (candidateId === canonicalAnonUserId) {
      continue;
    }
    await runIdentityStage("cookbook_merge", () =>
      dependencies.mergeCookbookAnonymousUsers(
        candidateId,
        canonicalAnonUserId,
      ),
    );
    await runIdentityStage("alias_write", () =>
      dependencies.upsertAliasForAnonId(candidateId, canonicalAnonUserId),
    );
  }

  await runIdentityStage("alias_write", () =>
    dependencies.upsertAliasForAnonId(
      canonicalAnonUserId,
      canonicalAnonUserId,
    ),
  );
  if (params.deviceKey) {
    await runIdentityStage("device_link_write", () =>
      dependencies.upsertCanonicalIdForDevice(
        params.deviceKey!,
        canonicalAnonUserId,
      ),
    );
  }
  if (authUserId) {
    await runIdentityStage("auth_link_write", () =>
      dependencies.upsertCanonicalIdForAuthUser(
        authUserId,
        canonicalAnonUserId,
      ),
    );
  }

  return {
    anonUserId: canonicalAnonUserId,
    shouldSetCookie:
      baseIdentity.shouldSetCookie ||
      !nonDeletedCandidateIds.includes(baseIdentity.anonUserId),
  };
}

export function buildIdentityUnavailableResponse() {
  const response = Response.json(
    {
      error: "Identity is temporarily unavailable. Please retry.",
      code: IDENTITY_UNAVAILABLE_CODE,
    },
    { status: 503 },
  );
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Retry-After", "1");
  return response;
}

export async function failClosedIdentityResolution(
  resolve: () => Promise<CookbookIdentity>,
) {
  try {
    return {
      ok: true as const,
      identity: await resolve(),
    };
  } catch {
    return {
      ok: false as const,
      response: buildIdentityUnavailableResponse(),
    };
  }
}
