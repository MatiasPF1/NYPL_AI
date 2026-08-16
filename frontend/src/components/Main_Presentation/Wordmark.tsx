/**
 * `tone="light"` is for placement on the dark collection background, where
 * the theme-token version would render a near-black tile on black.
 */
export function Wordmark({ tone = "auto" }: { tone?: "auto" | "light" }) {
  const tile = tone === "light" ? "fill-white" : "fill-ink";
  const glyph = tone === "light" ? "fill-black" : "fill-bg";

  return (
    <span className="flex items-center gap-2.5">
      <svg
        width="26"
        height="26"
        viewBox="0 0 26 26"
        fill="none"
        aria-hidden
        className="shrink-0"
      >
        <rect width="26" height="26" rx="7" className={tile} />
        <path
          d="M13 5.6c-2.7 0-4.9 2.2-4.9 4.9 0 3.6 4.9 9.9 4.9 9.9s4.9-6.3 4.9-9.9c0-2.7-2.2-4.9-4.9-4.9Z"
          className={glyph}
        />
        <circle cx="13" cy="10.4" r="1.75" className={tile} />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.02em]">
        SafeNYC
      </span>
    </span>
  );
}
