"use client";

import React, { useRef } from "react";
import {
  motion,
  useScroll,
  useTransform,
  useSpring,
  useMotionValue,
  MotionValue,
} from "framer-motion";

export interface CollectionItem {
  id: number;
  image: string;
  title: string;
  /** Optional kicker above the title — SafeNYC uses it for the borough. */
  subtitle?: string;
}

export type CollectionSurferVariant = "magnetic" | "uplift" | "simple";

interface CollectionSurferProps {
  items: CollectionItem[];
  variant?: CollectionSurferVariant;
  /**
   * Content pinned in front of the scene. The layer ignores pointer events so
   * the magnetic effect still tracks through it — put `pointer-events-auto`
   * on anything clickable.
   */
  overlay?: React.ReactNode;
  /** Small hint in the bottom-right corner. */
  hint?: string;
  /**
   * How far the page scrolls while the scene is pinned, in pixels. This is
   * the section's own height — the viewport sticks for exactly this long.
   */
  scrollLength?: number;
  /** Full passes through the collection over that scroll distance. */
  loops?: number;
}

/**
 * A 3D collection that surfs past while the section is pinned.
 *
 * The scene is driven by this section's own scroll progress rather than the
 * document's, so it can sit inside a normal page between other content.
 */
export function CollectionSurfer({
  items,
  variant = "magnetic",
  overlay,
  hint = "scroll to surf",
  scrollLength = 4000,
  loops = 1,
}: CollectionSurferProps) {
  const sectionRef = useRef<HTMLElement>(null);

  // Rendered twice so the wrap-around is never visible at the seam.
  const duplicatedItems = [...items, ...items];

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  });

  // Smooth first, wrap second — springing the sawtooth instead would sweep
  // the whole scene backwards on every wrap.
  const smoothProgress = useSpring(scrollYProgress, {
    mass: 0.1,
    stiffness: 100,
    damping: 20,
  });

  // 0 → 1 sawtooth, one tooth per loop.
  const loopedProgress = useTransform(
    smoothProgress,
    (value) => (value * loops) % 1,
  );

  // Step vector
  const stepX = 240;
  const stepY = -84;
  const stepZ = -288;

  const x = useTransform(loopedProgress, [0, 1], [0, -items.length * stepX]);
  const y = useTransform(loopedProgress, [0, 1], [0, -items.length * stepY]);
  const z = useTransform(loopedProgress, [0, 1], [0, -items.length * stepZ]);

  // Pointer position for the magnetic effect. Initialized off-screen so no
  // card is scaled before the pointer ever enters.
  const mouseX = useMotionValue(-10000);
  const mouseY = useMotionValue(-10000);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (variant === "simple") return;
    mouseX.set(e.clientX);
    mouseY.set(e.clientY);
  };

  const handleMouseLeave = () => {
    if (variant === "simple") return;
    mouseX.set(-10000);
    mouseY.set(-10000);
  };

  return (
    <section
      ref={sectionRef}
      // `isolate` keeps the overlays' z-index inside this section, so they
      // never paint over the page's sticky header.
      className="relative isolate w-full bg-black text-white"
      style={{ height: `${scrollLength}px` }}
    >
      <div
        className="sticky top-0 flex h-svh w-full items-center justify-center overflow-hidden"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* 3D Scene */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            perspective: "2000px",
            perspectiveOrigin: "10% 10%",
          }}
        >
          <motion.div
            className="relative h-0 w-0"
            style={{
              x,
              y,
              z,
              transformStyle: "preserve-3d",
            }}
          >
            {duplicatedItems.map((item, i) => (
              <Card
                key={`${item.id}-${i}`}
                item={item}
                i={i}
                total={items.length}
                stepX={stepX}
                stepY={stepY}
                stepZ={stepZ}
                mouseX={mouseX}
                mouseY={mouseY}
                scrollSpring={smoothProgress}
                variant={variant}
              />
            ))}
          </motion.div>
        </div>

        {/* Scrim: keeps the overlay readable as bright photos pass behind it.
            Inline because a four-stop gradient is clearer here than a chain
            of arbitrary color-stop utilities. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10"
          style={{
            backgroundImage:
              "linear-gradient(100deg, #000 0%, rgba(0,0,0,.94) 34%, rgba(0,0,0,.6) 62%, rgba(0,0,0,0) 88%)",
          }}
        />

        {overlay && (
          <div className="pointer-events-none absolute inset-0 z-20">
            {overlay}
          </div>
        )}

        <div className="absolute right-6 bottom-6 z-20 font-mono text-[11px] tracking-wider text-white uppercase opacity-70 sm:right-10 sm:bottom-10">
          {hint}
        </div>
      </div>
    </section>
  );
}

function Card({
  item,
  i,
  total,
  stepX,
  stepY,
  stepZ,
  mouseX,
  mouseY,
  scrollSpring,
  variant,
}: {
  item: CollectionItem;
  i: number;
  total: number;
  stepX: number;
  stepY: number;
  stepZ: number;
  mouseX: MotionValue<number>;
  mouseY: MotionValue<number>;
  scrollSpring: MotionValue<number>;
  variant: CollectionSurferVariant;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Distance from the pointer to the center of this card. `scrollSpring` is
  // an input purely so the value recomputes while the scene is moving.
  const distance = useTransform(
    [mouseX, mouseY, scrollSpring],
    ([x, y]: number[]) => {
      // 400 is the far end of the falloff below, i.e. "no effect".
      if (!ref.current || variant === "simple") return 400;
      const rect = ref.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
    },
  );

  // --- Magnetic Variant --- closer pointer, larger card
  const targetScale = useTransform(distance, [0, 400], [1.5, 1]);
  const springScale = useSpring(targetScale, {
    mass: 0.5,
    stiffness: 300,
    damping: 20,
  });

  // --- Uplift Variant --- closer pointer, card rises
  const targetUplift = useTransform(distance, [0, 400], [-100, 0]);
  const springUplift = useSpring(targetUplift, {
    mass: 0.5,
    stiffness: 300,
    damping: 20,
  });

  const transform = useTransform(
    [springScale, springUplift],
    ([s, u]: number[]) => {
      const scaleValue = variant === "magnetic" ? s : 1;
      const upliftValue = variant === "uplift" ? u : 0;

      const baseX = i * stepX;
      const baseY = i * stepY;
      const baseZ = i * stepZ;

      return `translate3d(${baseX}px, ${baseY + upliftValue}px, ${baseZ}px) rotateY(-50deg) scale(${scaleValue})`;
    },
  );

  return (
    <motion.div
      ref={ref}
      className="group absolute h-[400px] w-[300px] overflow-hidden bg-neutral-900 shadow-2xl transition-colors duration-500 ease-out"
      style={{
        transform,
        transformStyle: "preserve-3d",
      }}
    >
      {/* Index number. Modulo `total` so the duplicate set keeps counting 01..n */}
      <div className="absolute -top-6 -left-4 font-mono text-xs text-white opacity-50 transition-opacity group-hover:opacity-100">
        {String((i % total) + 1).padStart(2, "0")}
      </div>

      <div className="relative h-full w-full brightness-75 transition-all duration-300 group-hover:brightness-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.image}
          alt={item.title}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </div>

      <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/70 to-transparent" />

      <div className="pointer-events-none absolute right-4 bottom-4 left-4">
        {item.subtitle && (
          <p className="font-mono text-[10px] tracking-[0.18em] text-white/70 uppercase">
            {item.subtitle}
          </p>
        )}
        <p className="font-sans text-[15px] font-semibold tracking-tight text-white">
          {item.title}
        </p>
      </div>
    </motion.div>
  );
}

export default CollectionSurfer;
