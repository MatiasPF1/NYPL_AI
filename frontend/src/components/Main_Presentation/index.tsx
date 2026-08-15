import { Hero } from "./Hero";
import { TopBar } from "./TopBar";

export function MainPresentation() {
  return (
    <div className="flex min-h-full flex-1 flex-col font-sans">
      <TopBar />
      <Hero />
      <footer className="mt-auto border-t border-rule">
        <p className="mx-auto max-w-[1200px] px-5 py-7 text-[13px] text-ink-3 sm:px-8">
          SafeNYC · Built on NYC Open Data — crash, flooding, and live weather
        </p>
      </footer>
    </div>
  );
}
