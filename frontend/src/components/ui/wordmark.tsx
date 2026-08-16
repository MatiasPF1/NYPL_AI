/**
 * The wordmark reuses the headline's device: the city half sits in the same
 * solid blue pill that wraps "home safe." One idea, stated twice.
 *
 * `tone="light"` is for dark grounds; `auto` follows the page theme.
 *
 * The blue is a literal rather than `bg-accent` because the token lightens to
 * #4d86ff in dark mode, which would leave white text on a pale blue chip.
 */
export function Wordmark({ tone = "auto" }: { tone?: "auto" | "light" }) {
  return (
    <span
      className={`inline-flex items-baseline text-[17px] leading-none font-bold tracking-[-0.03em] ${
        tone === "light" ? "text-white" : "text-ink"
      }`}
    >
      Safe
      <span className="ml-[0.1em] rounded-[0.3em] bg-[#0039A6] px-[0.26em] py-[0.16em] text-white">
        NYC
      </span>
    </span>
  );
}
