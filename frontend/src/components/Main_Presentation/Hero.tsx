import Link from "next/link";

/** The three claims, stated once, under the fold of the headline. */
const CLAIMS = [
  {
    title: "Safer",
    body: "Routes around blocks with a history of injury crashes, and around streets that flood when it rains.",
  },
  {
    title: "NYC native",
    body: "Built on NYC Open Data — 2.3 million crash records and every logged flood, block by block.",
  },
];

export function Hero() {
  return (
    <main className="mx-auto w-full max-w-[1200px] px-5 pt-20 pb-24 sm:px-8 sm:pt-28">
      {/* One centered column; every element shares its axis and its rhythm. */}
      <div className="mx-auto flex max-w-[820px] flex-col items-center text-center">
        <p className="rounded-full border border-rule px-3.5 py-1.5 text-[13px] font-medium text-ink-2">
          Manhattan · Brooklyn · Queens · The Bronx · Staten Island
        </p>

        <h1 className="mt-8 text-[clamp(2.5rem,7vw,4.5rem)] leading-[1.08] font-bold tracking-[-0.04em] text-balance">
          Google Maps, but it gets you{" "}
          <span className="inline-block rounded-[0.3em] bg-accent-soft px-[0.16em] text-accent-ink">
            home safe.
          </span>
        </h1>

        <p className="mt-6 max-w-[46ch] text-[19px] leading-[1.55] text-ink-2 text-pretty">
          Same trip, safer line. SafeNYC reads New York&rsquo;s own crash and
          flooding records, then walks you around the blocks that hurt people,
          and still gets you there fast.
        </p>

        <div className="mt-9 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
          <Link
            href="/login"
            className="rounded-lg bg-accent px-6 py-3.5 text-center text-[15px] font-medium text-on-accent no-underline transition-colors hover:bg-accent-hover"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="rounded-lg bg-accent-soft px-6 py-3.5 text-center text-[15px] font-medium text-accent-ink no-underline transition-opacity hover:opacity-80"
          >
            Log in
          </Link>
        </div>
      </div>

      {/* Full container width, so its edges line up with the wordmark
          and the top-bar button above it. */}
      <ul className="mt-24 grid gap-px overflow-hidden rounded-xl border border-rule bg-rule sm:grid-cols-2">
        {CLAIMS.map((claim) => (
          <li key={claim.title} className="bg-bg px-6 py-7">
            <p className="mb-1.5 text-[15px] font-semibold tracking-[-0.01em]">
              {claim.title}
            </p>
            <p className="text-[14.5px] leading-[1.55] text-ink-2">
              {claim.body}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
