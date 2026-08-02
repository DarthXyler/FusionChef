const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AdminUserResolutionRecord = {
  authUserId: string;
  normalizedEmail: string;
  canonicalAnonUserId: string;
};

export type AdminUserResolutionTarget<TUser extends AdminUserResolutionRecord> = {
  input: string;
  status:
    | "ready"
    | "missing"
    | "ambiguous"
    | "duplicate_input"
    | "duplicate_target";
  message: string;
  user: TUser | null;
};

type ResolutionColumn = "normalized_email" | "id" | "canonical";

function normalizeIdentifier(value: string) {
  const trimmed = value.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}

export async function resolveAdminUserIdentifierTargets<
  TUser extends AdminUserResolutionRecord,
>(options: {
  identifiers: string[];
  allowAuthOnly: boolean;
  fetchUsers: (
    column: ResolutionColumn,
    values: string[],
  ) => Promise<Map<string, TUser[]>>;
}): Promise<Array<AdminUserResolutionTarget<TUser>>> {
  const seenInputs = new Set<string>();
  const normalizedInputs = options.identifiers.map((input) => ({
    input,
    key: normalizeIdentifier(input),
  }));
  const emails = [
    ...new Set(
      normalizedInputs
        .filter((item) => item.key.includes("@"))
        .map((item) => item.key),
    ),
  ];
  const uuids = [
    ...new Set(
      normalizedInputs
        .filter((item) => UUID_PATTERN.test(item.key))
        .map((item) => item.key),
    ),
  ];
  const [emailMatches, authIdMatches, anonIdMatches] = await Promise.all([
    options.fetchUsers("normalized_email", emails),
    options.fetchUsers("id", uuids),
    options.fetchUsers("canonical", uuids),
  ]);

  const targets: Array<AdminUserResolutionTarget<TUser>> = [];
  const targetOwnerKeys = new Set<string>();
  for (const item of normalizedInputs) {
    if (seenInputs.has(item.key)) {
      targets.push({
        input: item.input,
        status: "duplicate_input",
        message: "Duplicate input row.",
        user: null,
      });
      continue;
    }
    seenInputs.add(item.key);

    const matches = item.key.includes("@")
      ? emailMatches.get(item.key) ?? []
      : [
          ...(authIdMatches.get(item.key) ?? []),
          ...(anonIdMatches.get(item.key) ?? []),
        ];
    const uniqueMatches = Array.from(
      new Map(matches.map((record) => [record.authUserId, record])).values(),
    );

    if (uniqueMatches.length === 0) {
      targets.push({
        input: item.input,
        status: "missing",
        message: "No logged-in user found.",
        user: null,
      });
      continue;
    }
    if (uniqueMatches.length > 1) {
      targets.push({
        input: item.input,
        status: "ambiguous",
        message: "Identifier matched more than one logged-in user.",
        user: null,
      });
      continue;
    }

    const user = uniqueMatches[0];
    if (!user.canonicalAnonUserId && !options.allowAuthOnly) {
      targets.push({
        input: item.input,
        status: "missing",
        message: "User has not opened the app with this account yet.",
        user,
      });
      continue;
    }
    const ownerKey = user.canonicalAnonUserId || `auth:${user.authUserId}`;
    if (targetOwnerKeys.has(ownerKey)) {
      targets.push({
        input: item.input,
        status: "duplicate_target",
        message: options.allowAuthOnly
          ? "Another row already targets this account."
          : "Another row already targets this credit account.",
        user,
      });
      continue;
    }
    targetOwnerKeys.add(ownerKey);
    targets.push({
      input: item.input,
      status: "ready",
      message: options.allowAuthOnly ? "Ready to delete." : "Ready to grant.",
      user,
    });
  }
  return targets;
}
