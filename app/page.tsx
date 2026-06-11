import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BodyText, TextLink } from "@/components/PublicSite";
import { PhoneScreenCarousel } from "@/components/PhoneScreenCarousel";
import { Reveal } from "@/components/Reveal";
import { fallbackCreditPacks } from "@/lib/public-site-content";
import { fusionFeatures, homeFaqItems, howItWorksSteps } from "@/lib/landing-content";

export const metadata: Metadata = {
  title: "Turn Any Recipe Into Wild Fusion Cuisine",
  description:
    "Flavor Fusion Chef is the AI-powered iPhone app that smashes any recipe into a new cuisine — Sichuan Bolognese, Ramen Carbonara, Bulgogi Burritos. One-time credits, no subscription.",
  alternates: {
    canonical: "/",
  },
};

const appStoreUrl = "https://apps.apple.com/us/app/flavor-fusion-chef/id6764818879";

/*
 * Testimonials: real App Store reviews are not in yet, so the section is
 * intentionally not rendered. Placeholder data lives in
 * lib/landing-content.ts (placeholderTestimonials) ready to wire in
 * between Features and Pricing when reviews arrive.
 */

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "MobileApplication",
      name: "Flavor Fusion Chef",
      operatingSystem: "iOS",
      applicationCategory: "FoodApplication",
      description:
        "AI-powered cooking app that turns any recipe into a practical fusion recipe with cuisine, spice, and dietary preferences.",
      url: "https://www.flavorfusionchef.com/",
      installUrl: appStoreUrl,
      offers: fallbackCreditPacks.map((pack) => ({
        "@type": "Offer",
        name: pack.name,
        price: pack.price.replace("$", ""),
        priceCurrency: "USD",
      })),
    },
    {
      "@type": "FAQPage",
      mainEntity: homeFaqItems.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
};

function AppStoreBadge({ className = "" }: { className?: string }) {
  return (
    <Image
      src="/landing/app-store-download-badge.png"
      alt="Download on the App Store"
      width={258}
      height={76}
      className={`app-store-badge ${className}`}
    />
  );
}

function SteamWisps() {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[38%] z-10">
      <span className="steam-wisp" style={{ left: "-18px", animationDelay: "0s" }} />
      <span className="steam-wisp" style={{ left: "0px", animationDelay: "0.9s" }} />
      <span className="steam-wisp" style={{ left: "18px", animationDelay: "1.7s" }} />
    </span>
  );
}

