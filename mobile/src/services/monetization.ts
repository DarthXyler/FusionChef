import { Platform } from "react-native";
import { getApiBaseUrl } from "../config/api";
import {
  createAccountRefreshRequestCoalescer,
  createPostMutationAccountRefresh,
  mergeVerifiedAccountBalance,
} from "./accountRefresh";
import { getMobileAnonymousId, getMobileDeviceKey, setMobileAnonymousId } from "./mobileIdentity";
import { getMobileAuthRequestContext, getMobileAuthToken } from "./auth";
import {
  assertMobileSessionIdentityCurrent,
  captureMobileSessionIdentity,
  getMobileSessionIdentity,
  isMobileSessionIdentityCurrent,
  subscribeToMobileSessionIdentity,
  type MobileSessionIdentity,
} from "./authSession";
import {
  buildPurchaseVerificationHeaders,
  createPurchaseAccountBinding,
  isPurchaseAccountBindingCurrent,
  type PurchaseAccountBinding,
  type PurchaseAccountProvider,
} from "./purchaseAccountBinding";
import { clearInvalidMobileSession, isInvalidAuthPayload } from "./sessionInvalidation";

type IapResponse = {
  responseCode: number;
  errorCode?: number | null;
  results?: Array<{
    acknowledged?: boolean;
    productId: string;
    orderId?: string | null;
    purchaseState?: number;
    transactionReceipt?: string;
    [key: string]: unknown;
  }>;
};

type ReactNativeIapModule = typeof import("react-native-iap");

type ExpoIapModule = {
  connectAsync: () => Promise<void>;
  finishTransactionAsync: (purchase: unknown, consumeItem?: boolean) => Promise<void>;
  getPurchaseHistoryAsync: (options?: { useGooglePlayCache?: boolean }) => Promise<IapResponse>;
  getProductsAsync: (productIds: string[]) => Promise<IapResponse>;
  purchaseItemAsync: (productId: string) => Promise<void>;
  setPurchaseListener: (listener: (result: IapResponse) => void) => void;
  IAPResponseCode: {
    OK: number;
    USER_CANCELED: number;
    ERROR: number;
    DEFERRED: number;
  };
};

let cachedExpoIapModule: ExpoIapModule | null | undefined;

type PurchaseProvider = PurchaseAccountProvider;

type VerifyPurchasePayload = {
  purchase?: unknown;
  grantedCredits?: unknown;
  balance?: unknown;
  error?: unknown;
  requestId?: unknown;
};

type MonetizationAccountPayload = {
  authenticated?: unknown;
  reason?: unknown;
  code?: unknown;
  login?: unknown;
  enabled?: unknown;
  enforcementMode?: unknown;
  actionCosts?: unknown;
  freeDaily?: unknown;
  todayUsage?: unknown;
  freeRemaining?: unknown;
  balance?: unknown;
  products?: unknown;
  pricingPackages?: unknown;
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
  actionCosts: {
    fuse: number;
    reroll: number;
  };
  balance: CreditBalance;
  freeRemaining: {
    fuse: number;
    reroll: number;
  };
  products: MonetizationProduct[];
  pricingPackages: MonetizationPricingPackage[];
};

export type MonetizationPricingPackage = {
  packageKey: string;
  label: string;
  credits: number;
  displayPriceUsd: number;
  appleProductId: string;
  googleProductId: string;
  active: boolean;
};

const ACCOUNT_SNAPSHOT_CACHE_TTL_MS = 20_000;
const accountRefreshRequestCoalescer =
  createAccountRefreshRequestCoalescer<MonetizationAccountSnapshot>();
let accountRefreshGeneration = 0;
let cachedAccountSnapshot:
  | {
      value: MonetizationAccountSnapshot;
      fetchedAtMs: number;
      sessionRevision: number;
    }
  | null = null;
const accountSnapshotListeners = new Set<(snapshot: MonetizationAccountSnapshot) => void>();

type ApplePurchaseVerificationResult = {
  grantedCredits: number;
  balance: CreditBalance | null;
};

type CreditPurchaseVerificationResult = ApplePurchaseVerificationResult;

