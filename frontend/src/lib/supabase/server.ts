import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client, bound to the request's cookies.
 *
 * Also uses the publishable key: privilege comes from the user's session, not
 * from the key, so a leaked bundle grants an attacker nothing RLS would not
 * already allow an anonymous visitor.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session instead, so this is safe to skip.
          }
        },
      },
    },
  );
}

/**
 * The only sanctioned way to answer "who is calling?" on the server.
 *
 * Use this — never `getSession()`, and never a user id, email, or role read
 * from a cookie, a request body, or a query param. `getUser()` revalidates the
 * JWT against the Auth server on every call, so a forged or expired token
 * fails here. Anything derived from client-supplied input is an assertion by
 * the attacker, not an identity.
 */
export async function getAuthenticatedUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;
  return user;
}
