"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AuthState = { status: "idle" | "sent" | "error"; message?: string };

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Sends a magic link.
 *
 * The response is identical whether or not an account exists. Supabase will
 * happily tell us "user not found" when shouldCreateUser is false, and
 * surfacing that would turn this form into an account-enumeration oracle:
 * an attacker could test a list of emails and learn which ones are users.
 * The user-visible outcome is always "check your inbox".
 *
 * Rate limiting is enforced upstream by Supabase Auth (per-email and per-IP
 * OTP limits), which is the only place it cannot be bypassed by calling the
 * Auth endpoint directly instead of this action.
 */
export async function requestMagicLink(
  mode: "login" | "signup",
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!email || !email.includes("@") || email.length > 320) {
    return { status: "error", message: "Enter a valid email address." };
  }

  const supabase = await createClient();
  await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: mode === "signup",
      emailRedirectTo: `${SITE_URL}/auth/confirm?next=/app`,
    },
  });

  // Intentionally ignoring the error: see the enumeration note above.
  return {
    status: "sent",
    message: `If that address can sign in, a link is on its way to ${email}.`,
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
