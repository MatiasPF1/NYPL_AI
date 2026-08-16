import { type EmailOtpType } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Only same-origin, non-protocol-relative paths are accepted as a post-login
 * destination. Without this, `/auth/confirm?next=https://evil.example` turns
 * the magic link into an open redirect — a phishing primitive that inherits
 * this domain's credibility.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/app";
  // "//evil.com" and "/\evil.com" are parsed as protocol-relative URLs.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/app";
  }
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"));

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(new URL(next, origin));
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  // Deliberately vague: a link that is expired, already used, or was never
  // valid all land here with the same message.
  return NextResponse.redirect(new URL("/login?error=link", origin));
}
