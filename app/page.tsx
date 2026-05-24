import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  BodyText,
  TextLink,
} from "@/components/PublicSite";
import { PhoneScreenCarousel } from "@/components/PhoneScreenCarousel";
import { faqItems, featureCards } from "@/lib/public-site-content";

export const metadata: Metadata = {
  title: "Mobile Recipe Fusion App",
  description:
    "Flavor Fusion Chef helps you turn familiar recipes into cheerful fusion favorites on iPhone.",
};

const steps = [
  {
    title: "Add a recipe",
    body: "Start with a recipe you already have.",
  },
  {
    title: "Choose a cuisine",
    body: "Pick the cuisine you want to blend into.",
  },
  {
    title: "Create and save",
    body: "Get a practical fusion version with steps, swaps, and a shopping list.",
  },
] as const;

const appStoreUrl = "https://apps.apple.com/us/app/flavor-fusion-chef/id6764818879";

function AppStoreBadge({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/landing/app-store-download-badge.jpg"
      alt="Download on the App Store"
      width={258}
      height={76}
      className={`app-store-badge ${className}`}
    />
  );
}

export default function Home() {
  const previewFaq = faqItems.slice(0, 3);

  return (
    <div className="animate-rise-in space-y-12 lg:space-y-14">
      <section className="hero-scene relative -mx-4 -mt-6 overflow-hidden border-y border-emerald-100 bg-white md:-mx-8 md:-mt-10 lg:-mx-12">
        <div aria-hidden="true" className="hero-food-edge hero-food-left" />
        <div aria-hidden="true" className="hero-food-edge hero-food-right" />
        <div aria-hidden="true" className="hero-canvas-glow absolute inset-0" />
        <div className="relative grid min-h-[580px] items-start gap-8 px-5 py-8 sm:px-8 lg:min-h-[560px] lg:grid-cols-[1fr_0.72fr] lg:gap-12 lg:px-24 lg:py-14 xl:px-32">
          <div className="max-w-[650px] space-y-5">
            <div className="hero-copy inline-flex items-center gap-2 rounded-full bg-emerald-50/95 py-1.5 pl-2 pr-4 text-sm font-extrabold uppercase tracking-[0.12em] text-emerald-700 ring-1 ring-emerald-100">
              <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-emerald-100">
                <Image
                  src="/landing/brand-leaves-mark.png"
                  alt=""
                  width={24}
                  height={16}
                  className="h-4 w-6 object-contain"
                />
              </span>
              AI recipe fusion app
            </div>
            <div className="space-y-4">
              <h1 className="hero-copy hero-copy-delay-1 relative max-w-[680px] text-[40px] font-extrabold leading-[1.08] text-zinc-950 sm:text-[54px] lg:text-[60px] lg:leading-[1.08] xl:text-[62px]">
                <svg
                  aria-hidden="true"
                  className="hero-sparkle absolute right-4 top-1 hidden h-9 w-9 text-amber-400 sm:block"
                  viewBox="0 0 32 32"
                  fill="none"
                >
                  <path d="M16 3l2.8 9.2L28 15l-9.2 2.8L16 27l-2.8-9.2L4 15l9.2-2.8L16 3Z" fill="currentColor" />
                </svg>
                <span className="block">Turn any recipe</span>
                <span className="block">
                  into a{" "}
                  <span className="relative inline-block text-emerald-700">
                    new favorite
                    <svg
                      aria-hidden="true"
                      className="hero-underline absolute -bottom-4 left-[-7%] h-8 w-[114%] text-amber-300"
                      viewBox="0 0 360 42"
                      fill="none"
                      preserveAspectRatio="none"
                    >
                      <path d="M8 26C92 8 246 7 352 23" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
                      <path d="M40 34C130 18 238 17 322 30" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.95" />
                    </svg>
                  </span>
                  .
                </span>
              </h1>
              <p className="hero-copy hero-copy-delay-2 max-w-[470px] text-lg leading-8 text-zinc-600 sm:text-[20px] sm:leading-9">
                Fuse cuisines, import recipe photos, and save your best creations in one cheerful
                mobile cookbook.
              </p>
            </div>
            <div className="hero-copy hero-copy-delay-3 w-full max-w-[560px] space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1.55fr_1fr] sm:gap-4">
                <Link
                  href={appStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Download Flavor Fusion Chef on the App Store"
                  className="hero-app-store-link"
                >
                  <AppStoreBadge className="app-store-badge-hero" />
                </Link>
                <Link
                  href="/pricing"
                  className="inline-flex min-h-14 w-full min-w-0 items-center justify-center gap-3 rounded-xl border-2 border-emerald-700 bg-white px-5 text-base font-extrabold text-emerald-800 transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 sm:min-h-[68px] sm:px-7 sm:text-lg"
                >
                  View pricing
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </div>
              <div className="grid w-full min-w-0 gap-3 text-[13px] font-extrabold text-emerald-900 sm:grid-cols-3">
                {["One-time credits", "No subscription", "Private cookbook"].map((chip, index) => (
                  <span
                    key={chip}
                    className="inline-flex min-h-[54px] min-w-0 items-center justify-center gap-2 rounded-xl bg-emerald-50/95 px-2 text-center ring-1 ring-emerald-100"
                  >
                    <svg aria-hidden="true" className="h-6 w-6 shrink-0 text-emerald-700" viewBox="0 0 24 24" fill="none">
                      {index === 0 ? (
                        <>
                          <path d="M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Z" stroke="currentColor" strokeWidth="2" />
                          <path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7" stroke="currentColor" strokeWidth="2" />
                          <path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" stroke="currentColor" strokeWidth="2" />
                        </>
                      ) : null}
                      {index === 1 ? (
                        <path
                          d="M12 3l7 3v5c0 4.4-2.8 8.2-7 10-4.2-1.8-7-5.6-7-10V6l7-3Z"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinejoin="round"
                        />
                      ) : null}
                      {index === 2 ? (
                        <>
                          <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
                          <path d="M8 10V8a4 4 0 0 1 8 0v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </>
                      ) : null}
                    </svg>
                    <span className="min-w-0 whitespace-nowrap">{chip}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <PhoneScreenCarousel />
        </div>
      </section>

      <section className="relative -mx-4 overflow-hidden bg-white px-4 py-4 text-center md:-mx-8 md:px-8 lg:-mx-12 lg:px-12">
        <div>
          <h2 className="text-[30px] font-extrabold leading-tight text-zinc-950 sm:text-[34px]">How it works</h2>
          <p className="mt-2 text-zinc-600">Create fusion recipes in just a few simple steps.</p>
        </div>
        <div className="relative mx-auto mt-8 grid max-w-4xl gap-8 text-center md:grid-cols-3">
          <div aria-hidden="true" className="absolute left-[18%] right-[18%] top-10 hidden border-t-2 border-dashed border-emerald-200 md:block" />
          {steps.map((step, index) => (
            <article key={step.title} className="relative">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 ring-2 ring-emerald-100">
                <svg aria-hidden="true" className="h-10 w-10 text-emerald-700" viewBox="0 0 48 48" fill="none">
                  {index === 0 ? (
                    <>
                      <path d="M12 27h24v10H12z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
                      <path d="M16 27c0-6 4-10 8-10s8 4 8 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      <path d="M17 34h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </>
                  ) : null}
                  {index === 1 ? (
                    <>
                      <path d="M14 18h20v20H14z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
                      <path d="M18 18v-4h12v4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      <path d="M20 27h8M20 33h12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </>
                  ) : null}
                  {index === 2 ? (
                    <>
                      <path d="M24 11v26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      <path d="M14 18c7 0 10 4 10 10-7 0-10-4-10-10Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
                      <path d="M34 18c-7 0-10 4-10 10 7 0 10-4 10-10Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
                      <path d="M17 37h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </>
                  ) : null}
                </svg>
              </div>
              <h3 className="mt-4 text-xl font-extrabold leading-tight text-zinc-950">{step.title}</h3>
              <p className="mx-auto mt-2 max-w-[230px] leading-7 text-zinc-600">{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="features" className="features-scene relative -mx-4 overflow-hidden bg-white px-4 py-12 md:-mx-8 md:px-8 lg:-mx-12 lg:px-12">
        <div aria-hidden="true" className="features-food-edge features-food-left" />
        <div aria-hidden="true" className="features-food-edge features-food-right" />
        <div aria-hidden="true" className="features-canvas-glow absolute inset-0" />
        <div className="relative mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
          <div className="space-y-4">
            <p className="text-sm font-extrabold uppercase text-emerald-700">Features</p>
            <h2 className="max-w-xl text-[32px] font-extrabold leading-tight text-zinc-950 sm:text-[38px]">
              Built for playful cooks, not busywork.
            </h2>
            <p className="max-w-lg text-lg leading-8 text-zinc-600">
              Quick inputs, useful rerolls, photo import, and a cookbook that keeps your best
              experiments close.
            </p>
            <TextLink href="/faq">See common questions</TextLink>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {featureCards.map((feature, index) => (
              <article
                key={feature.title}
                className="rounded-2xl border border-emerald-100 bg-emerald-50/55 p-5 shadow-sm transition hover:-translate-y-1 hover:bg-white hover:shadow-md"
              >
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-100">
                  <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 32 32" fill="none">
                    {index === 0 ? (
                      <>
                        <path d="M8 16c5-6 11-6 16 0-5 6-11 6-16 0Z" stroke="currentColor" strokeWidth="2.4" />
                        <path d="M16 11v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                      </>
                    ) : null}
                    {index === 1 ? (
                      <>
                        <rect x="7" y="9" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="2.4" />
                        <path d="M12 9l2-3h4l2 3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                        <circle cx="16" cy="16" r="3.2" stroke="currentColor" strokeWidth="2.4" />
                      </>
                    ) : null}
                    {index === 2 ? (
                      <>
                        <path d="M9 13v12h14V13" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
                        <path d="M12 13V9a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                      </>
                    ) : null}
                    {index === 3 ? (
                      <>
                        <path d="M8 18a8 8 0 1 0 3-6.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                        <path d="M8 9v7h7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </>
                    ) : null}
                  </svg>
                </div>
                <h3 className="text-xl font-extrabold leading-tight text-zinc-950">{feature.title}</h3>
                <p className="mt-3 leading-7 text-zinc-600">{feature.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-8 py-10 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <p className="text-sm font-extrabold uppercase text-emerald-700">Questions</p>
          <h2 className="mt-3 text-[32px] font-extrabold leading-tight text-zinc-950 sm:text-[36px]">
            A calmer way to launch.
          </h2>
          <p className="mt-3 max-w-md leading-8 text-zinc-600">
            Quick answers for users, reviewers, and support before opening the mobile app.
          </p>
          <div className="mt-5">
            <TextLink href="/faq">Read all FAQs</TextLink>
          </div>
        </div>
        <div className="divide-y divide-emerald-100 rounded-2xl border border-emerald-100 bg-white shadow-sm">
          {previewFaq.map((item) => (
            <details key={item.question} className="group px-5 py-4" open={item === previewFaq[0]}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg text-left text-lg font-extrabold text-zinc-950 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-4">
                {item.question}
                <span className="text-2xl leading-none text-emerald-700 transition group-open:rotate-45">+</span>
              </summary>
              <BodyText className="mt-3 max-w-2xl">{item.answer}</BodyText>
            </details>
          ))}
        </div>
      </section>

      <section className="mobile-cta-scene relative -mx-4 -mb-6 overflow-hidden rounded-none border-y border-emerald-100 bg-emerald-700 px-5 py-10 text-white md:-mx-8 md:-mb-10 md:px-8 lg:-mx-12 lg:px-12">
        <div aria-hidden="true" className="mobile-cta-art" />
        <div aria-hidden="true" className="mobile-cta-overlay absolute inset-0" />
        <div className="relative mx-auto flex max-w-6xl flex-col gap-7 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col items-center gap-[30px] text-center md:flex-row md:text-left">
            <div>
              <p className="text-sm font-extrabold uppercase text-emerald-100">Mobile app</p>
              <h2 className="mt-3 max-w-2xl text-[34px] font-extrabold leading-tight sm:text-[44px]">
                Now Available on iPhone
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-emerald-50 md:mx-0">
                Turn everyday meals into exciting fusion dishes with AI.
              </p>
            </div>
            <Link
              href={appStoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download Flavor Fusion Chef on the App Store"
              className="mobile-cta-store-link"
            >
              <AppStoreBadge className="app-store-badge-large" />
            </Link>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto md:shrink-0">
            <Link
              href="/pricing"
              className="inline-flex min-h-14 items-center justify-center rounded-xl bg-white px-6 text-base font-extrabold text-emerald-800 shadow-sm transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-emerald-700"
            >
              View pricing
            </Link>
            <Link
              href="/support"
              className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/45 px-6 text-base font-extrabold text-white transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-emerald-700"
            >
              Contact support
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
