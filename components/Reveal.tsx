"use client";

/**
 * Scroll-reveal wrapper used across the landing page.
 * Adds `.is-visible` when the element enters the viewport; the actual
 * transition lives in globals.css and is disabled for reduced motion.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  /** Stagger step 0-4, mapped to .reveal-delay-N classes. */
  delay?: 0 | 1 | 2 | 3 | 4;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      node.classList.add("is-visible");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -40px 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const delayClass = delay > 0 ? ` reveal-delay-${delay}` : "";

  return (
    <div ref={ref} className={`reveal${delayClass} ${className}`.trim()}>
      {children}
    </div>
  );
}
