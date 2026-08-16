"use server";

import { revalidatePath } from "next/cache";
import {
  normaliseEmail,
  normalisePhone,
  notifyConfigured,
  sendAlertEmail,
} from "@/lib/notify";
import { createClient, getAuthenticatedUser } from "@/lib/supabase/server";

/**
 * The safety loop: consent, and the alerts that depend on it.
 *
 * Two rules run through everything here.
 *
 * Consent is a stored fact, not a client claim. Live tracking and alerts both
 * require `profiles.location_consent_at` to be non-null, and that is re-read
 * from the database on every alert rather than trusted from whatever the
 * browser sent. A caller who POSTs straight at this action without ever seeing
 * the form gets refused.
 *
 * An alert is recorded even when it cannot be delivered. The row in `alerts`
 * is the durable fact that something happened; email is one channel that can
 * be unconfigured, rate-limited, or simply down. Losing the record because a
 * mail API failed would be the wrong trade.
 */

export type Consent = {
  email: string | null;
  phone: string | null;
  consentedAt: string | null;
  /** Whether an alert can physically be delivered right now. */
  ready: boolean;
};

export type ConsentResult =
  | { ok: true; consent: Consent }
  | { ok: false; error: string };

export type AlertKind = "deviation" | "sos" | "arrived";

export type AlertResult =
  | { ok: true; delivery: "sent" | "not_configured" | "failed"; detail?: string }
  | { ok: false; error: string };

/**
 * Record where alerts go, and authorisation to track a walk.
 *
 * The email is required because it is the live channel. The mobile is stored
 * but optional: nothing sends to it yet — SMS needs a paid Twilio upgrade —
 * and a field that silently does nothing would be worse than one that says so.
 */
export async function grantConsent(input: {
  email: string;
  phone?: string | null;
  authorised: boolean;
}): Promise<ConsentResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const email = normaliseEmail(input?.email);
  if (!email) return { ok: false, error: "That doesn't look like an email address." };

  // Empty is fine; wrong is not. Silently dropping a mistyped number would
  // leave someone believing a channel is set up that isn't.
  const phone = input?.phone?.trim() ? normalisePhone(input.phone) : null;
  if (input?.phone?.trim() && !phone) {
    return { ok: false, error: "That mobile number doesn't look right. Try 10 digits, or +1…" };
  }

  if (!input.authorised) {
    return { ok: false, error: "Tracking needs your explicit go-ahead." };
  }

  const supabase = await createClient();
  const consentedAt = new Date().toISOString();
  // The profile row is created by the on-signup trigger, but upsert covers the
  // case where it is not there yet rather than failing in front of the user.
  const { error } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      trusted_contact_email: email,
      phone,
      location_consent_at: consentedAt,
    },
    { onConflict: "id" },
  );

  if (error) return { ok: false, error: "Couldn't save that." };

  revalidatePath("/app");
  return {
    ok: true,
    consent: { email, phone, consentedAt, ready: notifyConfigured() },
  };
}

/** Withdraw it. Tracking stops being permitted the moment this returns. */
export async function revokeConsent(): Promise<ConsentResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ location_consent_at: null })
    .eq("id", user.id);

  if (error) return { ok: false, error: "Couldn't update that." };

  revalidatePath("/app");
  return {
    ok: true,
    consent: { email: null, phone: null, consentedAt: null, ready: notifyConfigured() },
  };
}

const KINDS: AlertKind[] = ["deviation", "sos", "arrived"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Record an alert and try to deliver it.
 *
 * The message carries a plain maps link rather than a share URL: a coordinate
 * link opens anywhere with nothing to sign into. The token-based live-tracking
 * share is a separate piece of work and deliberately not faked here with a
 * guessable URL.
 */
export async function raiseAlert(input: {
  kind: AlertKind;
  routeId?: string | null;
  lat: number;
  lng: number;
  offByM?: number | null;
}): Promise<AlertResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, error: "Sign in first." };

  if (!KINDS.includes(input?.kind)) return { ok: false, error: "Unknown alert." };
  if (!finite(input.lat) || !finite(input.lng)) {
    return { ok: false, error: "No position to report." };
  }
  const routeId =
    typeof input.routeId === "string" && UUID.test(input.routeId)
      ? input.routeId
      : null;

  const supabase = await createClient();

  // Re-read consent server-side. This is the check that actually governs
  // whether anything may be sent, and it does not trust the caller.
  const { data: profile } = await supabase
    .from("profiles")
    .select("trusted_contact_email, location_consent_at, display_name")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.location_consent_at) {
    return { ok: false, error: "Location sharing is off for this account." };
  }

  const who = profile.display_name || user.email || "Your contact";
  const mapUrl = `https://www.google.com/maps?q=${input.lat.toFixed(5)},${input.lng.toFixed(5)}`;
  const subject =
    input.kind === "sos"
      ? `SafeNYC SOS from ${who}`
      : input.kind === "arrived"
        ? `${who} arrived safely`
        : `${who} has left their safe route`;
  const message =
    input.kind === "sos"
      ? `${who} pressed the emergency button in SafeNYC.`
      : input.kind === "arrived"
        ? `${who} reached their destination.`
        : `${who} has left their planned safe route` +
          (finite(input.offByM) ? ` by about ${Math.round(input.offByM)} m` : "") +
          `.`;

  const { data: row, error } = await supabase
    .from("alerts")
    .insert({
      user_id: user.id,
      route_id: routeId,
      kind: input.kind,
      message: `${message} ${mapUrl}`,
    })
    .select("id")
    .single();

  if (error || !row) return { ok: false, error: "Couldn't record that alert." };

  const to = profile.trusted_contact_email;
  const result = to
    ? await sendAlertEmail(to, subject, message, mapUrl)
    : ({ status: "failed", error: "no address on file" } as const);

  if (result.status === "sent") {
    await supabase
      .from("alerts")
      .update({ delivered_at: new Date().toISOString() })
      .eq("id", row.id);
  }

  return {
    ok: true,
    delivery: result.status,
    detail: result.status === "failed" ? result.error : undefined,
  };
}
