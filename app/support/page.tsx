import type { Metadata } from "next";
import { BodyText, Card, CardTitle, PageHeader, PageShell, TextLink } from "@/components/PublicSite";
import { SUPPORT_EMAIL } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with Flavor Fusion Chef recipe generation, cookbook saves, mobile imports, credits, and account questions.",
};

type SupportTopic = "purchase" | "delete-account";

type SupportPageProps = {
  searchParams?: Promise<{ topic?: string | string[] | undefined }>;
};

const topicGuidance: Record<
  SupportTopic,
  {
    title: string;
    intro: string;
    guidanceTitle: string;
    guidance: readonly string[];
    emailSubject: string;
  }
> = {
  purchase: {
    title: "Help with a purchase or missing credits.",
    intro:
      "Use the details below when a completed App Store or Google Play purchase is not reflected in your credit balance.",
    guidanceTitle: "Purchase support details",
    guidance: [
      "Tell us whether you purchased through the App Store on iOS or Google Play on Android.",
      "Include the credit pack and approximate purchase date and time.",
      "Include receipt or order information shown by the store, but never send a purchase token or full payment-card details.",
    ],
    emailSubject: "Flavor Fusion Chef Purchase Support",
  },
  "delete-account": {
    title: "Request account deletion.",
    intro:
      "You can request deletion of your Flavor Fusion Chef account and associated account data through support.",
    guidanceTitle: "Account deletion guidance",
    guidance: [
      "Email from the address associated with your Flavor Fusion Chef account when possible.",
      "State that you are requesting account deletion and mention the sign-in provider you use.",
      "Support may need to verify that you control the account. Never send passwords, sign-in codes, or access tokens.",
    ],
    emailSubject: "Flavor Fusion Chef Account Deletion Request",
  },
};

const supportTopics = [
  {
    title: "Credits and purchases",
    body: "Include your platform or store, credit pack, approximate purchase time, and whether the store showed the purchase as complete.",
    href: "/refund-policy",
  },
  {
    title: "Recipe generation",
    body: "Share the base recipe, cuisine choice, and what looked wrong or unexpected.",
    href: "/faq?support=recipe-generation#support-recipe-generation",
  },
  {
    title: "Recipe photo import",
    body: "Mention whether the image came from camera or library, plus any error message you saw.",
    href: "/faq?support=recipe-photo-import#support-recipe-photo-import",
  },
  {
    title: "Cookbook saves",
    body: "Include the recipe title and whether the issue happened after reinstalling or changing devices.",
    href: "/faq?support=cookbook-saves#support-cookbook-saves",
  },
] as const;

function getSupportTopic(value: string | string[] | undefined): SupportTopic | null {
  if (typeof value !== "string") {
    return null;
  }

  return value === "purchase" || value === "delete-account" ? value : null;
}

export default async function SupportPage({ searchParams }: SupportPageProps) {
  const params = searchParams ? await searchParams : undefined;
  const selectedTopic = getSupportTopic(params?.topic);
  const selectedGuidance = selectedTopic ? topicGuidance[selectedTopic] : null;
  const emailSubject = selectedGuidance?.emailSubject ?? "Flavor Fusion Chef Support";
  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(emailSubject)}`;

  return (
    <PageShell maxWidth="max-w-5xl">
      <PageHeader
        eyebrow="Support"
        title={selectedGuidance?.title ?? "Help for your mobile cookbook."}
      >
        <p>
          {selectedGuidance?.intro ??
            "Get help with purchases, credits, recipe generation, photo imports, saved recipes, and privacy questions."}
        </p>
      </PageHeader>

      {selectedGuidance ? (
        <Card tone="green" className="border-emerald-200">
          <CardTitle>{selectedGuidance.guidanceTitle}</CardTitle>
          <ul className="mt-4 list-disc space-y-2 pl-5 leading-7 text-zinc-700 marker:text-emerald-500">
            {selectedGuidance.guidance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="mt-5">
            <TextLink href={mailtoHref}>Email support about this topic</TextLink>
          </div>
        </Card>
      ) : null}

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
              href={mailtoHref}
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
