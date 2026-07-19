import type { Metadata } from "next";
import { BodyText, Card, PageHeader, PageShell, PrimaryLink, SecondaryLink } from "@/components/PublicSite";
import { SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Contact",
  description: "Contact Flavor Fusion Chef for app, purchase, privacy, or support questions.",
};

const contactReasons = [
  "Mobile app support",
  "Purchase or credit issue",
  "Privacy or data request",
  "Store review or business inquiry",
] as const;

export default function ContactPage() {
  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=Flavor%20Fusion%20Chef%20Support`;

  return (
    <PageShell maxWidth="max-w-4xl">
      <PageHeader eyebrow="Contact" title="Send a note to Flavor Fusion Chef.">
        <p>
          For now, email is the safest support path. It avoids collecting extra data through a web
          form and gives you space to include screenshots or details.
        </p>
      </PageHeader>

      <section className="grid gap-5 md:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">Email</h2>
          <div className="mt-4">
            <PrimaryLink href={mailtoHref}>{SUPPORT_EMAIL}</PrimaryLink>
          </div>
          <BodyText className="mt-4 text-sm leading-7 text-zinc-600">
            Please include your device model, app version if available, and the screen where the
            issue happened.
          </BodyText>
        </Card>

        <Card tone="green">
          <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">What to include</h2>
          <ul className="mt-4 space-y-3">
            {contactReasons.map((reason) => (
              <li key={reason} className="rounded-lg border border-emerald-100 bg-white px-4 py-3 text-zinc-700">
                {reason}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <Card>
        <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">Need a specific page?</h2>
        <div className="mt-4 flex flex-wrap gap-3">
          <SecondaryLink href="/faq">FAQ</SecondaryLink>
          <SecondaryLink href="/privacy">Privacy Policy</SecondaryLink>
          <SecondaryLink href="/terms">Terms</SecondaryLink>
        </div>
      </Card>
    </PageShell>
  );
}