const IN_APP_PURCHASE_STATE_PURCHASED = 1;
const IN_APP_PURCHASE_STATE_RESTORED = 3;
const PURCHASE_CONFIRMATION_TIMEOUT_MS = 45_000;
const ANDROID_PACKAGE_NAME = "com.flavorfusionchef.mobile";

type PurchaseAppleCreditsOptions = {
  onStatus?: (message: string) => void;
};

function buildSignedOutAccountSnapshot(): MonetizationAccountSnapshot {
  return {
    authenticated: false,
    enabled: false,
    enforcementMode: "off",
    actionCosts: {
      fuse: 3,
      reroll: 1,
    },
    balance: {
      availableCredits: 0,
      pendingCredits: 0,
    },
    freeRemaining: {
      fuse: 0,
      reroll: 0,
    },
    products: [],
    pricingPackages: [],
  };
}

function isLoginRequiredPayload(payload: unknown) {
  if (!isObjectRecord(payload)) {
    return false;
  }
  return payload.reason === "login_required" || payload.code === "login_required";
}

function setSignedOutAccountSnapshot() {
  const snapshot = buildSignedOutAccountSnapshot();
  const identity = getMobileSessionIdentity();
  cachedAccountSnapshot = {
    value: snapshot,
    fetchedAtMs: Date.now(),
    sessionRevision: identity.revision,
  };
  notifyAccountSnapshotListeners(snapshot);
  return snapshot;
}

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

function getDefaultGoogleProductIds(): string[] {
  const configuredRaw = process.env.EXPO_PUBLIC_GOOGLE_PLAY_IAP_PRODUCT_IDS as string | undefined;
  const configured = typeof configuredRaw === "string" ? configuredRaw.trim() : "";
  if (!configured) {
    return ["credits_20_android", "credits_50_android", "credits_120_android"];
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

async function handleInvalidAuthResponse(
  response: Response,
  payload: unknown,
  identity?: MobileSessionIdentity,
) {
  if (response.status !== 401 || !isInvalidAuthPayload(payload)) {
    return;
  }
  const didClearSession = await clearInvalidMobileSession(identity);
  if (didClearSession) {
    resetMonetizationAccountSnapshotForSignedOutSession();
  }
}

async function withIdentityHeaders(authTokenOverride?: string) {
  const [mobileAnonId, mobileDeviceKey] = await Promise.all([
    getMobileAnonymousId(),
    getMobileDeviceKey(),
  ]);
  const headers: Record<string, string> = {
    "x-flavor-fusion-anon-id": mobileAnonId,
    "x-flavor-fusion-device-key": mobileDeviceKey,
  };
  const authToken =
    typeof authTokenOverride === "string"
      ? authTokenOverride
      : await getMobileAuthToken();
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  return headers;
}

async function capturePurchaseAccountContext<TProvider extends PurchaseProvider>(
  provider: TProvider,
) {
  const authContext = await getMobileAuthRequestContext();
  if (!authContext.session || !authContext.token || !authContext.identity.userId) {
    throw new Error("Sign in to purchase credits.");
  }
  const [anonymousId, deviceKey] = await Promise.all([
    getMobileAnonymousId(),
    getMobileDeviceKey(),
  ]);
  assertMobileSessionIdentityCurrent(authContext.identity);
  return createPurchaseAccountBinding({
    provider,
    userId: authContext.session.userId,
    identity: authContext.identity,
    authToken: authContext.token,
    anonymousId,
    deviceKey,
    idempotencyKey: generateIdempotencyKey(),
  });
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

function parsePricingPackages(value: unknown): MonetizationPricingPackage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!isObjectRecord(entry)) {
        return null;
      }
      const packageKey = typeof entry.packageKey === "string" ? entry.packageKey.trim() : "";
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const credits = asInteger(entry.credits, 0);
      const displayPriceUsd =
        typeof entry.displayPriceUsd === "number" && Number.isFinite(entry.displayPriceUsd)
          ? entry.displayPriceUsd
          : 0;
      const appleProductId =
        typeof entry.appleProductId === "string" ? entry.appleProductId.trim() : "";
      const googleProductId =
        typeof entry.googleProductId === "string" ? entry.googleProductId.trim() : "";
      const active = entry.active !== false;
      if (
        !packageKey ||
        !label ||
        credits < 1 ||
        displayPriceUsd <= 0 ||
        (!appleProductId && !googleProductId)
      ) {
        return null;
      }
      return {
        packageKey,
        label,
        credits,
        displayPriceUsd,
        appleProductId,
        googleProductId,
        active,
      } satisfies MonetizationPricingPackage;
    })
    .filter((entry): entry is MonetizationPricingPackage => entry !== null)
    .sort((left, right) => left.credits - right.credits);
}

