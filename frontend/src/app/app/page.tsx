import { redirect } from "next/navigation";
import { signOut } from "@/components/Login_Page/actions";
import { MapDemo } from "@/components/Map_Demo";
import type { SavedRoute } from "@/components/Map_Demo/actions";
import { notifyConfigured } from "@/lib/notify";
import { createClient, getAuthenticatedUser } from "@/lib/supabase/server";

export const metadata = { title: "Plan a walk · SafeNYC" };

/**
 * The signed-in home is the map, not a list. An empty "your routes" table is
 * the wrong first thing to show someone who just logged in — the product is
 * the two lines. Saved walks live in the panel underneath them.
 *
 * The proxy already redirects signed-out visitors, but this check is not
 * redundant: proxy matchers are easy to mis-scope and run outside the render
 * path, so every protected page re-validates server-side with getUser().
 */
export default async function AppPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/login?next=/app");

  // No user_id filter: RLS already scopes this to the caller, and adding one
  // here would imply the policy is optional. `path` is deliberately not
  // selected — it is the largest column and the list only needs the labels.
  const supabase = await createClient();
  const [{ data }, { data: profile }] = await Promise.all([
    supabase
      .from("routes")
      .select("id, name, origin_lat, origin_lng, dest_lat, dest_lng, distance_m, risk_score, created_at")
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("profiles")
      .select("phone, trusted_contact_email, location_consent_at")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  return (
    <MapDemo
      saved={(data ?? []) as SavedRoute[]}
      // Passing the id is safe and is not a permission: RLS checks every write
      // against the JWT, so a tampered value is rejected by the database rather
      // than trusted by it.
      userId={user.id}
      // The address they signed in with, offered as the default so the form is
      // one tick rather than a typing exercise.
      defaultEmail={user.email ?? ""}
      consent={{
        email: profile?.trusted_contact_email ?? null,
        phone: profile?.phone ?? null,
        consentedAt: profile?.location_consent_at ?? null,
        // Whether an alert can physically be delivered. Read on the server
        // because the Resend key must never reach the browser.
        ready: notifyConfigured(),
      }}
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
