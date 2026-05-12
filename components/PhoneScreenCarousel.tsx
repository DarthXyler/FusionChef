"use client";

import Image from "next/image";
import { useCallback, useRef, useState } from "react";

const screens = [
  {
    label: "Home screen",
    src: "/landing/mobile-home-screen.jpg",
  },
  {
    label: "Cookbook screen",
    src: "/landing/mobile-cookbook-screen.jpg",
  },
  {
    label: "Create screen",
    src: "/landing/mobile-create-screen.jpg",
  },
  {
    label: "Profile screen",
    src: "/landing/mobile-profile-screen.jpg",
  },
] as const;

export function PhoneScreenCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDraggingView, setIsDraggingView] = useState(false);
  const dragStartX = useRef(0);
  const isDragging = useRef(false);

  const goToScreen = useCallback((index: number) => {
    setActiveIndex((index + screens.length) % screens.length);
    setDragOffset(0);
  }, []);

  const startDrag = useCallback((clientX: number) => {
    isDragging.current = true;
    setIsDraggingView(true);
    dragStartX.current = clientX;
    setDragOffset(0);
  }, []);

  const updateDrag = useCallback((clientX: number) => {
    if (!isDragging.current) {
      return;
    }

    const nextOffset = clientX - dragStartX.current;
    setDragOffset(Math.max(-110, Math.min(110, nextOffset)));
  }, []);

  const endDrag = useCallback(
    (clientX: number) => {
      if (!isDragging.current) {
        return;
      }

      const deltaX = clientX - dragStartX.current;
      isDragging.current = false;
      setIsDraggingView(false);
      setDragOffset(0);

      if (Math.abs(deltaX) < 42) {
        return;
      }

      goToScreen(activeIndex + (deltaX < 0 ? 1 : -1));
    },
    [activeIndex, goToScreen],
  );

  const transformPercent = -activeIndex * 100;

  return (
    <div className="hero-phone-float mx-auto w-full max-w-[220px] sm:max-w-[235px] lg:max-w-[240px]">
      <div className="rounded-[2rem] border-[8px] border-zinc-950 bg-zinc-950 shadow-2xl">
        <div className="relative overflow-hidden rounded-[1.35rem] bg-[#f4fbf7]">
          <div className="absolute left-1/2 top-0 z-20 h-5 w-24 -translate-x-1/2 rounded-b-2xl bg-zinc-950" />
          <div
            className="touch-pan-y cursor-grab overflow-hidden active:cursor-grabbing"
            role="region"
            aria-label="Preview Flavor Fusion Chef app screens"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                goToScreen(activeIndex - 1);
              }
              if (event.key === "ArrowRight") {
                goToScreen(activeIndex + 1);
              }
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              startDrag(event.clientX);
            }}
            onPointerMove={(event) => {
              updateDrag(event.clientX);
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              endDrag(event.clientX);
            }}
            onPointerCancel={() => {
              isDragging.current = false;
              setIsDraggingView(false);
              setDragOffset(0);
            }}
            onDragStart={(event) => {
              event.preventDefault();
            }}
          >
            <div
              className={[
                "flex ease-out",
                isDraggingView ? "transition-none" : "transition-transform duration-300",
              ].join(" ")}
              style={{ transform: `translateX(calc(${transformPercent}% + ${dragOffset}px))` }}
            >
              {screens.map((screen) => (
                <div key={screen.src} className="relative aspect-[591/1280] min-w-full select-none">
                  <Image
                    src={screen.src}
                    alt={screen.label}
                    fill
                    sizes="(max-width: 768px) 62vw, 240px"
                    className="object-cover"
                    priority={screen.src.includes("home")}
                    draggable={false}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-white/85 to-transparent" />
          <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/90 px-2.5 py-1.5 shadow-sm ring-1 ring-emerald-100 backdrop-blur">
            {screens.map((screen, index) => (
              <button
                key={screen.src}
                type="button"
                aria-label={`Show ${screen.label}`}
                aria-pressed={activeIndex === index}
                onClick={() => goToScreen(index)}
                className={[
                  "h-2.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2",
                  activeIndex === index ? "w-6 bg-emerald-600" : "w-2.5 bg-emerald-200 hover:bg-emerald-300",
                ].join(" ")}
              />
            ))}
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-xs font-extrabold uppercase text-emerald-700 sm:text-[13px]">
        Swipe to preview the app
      </p>
    </div>
  );
}
