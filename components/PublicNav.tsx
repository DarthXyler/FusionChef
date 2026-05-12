"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
  exact?: boolean;
};

const navItems: NavItem[] = [
  { href: "/#features", label: "Features", exact: true },
  { href: "/pricing", label: "Pricing" },
  { href: "/faq", label: "FAQ" },
  { href: "/support", label: "Support" },
];

function isActivePath(pathname: string, href: string, exact?: boolean) {
  if (exact) {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PublicNav() {
  const pathname = usePathname();

  return (
    <nav className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto text-sm font-extrabold sm:gap-4 sm:text-base md:gap-8">
      {navItems.map((item) => {
        const isActive = isActivePath(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={[
              "whitespace-nowrap rounded-lg px-2.5 py-2 transition sm:px-3",
              isActive
                ? "bg-emerald-500 text-white shadow-sm hover:bg-emerald-600"
                : "text-zinc-700 hover:bg-emerald-50 hover:text-emerald-800",
            ].join(" ")}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
