"use client";

/**
 * Interactive "Fusion Demo": pick a base dish + a cuisine, press Fuse, and
 * reveal one of nine pre-rendered fusion dishes. Two slot-wheel reels feed a
 * result panel. All motion respects prefers-reduced-motion (instant reveal,
 * no fusing animation, no steam). Keyboard: each reel is a listbox with
 * aria-activedescendant + ArrowUp/ArrowDown cycling.
 */
import Image from "next/image";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  fusionDemoBases,
  fusionDemoCuisines,
  fusionDemoResults,
} from "@/lib/fusion-demo-content";

/** Steam wisps reused from the landing page (see .steam-wisp in globals.css). */
function SteamWisps() {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[36%] z-10">
      <span className="steam-wisp" style={{ left: "-18px", animationDelay: "0s" }} />
      <span className="steam-wisp" style={{ left: "0px", animationDelay: "0.9s" }} />
      <span className="steam-wisp" style={{ left: "18px", animationDelay: "1.7s" }} />
    </span>
  );
}

const FUSING_MS = 900;

type ReelItem = {
  id: string;
  name: string;
  /** Local JPG dish photo. */
  image?: string;
  /** Square SVG flag, rendered with a plain <img>. */
  flag?: string;
};

/** Circular tile content: dish photo via next/image, or SVG flag via plain img. */
function ReelTile({ item }: { item: ReelItem }) {
  return item.image ? (
    <Image
      src={item.image}
      alt=""
      fill
      sizes="160px"
      className="object-cover"
    />
  ) : (
    // Flags are SVG: next/image rejects them, so use a plain <img>.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={item.flag} alt="" className="h-full w-full object-cover" />
  );
}

function up(index: number, length: number): number {
  return (index - 1 + length) % length;
}

function down(index: number, length: number): number {
  return (index + 1) % length;
}

/**
 * A vertical slot-wheel reel. The selected item is a large circular tile with
 * its label below; the previous/next items sit dimmed above and below.
 */
function Reel({
  label,
  items,
  selectedIndex,
  onSelect,
}: {
  label: string;
  items: ReelItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const baseId = useId();
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const prevIndex = up(selectedIndex, items.length);
  const nextIndex = down(selectedIndex, items.length);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onSelect(up(selectedIndex, items.length));
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onSelect(down(selectedIndex, items.length));
    }
  };

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        aria-label={`Previous ${label}`}
        onClick={() => onSelect(up(selectedIndex, items.length))}
        className="flex h-9 w-9 items-center justify-center rounded-full text-emerald-700 transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2"
      >
        <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
          <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div
        role="listbox"
        aria-label={label}
        tabIndex={0}
        aria-activedescendant={optionId(selectedIndex)}
        onKeyDown={handleKeyDown}
        className="flex flex-col items-center gap-2 rounded-2xl px-2 py-1 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2"
      >
        {/* Dimmed item above */}
        <div
          id={optionId(prevIndex)}
          role="option"
          aria-selected={false}
          aria-label={items[prevIndex].name}
          onClick={() => onSelect(prevIndex)}
          className="relative h-12 w-12 cursor-pointer overflow-hidden rounded-full opacity-45 ring-1 ring-emerald-100 transition hover:opacity-70 sm:h-14 sm:w-14"
        >
          <ReelTile item={items[prevIndex]} />
        </div>

        {/* Selected item */}
        <div className="flex flex-col items-center">
          <div
            id={optionId(selectedIndex)}
            role="option"
            aria-selected={true}
            aria-label={items[selectedIndex].name}
            className="relative h-[136px] w-[136px] overflow-hidden rounded-full ring-2 ring-emerald-200 lg:h-[160px] lg:w-[160px]"
          >
            <ReelTile item={items[selectedIndex]} />
          </div>
          <p className="mt-3 max-w-[160px] text-center text-base font-extrabold text-zinc-950">
            {items[selectedIndex].name}
          </p>
        </div>

        {/* Dimmed item below */}
        <div
          id={optionId(nextIndex)}
          role="option"
          aria-selected={false}
          aria-label={items[nextIndex].name}
          onClick={() => onSelect(nextIndex)}
          className="relative h-12 w-12 cursor-pointer overflow-hidden rounded-full opacity-45 ring-1 ring-emerald-100 transition hover:opacity-70 sm:h-14 sm:w-14"
        >
          <ReelTile item={items[nextIndex]} />
        </div>
      </div>

      <button
        type="button"
        aria-label={`Next ${label}`}
        onClick={() => onSelect(down(selectedIndex, items.length))}
        className="flex h-9 w-9 items-center justify-center rounded-full text-emerald-700 transition hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2"
      >
        <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="none">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** Small uppercase column header, e.g. "01 — Pick a dish". */
function ColumnHeader({ children }: { children: string }) {
  return (
    <p className="mb-4 text-center text-xs font-extrabold uppercase tracking-wide text-emerald-700">
      {children}
    </p>
  );
}

