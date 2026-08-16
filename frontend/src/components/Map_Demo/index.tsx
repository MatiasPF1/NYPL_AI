"use client";

// maplibre-gl v6 dropped its default export; everything is a named import now.
import {
  GeoJSONSource,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type MapMouseEvent,
} from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { Wordmark } from "@/components/ui/wordmark";

const ROUTER = process.env.NEXT_PUBLIC_ROUTER_URL ?? "http://127.0.0.1:8000";

// Next's Turbopack bundle gives MapLibre a non-HTTP `import.meta.url`, so
// MapLibre 6 cannot derive its sibling worker module and falls back to
// `new Worker("")`. That loads this page as HTML and leaves every vector and
// GeoJSON source unprocessed. Pin the worker to the installed MapLibre version
// before the first map is constructed.
setWorkerUrl(
  "https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl-worker.mjs",
);

// Carto's dark basemap: no token, and it leaves the routes and the heatmap as
// the only bright things on screen, which is the whole point of the view.
const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Fallback if the vector style never loads. Raster tiles need no worker, no
// glyph server, and no vector decoding — if anything in that chain is broken,
// this still paints a map. Same dark Carto basemap, just pre-rendered.
const RASTER_STYLE = {
  version: 8 as const,
  sources: {
    carto: {
      type: "raster" as const,
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  layers: [{ id: "carto", type: "raster" as const, source: "carto" }],
};

type Point = { lat: number; lng: number };
type Path = {
  distance_m: number;
  risk_exposure: number;
  risky_segments: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
};
type RouteResponse = { shortest: Path; safest: Path; reason: string };

const PRESET = {
  label: "Times Sq → Washington Sq",
  fromText: "Times Square",
  toText: "Washington Square Park",
  from: { lat: 40.758, lng: -73.9855 },
  to: { lat: 40.7308, lng: -73.9973 },
};

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/**
 * Sources and layers for the routes and the heatmap.
 *
 * Extracted so it can run against whichever style ends up loading — a
 * `setStyle` call wipes every source and layer, so the fallback needs to
 * rebuild them rather than inherit them.
 */
function addLayers(m: MapLibreMap) {
  if (m.getSource("risk")) return;

  m.addSource("risk", { type: "geojson", data: EMPTY });
  m.addSource("shortest", { type: "geojson", data: EMPTY });
  m.addSource("safest", { type: "geojson", data: EMPTY });

  // Heatmap underneath, so a route never disappears behind the risk it is
  // avoiding. Colour and width both ramp with the score: on a dark map, hue
  // alone is hard to rank, width makes the tail unmissable.
  m.addLayer({
    id: "risk",
    type: "line",
    source: "risk",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": [
        "interpolate", ["linear"], ["get", "risk"],
        0, "#2E5A88",
        0.25, "#3F9BD9",
        0.5, "#F5C518",
        0.75, "#FF6319",
        1, "#EE352E",
      ],
      "line-width": ["interpolate", ["linear"], ["get", "risk"], 0, 1.5, 1, 4.5],
      "line-opacity": 0.75,
    },
  });

  // Shortest below safest, so the divergence is what the eye catches.
  m.addLayer({
    id: "shortest",
    type: "line",
    source: "shortest",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#FFFFFF",
      "line-width": 3,
      "line-opacity": 0.55,
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
}

type Painted = {
  risk: unknown | null;
  result: RouteResponse | null;
  heat: boolean;
};

/**
 * Push whatever we already know into the map's sources.
 *
 * Every `setStyle` call destroys sources and layers, so data fetched before a
 * style swap is gone. Keeping it in refs and replaying it here is what makes
 * the raster fallback survive with routes and heatmap intact, instead of
 * quietly coming back empty.
 */
function applyData(m: MapLibreMap, state: Painted) {
  if (!m.getSource("risk")) return;

  if (state.risk) {
    (m.getSource("risk") as GeoJSONSource).setData(
      state.risk as GeoJSON.FeatureCollection,
    );
  }
  m.setLayoutProperty("risk", "visibility", state.heat ? "visible" : "none");

  for (const key of ["shortest", "safest"] as const) {
    (m.getSource(key) as GeoJSONSource).setData(
      state.result
        ? { type: "Feature", properties: {}, geometry: state.result[key].geometry }
        : EMPTY,
    );
  }
}

export function MapDemo({ account }: { account?: React.ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);

  const [ready, setReady] = useState(false);
  const [pins, setPins] = useState<{ from: Point | null; to: Point | null }>({
    from: null,
    to: null,
  });
  const { from, to } = pins;
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [heat, setHeat] = useState(true);
  const [heatCount, setHeatCount] = useState<number | null>(null);
  // Mirrors of the map's data, so it can be replayed after a style swap
  // destroys every source. Refs, not state: the map listeners that read this
  // are registered once and would otherwise close over stale values.
  const painted = useRef<Painted>({ risk: null, result: null, heat: true });
  // Anything that stops the basemap from drawing. Kept separate from `error`
  // (which is about routing) so a dead map never looks like a dead router.
  const [mapError, setMapError] = useState<string | null>(null);

  // --- map init ------------------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    // WebGL is a hard requirement for MapLibre. Checking first turns "the page
    // is black" into a sentence that says why.
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) {
      setMapError(
        "This browser can't create a WebGL context, which the map needs. " +
          "Try Chrome or Edge, and check that hardware acceleration is on.",
      );
      return;
    }

    let m: MapLibreMap;
    try {
      m = new MapLibreMap({
        container: container.current,
        style: STYLE,
        center: [-73.9712, 40.7551],
        zoom: 12.2,
        attributionControl: { compact: true },
      });
    } catch (e) {
      setMapError(
        `The map failed to start: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

    // If the vector style hasn't finished in 6s, something in the vector
    // pipeline is wedged. Swap to raster rather than leaving a black rectangle.
    let usedFallback = false;
    let removed = false;
    const fallback = (why: string) => {
      if (usedFallback || removed) return;
      usedFallback = true;
      console.warn(`[SafeNYC] vector basemap failed (${why}); using raster`);
      m.setStyle(RASTER_STYLE);
    };
    // A map created before its container has been laid out ends up with a 0x0
    // canvas: MapLibre reads the size once at construction and never notices
    // it changed. It paints nothing and reports no error. Re-measuring on
    // every container resize is the fix, and it costs nothing.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(container.current);

    const timer = window.setTimeout(() => {
      const rect = container.current?.getBoundingClientRect();
      const canvas = m.getCanvas();
      console.warn(
        `[SafeNYC] container ${Math.round(rect?.width ?? 0)}x${Math.round(rect?.height ?? 0)}, ` +
          `canvas ${canvas.width}x${canvas.height}, styleLoaded=${m.isStyleLoaded()}`,
      );
      if (!rect || rect.width < 10 || rect.height < 10) {
        setMapError(
          `The map has no room to draw — its container measured ` +
            `${Math.round(rect?.width ?? 0)}x${Math.round(rect?.height ?? 0)} px. ` +
            `This is a layout bug, not a data problem.`,
        );
        return;
      }
      if (!m.isStyleLoaded()) fallback("timeout");
    }, 6000);

    // MapLibre reports style, tile, and worker failures here rather than
    // throwing. Without this handler they vanish into the console.
    m.on("error", (ev) => {
      const msg = ev?.error?.message ?? "unknown map error";
      // Individual tile misses are noise; a style or worker failure is not.
      if (/tile/i.test(msg)) return;
      if (!usedFallback) {
        fallback(msg);
        return;
      }
      setMapError(`Basemap error: ${msg}`);
    });

    // `styledata` fires again after setStyle, so the layers get rebuilt on the
    // fallback style too rather than only existing on the failed one.
    m.on("styledata", () => {
      if (!m.isStyleLoaded() || m.getSource("risk")) return;
      addLayers(m);
      applyData(m, painted.current);
      setReady(true);
    });

    m.on("load", () => {
      window.clearTimeout(timer);
      setMapError(null);
      addLayers(m);
      applyData(m, painted.current);
      setReady(true);
    });

    map.current = m;
    return () => {
      removed = true;
      window.clearTimeout(timer);
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  // --- load the risk heatmap once -----------------------------------------
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ROUTER}/risk`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        painted.current.risk = data;
        if (map.current) applyData(map.current, painted.current);
        setHeatCount(data.features.length);
      } catch {
        // The heatmap is decoration; routing is the product. Fail quietly.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  useEffect(() => {
    painted.current.heat = heat;
    const m = map.current;
    if (!m || !ready || !m.getLayer("risk")) return;
    m.setLayoutProperty("risk", "visibility", heat ? "visible" : "none");
  }, [heat, ready]);

  // --- click to place pins -------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const onClick = (e: MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      setError(null);
      // First click sets the origin, second the destination, third starts over.
      setPins((prev) => {
        if (!prev.from) {
          setFromText("");
          return { from: p, to: null };
        }
        if (!prev.to) {
          setToText("");
          return { from: prev.from, to: p };
        }
        setFromText("");
        setToText("");
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

  // --- routing -------------------------------------------------------------
  const run = useCallback(async (a: Point, b: Point) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${ROUTER}/route?from_lat=${a.lat}&from_lng=${a.lng}` +
          `&to_lat=${b.lat}&to_lng=${b.lng}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `router returned ${res.status}`);
      }
      const data: RouteResponse = await res.json();
      setResult(data);
      painted.current.result = data;

      const m = map.current;
      if (!m) return;
      applyData(m, painted.current);

      const coords = data.shortest.geometry.coordinates.concat(
        data.safest.geometry.coordinates,
      );
      const first = coords[0] as [number, number];
      const bounds = coords.reduce(
        (acc, c) => acc.extend(c as [number, number]),
        new LngLatBounds(first, first),
      );
      m.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 440, right: 80 }, duration: 700 });
    } catch (e) {
      setResult(null);
      setError(
        e instanceof Error && /fetch|network/i.test(e.message)
          ? `Can't reach the routing service at ${ROUTER}. Start it with: python -m uvicorn backend.app.main:app --port 8000`
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

  // --- address search ------------------------------------------------------
  const geocode = useCallback(async (q: string): Promise<Point> => {
    const res = await fetch(`${ROUTER}/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`Couldn't look up "${q}".`);
    const data = await res.json();
    if (!data.results?.length) {
      throw new Error(`No match for "${q}" in Manhattan below 96th.`);
    }
    return { lat: data.results[0].lat, lng: data.results[0].lng };
  }, []);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromText.trim() || !toText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Sequential, not parallel: Nominatim's usage policy is one request a
      // second and it will start refusing if we fan out.
      const a = await geocode(fromText.trim());
      const b = await geocode(toText.trim());
      setPins({ from: a, to: b });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Address lookup failed.");
      setBusy(false);
    }
  };

  const reset = () => {
    setPins({ from: null, to: null });
    setFromText("");
    setToText("");
    setResult(null);
    setError(null);
    painted.current.result = null;
    if (map.current) applyData(map.current, painted.current);
  };

  const extra = result
    ? Math.round(result.safest.distance_m - result.shortest.distance_m)
    : 0;

  const field =
    "w-full rounded-lg border border-white/15 bg-white/5 px-3.5 py-2.5 text-[14px] text-white transition-colors placeholder:text-white/35 hover:border-white/25 focus:border-white/60 focus:outline-none";

  return (
    // Positioning is inline, not utility classes.
    //
    // This wrapper has no content height of its own — both children are taken
    // out of flow — so if `position` fails to apply, it collapses to zero and
    // MapLibre builds a 0-height canvas, paints nothing, and reports no error.
    // That failure is silent and cost hours to find, and a stale dev
    // stylesheet is enough to cause it. Three declarations are too
    // load-bearing to route through the CSS pipeline.
    <div
      style={{ position: "fixed", inset: 0 }}
      className="overflow-hidden bg-black font-sans text-white"
    >
      <div ref={container} style={{ position: "absolute", inset: 0 }} />

      <div
        style={{ position: "absolute", top: 0, bottom: 0, left: 0 }}
        className="pointer-events-none flex w-full max-w-[400px] flex-col p-4 sm:p-6"
      >
        <div className="pointer-events-auto flex max-h-full flex-col overflow-y-auto rounded-xl border border-white/10 bg-black/85 p-5 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3">
            <Wordmark tone="light" />
            {account}
          </div>

          {/* Address search */}
          <form onSubmit={search} className="mt-5 flex flex-col gap-2">
            <label htmlFor="from" className="sr-only">
              Starting street or place
            </label>
            <input
              id="from"
              value={fromText}
              onChange={(e) => setFromText(e.target.value)}
              placeholder="From — e.g. Times Square"
              className={field}
            />
            <label htmlFor="to" className="sr-only">
              Destination street or place
            </label>
            <input
              id="to"
              value={toText}
              onChange={(e) => setToText(e.target.value)}
              placeholder="To — e.g. Washington Square Park"
              className={field}
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy || !fromText.trim() || !toText.trim()}
                className="flex-1 rounded-lg bg-white px-4 py-2.5 text-[14px] font-medium text-black transition-opacity hover:opacity-85 disabled:opacity-40"
              >
                {busy ? "Routing…" : "Find the safer walk"}
              </button>
              {(from || to || result) && (
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg border border-white/25 px-3.5 py-2.5 text-[14px] font-medium text-white transition-colors hover:border-white/60"
                >
                  Clear
                </button>
              )}
            </div>
          </form>

          <p className="mt-3 text-[13px] leading-[1.5] text-white/40">
            {!from
              ? "Type two places, or click the map to drop your start pin."
              : !to
                ? "Now click your destination."
                : "Click the map again to start over."}
          </p>

          {mapError && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-[#FF8A80]/30 bg-[#FF8A80]/10 p-3 text-[13px] leading-[1.55] text-[#FF8A80]"
            >
              {mapError}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-[13px] leading-[1.55] text-[#FF8A80]">
              {error}
            </p>
          )}

          {result && (
            <>
              <p className="mt-5 text-[17px] leading-[1.45] font-medium text-pretty">
                {result.reason}
              </p>

              <dl className="mt-4 flex flex-col gap-2.5">
                {(
                  [
                    ["safest", "Safest", "#4D86FF", result.safest],
                    ["shortest", "Shortest", "#FFFFFF", result.shortest],
                  ] as const
                ).map(([key, label, color, p]) => (
                  <div key={key} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="h-[3px] w-6 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    <dt className="w-[62px] text-[14px] text-white/70">{label}</dt>
                    <dd className="text-[14px] tabular-nums text-white">
                      {(p.distance_m / 1000).toFixed(2)} km
                      <span className="ml-2 text-white/45">
                        exposure {p.risk_exposure.toFixed(0)}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="mt-3 text-[13px] leading-[1.55] text-white/45">
                {extra <= 0
                  ? "No detour needed on this trip."
                  : `About ${extra} m further — roughly ${Math.max(1, Math.round(extra / 80))} min of extra walking.`}
              </p>
            </>
          )}

          {/* Heatmap control + legend */}
          <div className="mt-5 border-t border-white/10 pt-4">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-[14px] font-medium">Crash risk heatmap</span>
              <input
                type="checkbox"
                checked={heat}
                onChange={(e) => setHeat(e.target.checked)}
                className="h-4 w-4 accent-[#4D86FF]"
              />
            </label>

            {heat && (
              <>
                <div
                  aria-hidden
                  className="mt-3 h-1.5 w-full rounded-full"
                  style={{
                    background:
                      "linear-gradient(90deg,#2E5A88,#3F9BD9,#F5C518,#FF6319,#EE352E)",
                  }}
                />
                <div className="mt-1.5 flex justify-between font-mono text-[10px] tracking-wider text-white/40 uppercase">
                  <span>Lower</span>
                  <span>Higher</span>
                </div>
                <p className="mt-2.5 text-[12px] leading-[1.5] text-white/40">
                  {heatCount === null
                    ? "Loading…"
                    : `${heatCount.toLocaleString()} Manhattan segments scored from 23,775 injury crashes since 2022.`}
                </p>
              </>
            )}
          </div>

          <button
            onClick={() => {
              setFromText(PRESET.fromText);
              setToText(PRESET.toText);
              setPins({ from: PRESET.from, to: PRESET.to });
            }}
            className="mt-4 rounded-lg border border-white/25 px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:border-white/60"
          >
            Try {PRESET.label}
          </button>
        </div>
      </div>
    </div>
  );
}
