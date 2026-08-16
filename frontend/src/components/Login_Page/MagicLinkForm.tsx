"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { requestMagicLink, type AuthState } from "./actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-white px-4 py-3.5 text-[15px] font-medium text-black transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
    >
      {pending ? "Sending…" : label}
    </button>
  );
}

export function MagicLinkForm({
  mode,
  submitLabel,
}: {
  mode: "login" | "signup";
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<AuthState, FormData>(
    requestMagicLink.bind(null, mode),
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <div className="mt-9 rounded-lg border border-white/15 bg-white/5 p-5">
        <p className="font-mono text-[11px] tracking-[0.16em] text-white/50 uppercase">
          Check your inbox
        </p>
        <p className="mt-2.5 text-[15px] leading-[1.55] text-white/80">
          {state.message}
        </p>
        <p className="mt-3 text-[13px] text-white/40">
          The link expires in one hour and can only be used once.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-9 flex flex-col gap-3">
      <label htmlFor="email" className="sr-only">
        Email address
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        placeholder="you@example.com"
        aria-describedby={state.status === "error" ? "email-error" : undefined}
        className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-3.5 text-[15px] text-white transition-colors placeholder:text-white/35 hover:border-white/25 focus:border-white/60 focus:outline-none"
      />
      <Submit label={submitLabel} />
      {state.status === "error" && (
        <p id="email-error" role="alert" className="text-[14px] text-white/70">
          {state.message}
        </p>
      )}
    </form>
  );
}
