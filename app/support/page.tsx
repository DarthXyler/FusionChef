import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with Flavor Fusion Chef recipe generation, cookbook saves, mobile imports, and general support questions.",
};

const supportTopics = [
  {
    title: "Recipe generation issues",
    body: "If a recipe fails to generate, includes a strange output, or produces the wrong image style, send the recipe title or input you used so the issue can be reproduced.",
  },
  {
    title: "Cookbook and saved recipes",
    body: "If saved recipes are missing, not syncing correctly, or behaving unexpectedly across sessions, include the device and a short description of what happened.",
  },
  {
    title: "Mobile app help",
    body: "If you hit problems with image import, sharing, scrolling, offline cookbook access, or screen layout, mention your device model and what screen you were on.",
  },
];

export default function SupportPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 animate-rise-in lg:space-y-10">
      <section className="space-y-3 rounded-[2rem] border border-emerald-100 bg-white px-6 py-8 shadow-sm sm:px-8">
        <p className="inline-block rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
          Support
        </p>
        <h1 className="font-serif text-4xl leading-tight text-zinc-900 md:text-5xl">
          Need help with Flavor Fusion Chef?
        </h1>
        <p className="max-w-3xl text-lg text-zinc-700">
          Send a note and include as much detail as you can. That makes it much easier to fix
          recipe, cookbook, import, or mobile app issues quickly.
        </p>
      </section>

      <section className="rounded-[2rem] border border-zinc-200 bg-white px-6 py-7 shadow-sm sm:px-8">
        <h2 className="font-serif text-2xl text-zinc-900">Contact support</h2>
        <p className="mt-3 text-base leading-8 text-zinc-700">
          Email{" "}
          <a
            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4"
            href="mailto:darthxyler@gmail.com"
          >
            darthxyler@gmail.com
          </a>{" "}
          for help with the web app or mobile app.
        </p>
        <p className="mt-3 text-base leading-8 text-zinc-700">
          Helpful details to include:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-base leading-8 text-zinc-700 marker:text-emerald-500">
          <li>what you were trying to do</li>
          <li>the recipe title or input used</li>
          <li>the device or browser you were using</li>
          <li>what happened instead of the expected result</li>
        </ul>
      </section>

      <section className="space-y-4 rounded-[2rem] border border-zinc-200 bg-white px-6 py-7 shadow-sm sm:px-8">
        <h2 className="font-serif text-2xl text-zinc-900">Common support topics</h2>
        {supportTopics.map((topic) => (
          <div key={topic.title} className="rounded-3xl border border-emerald-100 bg-emerald-50/60 px-5 py-4">
            <h3 className="text-lg font-semibold text-zinc-900">{topic.title}</h3>
            <p className="mt-2 text-base leading-8 text-zinc-700">{topic.body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-[2rem] border border-emerald-100 bg-white px-6 py-6 shadow-sm sm:px-8">
        <h2 className="font-serif text-2xl text-zinc-900">Privacy information</h2>
        <p className="mt-3 text-base leading-8 text-zinc-700">
          For details about how recipe inputs, saved cookbook entries, imported images, and
          support requests are handled, read the{" "}
          <Link
            className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4"
            href="/privacy"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
