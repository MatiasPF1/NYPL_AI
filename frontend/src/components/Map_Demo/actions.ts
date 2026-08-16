"use server";

import { revalidatePath } from "next/cache";
import { createClient, getAuthenticatedUser } from "@/lib/supabase/server";

/**
 * Saving and deleting a walk.
 *
 * Server Functions are reachable by direct POST, not only through the button
 * that calls them, so every one of these re-checks the caller with getUser()
 * rather than trusting anything the client sent. `user_id` is taken from that
 * session and never from the payload — a client-supplied owner id is an
 * assertion by the caller, not an identity.
 *
 * RLS on public.routes enforces the same rule a second time in the database,
 * which is what makes this safe rather than merely careful.
 */

export type SavedRoute = {
  id: string;
  name: string | null;
  origin_lat: number;
  origin_lng: number;
  dest_lat: number;
  dest_lng: number;
  distance_m: number | null;
  risk_score: number | null;
  created_at: string;
};

export type SaveInput = {
  name?: string | null;
  origin: { lat: number; lng: number };
  dest: { lat: number; lng: number };
  /** The recommended (safest) line, as [lng, lat] pairs. */
  coordinates: [number, number][];
  distanceM: number;
  riskExposure: number;
};

export type ActionResult = { ok: true } | { ok: false; error: string };

// A walk across Manhattan is a few hundred points. The cap is three orders of
// magnitude of headroom and still bounds what one row can cost — the column is
// jsonb, and nothing else limits how much a caller could push into it.
const MAX_POINTS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function validPoint(p: { lat: number; lng: number } | undefined): boolean {
  return (
    !!p &&
    finite(p.lat) && finite(p.lng) &&
    p.lat >= -90 && p.lat <= 90 &&
    p.lng >= -180 && p.lng <= 180
  );
}

export async function saveRoute(input: SaveInput): Promise<ActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, error: "Sign in to save a walk." };

  if (!validPoint(input?.origin) || !validPoint(input?.dest)) {
    return { ok: false, error: "That route has no usable coordinates." };
  }
  if (!finite(input.distanceM) || input.distanceM < 0) {
    return { ok: false, error: "That route has no usable distance." };
  }

  const coords = Array.isArray(input.coordinates) ? input.coordinates : [];
  if (coords.length < 2 || coords.length > MAX_POINTS) {
    return { ok: false, error: "That route's shape can't be saved." };
  }
  if (!coords.every((c) => Array.isArray(c) && c.length === 2 && finite(c[0]) && finite(c[1]))) {
    return { ok: false, error: "That route's shape can't be saved." };
  }

  const name = (input.name ?? "").trim().slice(0, 80) || null;

  const supabase = await createClient();
  const { error } = await supabase.from("routes").insert({
    user_id: user.id,
    name,
    origin_lat: input.origin.lat,
    origin_lng: input.origin.lng,
    dest_lat: input.dest.lat,
    dest_lng: input.dest.lng,
    // Stored as a GeoJSON LineString rather than a bare array: Phase D's
    // deviation detector needs to know what the numbers are without a comment
    // to tell it.
    path: { type: "LineString", coordinates: coords },
    distance_m: input.distanceM,
    // The same exposure figure the panel shows, so a saved walk and a live one
    // are never quoting two different numbers for the same thing.
    risk_score: finite(input.riskExposure) ? input.riskExposure : null,
  });

  if (error) return { ok: false, error: "Couldn't save that walk." };

  revalidatePath("/app");
  return { ok: true };
}

export async function deleteRoute(id: string): Promise<ActionResult> {
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, error: "Sign in first." };
  if (typeof id !== "string" || !UUID.test(id)) {
    return { ok: false, error: "Unknown walk." };
  }

  const supabase = await createClient();
  // The user_id filter is redundant under RLS and kept anyway: if a policy is
  // ever loosened by accident, this still refuses to delete someone else's row.
  const { error } = await supabase
    .from("routes")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return { ok: false, error: "Couldn't delete that walk." };

  revalidatePath("/app");
  return { ok: true };
}
