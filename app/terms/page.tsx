import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { legalLastUpdated, SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Terms and Conditions",
  description: "Flavor Fusion Chef terms for app usage, generated recipes, credits, and support.",
};

const termsSections = [
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
      "Apple processes iOS purchases. Purchase availability, local pricing, taxes, receipts, and refunds are handled through Apple's systems and policies.",
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