export function FusionDemo() {
  const [baseIndex, setBaseIndex] = useState(0);
  const [cuisineIndex, setCuisineIndex] = useState(0);
  // "idle" = placeholder, "fusing" = animation in flight, "revealed" = result shown.
  const [stage, setStage] = useState<"idle" | "fusing" | "revealed">("idle");
  const timerRef = useRef<number | null>(null);

  const base = fusionDemoBases[baseIndex];
  const cuisine = fusionDemoCuisines[cuisineIndex];
  const result = fusionDemoResults[`${base.id}-${cuisine.id}`];

  // Clear any pending fusing timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Changing either reel resets the result panel to its unfused state.
  const resetToIdle = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStage("idle");
  }, []);

  const handleBaseSelect = useCallback(
    (index: number) => {
      setBaseIndex(index);
      resetToIdle();
    },
    [resetToIdle],
  );

  const handleCuisineSelect = useCallback(
    (index: number) => {
      setCuisineIndex(index);
      resetToIdle();
    },
    [resetToIdle],
  );

  const handleFuse = useCallback(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion) {
      // Skip the fusing animation entirely — instant reveal.
      setStage("revealed");
      return;
    }

    setStage("fusing");
    timerRef.current = window.setTimeout(() => {
      setStage("revealed");
      timerRef.current = null;
    }, FUSING_MS);
  }, []);

  const isFusing = stage === "fusing";
  const isRevealed = stage === "revealed";

  return (
    <div className="mx-auto mt-10 max-w-6xl rounded-2xl border border-emerald-100 bg-white p-6 shadow-sm sm:p-8">
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-3 lg:gap-0">
        {/* Column 1 — Pick a dish */}
        <div className="lg:px-8">
          <ColumnHeader>01 — Pick a dish</ColumnHeader>
          <Reel
            label="Pick a dish"
            items={fusionDemoBases}
            selectedIndex={baseIndex}
            onSelect={handleBaseSelect}
          />
        </div>

        {/* Column 2 — Pick a cuisine */}
        <div className="lg:border-l lg:border-dashed lg:border-emerald-100 lg:px-8">
          <ColumnHeader>02 — Pick a cuisine</ColumnHeader>
          <Reel
            label="Pick a cuisine"
            items={fusionDemoCuisines}
            selectedIndex={cuisineIndex}
            onSelect={handleCuisineSelect}
          />
        </div>

        {/* Column 3 — Your fusion (full width below on small screens) */}
        <div className="col-span-2 mt-2 border-t border-dashed border-emerald-100 pt-6 lg:col-span-1 lg:mt-0 lg:border-l lg:border-t-0 lg:px-8 lg:pt-0">
          <ColumnHeader>03 — Your fusion</ColumnHeader>
          {/* lg:pt matches the reel columns' chevron (36px) + listbox padding (4px)
              + dimmed tile (56px) + gap (8px) so all three big circles align. */}
          <div className="flex flex-col items-center lg:pt-[104px]">
            {/* Result tile */}
            <div
              className={[
                "relative h-[136px] w-[136px] overflow-hidden rounded-full ring-2 lg:h-[160px] lg:w-[160px]",
                isRevealed ? "fusion-result-pop ring-amber-300" : "ring-emerald-200",
                isFusing ? "fusion-tile-fusing" : "",
              ].join(" ")}
            >
              {isRevealed ? (
                <>
                  <SteamWisps />
                  <Image
                    src={result.image}
                    alt=""
                    fill
                    sizes="160px"
                    className="object-cover"
                  />
                </>
              ) : (
                // Idle / fusing placeholder: steaming cloche on warm cream.
                <div
                  className="flex h-full w-full items-center justify-center"
                  style={{ backgroundColor: "var(--warm-cream)" }}
                >
                  {isFusing ? <SteamWisps /> : null}
                  <svg
                    aria-hidden="true"
                    className="h-16 w-16 text-emerald-700"
                    viewBox="0 0 64 64"
                    fill="none"
                  >
                    {/* Cloche dome */}
                    <path
                      d="M12 44a20 16 0 0 1 40 0Z"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinejoin="round"
                    />
                    {/* Knob */}
                    <circle cx="32" cy="24" r="3" fill="currentColor" />
                    {/* Plate */}
                    <path
                      d="M8 48h48"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              )}
            </div>

            <p className="mt-3 min-h-[1.5rem] max-w-[200px] text-center text-base font-extrabold text-zinc-950">
              {isRevealed ? result.name : "Press Fuse to reveal"}
            </p>

            <button
              type="button"
              onClick={handleFuse}
              disabled={isFusing}
              className="mt-5 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-7 text-base font-extrabold text-white shadow-sm transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isFusing ? "Fusing…" : "Fuse it!"}
            </button>

            {/* Screen-reader announcement for the revealed result. */}
            <p aria-live="polite" className="sr-only">
              {isRevealed ? `Fusion created: ${result.name}` : ""}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
