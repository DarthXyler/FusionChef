/**
 * Root layout for every page in the app.
 * It defines the global header/navigation and wraps each screen with shared spacing.
 */
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

const siteUrl = "https://www.flavorfusionchef.com";
const appStoreUrl = "https://apps.apple.com/us/app/flavor-fusion-chef/id6764818879";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Flavor Fusion Chef — Turn Any Recipe Into Wild Fusion Cuisine",
    template: "%s | Flavor Fusion Chef",
  },
  description:
    "The AI-powered iPhone app that smashes any recipe into a new cuisine — Sichuan Bolognese, Ramen Carbonara, Bulgogi Burritos. One-time credits, no subscription.",
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Flavor Fusion Chef",
    title: "Flavor Fusion Chef — Turn Any Recipe Into Wild Fusion Cuisine",
    description:
      "The AI chef that smashes cuisines together — gloriously. Import any recipe, pick a flavor world, cook the mashup tonight.",
    images: [
      {
        // Placeholder OG image — replace per FUSION-IMAGE-PROMPTS.md
        url: "/landing/fusion/og-image.jpg",
        width: 1200,
        height: 630,
        alt: "Flavor Fusion Chef — wild fusion dishes made from everyday recipes",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Flavor Fusion Chef — Turn Any Recipe Into Wild Fusion Cuisine",
    description:
      "The AI chef that smashes cuisines together — gloriously. One-time credits, no subscription.",
    images: ["/landing/fusion/og-image.jpg"],
  },
  appleWebApp: {
    title: "Flavor Fusion Chef",
  },
  other: {
    "apple-itunes-app": "app-id=6764818879",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="relative antialiased">
        {/* Scroll-reveal sections start invisible and depend on JS; keep them visible without it. */}
        <noscript>
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
        <div aria-hidden="true" className="app-background-layer pointer-events-none fixed inset-0" />
        <div className="relative z-10 flex min-h-screen flex-col">
          {/* Public top bar shared by marketing, support, legal, and admin pages. */}
          <SiteHeader />
          {/* Current page content gets injected here */}
          <main className="mx-auto w-full max-w-none flex-1 px-4 py-6 md:px-8 md:py-10 lg:px-12">
            {children}
          </main>
          <footer className="border-t border-emerald-100 bg-emerald-50/55">
            <div className="mx-auto grid w-full max-w-none gap-8 px-4 py-10 text-sm text-zinc-600 md:grid-cols-[1.4fr_1fr_1fr] md:px-8 lg:px-12">
              <div>
                <p className="text-lg font-extrabold text-zinc-950">Flavor Fusion Chef</p>
                <p className="mt-3 max-w-sm leading-7">
                  The AI-powered mobile app that turns familiar recipes into wild, cookable
                  fusion favorites. Sichuan Bolognese, anyone?
                </p>
                <Link
                  href={appStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Download Flavor Fusion Chef on the App Store"
                  className="mt-5 inline-block"
                >
                  <Image
                    src="/landing/app-store-download-badge.png"
                    alt="Download on the App Store"
                    width={172}
                    height={51}
                    className="rounded-xl"
                  />
                </Link>
              </div>
              <nav className="grid gap-2">
                <p className="font-extrabold uppercase text-emerald-700">App</p>
                <Link className="hover:text-emerald-700" href="/#how-it-works">How it works</Link>
                <Link className="hover:text-emerald-700" href="/#features">Features</Link>
                <Link className="hover:text-emerald-700" href="/pricing">Pricing</Link>
                <Link className="hover:text-emerald-700" href="/faq">FAQ</Link>
                <Link className="hover:text-emerald-700" href="/support">Support</Link>
              </nav>
              <nav className="grid gap-2">
                <p className="font-extrabold uppercase text-emerald-700">Company</p>
                <Link className="hover:text-emerald-700" href="/contact">Contact</Link>
                <Link className="hover:text-emerald-700" href="/privacy">Privacy Policy</Link>
                <Link className="hover:text-emerald-700" href="/terms">Terms</Link>
                <Link className="hover:text-emerald-700" href="/refund-policy">Purchases and refunds</Link>
              </nav>
            </div>
            <div className="border-t border-emerald-100">
              <div className="mx-auto flex w-full max-w-none flex-col gap-2 px-4 py-4 text-xs font-semibold text-zinc-500 md:flex-row md:items-center md:justify-between md:px-8 lg:px-12">
                <p>(c) 2026 Flavor Fusion Chef.</p>
                <p>Fusion first. Boring never.</p>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
