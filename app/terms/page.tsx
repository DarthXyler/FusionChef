import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import {
  legalLastUpdated,
  STORE_REFUND_SUMMARY,
  SUPPORT_EMAIL,
} from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description: "Flavor Fusion Chef terms for app usage, generated recipes, credits, and support.",
};

const termsSections = [
  {
    title: "Accounts",
    body: [
      "Some features require a signed-in account. You are responsible for using an account you are authorized to access and for keeping access to your device and authentication provider secure.",
      "Account, cookbook, credit, and purchase-verification records may be associated with your authentication provider and device or session identifiers so the service can synchronize data and prevent duplicate credit grants.",
    ],
  },
  {
    title: "Use of the app",
    body: [
      "Flavor Fusion Chef helps create recipe ideas and cooking guidance. You are responsible for reviewing ingredients, allergens, food safety, cooking times, and suitability before preparing or serving any recipe.",
      "Do not use the service for unlawful activity, abuse, reverse engineering, automated scraping, or attempts to bypass app limits or credit rules.",
    ],
  },
  {
    title: "Generated content",
    body: [
      "Generated recipes are suggestions and may contain mistakes. Check measurements, substitutions, temperatures, and food safety steps before cooking.",
      "You may use recipes generated for your personal cooking. The app may store generated results only when needed to provide features you request, such as cookbook saves.",
    ],
  },
  {
    title: "Credits and purchases",
    body: [
      "Credits are consumable digital items used for recipe generation and rerolls. Credit packs are one-time purchases and are not subscriptions.",
      "Purchases are processed through the App Store on iOS and Google Play on Android. Store availability, local pricing, taxes, payment methods, and receipts are governed by the applicable storefront and its policies.",
      "Flavor Fusion Chef verifies store product and transaction information before granting credits. We do not receive or store full payment-card details.",
      STORE_REFUND_SUMMARY,
    ],
  },
  {
    title: "Availability and changes",
    body: [
      "Features may change as the mobile app evolves. Some features may be unavailable during testing, maintenance, or platform review.",
      "The older browser-based fusion interface may be disabled while the product focuses on the mobile app.",
    ],
  },
  {
    title: "Support and contact",
    body: [
      "If you experience app, purchase, cookbook, or privacy issues, contact support with enough detail to investigate the problem.",
      "For missing credits, include the platform or store, credit pack, approximate purchase time, and relevant receipt, transaction, or order information. Do not send full payment-card details or authentication secrets.",
    ],
  },
] as const;

export default function TermsPage() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader
        eyebrow="Terms and Conditions"
        title="Terms for using Flavor Fusion Chef."
        meta={`Last updated: ${legalLastUpdated}`}
      >
        <p>
          These terms explain the basic rules for using the app, generated recipes, credits, and
          support channels.
        </p>
      </PageHeader>

      <LegalSectionList sections={termsSections} />

      <LegalCallout title="Questions">
        <BodyText className="mt-3">
          Contact{" "}
          <a className="font-semibold text-emerald-700 underline underline-offset-4" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>{" "}
          or visit the <TextLink href="/support">Support page</TextLink>.
        </BodyText>
      </LegalCallout>
    </PageShell>
  );
}
