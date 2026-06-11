"use client";

/**
 * Sticky site header: gains a soft shadow once the page is scrolled and
 * keeps a persistent App Store CTA next to the nav on larger screens.
 */
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { PublicNav } from "@/components/PublicNav";

export function SiteHeader() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    function onScroll() {
      setIsScrolled(window.scrollY > 8);
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={[
        "site-header sticky top-0 z-20 border-b border-zinc-200 bg-white/95 backdrop-blur",
        isScrolled ? "is-scrolled" : "",
      ].join(" ")}
    >
      <div className="mx-auto flex w-full max-w-none flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-8 lg:px-12">
        <BrandLogo />
        <PublicNav />
      </div>
    </header>
  );
}
