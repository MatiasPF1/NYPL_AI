import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/components/Login_Page/actions";
import { Wordmark } from "@/components/ui/wordmark";
import { createClient, getAuthenticatedUser } from "@/lib/supabase/server";

export const metadata = { title: "Your routes · SafeNYC" };

/**
 * A protected page.
 *
 * The proxy already redirects signed-out visitors, but this check is not
 * redundant: proxy matchers are easy to mis-scope and run outside the render
 * path. Every protected page re-validates server-side, and no query below
 * filters by a user id taken from the client — RLS scopes the rows to the
 * caller's JWT, so the query cannot return someone else's data even if the
 * page logic were wrong.
 */
export default async function AppPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login?next=/app");

  const supabase = await createClient();

  // Note the absence of `.eq("user_id", ...)`. Adding it would be a filter,
  // not a control; the RLS policy is what makes this safe.
  const { data: routes } = await supabase
    .from("routes")
    .select("id, name, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="flex min-h-svh flex-col bg-black font-sans text-white">
      <header className="flex items-center justify-between gap-3 p-6 sm:p-10">
        <Wordmark tone="light" />
        <div className="flex items-center gap-2">
          <Link
            href="/map"
            className="rounded-lg bg-white px-4 py-2 text-[14px] font-medium text-black no-underline transition-opacity hover:opacity-85"
          >
            Plan a route
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-lg border border-white/25 px-4 py-2 text-[14px] font-medium text-white transition-colors hover:border-white/60"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[620px] px-6 pb-24">
        <p className="font-mono text-[11px] tracking-[0.16em] text-white/50 uppercase">
          Signed in
        </p>
        <h1 className="mt-4 text-[clamp(2rem,4.5vw,2.75rem)] leading-[1.08] font-bold tracking-[-0.035em]">
          Your routes
        </h1>
        <p className="mt-4 text-[16px] text-white/60">{user.email}</p>

        <ul className="mt-9 flex flex-col gap-2">
          {routes && routes.length > 0 ? (
            routes.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-white/15 bg-white/5 px-4 py-3.5 text-[15px]"
              >
                {r.name ?? "Untitled route"}
              </li>
            ))
          ) : (
            <li className="rounded-lg border border-white/10 px-4 py-6 text-[15px] text-white/50">
              No saved routes yet.
            </li>
          )}
        </ul>
      </main>
    </div>
  );
}
