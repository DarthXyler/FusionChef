import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { legalLastUpdated, SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Purchases and Refunds",
  description:
    "How Flavor Fusion Chef handles credit purchases, Apple purchase processing, and support for purchase issues.",
};

const purchaseSections = [
  {
    title: "Credit packs",
    body: [
      "Credits are one-time consumable digital items. They can be used for recipe generation and rerolls in Flavor Fusion Chef. They are not a subscription and do not renew automatically.",
    ],
  },
  {
    title: "Apple purchases",
    body: [
      "On iOS, purchases are processed by Apple. Apple controls the purchase sheet, receipts, local pricing, taxes, payment methods, and refund review process.",
    ],
  },
  {
    title: "When to contact support",
    body: [
      "If Apple shows a purchase as completed but credits do not appear in the app, contact Flavor Fusion Chef support. Include the purchase time, credit pack, device model, and a screenshot of the Apple purchase history if available.",
    ],
  },
] as const;

export default function RefundPolicyPage() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader
        eyebrow="Purchases and Refunds"
        title="Credit purchases are handled through Apple on iOS."
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
          <a className="font-semibold text-emerald-700 underline underline-offset-4" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>{" "}
          or visit <TextLink href="/support">Support</TextLink>.
        </BodyText>
      </LegalCallout>
    </PageShell>
  );
}