export default function Home() {
  return (
    <div className="animate-rise-in space-y-12 lg:space-y-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      {/* ---------- Hero ---------- */}
      <section className="hero-scene relative -mx-4 -mt-6 overflow-hidden border-y border-emerald-100 bg-white md:-mx-8 md:-mt-10 lg:-mx-12">
        <div aria-hidden="true" className="hero-food-edge hero-food-left" />
        <div aria-hidden="true" className="hero-food-edge hero-food-right" />
        <div aria-hidden="true" className="hero-canvas-glow absolute inset-0" />
        <div aria-hidden="true" className="hero-warm-wash absolute inset-0" />
        <div className="relative grid min-h-[580px] items-start gap-8 px-5 py-8 sm:px-8 lg:min-h-[560px] lg:grid-cols-[1fr_0.72fr] lg:gap-12 lg:px-24 lg:py-14 xl:px-32">
          <div className="max-w-[660px] space-y-5">
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
              <h1 className="hero-copy hero-copy-delay-1 max-w-[680px] text-[40px] font-extrabold leading-[1.08] text-zinc-950 sm:text-[54px] lg:text-[60px] xl:text-[62px]">
                <span className="block">Turn any recipe</span>
                <span className="block">
                  into a{" "}
                  <span className="relative inline-block">
                    <span className="text-emerald-700">new</span>{" "}
                    <span style={{ color: "var(--warm-ember)" }}>favorite</span>
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
              <p className="hero-copy hero-copy-delay-2 max-w-[490px] text-lg leading-8 text-zinc-600 sm:text-[20px] sm:leading-9">
                The AI chef that smashes cuisines together — gloriously. Import any
                recipe, pick a flavor world, and cook the mashup tonight.
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
                  href="#pricing"
                  className="inline-flex min-h-14 w-full min-w-0 items-center justify-center gap-3 rounded-xl border-2 border-emerald-700 bg-white px-5 text-base font-extrabold text-emerald-800 transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 sm:min-h-[68px] sm:px-7 sm:text-lg"
                >
                  See pricing
                  <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              </div>
              <div className="grid w-full min-w-0 gap-3 text-[13px] font-extrabold text-emerald-900 sm:grid-cols-3">
                {["Pay-as-you-go credits", "No subscription", "Private cookbook"].map((chip, index) => (
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
                    <span className="min-w-0">{chip}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <PhoneScreenCarousel />
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section id="how-it-works" className="anchor-section relative -mx-4 overflow-hidden bg-white px-4 py-6 md:-mx-8 md:px-8 lg:-mx-12 lg:px-12">
        <Reveal className="text-center">
          <p className="text-sm font-extrabold uppercase tracking-wide text-emerald-700">How it works</p>
          <h2 className="mt-2 text-[32px] font-extrabold leading-tight text-zinc-950 sm:text-[38px]">
            From &ldquo;same old dinner&rdquo; to fusion magic.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-lg leading-8 text-zinc-600">
            Four steps. One gloriously mashed-up meal.
          </p>
        </Reveal>
        <div className="mx-auto mt-10 grid max-w-6xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {howItWorksSteps.map((step, index) => (
            <Reveal key={step.title} delay={(index % 4) as 0 | 1 | 2 | 3}>
              <article className="food-card group h-full overflow-hidden rounded-2xl border border-emerald-100 bg-white shadow-sm">
                <div className="relative aspect-[4/3] overflow-hidden">
                  {/* No steam on step 2 — raw ingredients, nothing hot. */}
                  {index !== 1 ? <SteamWisps /> : null}
                  <Image
                    src={step.image}
                    alt={step.imageAlt}
                    fill
                    sizes="(max-width: 640px) 92vw, (max-width: 1024px) 46vw, 280px"
                    className="food-card-image object-cover"
                  />
                  <span className="absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/95 text-base font-extrabold text-emerald-800 shadow-sm ring-1 ring-emerald-100">
                    {index + 1}
                  </span>
                  {index === 2 ? (
                    <span aria-hidden="true" className="absolute bottom-3 right-3 z-10 flex items-center rounded-full bg-white/95 px-2.5 py-1.5 shadow-sm ring-1 ring-amber-200">
                      <span className="fusion-collide-left text-sm">🍝</span>
                      <span className="fusion-collide-burst mx-0.5 text-base text-amber-500">✦</span>
                      <span className="fusion-collide-right text-sm">🌶️</span>
                    </span>
                  ) : null}
                </div>
                <div className="p-5">
                  <h3 className="text-lg font-extrabold leading-tight text-zinc-950">{step.title}</h3>
                  <p className="mt-2 leading-7 text-zinc-600">{step.body}</p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- Features ---------- */}
      <section id="features" className="features-scene anchor-section relative -mx-4 overflow-hidden bg-white px-4 py-12 md:-mx-8 md:px-8 lg:-mx-12 lg:px-12">
        <div aria-hidden="true" className="features-canvas-glow absolute inset-0" />
        <div className="relative mx-auto max-w-6xl">
          <Reveal className="max-w-2xl">
            <p className="text-sm font-extrabold uppercase tracking-wide text-emerald-700">Features</p>
            <h2 className="mt-2 text-[32px] font-extrabold leading-tight text-zinc-950 sm:text-[38px]">
              Built for playful cooks, not busywork.
            </h2>
            <p className="mt-3 max-w-lg text-lg leading-8 text-zinc-600">
              Quick inputs, useful rerolls, photo import, and a cookbook that keeps your
              wildest successful experiments close.
            </p>
          </Reveal>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {fusionFeatures.map((feature, index) => (
              <Reveal key={feature.title} delay={(index % 4) as 0 | 1 | 2 | 3}>
                <article className="food-card wiggle-on-hover h-full overflow-hidden rounded-2xl border border-emerald-100 bg-white shadow-sm">
                  <div className="relative aspect-[4/3] overflow-hidden">
                    <Image
                      src={feature.image}
                      alt={feature.imageAlt}
                      fill
                      sizes="(max-width: 640px) 92vw, (max-width: 1024px) 46vw, 280px"
                      className="food-card-image object-cover"
                    />
                    <span className="absolute bottom-3 left-3 z-10 rounded-full bg-white/95 px-3 py-1 text-xs font-extrabold text-amber-700 shadow-sm ring-1 ring-amber-200">
                      <span className="wiggle-target inline-block">{feature.dish}</span>
                    </span>
                  </div>
                  <div className="p-5">
                    <h3 className="text-lg font-extrabold leading-tight text-zinc-950">{feature.title}</h3>
                    <p className="mt-2 leading-7 text-zinc-600">{feature.body}</p>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- Pricing ---------- */}
      <section id="pricing" className="anchor-section mx-auto max-w-6xl py-4">
        <Reveal className="text-center">
          <p className="text-sm font-extrabold uppercase tracking-wide text-emerald-700">Pricing</p>
          <h2 className="mt-2 text-[32px] font-extrabold leading-tight text-zinc-950 sm:text-[38px]">
            No subscription. Ever.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-lg leading-8 text-zinc-600">
            Pay as you go: buy a credit pack, and each fusion or reroll uses credits from
            your balance. Top up only when you need more — nothing renews automatically.
          </p>
        </Reveal>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {fallbackCreditPacks.map((pack, index) => (
            <Reveal key={pack.name} delay={(index % 3) as 0 | 1 | 2}>
              <article
                className={[
                  "food-card relative h-full rounded-2xl border bg-white p-6 shadow-sm",
                  pack.featured ? "border-amber-300 ring-2 ring-amber-200" : "border-emerald-100",
                ].join(" ")}
              >
                {pack.featured ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-500 px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-white shadow-sm">
                    Most popular
                  </span>
                ) : null}
                <h3 className="text-xl font-extrabold text-zinc-950">{pack.name}</h3>
                <p className="mt-3 flex items-baseline gap-2">
                  <span className="text-4xl font-extrabold text-emerald-800">{pack.price}</span>
                  <span className="text-sm font-bold text-zinc-500">one-time</span>
                </p>
                <p className="mt-1 text-sm font-extrabold text-amber-700">{pack.credits} credits</p>
                <p className="mt-3 leading-7 text-zinc-600">{pack.description}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <Reveal className="mt-6 text-center">
          <p className="text-sm leading-7 text-zinc-500">
            Purchases are handled by Apple in the App Store.{" "}
            <TextLink href="/pricing">Full pricing details</TextLink>
          </p>
        </Reveal>
      </section>

      {/* ---------- FAQ ---------- */}
      <section id="faq" className="anchor-section mx-auto grid max-w-6xl gap-8 py-6 lg:grid-cols-[0.8fr_1.2fr]">
        <Reveal>
          <p className="text-sm font-extrabold uppercase tracking-wide text-emerald-700">Questions</p>
          <h2 className="mt-3 text-[32px] font-extrabold leading-tight text-zinc-950 sm:text-[36px]">
            Everything before your first mashup.
          </h2>
          <p className="mt-3 max-w-md leading-8 text-zinc-600">
            Quick answers about fusion quality, credits, photo import, and saves.
          </p>
          <div className="mt-5">
            <TextLink href="/faq">Read all FAQs</TextLink>
          </div>
        </Reveal>
        <Reveal delay={1}>
          <div className="divide-y divide-emerald-100 rounded-2xl border border-emerald-100 bg-white shadow-sm">
            {homeFaqItems.map((item, index) => (
              <details key={item.id} className="group px-5 py-4" open={index === 0}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg text-left text-lg font-extrabold text-zinc-950 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-4">
                  {item.question}
                  <span className="text-2xl leading-none text-emerald-700 transition group-open:rotate-45">+</span>
                </summary>
                <BodyText className="mt-3 max-w-2xl">{item.answer}</BodyText>
              </details>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ---------- Final CTA ---------- */}
      <section className="relative -mx-4 -mt-6 -mb-6 overflow-hidden border-y border-emerald-100 px-5 py-12 text-white md:-mx-8 md:-mt-8 md:-mb-10 md:px-8 lg:-mx-12 lg:px-12">
        <Image
          src="/landing/fusion/cta-banner.jpg"
          alt=""
          fill
          sizes="100vw"
          className="object-cover"
          aria-hidden="true"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(100deg, rgba(4, 78, 56, 0.94) 0%, rgba(4, 96, 70, 0.88) 45%, rgba(124, 45, 18, 0.82) 100%)",
          }}
        />
        <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-6 md:flex-row md:items-center md:justify-between md:gap-8">
          <div className="text-center md:text-left">
            <p className="text-sm font-extrabold uppercase tracking-wide text-amber-200">Mobile app</p>
            <h2 className="mt-3 max-w-2xl text-[34px] font-extrabold leading-tight sm:text-[44px]">
              Tonight&rsquo;s dinner deserves a plot twist.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-emerald-50 md:mx-0">
              Download Flavor Fusion Chef and turn everyday meals into wild,
              cookable fusion dishes with AI.
            </p>
          </div>
          <div className="flex flex-col items-center gap-4 md:shrink-0">
            <Link
              href={appStoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download Flavor Fusion Chef on the App Store"
              className="mobile-cta-store-link"
            >
              <AppStoreBadge className="app-store-badge-large" />
            </Link>
            <div className="flex gap-3">
              <Link
                href="/pricing"
                className="inline-flex min-h-12 items-center justify-center rounded-xl bg-white px-5 text-sm font-extrabold text-emerald-800 shadow-sm transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-emerald-700"
              >
                View pricing
              </Link>
              <Link
                href="/support"
                className="inline-flex min-h-12 items-center justify-center rounded-xl border border-white/50 px-5 text-sm font-extrabold text-white transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-emerald-700"
              >
                Contact support
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
