import { AccountDeletionStorageError } from "./account-deletion-storage.ts";

export type AccountDeletionFailureStage =
  | "request_validation"
  | "preflight"
  | "target_resolution"
  | "actor_validation"
  | "execution_gate"
  | "preview_persistence"
  | "preview_status"
  | "execution"
  | "storage_processing"
  | "job_status"
  | "response_serialization";

type StorageApiFailure = {
  statusCode: number;
  body: {
    error: string;
    code: string;
  };
};

const STORAGE_API_FAILURES: Readonly<Record<string, StorageApiFailure>> = {
  storage_reference_invalid: {
    statusCode: 409,
    body: {
      error: "An account deletion storage reference is invalid.",
      code: "storage_reference_invalid",
    },
  },
  storage_reference_sensitive: {
    statusCode: 409,
    body: {
      error: "An account deletion storage reference requires manual review.",
      code: "storage_reference_sensitive",
    },
  },
  storage_reference_unsupported: {
    statusCode: 409,
    body: {
      error: "An account deletion storage reference cannot be attributed safely.",
      code: "storage_reference_unsupported",
    },
  },
  storage_reference_ambiguous: {
    statusCode: 409,
    body: {
      error: "An account deletion storage reference has ambiguous ownership.",
      code: "storage_reference_ambiguous",
    },
  },
  storage_configuration_unavailable: {
    statusCode: 503,
    body: {
      error: "Account deletion storage configuration is unavailable.",
      code: "storage_configuration_unavailable",
    },
  },
};

const UNKNOWN_STORAGE_API_FAILURE: StorageApiFailure = {
  statusCode: 503,
  body: {
    error: "Account deletion storage verification is unavailable.",
    code: "account_deletion_storage_unavailable",
  },
};

export function getAccountDeletionStorageApiFailure(
  error: unknown,
): StorageApiFailure | null {
  if (!(error instanceof AccountDeletionStorageError)) {
    return null;
  }
  return STORAGE_API_FAILURES[error.code] ?? UNKNOWN_STORAGE_API_FAILURE;
}

type SafeAccountDeletionFailureDiagnostic = {
  event: "account_deletion_failed";
  requestId: string;
  stage: AccountDeletionFailureStage;
  errorClass: string;
  code: string;
};

function getSafeErrorClass(error: unknown) {
  let candidate = "UnknownError";
  try {
    if (error instanceof Error && typeof error.constructor?.name === "string") {
      candidate = error.constructor.name;
    }
  } catch {
    candidate = "UnknownError";
  }
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate)
    ? candidate
    : "UnknownError";
}

function getSafeErrorCode(error: unknown) {
  let candidate = "";
  try {
    if (error && typeof error === "object" && "code" in error) {
      const value = (error as { code?: unknown }).code;
      candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
    }
  } catch {
    candidate = "";
  }
  return /^(?:sqlite|libsql)_[a-z0-9_]{1,70}$/.test(candidate)
    ? "account_deletion_database_unavailable"
    : "unexpected_account_deletion_failure";
}

function getSafeRequestId(requestId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    requestId,
  )
    ? requestId
    : "unavailable";
}

export function logUnexpectedAccountDeletionFailure(options: {
  requestId: string;
  stage: AccountDeletionFailureStage;
  error: unknown;
  logger?: (serializedDiagnostic: string) => void;
}) {
  const diagnostic: SafeAccountDeletionFailureDiagnostic = {
    event: "account_deletion_failed",
    requestId: getSafeRequestId(options.requestId),
    stage: options.stage,
    errorClass: getSafeErrorClass(options.error),
    code: getSafeErrorCode(options.error),
  };
  const logger = options.logger ?? console.error;
  try {
    logger(JSON.stringify(diagnostic));
  } catch {
    // Diagnostic delivery must never replace the stable API failure response.
  }
  return diagnostic;
}
