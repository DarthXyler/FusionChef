import Link from "next/link";
import type { ReactNode } from "react";

type ClassNameProps = {
  className?: string;
};

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function PageShell({
  children,
  maxWidth = "max-w-5xl",
}: {
  children: ReactNode;
  maxWidth?: "max-w-4xl" | "max-w-5xl" | "max-w-6xl";
}) {
  return (
    <div className={joinClasses("mx-auto w-full animate-rise-in space-y-12 lg:space-y-14", maxWidth)}>
      {children}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode } & ClassNameProps) {
  return (
    <p
      className={joinClasses(
        "inline-flex rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function PageHeader({
  eyebrow,
  title,
  children,
  meta,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  meta?: string;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-emerald-100 bg-white px-6 py-8 shadow-sm md:px-8 md:py-10">
      <div aria-hidden="true" className="absolute right-0 top-0 h-24 w-24 rounded-bl-full bg-emerald-50 sm:h-32 sm:w-32" />
      <div className="relative">
        <Eyebrow className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">{eyebrow}</Eyebrow>
        <h1 className="mt-4 max-w-4xl text-3xl font-extrabold leading-tight text-zinc-950 md:text-5xl">{title}</h1>
        <div className="mt-4 max-w-3xl text-base leading-8 text-zinc-700 md:text-lg">{children}</div>
      </div>
      {meta ? <p className="mt-4 text-sm text-zinc-500">{meta}</p> : null}
    </section>
  );
}

export function SectionIntro({
  eyebrow,
  title,
  children,
  className,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
} & ClassNameProps) {
  return (
    <div className={joinClasses("max-w-2xl space-y-3", className)}>
      {eyebrow ? (
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">{eyebrow}</p>
      ) : null}
      <h2 className="font-serif text-3xl leading-tight text-zinc-950">{title}</h2>
      {children ? <div className="leading-8 text-zinc-700">{children}</div> : null}
    </div>
  );
}

export function Card({
  children,
  className,
  tone = "white",
}: {
  children: ReactNode;
  tone?: "white" | "green";
} & ClassNameProps) {
  return (
    <article
      className={joinClasses(
        "rounded-lg border p-6 shadow-sm",
        tone === "green" ? "border-emerald-100 bg-emerald-50" : "border-zinc-200 bg-white",
        className,
      )}
    >
      {children}
    </article>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold leading-7 text-zinc-950">{children}</h2>;
}

export function BodyText({ children, className }: { children: ReactNode } & ClassNameProps) {
  return <p className={joinClasses("leading-8 text-zinc-700", className)}>{children}</p>;
}

export function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center rounded-lg bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
    >
      {children}
    </Link>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 bg-white px-5 py-3 text-sm font-semibold text-zinc-900 transition hover:border-emerald-300 hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
    >
      {children}
    </Link>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-4">
      {children}
    </Link>
  );
}

export function SectionPanel({
  children,
  className,
  tone = "green",
}: {
  children: ReactNode;
  tone?: "green" | "white";
} & ClassNameProps) {
  return (
    <section
      className={joinClasses(
        "border-y px-0 py-8 md:py-10",
        tone === "green" ? "border-emerald-100 bg-emerald-50/70" : "border-zinc-200 bg-white",
        className,
      )}
    >
      {children}
    </section>
  );
}
