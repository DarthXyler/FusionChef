import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { legalLastUpdated, SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Read how Flavor Fusion Chef handles recipe inputs, mobile cookbook data, imported images, credits, and support requests.",
};

const policySections = [
  {
    title: "Information we collect",
    body: [
      "Recipe text, cuisine preferences, meal type, spice level, and dietary preferences you choose to submit.",
      "Recipe photos or imported images you choose to use with app features.",
      "Saved cookbook records, generated recipe details, and related images you choose to keep.",
      "Anonymous device or session identifiers used to connect app activity, saved recipes, credits, and support diagnostics.",
      "Support messages you send, including your email address and any details or screenshots you include.",
    ],
  },
  {
    title: "How we use information",
    body: [
      "To generate fusion recipes, rerolls, shopping lists, substitutions, and related recipe images.",
      "To save and retrieve cookbook entries that you choose to keep.",
      "To operate credits, purchase verification, fraud prevention, and support workflows.",
      "To diagnose errors, prevent abuse, protect service reliability, and improve the app experience.",
    ],
  },
  {
    title: "Service providers",
    body: [
      "Flavor Fusion Chef uses hosted services for app hosting, database storage, file storage, AI generation, authentication, purchase verification, and email-based support.",
      "Those providers process only the data needed to provide the feature you requested or to keep the service operating securely.",
    ],
  },
  {
    title: "Your choices",
    body: [
      "You can choose not to submit a recipe, not to import photos, and not to save generated recipes.",
      "You can delete saved recipes in the app where deletion is available, or contact support for help with data-related requests.",
      "You can contact support if credits or purchase-related state appears incorrect after a completed Apple purchase.",
    ],
  },
  {
    title: "Children",
    body: [
      "Flavor Fusion Chef is intended for general cooking use and is not designed to knowingly collect personal information from children.",
    ],
  },
  {
    title: "Updates",
    body: [
      "We may update this Privacy Policy as the product changes. The latest published version on this page is the version that applies.",
    ],
  },
] as const;

export default function PrivacyPage() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader
        eyebrow="Privacy Policy"
        title="How Flavor Fusion Chef handles your data."
        meta={`Last updated: ${legalLastUpdated}`}
      >
        <p>
          This policy explains what the app may process when you generate recipes, import recipe
          photos, save cookbook entries, use credits, or contact support.
        </p>
      </PageHeader>

      <LegalSectionList sections={policySections} />

      <LegalCallout title="Contact">
        <BodyText className="mt-3">
          Privacy questions or data-related requests can be sent to{" "}
          <a
            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4"
            href={`mailto:${SUPPORT_EMAIL}?subject=Flavor%20Fusion%20Chef%20Privacy`}
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </BodyText>
        <p className="mt-4 text-sm text-zinc-600">
          For purchase or app support, visit <TextLink href="/support">Support</TextLink>.
        </p>
      </LegalCallout>
    </PageShell>
  );
}
