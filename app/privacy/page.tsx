import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Read how Flavor Fusion Chef handles recipe inputs, saved cookbook data, imported images, and support requests.",
};

const policySections = [
  {
    title: "Information we collect",
    body: [
      "When you use Flavor Fusion Chef, we may process recipe text you enter, images you choose to import, and cookbook records you decide to save.",
      "We also store a device-level anonymous identifier for the mobile cookbook so saved recipes can be retrieved later without requiring a full account system.",
    ],
  },
  {
    title: "How we use information",
    body: [
      "We use your recipe input and selected options to generate fusion recipes, shopping lists, swaps, and related images.",
      "Saved cookbook data is used only to help you revisit recipes you chose to keep. Support emails are used to respond to questions or resolve issues.",
    ],
  },
  {
    title: "Storage and third-party services",
    body: [
      "Flavor Fusion Chef uses hosted infrastructure and service providers to operate the app, including cloud hosting, database storage, image storage, and AI generation services.",
      "Those providers may process limited data needed to deliver the feature you requested, such as generating a recipe or storing a cookbook entry.",
    ],
  },
  {
    title: "Your choices",
    body: [
      "You can choose not to save a recipe, delete saved cookbook recipes from the app, or contact support if you need help with stored data related to your usage.",
      "If you clear local app storage on your device, locally cached cookbook data may be removed, but recipes saved to the backend can still be retrieved when the app reconnects.",
    ],
  },
  {
    title: "Updates to this policy",
    body: [
      "We may update this Privacy Policy as the product evolves. The latest published version on this page will be the version that applies.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 animate-rise-in lg:space-y-10">
      <section className="space-y-3 rounded-[2rem] border border-emerald-100 bg-white px-6 py-8 shadow-sm sm:px-8">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          Privacy Policy
        </p>
        <h1 className="font-serif text-4xl leading-tight text-zinc-900 md:text-5xl">
          How Flavor Fusion Chef handles your data.
        </h1>
        <p className="max-w-3xl text-lg text-zinc-700">
          This page explains what we collect, why we use it, and how saved cookbook and imported
          recipe data are handled across the web app and mobile app.
        </p>
        <p className="text-sm text-zinc-500">Last updated: March 24, 2026</p>
      </section>

      <section className="space-y-4 rounded-[2rem] border border-zinc-200 bg-white px-6 py-7 shadow-sm sm:px-8">
        {policySections.map((section) => (
          <div key={section.title} className="space-y-2 border-b border-zinc-100 pb-5 last:border-b-0 last:pb-0">
            <h2 className="font-serif text-2xl text-zinc-900">{section.title}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph} className="text-base leading-8 text-zinc-700">
                {paragraph}
              </p>
            ))}
          </div>
        ))}
      </section>

      <section className="rounded-[2rem] border border-emerald-100 bg-emerald-50/70 px-6 py-6 shadow-sm sm:px-8">
        <h2 className="font-serif text-2xl text-zinc-900">Contact</h2>
        <p className="mt-3 text-base leading-8 text-zinc-700">
          Questions about this policy or a data-related request can be sent to{" "}
          <a
            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4"
            href="mailto:darthxyler@gmail.com"
          >
            darthxyler@gmail.com
          </a>
          .
        </p>
        <p className="mt-4 text-sm text-zinc-600">
          Need general help instead? Visit the{" "}
          <Link
            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4"
            href="/support"
          >
            Support page
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