export function invalidateMonetizationAccountSnapshotCache() {
  cachedAccountSnapshot = null;
}

export function resetMonetizationAccountSnapshotForSignedOutSession() {
  setSignedOutAccountSnapshot();
}

export function subscribeToMonetizationAccountSnapshot(
  listener: (snapshot: MonetizationAccountSnapshot) => void,
) {
  accountSnapshotListeners.add(listener);
  return () => {
    accountSnapshotListeners.delete(listener);
  };
}

function notifyAccountSnapshotListeners(snapshot: MonetizationAccountSnapshot) {
  accountSnapshotListeners.forEach((listener) => {
    listener(snapshot);
  });
}

subscribeToMobileSessionIdentity(() => {
  accountRefreshGeneration += 1;
  accountRefreshRequestCoalescer.reset();
  setSignedOutAccountSnapshot();
});

function isAccountRefreshCurrent(
  identity: MobileSessionIdentity,
  refreshGeneration: number,
) {
  return (
    refreshGeneration === accountRefreshGeneration &&
    isMobileSessionIdentityCurrent(identity)
  );
}

async function fetchFreshMonetizationAccountSnapshot(
  authContext: Awaited<ReturnType<typeof getMobileAuthRequestContext>>,
  requestIdentity: MobileSessionIdentity,
  refreshGeneration: number,
) {
  const identityHeaders = await withIdentityHeaders(authContext.token);
  if (!isAccountRefreshCurrent(requestIdentity, refreshGeneration)) {
    return cachedAccountSnapshot?.sessionRevision === getMobileSessionIdentity().revision
      ? cachedAccountSnapshot.value
      : buildSignedOutAccountSnapshot();
  }
  const response = await fetch(`${getApiBaseUrl()}/api/monetization/account`, {
    method: "GET",
    headers: {
      ...identityHeaders,
      "Content-Type": "application/json",
    },
  });
  if (!isAccountRefreshCurrent(requestIdentity, refreshGeneration)) {
    return cachedAccountSnapshot?.sessionRevision === getMobileSessionIdentity().revision
      ? cachedAccountSnapshot.value
      : buildSignedOutAccountSnapshot();
  }
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (canonicalAnonId) {
    await setMobileAnonymousId(canonicalAnonId);
  }
  const payload = (await response.json()) as MonetizationAccountPayload;
  if (!isAccountRefreshCurrent(requestIdentity, refreshGeneration)) {
    return cachedAccountSnapshot?.sessionRevision === getMobileSessionIdentity().revision
      ? cachedAccountSnapshot.value
      : buildSignedOutAccountSnapshot();
  }
  if (!response.ok) {
    if (response.status === 401 && isLoginRequiredPayload(payload)) {
      return setSignedOutAccountSnapshot();
    }
    await handleInvalidAuthResponse(response, payload, requestIdentity);
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

  const snapshot = {
    authenticated: payload.authenticated === true,
    enabled: payload.enabled === true,
    enforcementMode,
    actionCosts: {
      fuse: asInteger(isObjectRecord(payload.actionCosts) ? payload.actionCosts.fuse : 3, 3),
      reroll: asInteger(isObjectRecord(payload.actionCosts) ? payload.actionCosts.reroll : 1, 1),
    },
    balance: parseBalance(payload.balance) ?? {
      availableCredits: 0,
      pendingCredits: 0,
    },
    freeRemaining: {
      fuse: asInteger(isObjectRecord(payload.freeRemaining) ? payload.freeRemaining.fuse : 0, 0),
      reroll: asInteger(isObjectRecord(payload.freeRemaining) ? payload.freeRemaining.reroll : 0, 0),
    },
    products: parseProducts(payload.products),
    pricingPackages: parsePricingPackages(payload.pricingPackages),
  } satisfies MonetizationAccountSnapshot;

  if (!isAccountRefreshCurrent(requestIdentity, refreshGeneration)) {
    return cachedAccountSnapshot?.sessionRevision === getMobileSessionIdentity().revision
      ? cachedAccountSnapshot.value
      : buildSignedOutAccountSnapshot();
  }
  cachedAccountSnapshot = {
    value: snapshot,
    fetchedAtMs: Date.now(),
    sessionRevision: requestIdentity.revision,
  };
  notifyAccountSnapshotListeners(snapshot);
  return snapshot;
}

export async function fetchMonetizationAccountSnapshot(options?: {
  preferCache?: boolean;
  forceRefresh?: boolean;
}) {
  const preferCache = options?.preferCache === true;
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();
  const authContext = await getMobileAuthRequestContext();
  const requestIdentity = authContext.identity;
  const refreshGeneration = accountRefreshGeneration;

  if (
    !forceRefresh &&
    preferCache &&
    cachedAccountSnapshot &&
    cachedAccountSnapshot.sessionRevision === requestIdentity.revision &&
    now - cachedAccountSnapshot.fetchedAtMs <= ACCOUNT_SNAPSHOT_CACHE_TTL_MS
  ) {
    return cachedAccountSnapshot.value;
  }

  return accountRefreshRequestCoalescer.run(
    {
      ...requestIdentity,
      refreshGeneration,
    },
    () =>
      fetchFreshMonetizationAccountSnapshot(
        authContext,
        requestIdentity,
        refreshGeneration,
      ),
  );
}

function publishVerifiedPurchaseBalance(
  balance: CreditBalance,
  expectedIdentity: MobileSessionIdentity,
) {
  if (!isMobileSessionIdentityCurrent(expectedIdentity)) {
    return false;
  }

  const baseSnapshot =
    cachedAccountSnapshot?.sessionRevision === expectedIdentity.revision
      ? cachedAccountSnapshot.value
      : {
          ...buildSignedOutAccountSnapshot(),
          authenticated: expectedIdentity.userId !== null,
        };
  const snapshot = mergeVerifiedAccountBalance(baseSnapshot, balance);
  cachedAccountSnapshot = {
    value: snapshot,
    fetchedAtMs: Date.now(),
    sessionRevision: expectedIdentity.revision,
  };
  notifyAccountSnapshotListeners(snapshot);
  return true;
}

const runPostMutationAccountRefresh = createPostMutationAccountRefresh<
  MonetizationAccountSnapshot,
  CreditBalance,
  MobileSessionIdentity
>({
  isCurrent: isMobileSessionIdentityCurrent,
  onMutation: () => {
    accountRefreshGeneration += 1;
  },
  requestFreshSnapshot: () =>
    fetchMonetizationAccountSnapshot({ forceRefresh: true }),
  publishVerifiedBalance: (balance, identity) => {
    publishVerifiedPurchaseBalance(balance, identity);
  },
  refreshTimeoutMs: 5_000,
});

export function refreshMonetizationAccountAfterMutation(options?: {
  expectedIdentity?: MobileSessionIdentity;
  verifiedBalance?: CreditBalance | null;
}) {
  const expectedIdentity = options?.expectedIdentity ?? captureMobileSessionIdentity();
  try {
    return runPostMutationAccountRefresh.schedule({
      expectedIdentity,
      verifiedBalance: options?.verifiedBalance,
    });
  } catch {
    return null;
  }
}

async function verifyApplePurchase(params: {
  productId: string;
  appleTransactionId: string;
  purchaseContext: PurchaseAccountBinding<"apple_app_store">;
}) {
  const identityHeaders = buildPurchaseVerificationHeaders(params.purchaseContext);
  const response = await fetch(`${getApiBaseUrl()}/api/monetization/purchases/verify`, {
    method: "POST",
    headers: {
      ...identityHeaders,
      "Content-Type": "application/json",
      "idempotency-key": params.purchaseContext.idempotencyKey,
    },
    body: JSON.stringify({
      provider: "apple_app_store",
      productId: params.productId,
      appleTransactionId: params.appleTransactionId,
    }),
  });
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (
    canonicalAnonId &&
    isPurchaseAccountBindingCurrent(params.purchaseContext, getMobileSessionIdentity())
  ) {
    await setMobileAnonymousId(canonicalAnonId);
  }

  const payload = (await response.json()) as VerifyPurchasePayload;
  if (!response.ok) {
    await handleInvalidAuthResponse(response, payload, params.purchaseContext.identity);
    throw new Error(
      extractErrorMessage(payload as Record<string, unknown>, "Purchase verification failed."),
    );
  }

  return {
    grantedCredits: asInteger(payload.grantedCredits, 0),
    balance: parseBalance(payload.balance),
  } satisfies ApplePurchaseVerificationResult;
}

async function verifyGooglePurchase(params: {
  productId: string;
  googlePurchaseToken: string;
  purchaseContext: PurchaseAccountBinding<"google_play">;
}) {
  const identityHeaders = buildPurchaseVerificationHeaders(params.purchaseContext);
  const response = await fetch(`${getApiBaseUrl()}/api/monetization/purchases/verify`, {
    method: "POST",
    headers: {
      ...identityHeaders,
      "Content-Type": "application/json",
      "idempotency-key": params.purchaseContext.idempotencyKey,
    },
    body: JSON.stringify({
      provider: "google_play",
      productId: params.productId,
      googlePurchaseToken: params.googlePurchaseToken,
      packageName: ANDROID_PACKAGE_NAME,
    }),
  });
  const canonicalAnonId = response.headers.get("x-flavor-fusion-anon-id")?.trim();
  if (
    canonicalAnonId &&
    isPurchaseAccountBindingCurrent(params.purchaseContext, getMobileSessionIdentity())
  ) {
    await setMobileAnonymousId(canonicalAnonId);
  }

  const payload = (await response.json()) as VerifyPurchasePayload;
  if (!response.ok) {
    await handleInvalidAuthResponse(response, payload, params.purchaseContext.identity);
    throw new Error(
      extractErrorMessage(
        payload as Record<string, unknown>,
        "Purchase verification failed. Please try again or contact support.",
      ),
    );
  }

  return {
    grantedCredits: asInteger(payload.grantedCredits, 0),
    balance: parseBalance(payload.balance),
  } satisfies CreditPurchaseVerificationResult;
}

async function ensureIapConnected() {
  const iap = await getExpoIapModule();
  if (!iap) {
    throw new Error(
      "In-app purchases are unavailable in this build. Update the app and try again.",
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

async function getReactNativeIapModule() {
  return import("react-native-iap");
}

async function ensureGoogleIapConnected() {
  if (Platform.OS !== "android") {
    throw new Error("Google Play purchases are only available on Android.");
  }
  const iap = await getReactNativeIapModule();
  await iap.initConnection();
  return iap;
}

async function waitForApplePurchase(
  iap: ExpoIapModule,
  productId: string,
  timeoutMs = PURCHASE_CONFIRMATION_TIMEOUT_MS,
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
      settle(() =>
        reject(
          new Error(
            "No purchase confirmation came back from the App Store. Close and reopen the app, then try again. If Apple already completed the purchase, contact support.",
          ),
        ),
      );
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
        if (
          typeof purchase.purchaseState === "number" &&
          purchase.purchaseState !== IN_APP_PURCHASE_STATE_PURCHASED &&
          purchase.purchaseState !== IN_APP_PURCHASE_STATE_RESTORED
        ) {
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
      if (result.responseCode === iap.IAPResponseCode.ERROR) {
        clearTimeout(timeoutId);
        settle(() => reject(new Error("The App Store could not complete this purchase.")));
        return;
      }
      clearTimeout(timeoutId);
      settle(() => reject(new Error("Purchase failed before completion.")));
    });
  });
}

function findCompletedPurchase(
  purchases: IapResponse["results"] | undefined,
  productId: string,
) {
  return purchases?.find((entry) => {
    if (entry.productId !== productId) {
      return false;
    }
    if (
      typeof entry.purchaseState === "number" &&
      entry.purchaseState !== IN_APP_PURCHASE_STATE_PURCHASED &&
      entry.purchaseState !== IN_APP_PURCHASE_STATE_RESTORED
    ) {
      return false;
    }
    return typeof entry.orderId === "string" && entry.orderId.trim().length > 0;
  });
}

async function findRecoverableApplePurchase(iap: ExpoIapModule, productId: string) {
  try {
    const history = await iap.getPurchaseHistoryAsync({ useGooglePlayCache: false });
    if (history.responseCode !== iap.IAPResponseCode.OK) {
      return null;
    }
    return findCompletedPurchase(history.results, productId) ?? null;
  } catch {
    return null;
  }
}

export async function purchaseAppleCredits(
  productId: string,
  options?: PurchaseAppleCreditsOptions,
) {
  if (Platform.OS !== "ios") {
    throw new Error("This purchase method is unavailable on this device.");
  }

  const purchaseContext = await capturePurchaseAccountContext("apple_app_store");
  const iap = await ensureIapConnected();

  const productQuery = await iap.getProductsAsync([productId]);
  if (productQuery.responseCode !== iap.IAPResponseCode.OK) {
    throw new Error("Could not load credit pack details from App Store.");
  }
  const matchedProduct = productQuery.results?.find((entry) => entry.productId === productId);
  if (!matchedProduct) {
    throw new Error("Requested credit pack is not available in App Store.");
  }

  options?.onStatus?.("Opening App Store...");
  const purchasePromise = waitForApplePurchase(iap, productId);
  let rejectLaunchError: (error: unknown) => void = () => {};
  const launchErrorPromise = new Promise<never>((_, reject) => {
    rejectLaunchError = reject;
  });
  void iap.purchaseItemAsync(productId).catch((error) => {
    iap.setPurchaseListener(() => {});
    rejectLaunchError(error);
  });
  let purchase: { productId: string; orderId?: string | null; [key: string]: unknown };
  try {
    purchase = await Promise.race([purchasePromise, launchErrorPromise]);
  } catch (error) {
    const recoveredPurchase = await findRecoverableApplePurchase(iap, productId);
    if (!recoveredPurchase) {
      throw error;
    }
    purchase = recoveredPurchase;
  }
  options?.onStatus?.("Adding credits...");
  const transactionId = purchase.orderId?.trim();
  if (!transactionId) {
    throw new Error("Purchase completed but no transaction id was returned.");
  }

  const verification = await verifyApplePurchase({
    productId,
    appleTransactionId: transactionId,
    purchaseContext,
  });
  refreshMonetizationAccountAfterMutation({
    expectedIdentity: purchaseContext.identity,
    verifiedBalance: verification.balance,
  });
  await iap.finishTransactionAsync(purchase, true);

  return {
    product: matchedProduct,
    verification,
  };
}

function isGooglePurchaseCancelled(error: unknown) {
  if (!isObjectRecord(error)) {
    return false;
  }
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return (
    code.includes("user") && (code.includes("cancel") || code.includes("cancelled")) ||
    message.includes("cancel")
  );
}

function waitForGooglePurchase(iap: ReactNativeIapModule, productId: string) {
  let cleanup = () => {};
  const promise = new Promise<import("react-native-iap").Purchase>((resolve, reject) => {
    let settled = false;
    cleanup = () => {
      updateSubscription.remove();
      errorSubscription.remove();
      clearTimeout(timeoutId);
    };
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };
    const timeoutId = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            "No purchase confirmation came back from Google Play. Please try again in a moment.",
          ),
        ),
      );
    }, PURCHASE_CONFIRMATION_TIMEOUT_MS);
    const updateSubscription = iap.purchaseUpdatedListener((purchase) => {
      if (purchase.productId !== productId) {
        return;
      }
      settle(() => resolve(purchase));
    });
    const errorSubscription = iap.purchaseErrorListener((error) => {
      settle(() => reject(error));
    });
  });
  return { promise, cleanup };
}

