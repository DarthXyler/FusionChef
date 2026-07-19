import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { legalLastUpdated, SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Read how Flavor Fusion Chef handles account details, recipe and cookbook data, purchases, imported images, credits, and support requests.",
};

const policySections = [
  {
    title: "Information we collect",
    body: [
      "When you sign in, we may collect your account name, email address, profile image, authentication provider, and the provider-specific account identifier needed to connect your sign-in.",
      "Recipe text, cuisine preferences, meal type, spice level, and dietary preferences you choose to submit.",
      "Recipe photos or imported images you choose to use with app features.",
      "Saved cookbook records, generated recipe details, and related images you choose to keep.",
      "Device, anonymous identity, and session identifiers used to connect app activity, saved recipes, credits, authentication sessions, and support diagnostics.",
      "For credit purchases, store product identifiers, App Store transaction identifiers, Google Play order identifiers or purchase tokens, and purchase verification status. Flavor Fusion Chef does not receive or store your full payment-card details.",
      "Support messages you send, including your email address and any details or screenshots you include.",
    ],
  },
  {
    title: "How we use information",
    body: [
      "To generate fusion recipes, rerolls, shopping lists, substitutions, and related recipe images.",
      "To save and retrieve cookbook entries that you choose to keep.",
      "To authenticate your account, synchronize account-owned data, and maintain your signed-in session.",
      "To operate credits, verify App Store and Google Play purchases, prevent duplicate or fraudulent credit grants, and support purchase issues.",
      "To diagnose errors, prevent abuse, protect service reliability, and improve the app experience.",
    ],
  },
  {
    title: "Service providers",
    body: [
      "Flavor Fusion Chef uses hosted services for app hosting, database storage, file storage, AI generation, authentication, purchase verification, and email-based support.",
      "Those providers process only the data needed to provide the feature you requested or to keep the service operating securely.",
      "Credit purchases are processed by Apple through the App Store on iOS and by Google through Google Play on Android. Their privacy terms also apply to information they process as the payment and storefront providers.",
    ],
  },
  {
    title: "Your choices and data rights",
    body: [
      "You can choose not to submit a recipe, not to import photos, and not to save generated recipes.",
      "You can delete saved recipes in the app where deletion is available. You may contact support to request help accessing, correcting, or deleting account-related data, subject to records we must retain for security, fraud prevention, legal, or transaction-integrity purposes.",
      "For account deletion help, visit the Support page using the delete-account topic. We may need to verify that the request comes from the account holder before acting on it.",
      "If credits are missing after a completed purchase, tell support the platform or store, credit pack, approximate purchase time, and the relevant receipt, transaction, or order information. Do not send full payment-card details.",
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
          This policy explains what the app may process when you sign in, generate recipes, import
          recipe photos, save cookbook entries, purchase or use credits, or contact support.
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
