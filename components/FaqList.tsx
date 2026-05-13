"use client";

import { useEffect, useState } from "react";
import { BodyText } from "@/components/PublicSite";

type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

type SupportFaqItem = FaqItem & {
  supportKey: string;
};

export function FaqList({
  items,
  supportItems = [],
}: {
  items: readonly FaqItem[];
  supportItems?: readonly SupportFaqItem[];
}) {
  const defaultId = items[0]?.id ?? "";
  const [openId, setOpenId] = useState(defaultId);
  const [activeSupportKey, setActiveSupportKey] = useState("");

  useEffect(() => {
    function syncWithHash() {
      const params = new URLSearchParams(window.location.search);
      const supportKey = params.get("support") ?? "";
      const supportItem = supportItems.find((item) => item.supportKey === supportKey);
      setActiveSupportKey(supportItem?.supportKey ?? "");

      const visibleItems = supportItem ? [supportItem, ...items] : items;
      const hashId = window.location.hash.replace(/^#/, "");
      const nextId = visibleItems.some((item) => item.id === hashId)
        ? hashId
        : supportItem?.id || defaultId;
      setOpenId(nextId);

      if (hashId) {
        window.setTimeout(() => {
          const target = document.getElementById(hashId);
          target?.scrollIntoView({ block: "start" });
        }, 0);
      }
    }

    syncWithHash();
    window.addEventListener("hashchange", syncWithHash);
    return () => window.removeEventListener("hashchange", syncWithHash);
  }, [defaultId, items, supportItems]);

  const activeSupportItem =
    activeSupportKey.length > 0
      ? supportItems.find((item) => item.supportKey === activeSupportKey)
      : undefined;
  const visibleItems = activeSupportItem ? [activeSupportItem, ...items] : items;

  return (
    <section className="divide-y divide-emerald-100 rounded-2xl border border-emerald-100 bg-white shadow-sm">
      {visibleItems.map((item) => {
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
