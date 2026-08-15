import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-rule/70 bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] max-w-[1200px] items-center justify-between px-5 sm:px-8">
        <Link href="/" className="no-underline text-ink">
          <Wordmark />
        </Link>

        <nav className="flex items-center gap-1.5 sm:gap-3">
          <Link
            href="/login"
            className="rounded-md px-3 py-2 text-[14px] font-medium text-ink-2 no-underline transition-colors hover:text-ink"
          >
            Log in
          </Link>
          <Link
            href="/login"
            className="rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-on-accent no-underline transition-colors hover:bg-accent-hover"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
