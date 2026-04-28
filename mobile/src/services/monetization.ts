import { Platform } from "react-native";
import { getApiBaseUrl } from "../config/api";
import { getMobileAnonymousId, getMobileDeviceKey, setMobileAnonymousId } from "./mobileIdentity";
import { getMobileAuthToken } from "./auth";

type IapResponse = {
  responseCode: number;
  results?: Array<{
    productId: string;
    orderId?: string | null;
    [key: string]: unknown;
  }>;
};

type ExpoIapModule = {
  connectAsync: () => Promise<void>;
  finishTransactionAsync: (purchase: unknown, consumeItem?: boolean) => Promise<void>;
  getProductsAsync: (productIds: string[]) => Promise<IapResponse>;
  purchaseItemAsync: (productId: string) => Promise<void>;
  setPurchaseListener: (listener: (result: IapResponse) => void) => void;
  IAPResponseCode: {
    OK: number;
    USER_CANCELED: number;
    DEFERRED: number;
  };
};

let cachedExpoIapModule: ExpoIapModule | null | undefined;

type PurchaseProvider = "apple_app_store" | "google_play";

type VerifyPurchasePayload = {
  purchase?: unknown;
  grantedCredits?: unknown;
  balance?: unknown;
  error?: unknown;
};

type MonetizationAccountPayload = {
  authenticated?: unknown;
  login?: unknown;
  enabled?: unknown;
  enforcementMode?: unknown;
  actionCosts?: unknown;
  freeDaily?: unknown;
  todayUsage?: unknown;
  freeRemaining?: unknown;
  balance?: unknown;
  products?: unknown;
};

export type CreditBalance = {
  availableCredits: number;
  pendingCredits: number;
};

export type MonetizationProduct = {
  provider: PurchaseProvider;
  productId: string;
  credits: number;
};

export type MonetizationAccountSnapshot = {
  authenticated: boolean;
  enabled: boolean;
  enforcementMode: "off" | "observe" | "enforce";
  balance: CreditBalance;
  freeRemaining: {
    fuse: number;
    reroll: number;
  };
  products: MonetizationProduct[];
};

type ApplePurchaseVerificationResult = {
  grantedCredits: number;
  balance: CreditBalance | null;
};

async function getExpoIapModule() {
  if (cachedExpoIapModule !== undefined) {
    return cachedExpoIapModule;
  }

  try {
    const iapModule = (await import("expo-in-app-purchases")) as unknown as ExpoIapModule;
    cachedExpoIapModule = iapModule;
    return iapModule;
  } catch {
    cachedExpoIapModule = null;
    return null;
  }
}

function asInteger(value: unknown, fallback = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
}

function parseBalance(value: unknown): CreditBalance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  return {
    availableCredits: asInteger(candidate.availableCredits),
    pendingCredits: asInteger(candidate.pendingCredits),
  };
}

