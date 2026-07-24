import type { Metadata } from "next";
import { LegalCallout, LegalSectionList } from "@/components/LegalSectionList";
import { BodyText, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Delete Your Account",
  description:
    "Learn how to request permanent deletion of your Flavor Fusion Chef account and associated account data.",
};

const accountDeletionLastUpdated = "July 24, 2026";
const deletionRequestEmail =
  "mailto:admin@flavorfusionchef.com?subject=Flavor%20Fusion%20Chef%20Account%20Deletion%20Request";

const deletionSections = [
  {
    title: "How to request deletion",
    body: [
      "In the app, go to Profile → Delete account → Contact Support. You can also email admin@flavorfusionchef.com to request deletion.",
      "Include the email address associated with your Flavor Fusion Chef account and tell us whether you use Apple, Google, or email sign-in.",
      "Never send your password, verification codes, access tokens, or purchase tokens.",
    ],
  },
  {
    title: "Identity verification",
    body: [
      "To protect your account, support may ask you to confirm the request from the email address associated with the account or provide other non-secret account information.",
      "Processing begins after we verify that the request comes from the account holder.",
    ],
  },
  {
    title: "What is deleted",
    body: [
      "Your Flavor Fusion Chef account and profile record, authentication and identity links, and linked device or account mappings.",
      "Saved cookbook recipes and associated saved recipe data.",
      "Your credit balance, credit reservations, credit ledger history, and daily usage records, except where limited records must be retained for legal, security, fraud-prevention, audit, or transaction-integrity purposes.",
    ],
  },
  {
    title: "What may be retained",
    body: [
      "We may retain limited purchase-verification, deletion-audit, security, fraud-prevention, legal, or transaction-integrity records where necessary.",
      "Support correspondence may remain subject to the retention practices of our email provider.",
      "Deleting your Flavor Fusion Chef account does not delete your Apple account, Google account, or app-store purchase history.",
    ],
  },
  {
    title: "Timing and permanence",
    body: [
      "Verified deletion requests are processed as soon as reasonably possible and within 30 days.",
      "Completed deletion is permanent. Deleted cookbook and credit data cannot be restored.",
      "If you sign in again later, Flavor Fusion Chef may create a new account rather than restore the deleted account.",
    ],
  },
] as const;

export default function DeleteAccountPage() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader
        eyebrow="Account deletion"
        title="Delete your Flavor Fusion Chef account."
        meta={`Last updated: ${accountDeletionLastUpdated}`}
      >
        <p>
          Follow these steps to request permanent deletion of your account and associated account
          data.
        </p>
      </PageHeader>

      <LegalSectionList sections={deletionSections} />

      <LegalCallout title="Request account deletion">
        <BodyText className="mt-3">
          Review the{" "}
          <TextLink href="/support?topic=delete-account">
            account deletion support guidance
          </TextLink>{" "}
          before sending your request.
        </BodyText>
        <BodyText className="mt-3">
          When you are ready,{" "}
          <a
            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            href={deletionRequestEmail}
          >
            email Flavor Fusion Chef support to request account deletion
          </a>
          . Requests are handled at {SUPPORT_EMAIL}.
        </BodyText>
      </LegalCallout>
    </PageShell>
  );
}
