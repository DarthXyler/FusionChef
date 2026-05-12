import type { Metadata } from "next";
import { BodyText, Card, CardTitle, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { creditPacks } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "See Flavor Fusion Chef credit packs and how one-time mobile app credits work.",
};

const usageNotes = [
  "Credits are one-time consumable digital items.",
  "Credits can be used for recipe generation and rerolls in the mobile app.",
  "Credit packs do not renew automatically and are not subscriptions.",
  "Final local pricing and taxes are shown by Apple during purchase.",
] as const;

export default function PricingPage() {
  return (
    <PageShell maxWidth="max-w-5xl">
      <PageHeader eyebrow="Pricing" title="Simple one-time credit packs.">
        <p>
          Flavor Fusion Chef is planned around flexible credits, not a subscription. Buy a pack
          when you want more recipe generations or rerolls.
        </p>
      </PageHeader>

      <section className="grid gap-5 md:grid-cols-3">
        {creditPacks.map((pack) => (
          <Card
            key={pack.name}
            className={[
              "relative overflow-hidden p-6 pt-8 transition hover:-translate-y-1 hover:shadow-md",
              pack.featured ? "border-emerald-500 ring-2 ring-emerald-100" : "border-emerald-100",
            ].join(" ")}
          >
            {pack.featured ? (
              <>
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
                  <svg className="h-full w-full" viewBox="0 0 320 430" preserveAspectRatio="none" fill="none">
                    <path
                      className="featured-pack-trace"
                      d="M278 4H16Q4 4 4 16V414Q4 426 16 426H304Q316 426 316 414V16Q316 4 304 4H278"
                      stroke="#e4b74a"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray="118 1222"
                      filter="url(#featured-pack-glow)"
                    />
                    <defs>
                      <filter id="featured-pack-glow" x="-10" y="-10" width="340" height="450" filterUnits="userSpaceOnUse">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="0.9" result="blurred" />
                        <feMerge>
                          <feMergeNode in="blurred" />
                          <feMergeNode in="SourceGraphic" />
                        </feMerge>
                      </filter>
                    </defs>
                  </svg>
                  <span className="featured-pack-spark absolute right-[0.95rem] top-[0.6rem] text-[20px] leading-none text-[#e8c76a] drop-shadow-[0_0_5px_rgba(228,183,74,0.35)]">
                    ✦
                  </span>
                </div>
                <p className="absolute right-4 top-4 z-20 inline-flex rounded-full bg-emerald-600 px-3 py-1 text-xs font-extrabold uppercase text-white">
                  Popular
                </p>
              </>
            ) : null}
            <CardTitle>{pack.name}</CardTitle>
            <p className="mt-4 text-6xl font-extrabold leading-none text-zinc-950">{pack.credits}</p>
            <p className="text-sm font-extrabold text-zinc-500">credits</p>
            <p className="mt-5 text-2xl font-extrabold text-zinc-950">{pack.price}</p>
            <BodyText className="mt-4">{pack.description}</BodyText>
          </Card>
        ))}
      </section>

      <Card tone="green" className="overflow-hidden">
        <div className="grid gap-6 md:grid-cols-[0.78fr_1.22fr] md:items-start">
          <div className="space-y-3 md:pr-3">
            <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">How credits work</h2>
            <BodyText className="max-w-md">
              Credits keep the app flexible: use them when you want new generations or another recipe
              variation, then keep your favorite results in the cookbook.
            </BodyText>
          </div>
          <ul className="grid gap-3">
            {usageNotes.map((note) => (
              <li key={note} className="rounded-lg border border-emerald-100 bg-white px-4 py-3 text-zinc-700">
                {note}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card>
        <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">Purchase and refund note</h2>
        <BodyText className="mt-3">
          iOS purchases are processed by Apple. If you need help with a completed Apple purchase,
          start with Apple&apos;s purchase history and refund flow, then contact Flavor Fusion Chef
          support if the app did not reflect a completed purchase correctly.
        </BodyText>
        <div className="mt-5">
          <TextLink href="/refund-policy">Read the purchases and refunds page</TextLink>
        </div>
      </Card>
    </PageShell>
  );
}
