import Link from "next/link";
import { Wordmark } from "@/components/ui/wordmark";
import { MagicLinkForm } from "./MagicLinkForm";

export type AuthMode = "login" | "signup";

const COPY = {
  signup: {
    kicker: "Create account",
    heading: "Start walking safer.",
    blurb:
      "Save your routes and name the trusted contact we notify if you wander off one.",
    submit: "Create account",
    switchLead: "Already have an account?",
    switchLabel: "Log in",
    switchHref: "/login",
  },
  login: {
    kicker: "Log in",
    heading: "Walk safer tonight.",
    blurb: "Pick up your saved routes and your trusted contact.",
    submit: "Continue with email",
    switchLead: "New to SafeNYC?",
    switchLabel: "Create an account",
    switchHref: "/signup",
  },
} as const;

/**
 * Both auth screens. Same world as the collection: black ground, white type,
 * one blue.
 *
 * Auth is magic link only, so no password is ever stored, transmitted, or
 * reset — the whole class of credential-stuffing and password-reset attacks
 * simply has no surface here. The two modes differ only in copy and in
 * `shouldCreateUser`.
 */
export function AuthScreen({ mode }: { mode: AuthMode }) {
  const copy = COPY[mode];

  return (
    <div className="relative flex min-h-svh w-full flex-col bg-black font-sans text-white">
      <header className="p-6 sm:p-10">
        <Link href="/" className="inline-flex no-underline">
          <Wordmark tone="light" />
        </Link>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[400px]">
          <p className="font-mono text-[11px] tracking-[0.16em] text-white/50 uppercase">
            {copy.kicker}
          </p>

          <h1 className="mt-4 text-[clamp(2rem,4.5vw,2.75rem)] leading-[1.08] font-bold tracking-[-0.035em] text-balance">
            {copy.heading}
          </h1>

          <p className="mt-4 text-[16px] leading-[1.55] text-white/60 text-pretty">
            {copy.blurb}
          </p>

          <MagicLinkForm mode={mode} submitLabel={copy.submit} />

          <p className="mt-6 text-[14px] text-white/50">
            {copy.switchLead}{" "}
            <Link
              href={copy.switchHref}
              className="font-medium text-white underline-offset-4 hover:underline"
            >
              {copy.switchLabel}
            </Link>
          </p>

          {mode === "signup" && (
            <p className="mt-6 border-t border-white/10 pt-6 text-[13px] leading-[1.55] text-white/40">
              By creating an account you agree to share your location while a
              route is active. You choose who gets notified, and you can revoke
              it at any time.
            </p>
          )}
        </div>
      </main>

      <p className="absolute right-6 bottom-6 font-mono text-[11px] tracking-wider text-white/40 uppercase sm:right-10 sm:bottom-10">
        Manhattan · Brooklyn · Queens
      </p>
    </div>
  );
}
