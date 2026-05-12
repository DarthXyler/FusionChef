import type { Metadata } from "next";
import { BodyText, Card, CardTitle, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with Flavor Fusion Chef recipe generation, cookbook saves, mobile imports, credits, and account questions.",
};

const supportTopics = [
  {
    title: "Credits and purchases",
    body: "Include the credit pack, purchase time, and whether Apple showed the purchase as complete.",
    href: "/refund-policy",
  },
  {
    title: "Recipe generation",
    body: "Share the base recipe, cuisine choice, and what looked wrong or unexpected.",
    href: "/faq#recipe-generation-help",
  },
  {
    title: "Recipe photo import",
    body: "Mention whether the image came from camera or library, plus any error message you saw.",
    href: "/faq#recipe-photo-import",
  },
  {
    title: "Cookbook saves",
    body: "Include the recipe title and whether the issue happened after reinstalling or changing devices.",
    href: "/faq#cookbook-saves",
  },
] as const;

export default function SupportPage() {
  return (
    <PageShell maxWidth="max-w-5xl">
      <PageHeader eyebrow="Support" title="Help for your mobile cookbook.">
        <p>
          Get help with purchases, credits, recipe generation, photo imports, saved recipes, and
          privacy questions.
        </p>
      </PageHeader>

      <section className="grid gap-5 md:grid-cols-2">
        {supportTopics.map((topic) => (
          <Card key={topic.title} className="border-emerald-100 transition hover:-translate-y-1 hover:shadow-md">
            <CardTitle>{topic.title}</CardTitle>
            <BodyText className="mt-3">{topic.body}</BodyText>
            <div className="mt-4">
              <TextLink href={topic.href}>Related information</TextLink>
            </div>
          </Card>
        ))}
      </section>

      <Card tone="green" className="overflow-hidden">
        <div className="grid gap-6 md:grid-cols-[0.78fr_1.22fr] md:items-start">
          <div className="space-y-3 md:pr-3">
            <h2 className="text-3xl font-extrabold leading-tight text-zinc-950">Contact support</h2>
            <BodyText className="max-w-md">
              Email support with details that help reproduce the issue.
            </BodyText>
          </div>
          <div className="rounded-lg border border-emerald-100 bg-white px-5 py-5 shadow-sm">
            <a
              className="text-lg font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4"
              href={`mailto:${SUPPORT_EMAIL}?subject=Flavor%20Fusion%20Chef%20Support`}
            >
              {SUPPORT_EMAIL}
            </a>
            <ul className="mt-4 list-disc space-y-2 pl-5 leading-7 text-zinc-700 marker:text-emerald-500">
              <li>what you were trying to do</li>
              <li>your device model and app version if available</li>
              <li>the recipe title, credit pack, or screen involved</li>
              <li>screenshots if they help explain the issue</li>
            </ul>
          </div>
        </div>
      </Card>
    </PageShell>
  );
}
