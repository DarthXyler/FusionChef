import type { ReactNode } from "react";

type LegalSection = {
  title: string;
  body: readonly string[];
};

export function LegalSectionList({ sections }: { sections: readonly LegalSection[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-100 bg-white shadow-sm">
      {sections.map((section, index) => (
        <article key={section.title} className="grid gap-4 border-b border-emerald-100 p-5 last:border-b-0 md:grid-cols-[72px_1fr] md:p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-sm font-extrabold text-emerald-700 ring-1 ring-emerald-100">
            {String(index + 1).padStart(2, "0")}
          </div>
          <div>
            <h2 className="text-xl font-extrabold leading-tight text-zinc-950 sm:text-2xl">{section.title}</h2>
            <div className="mt-3 space-y-3 leading-8 text-zinc-700">
              {section.body.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

export function LegalCallout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5 shadow-sm sm:p-6">
      <h2 className="text-2xl font-extrabold leading-tight text-zinc-950 sm:text-3xl">{title}</h2>
      <div className="mt-3 leading-8 text-zinc-700">{children}</div>
    </section>
  );
}
