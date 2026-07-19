import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import {
  GOOGLE_PLAY_REFUND_GUIDANCE,
  legalLastUpdated,
  SUPPORT_EMAIL,
} from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Purchases and Refunds",
  description:
    "How Flavor Fusion Chef handles credit purchases, App Store and Google Play refund requests, and support for missing credits.",
};

const purchaseSections = [
  {
    title: "Credit packs",
    body: [
      "Credits are one-time consumable digital items. They can be used for recipe generation and rerolls in Flavor Fusion Chef. They are not a subscription and do not renew automatically.",
    ],
  },
  {
    title: "How purchases are processed",
    body: [
      "Purchases are processed through the App Store on iOS and Google Play on Android. The applicable store controls the purchase flow, local pricing, taxes, payment methods, and receipts.",
      "Flavor Fusion Chef receives the store product identifier and transaction, order, or purchase-token information needed to verify a purchase and record its verification status. We do not receive or store full payment-card details.",
    ],
  },
  {
    title: "App Store refund guidance",
    body: [
      "For an iOS purchase, review the transaction in your Apple purchase history and use Apple's Report a Problem or refund-request flow. Apple decides whether a purchase is eligible under its current policies.",
      "Flavor Fusion Chef cannot approve an App Store refund or promise that Apple will grant one.",
    ],
  },
  {
    title: "Google Play refund guidance",
    body: [
      GOOGLE_PLAY_REFUND_GUIDANCE,
      "When contacting Flavor Fusion Chef, include the credit pack, approximate purchase time, and relevant Google Play receipt or order information. Do not send a purchase token or full payment-card details.",
    ],
  },
  {
    title: "When to contact support",
    body: [
      "If the App Store or Google Play shows a purchase as completed but credits do not appear, contact Flavor Fusion Chef support so we can investigate verification and credit delivery.",
      "Include the platform or store, credit pack, approximate purchase time, and relevant receipt, transaction, or order information. A screenshot may help, but do not send full payment-card details, account passwords, or purchase tokens in an unsecured message.",
    ],
  },
] as const;

export default function RefundPolicyPage() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader
        eyebrow="Purchases and Refunds"
        title="Credit purchases are handled by your mobile app store."
        meta={`Last updated: ${legalLastUpdated}`}
      >
        <p>
          This page explains how credit packs work and where to go if a purchase or refund needs
          attention.
        </p>
      </PageHeader>

      <LegalSectionList sections={purchaseSections} />

      <LegalCallout title="Need help?">
        <BodyText className="mt-3">
          Email{" "}
          <a
            className="font-semibold text-emerald-700 underline underline-offset-4"
            href={`mailto:${SUPPORT_EMAIL}?subject=Flavor%20Fusion%20Chef%20Purchase%20Support`}
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          or visit <TextLink href="/support?topic=purchase">Purchase support</TextLink>.
        </BodyText>
      </LegalCallout>
    </PageShell>
  );
}
