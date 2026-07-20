import type { MobileSessionIdentity } from "./authSession";

export type PurchaseAccountProvider = "apple_app_store" | "google_play";

export type PurchaseAccountBinding<TProvider extends PurchaseAccountProvider> = Readonly<{
  provider: TProvider;
  userId: string;
  identity: Readonly<MobileSessionIdentity & { userId: string }>;
  authToken: string;
  anonymousId: string;
  deviceKey: string;
  idempotencyKey: string;
}>;

export function createPurchaseAccountBinding<TProvider extends PurchaseAccountProvider>(input: {
  provider: TProvider;
  userId: string;
  identity: MobileSessionIdentity;
  authToken: string;
  anonymousId: string;
  deviceKey: string;
  idempotencyKey: string;
}): PurchaseAccountBinding<TProvider> {
  const userId = input.userId.trim();
  const authToken = input.authToken.trim();
  const anonymousId = input.anonymousId.trim();
  const deviceKey = input.deviceKey.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    !userId ||
    input.identity.userId !== userId ||
    !authToken ||
    !anonymousId ||
    !deviceKey ||
    !idempotencyKey
  ) {
    throw new Error("A purchase requires a complete authenticated account context.");
  }

  return Object.freeze({
    provider: input.provider,
    userId,
    identity: Object.freeze({
      ...input.identity,
      userId,
    }),
    authToken,
    anonymousId,
    deviceKey,
    idempotencyKey,
  });
}

export function buildPurchaseVerificationHeaders(
  binding: PurchaseAccountBinding<PurchaseAccountProvider>,
) {
  return {
    "x-flavor-fusion-anon-id": binding.anonymousId,
    "x-flavor-fusion-device-key": binding.deviceKey,
    authorization: `Bearer ${binding.authToken}`,
  };
}

export function isPurchaseAccountBindingCurrent(
  binding: PurchaseAccountBinding<PurchaseAccountProvider>,
  currentIdentity: MobileSessionIdentity,
) {
  return (
    binding.identity.userId === currentIdentity.userId &&
    binding.identity.revision === currentIdentity.revision
  );
}
