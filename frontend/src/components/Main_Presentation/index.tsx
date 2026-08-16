import Link from "next/link";
import { CollectionSurfer } from "@/components/ui/collection-surfer";
import { NYC_COLLECTION } from "@/lib/nyc-collection";
import { Wordmark } from "./Wordmark";

/**
 * The whole landing page: the collection surfs the three boroughs while the
 * pitch and the login CTA stay pinned in front of it.
 */
export function MainPresentation() {
  return (
    <CollectionSurfer
      items={NYC_COLLECTION}
      variant="magnetic"
      hint="scroll to surf"
      scrollLength={4500}
      overlay={<Overlay />}
    />
  );
}

function Overlay() {
  return (
    <div className="flex h-full flex-col p-6 sm:p-10">
      {/* Top row */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-white">
          <Wordmark tone="light" />
        </span>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/login"
            className="pointer-events-auto rounded-lg px-3 py-2 text-[14px] font-medium text-white/70 no-underline transition-colors hover:text-white"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="pointer-events-auto rounded-lg bg-white px-4 py-2.5 text-[14px] font-medium text-black no-underline transition-opacity hover:opacity-85"
          >
            Get started
          </Link>
        </nav>
      </div>

      {/* The pitch. Centered in the leftover height rather than pinned to the
          bottom, so the buttons can never be clipped by the viewport edge. */}
      <div className="flex min-h-0 flex-1 items-center">
        <div className="w-full max-w-[620px]">
          <p className="font-mono text-[11px] tracking-[0.16em] text-white/60 uppercase">
            Manhattan · Brooklyn · Queens
          </p>

          <h1 className="mt-5 max-w-[15ch] text-[clamp(2.25rem,5.4vw,4.25rem)] leading-[1.05] font-bold tracking-[-0.04em] text-white text-balance">
            Google Maps, but it gets you{" "}
            {/* Literal, not `bg-accent`: this sits on the always-black scene,
                and the accent token lightens to #4d86ff in dark mode, which
                would leave white text on a pale blue pill. */}
            <span className="inline-block rounded-[0.28em] bg-[#0039A6] px-[0.16em] text-white">
              home safe.
            </span>
          </h1>

          <p className="mt-6 max-w-[46ch] text-[17px] leading-[1.55] text-white/70 text-pretty">
            Same trip, safer line. SafeNYC reads New York&rsquo;s own crash and
            flooding records, then walks you around the blocks that hurt people,
            and still gets you there fast.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="pointer-events-auto rounded-lg bg-white px-6 py-3.5 text-[15px] font-medium text-black no-underline transition-opacity hover:opacity-85"
            >
              Get started
            </Link>
            <Link
              href="/login"
              className="pointer-events-auto rounded-lg border border-white/25 px-6 py-3.5 text-[15px] font-medium text-white no-underline transition-colors hover:border-white/60"
            >
              Log in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
