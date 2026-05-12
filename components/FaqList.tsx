"use client";

import { useEffect, useState } from "react";
import { BodyText } from "@/components/PublicSite";

type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

export function FaqList({ items }: { items: readonly FaqItem[] }) {
  const defaultId = items[0]?.id ?? "";
  const [openId, setOpenId] = useState(defaultId);

  useEffect(() => {
    function syncWithHash() {
      const hashId = window.location.hash.replace(/^#/, "");
      const nextId = items.some((item) => item.id === hashId) ? hashId : defaultId;
      setOpenId(nextId);

      if (hashId) {
        const target = document.getElementById(hashId);
        target?.scrollIntoView({ block: "start" });
      }
    }

    syncWithHash();
    window.addEventListener("hashchange", syncWithHash);
    return () => window.removeEventListener("hashchange", syncWithHash);
  }, [defaultId, items]);

  return (
    <section className="divide-y divide-emerald-100 rounded-2xl border border-emerald-100 bg-white shadow-sm">
      {items.map((item) => {
        const isOpen = item.id === openId;

        return (
          <details
            key={item.id}
            id={item.id}
            className="group scroll-mt-28 px-5 py-4"
            open={isOpen}
            onToggle={(event) => {
              if ((event.currentTarget as HTMLDetailsElement).open) {
                setOpenId(item.id);
              }
            }}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg text-left text-lg font-extrabold text-zinc-950 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-4">
              {item.question}
              <span className="text-2xl leading-none text-emerald-700 transition group-open:rotate-45">+</span>
            </summary>
            <BodyText className="mt-3 max-w-3xl">{item.answer}</BodyText>
          </details>
        );
      })}
    </section>
  );
}
