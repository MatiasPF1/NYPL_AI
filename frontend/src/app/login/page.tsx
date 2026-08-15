import Link from "next/link";
import { Wordmark } from "@/components/Main_Presentation/Wordmark";

/**
 * Where the landing CTA lands. UI only — no auth provider is wired up yet.
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-5 py-16 font-sans">
      <div className="w-full max-w-[380px]">
        <Link
          href="/"
          className="mb-10 flex justify-center text-ink no-underline"
        >
          <Wordmark />
        </Link>

        <h1 className="text-center text-[28px] leading-tight font-bold tracking-[-0.03em] text-balance">
          Walk safer tonight
        </h1>
        <p className="mt-2.5 text-center text-[15px] text-ink-2">
          Log in to save your trips and your trusted contact.
        </p>

        <form className="mt-8 flex flex-col gap-3">
          <label htmlFor="email" className="sr-only">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            className="w-full rounded-lg border border-rule bg-surface px-4 py-3 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-accent px-4 py-3 text-[15px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            Continue with email
          </button>
        </form>

        <p className="mt-6 text-center text-[13px] leading-[1.5] text-ink-3">
          By continuing you agree to share your location while a route is
          active.
        </p>
      </div>
    </div>
  );
}
