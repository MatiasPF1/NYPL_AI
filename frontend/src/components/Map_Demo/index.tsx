"use client";

// maplibre-gl v6 dropped its default export; everything is a named import now.
import {
  GeoJSONSource,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type MapMouseEvent,
} from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { Wordmark } from "@/components/ui/wordmark";

const ROUTER = process.env.NEXT_PUBLIC_ROUTER_URL ?? "http://127.0.0.1:8000";

// Carto's dark basemap: no token, and it leaves the two route lines as the
// only bright things on screen, which is the whole point of the view.
const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

type Point = { lat: number; lng: number };
type Path = {
  distance_m: number;
  risk_exposure: number;
  risky_segments: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
};
type RouteResponse = { shortest: Path; safest: Path; reason: string };

const PRESET: { from: Point; to: Point; label: string } = {
  label: "Times Square → Washington Square",
  from: { lat: 40.758, lng: -73.9855 },
  to: { lat: 40.7308, lng: -73.9973 },
};

export function MapDemo() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  // One piece of state, not two: the click handler needs to see both pins to
  // decide whether it is setting the origin, the destination, or starting over.
  const [pins, setPins] = useState<{ from: Point | null; to: Point | null }>({
    from: null,
    to: null,
  });
  const { from, to } = pins;
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- map init ------------------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new MapLibreMap({
      container: container.current,
      style: STYLE,
      center: [-73.9855, 40.75],
      zoom: 12.6,
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

    m.on("load", () => {
      // `as const` on the whole object would make `features` readonly, which
      // MapLibre's GeoJSON types reject.
      const empty = { type: "FeatureCollection" as const, features: [] };
      m.addSource("shortest", { type: "geojson", data: empty });
      m.addSource("safest", { type: "geojson", data: empty });

      // Shortest goes down first so the safest route draws on top of it where
      // the two overlap — the divergence is what the eye should catch.
      m.addLayer({
        id: "shortest",
        type: "line",
        source: "shortest",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#8A8F98",
          "line-width": 3.5,
          "line-dasharray": [2, 2],
        },
      });
      m.addLayer({
        id: "safest",
        type: "line",
        source: "safest",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4D86FF", "line-width": 5 },
      });
      setReady(true);
    });

    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // --- click to place pins -------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const onClick = (e: MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      setError(null);
      // First click sets the origin, second the destination, third starts over.
      // Cheaper to learn than a mode toggle.
      setPins((prev) => {
        if (!prev.from) return { from: p, to: null };
        if (!prev.to) return { from: prev.from, to: p };
        return { from: p, to: null };
      });
    };

    m.on("click", onClick);
    return () => {
      m.off("click", onClick);
    };
  }, [ready]);

  // --- draw pins -----------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const mk of markers.current) mk.remove();
    markers.current = [];
    for (const [p, color] of [
      [from, "#FFFFFF"],
      [to, "#4D86FF"],
    ] as const) {
      if (!p) continue;
      markers.current.push(
        new Marker({ color }).setLngLat([p.lng, p.lat]).addTo(m),
      );
    }
  }, [from, to]);

  // --- fetch the two routes ------------------------------------------------
  const run = useCallback(async (a: Point, b: Point) => {
    setBusy(true);
    setError(null);
    try {
      const url =
        `${ROUTER}/route?from_lat=${a.lat}&from_lng=${a.lng}` +
        `&to_lat=${b.lat}&to_lng=${b.lng}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `router returned ${res.status}`);
      }
      const data: RouteResponse = await res.json();
      setResult(data);

      const m = map.current;
      if (!m) return;
      for (const key of ["shortest", "safest"] as const) {
        (m.getSource(key) as GeoJSONSource | undefined)?.setData({
          type: "Feature",
          properties: {},
          geometry: data[key].geometry,
        });
      }
      const coords = data.shortest.geometry.coordinates.concat(
        data.safest.geometry.coordinates,
      );
      const bounds = coords.reduce(
        (acc, c) => acc.extend(c as [number, number]),
        new LngLatBounds(
          coords[0] as [number, number],
          coords[0] as [number, number],
        ),
      );
      m.fitBounds(bounds, { padding: 90, duration: 700 });
    } catch (e) {
      setResult(null);
      setError(
        e instanceof Error && e.message.includes("fetch")
          ? `Can't reach the routing service at ${ROUTER}. Start it with: uvicorn backend.app.main:app --port 8000`
          : e instanceof Error
            ? e.message
            : "Routing failed.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (from && to) void run(from, to);
  }, [from, to, run]);

  const reset = () => {
    setPins({ from: null, to: null });
    setResult(null);
    setError(null);
    const m = map.current;
    for (const key of ["shortest", "safest"] as const) {
      (m?.getSource(key) as GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: [],
      });
    }
  };

  const extra = result
    ? Math.round(result.safest.distance_m - result.shortest.distance_m)
    : 0;

  return (
    <div className="relative h-svh w-full bg-black font-sans text-white">
      <div ref={container} className="absolute inset-0" />

      {/* Panel */}
      <div className="pointer-events-none absolute inset-y-0 left-0 flex w-full max-w-[400px] flex-col gap-4 p-6">
        <div className="pointer-events-auto rounded-xl border border-white/10 bg-black/85 p-5 backdrop-blur-md">
          <Wordmark tone="light" />

          <p className="mt-5 font-mono text-[11px] tracking-[0.16em] text-white/50 uppercase">
            {!from ? "Click your start" : !to ? "Click your destination" : "Your two options"}
          </p>

          {!result && !busy && (
            <p className="mt-3 text-[15px] leading-[1.55] text-white/60">
              Drop two pins in Manhattan below 96th and SafeNYC draws the
              shortest walk against the one that steps around crash-heavy
              blocks.
            </p>
          )}

          {busy && (
            <p className="mt-3 text-[15px] text-white/60">Routing…</p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-[14px] leading-[1.55] text-[#FF8A80]">
              {error}
            </p>
          )}

          {result && (
            <>
              <p className="mt-3 text-[17px] leading-[1.45] font-medium text-pretty">
                {result.reason}
              </p>

              <dl className="mt-5 flex flex-col gap-2.5">
                {(
                  [
                    ["safest", "Safest", "#4D86FF", result.safest],
                    ["shortest", "Shortest", "#8A8F98", result.shortest],
                  ] as const
                ).map(([key, label, color, p]) => (
                  <div key={key} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="h-[3px] w-6 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    <dt className="w-[70px] text-[14px] text-white/70">{label}</dt>
                    <dd className="text-[14px] tabular-nums text-white">
                      {(p.distance_m / 1000).toFixed(2)} km
                      <span className="ml-2 text-white/45">
                        exposure {p.risk_exposure.toFixed(0)}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="mt-4 border-t border-white/10 pt-4 text-[13px] leading-[1.55] text-white/45">
                {extra <= 0
                  ? "No detour needed on this trip."
                  : `Costs you about ${extra} m — roughly ${Math.max(1, Math.round(extra / 80))} min of extra walking.`}
              </p>
            </>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={() => {
                setPins({ from: PRESET.from, to: PRESET.to });
              }}
              className="rounded-lg bg-white px-4 py-2.5 text-[14px] font-medium text-black transition-opacity hover:opacity-85"
            >
              Try {PRESET.label}
            </button>
            {(from || to) && (
              <button
                onClick={reset}
                className="rounded-lg border border-white/25 px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:border-white/60"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