export async function purchaseGoogleCredits(
  productId: string,
  options?: PurchaseAppleCreditsOptions,
) {
  if (Platform.OS !== "android") {
    throw new Error("Google Play purchases are only available on Android.");
  }

  const purchaseContext = await capturePurchaseAccountContext("google_play");
  const iap = await ensureGoogleIapConnected();
  const products = await iap.fetchProducts({ skus: [productId], type: "in-app" });
  const matchedProduct = products?.find((product) => product.id === productId);
  if (!matchedProduct) {
    throw new Error("This credit pack is unavailable in Google Play right now.");
  }

  const pendingPurchase = waitForGooglePurchase(iap, productId);
  try {
    await iap.requestPurchase({
      request: {
        google: {
          skus: [productId],
        },
      },
      type: "in-app",
    });
  } catch (error) {
    pendingPurchase.cleanup();
    if (isGooglePurchaseCancelled(error)) {
      throw new Error("Purchase canceled.");
    }
    throw error instanceof Error
      ? error
      : new Error("Google Play could not start this purchase.");
  }

  let purchase: import("react-native-iap").Purchase;
  try {
    purchase = await pendingPurchase.promise;
  } catch (error) {
    if (isGooglePurchaseCancelled(error)) {
      throw new Error("Purchase canceled.");
    }
    throw error instanceof Error
      ? error
      : new Error("Google Play could not complete this purchase.");
  }

  const googlePurchaseToken = purchase.purchaseToken?.trim() ?? "";
  if (!googlePurchaseToken) {
    throw new Error("Google Play did not return a purchase token. Please try again.");
  }

  options?.onStatus?.("Adding credits...");
  const verification = await verifyGooglePurchase({
    productId,
    googlePurchaseToken,
    purchaseContext,
  });
  refreshMonetizationAccountAfterMutation({
    expectedIdentity: purchaseContext.identity,
    verifiedBalance: verification.balance,
  });
  try {
    await iap.finishTransaction({ purchase, isConsumable: true });
  } catch {
    return {
      product: matchedProduct,
      verification,
      warningMessage:
        "Credits were added, but Google Play did not finish the transaction cleanly. If this repeats, contact support.",
    };
  }

  return {
    product: matchedProduct,
    verification,
  };
}

