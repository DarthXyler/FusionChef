/**
 * Root layout for every page in the app.
 * It defines the global header/navigation and wraps each screen with shared spacing.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";
import { PublicNav } from "@/components/PublicNav";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Flavor Fusion Chef",
    template: "%s | Flavor Fusion Chef",
  },
  description:
    "Flavor Fusion Chef is a cheerful mobile cooking app for turning familiar recipes into practical fusion favorites.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="relative antialiased">
        <div aria-hidden="true" className="app-background-layer pointer-events-none fixed inset-0" />
        <div className="relative z-10 flex min-h-screen flex-col">
          {/* Public top bar shared by marketing, support, legal, and admin pages. */}
          <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/95 backdrop-blur">
            <div className="mx-auto flex w-full max-w-none flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-8 lg:px-12">
              <BrandLogo />
              <PublicNav />
            </div>
          </header>
          {/* Current page content gets injected here */}
          <main className="mx-auto w-full max-w-none flex-1 px-4 py-6 md:px-8 md:py-10 lg:px-12">
            {children}
          </main>
          <footer className="border-t border-emerald-100 bg-emerald-50/55">
            <div className="mx-auto grid w-full max-w-none gap-8 px-4 py-10 text-sm text-zinc-600 md:grid-cols-[1.2fr_1fr_1fr] md:px-8 lg:px-12">
              <div>
                <p className="text-lg font-extrabold text-zinc-950">Flavor Fusion Chef</p>
                <p className="mt-3 max-w-sm leading-7">
                  A cheerful mobile cooking app for turning familiar recipes into practical fusion
                  favorites.
                </p>
              </div>
              <nav className="grid gap-2">
                <p className="font-extrabold uppercase text-emerald-700">App</p>
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
                <p>Mobile-first recipe fusion.</p>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