function generateIdempotencyKey() {
  return `mobile-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getDefaultAppleProductIds(): string[] {
  const configuredRaw = process.env.EXPO_PUBLIC_APPLE_IAP_PRODUCT_IDS as string | undefined;
  const configured = typeof configuredRaw === "string" ? configuredRaw.trim() : "";
  if (!configured) {
    return ["com.flavorfusion.credits.20", "com.flavorfusion.credits.50", "com.flavorfusion.credits.120"];
  }

  return configured
    .split(",")
    .map((value: string) => value.trim())
    .filter((value: string) => value.length > 0);
}

function extractErrorMessage(payload: Record<string, unknown>, fallback: string) {
  const rawError = payload.error;
  if (typeof rawError === "string" && rawError.trim().length > 0) {
    return rawError;
  }
  return fallback;
}

async function withIdentityHeaders() {
  const [mobileAnonId, mobileDeviceKey] = await Promise.all([
    getMobileAnonymousId(),
    getMobileDeviceKey(),
  ]);
  const headers: Record<string, string> = {
    "x-flavor-fusion-anon-id": mobileAnonId,
    "x-flavor-fusion-device-key": mobileDeviceKey,
  };
  const authToken = await getMobileAuthToken();
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  return headers;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProducts(value: unknown): MonetizationProduct[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!isObjectRecord(entry)) {
        return null;
      }
      const provider =
        entry.provider === "apple_app_store" || entry.provider === "google_play"
          ? entry.provider
          : null;
      const productId = typeof entry.productId === "string" ? entry.productId.trim() : "";
      const credits = asInteger(entry.credits, 0);
      if (!provider || !productId || credits < 1) {
        return null;
      }
      return { provider, productId, credits } satisfies MonetizationProduct;
    })
    .filter((entry): entry is MonetizationProduct => entry !== null);
}

export async function fetchMonetizationAccountSnapshot() {
  const identityHeaders = await withIdentityHeaders();
  const response = await fetch(`${getApiBaseUrl()}/api/monetization/account`, {
    method: "GET",
    headers: {
      ...identityHeaders,
      "Content-Type": "application/json",
    },
  });
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (canonicalAnonId) {
    await setMobileAnonymousId(canonicalAnonId);
  }
  const payload = (await response.json()) as MonetizationAccountPayload;
  if (!response.ok) {
    const message = extractErrorMessage(
      payload as Record<string, unknown>,
      "Could not load monetization account.",
    );
    throw new Error(message);
  }

  const enforcementMode =
    payload.enforcementMode === "enforce" ||
    payload.enforcementMode === "observe" ||
    payload.enforcementMode === "off"
      ? payload.enforcementMode
      : "off";

  return {
    authenticated: payload.authenticated === true,
    enabled: payload.enabled === true,
    enforcementMode,
    balance: parseBalance(payload.balance) ?? {
      availableCredits: 0,
      pendingCredits: 0,
    },
    freeRemaining: {
      fuse: asInteger(isObjectRecord(payload.freeRemaining) ? payload.freeRemaining.fuse : 0, 0),
      reroll: asInteger(isObjectRecord(payload.freeRemaining) ? payload.freeRemaining.reroll : 0, 0),
    },
    products: parseProducts(payload.products),
  } satisfies MonetizationAccountSnapshot;
}

async function verifyApplePurchase(params: {
  productId: string;
  appleTransactionId: string;
}) {
  const identityHeaders = await withIdentityHeaders();
  const response = await fetch(`${getApiBaseUrl()}/api/monetization/purchases/verify`, {
    method: "POST",
    headers: {
      ...identityHeaders,
      "Content-Type": "application/json",
      "idempotency-key": generateIdempotencyKey(),
    },
    body: JSON.stringify({
      provider: "apple_app_store",
      productId: params.productId,
      appleTransactionId: params.appleTransactionId,
    }),
  });
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (canonicalAnonId) {
    await setMobileAnonymousId(canonicalAnonId);
  }

  const payload = (await response.json()) as VerifyPurchasePayload;
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(payload as Record<string, unknown>, "Purchase verification failed."),
    );
  }

  return {
    grantedCredits: asInteger(payload.grantedCredits, 0),
    balance: parseBalance(payload.balance),
  } satisfies ApplePurchaseVerificationResult;
}

async function ensureIapConnected() {
  const iap = await getExpoIapModule();
  if (!iap) {
    throw new Error(
      "In-app purchases are unavailable in this app build. Install the latest iOS development build.",
    );
  }

  try {
    await iap.connectAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.toLowerCase().includes("already connected")) {
      throw error;
    }
  }

  return iap;
}

async function waitForApplePurchase(
  iap: ExpoIapModule,
  productId: string,
  timeoutMs = 40_000,
): Promise<{ productId: string; orderId?: string | null; [key: string]: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      iap.setPurchaseListener(() => {});
      fn();
    };

    const timeoutId = setTimeout(() => {
      settle(() => reject(new Error("Timed out waiting for App Store confirmation.")));
    }, timeoutMs);

    iap.setPurchaseListener((result) => {
      if (settled) {
        return;
      }
      if (result.responseCode === iap.IAPResponseCode.OK) {
        const purchase = result.results?.find((entry) => entry.productId === productId);
        if (!purchase) {
          return;
        }
        clearTimeout(timeoutId);
        settle(() => resolve(purchase));
        return;
      }
      if (result.responseCode === iap.IAPResponseCode.USER_CANCELED) {
        clearTimeout(timeoutId);
        settle(() => reject(new Error("Purchase canceled.")));
        return;
      }
      if (result.responseCode === iap.IAPResponseCode.DEFERRED) {
        clearTimeout(timeoutId);
        settle(() => reject(new Error("Purchase is pending approval. Try again in a moment.")));
        return;
      }
      clearTimeout(timeoutId);
      settle(() => reject(new Error("Purchase failed before completion.")));
    });
  });
}

export async function purchaseAppleCredits(productId: string) {
  if (Platform.OS !== "ios") {
    throw new Error("In-app purchases are currently enabled for iOS only.");
  }

  const iap = await ensureIapConnected();

  const productQuery = await iap.getProductsAsync([productId]);
  if (productQuery.responseCode !== iap.IAPResponseCode.OK) {
    throw new Error("Could not load credit pack details from App Store.");
  }
  const matchedProduct = productQuery.results?.find((entry) => entry.productId === productId);
  if (!matchedProduct) {
    throw new Error("Requested credit pack is not available in App Store.");
  }

  const purchasePromise = waitForApplePurchase(iap, productId);
  await iap.purchaseItemAsync(productId);
  const purchase = await purchasePromise;
  const transactionId = purchase.orderId?.trim();
  if (!transactionId) {
    throw new Error("Purchase completed but no transaction id was returned.");
  }

  const verification = await verifyApplePurchase({
    productId,
    appleTransactionId: transactionId,
  });
  await iap.finishTransactionAsync(purchase, true);

  return {
    product: matchedProduct,
    verification,
  };
}

export function getConfiguredAppleProductIds(): string[] {
  return getDefaultAppleProductIds();
}