export async function purchaseCreditsForPlatform(
  productId: string,
  options?: PurchaseAppleCreditsOptions,
) {
  if (Platform.OS === "android") {
    options?.onStatus?.("Opening Google Play...");
    return purchaseGoogleCredits(productId, options);
  }
  return purchaseAppleCredits(productId, options);
}

export async function getAvailableAppleProductIds(productIds: string[]) {
  if (Platform.OS !== "ios") {
    return productIds;
  }

  const normalizedIds = Array.from(
    new Set(
      productIds
        .map((productId) => productId.trim())
        .filter((productId) => productId.length > 0),
    ),
  );
  if (normalizedIds.length === 0) {
    return [] as string[];
  }

  const iap = await ensureIapConnected();
  const productQuery = await iap.getProductsAsync(normalizedIds);
  if (productQuery.responseCode !== iap.IAPResponseCode.OK) {
    throw new Error("Could not load App Store product catalog.");
  }

  return Array.from(
    new Set(
      (productQuery.results ?? [])
        .map((entry) => (typeof entry.productId === "string" ? entry.productId.trim() : ""))
        .filter((productId) => productId.length > 0),
    ),
  );
}

export function getConfiguredAppleProductIds(): string[] {
  return getDefaultAppleProductIds();
}

export async function getAvailableCreditProductIdsForPlatform(productIds: string[]) {
  if (Platform.OS !== "android") {
    return getAvailableAppleProductIds(productIds);
  }

  const normalizedIds = Array.from(
    new Set(
      productIds
        .map((productId) => productId.trim())
        .filter((productId) => productId.length > 0),
    ),
  );
  if (normalizedIds.length === 0) {
    return [] as string[];
  }

  const iap = await ensureGoogleIapConnected();
  const products = await iap.fetchProducts({ skus: normalizedIds, type: "in-app" });
  const availableIds = (products ?? [])
    .map((product) => (typeof product.id === "string" ? product.id.trim() : ""))
    .filter((productId) => productId.length > 0);
  return Array.from(new Set(availableIds));
}

export function getConfiguredCreditProductIdsForPlatform(): string[] {
  return Platform.OS === "android" ? getDefaultGoogleProductIds() : getDefaultAppleProductIds();
}

export function getCreditPricingProductIdForPlatform(pack: MonetizationPricingPackage) {
  return Platform.OS === "android" ? pack.googleProductId.trim() : pack.appleProductId.trim();
}

export function getCreditProviderForPlatform(): PurchaseProvider {
  return Platform.OS === "android" ? "google_play" : "apple_app_store";
}
