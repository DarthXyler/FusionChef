import type { Metadata } from "next";
import { FaqList } from "@/components/FaqList";
import { BodyText, Card, PageHeader, PageShell, PrimaryLink } from "@/components/PublicSite";
import { faqItems, supportFaqItems } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers to common Flavor Fusion Chef mobile app, credits, cookbook, and support questions.",
};

export default function FaqPage() {
  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader eyebrow="FAQ" title="Questions before you start cooking.">
        <p>Quick answers about the mobile app, credits, recipe imports, cookbook saves, and support.</p>
      </PageHeader>

      <FaqList items={faqItems} supportItems={supportFaqItems} />

      <Card tone="green">
        <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">Still need help?</h2>
        <BodyText className="mt-3">
          Send a support note with your device, what you were trying to do, and what happened.
        </BodyText>
        <div className="mt-5">
          <PrimaryLink href="/support">Visit support</PrimaryLink>
        </div>
      </Card>
    </PageShell>
  );
}
