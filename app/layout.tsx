/**
 * Root layout for every page in the app.
 * It defines the global header/navigation and wraps each screen with shared spacing.
 */
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Flavor Fusion Chef",
    template: "%s | Flavor Fusion Chef",
  },
  description:
    "Generate practical fusion recipes from a base recipe, then save, reroll, and shop from your cookbook.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="relative antialiased">
        <div aria-hidden="true" className="app-background-layer pointer-events-none fixed inset-0">
          <div className="app-background-side app-background-side-left" />
          <div className="app-background-side app-background-side-right" />
        </div>
        <div className="relative z-10 flex min-h-screen flex-col">
          {/* Global top bar shown on all screens */}
          <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white">
            <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 md:px-6 lg:px-8 xl:px-10">
              <Link href="/" className="font-brand text-2xl text-zinc-900">
                Flavor Fusion Chef
              </Link>
              <nav className="flex items-center gap-2 text-sm font-medium">
                <Link
                  href="/?reset=1"
                  className="rounded-full px-4 py-2 text-zinc-700 transition hover:bg-zinc-100"
                >
                  Home
                </Link>
                <Link
                  href="/cookbook"
                  className="rounded-full bg-emerald-500 px-4 py-2 text-white transition hover:bg-emerald-600"
                >
                  Cookbook
                </Link>
              </nav>
            </div>
          </header>
          {/* Current page content gets injected here */}
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-6 md:py-10 lg:px-8 xl:px-10">{children}</main>
        </div>
      </body>
    </html>
  );
}
