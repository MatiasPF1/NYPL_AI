import { redirect } from "next/navigation";
import { signOut } from "@/components/Login_Page/actions";
import { MapDemo } from "@/components/Map_Demo";
import { getAuthenticatedUser } from "@/lib/supabase/server";

export const metadata = { title: "Plan a walk · SafeNYC" };

/**
 * The signed-in home is the map, not a list. An empty "your routes" table is
 * the wrong first thing to show someone who just logged in — the product is
 * the two lines.
 *
 * The proxy already redirects signed-out visitors, but this check is not
 * redundant: proxy matchers are easy to mis-scope and run outside the render
 * path, so every protected page re-validates server-side with getUser().
 */
export default async function AppPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login?next=/app");

  return (
    <MapDemo
      account={
        <form action={signOut}>
          <button
            type="submit"
            title={user.email ?? undefined}
            className="rounded-lg border border-white/20 px-3 py-1.5 text-[13px] font-medium text-white/70 transition-colors hover:border-white/50 hover:text-white"
          >
            Sign out
          </button>
        </form>
      }
    />
  );
}
