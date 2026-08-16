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
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { deleteRoute, saveRoute, type SavedRoute } from "@/components/Map_Demo/actions";
import {
  grantConsent,
  raiseAlert,
  revokeConsent,
  type AlertKind,
  type Consent,
} from "@/components/Map_Demo/safety";
import { Wordmark } from "@/components/ui/wordmark";
import { metresBetween, metresFromPath, offsetMetres, type LngLat } from "@/lib/geo";
import { createClient } from "@/lib/supabase/client";

const ROUTER = process.env.NEXT_PUBLIC_ROUTER_URL ?? "http://127.0.0.1:8000";

// --- the safety loop's constants ------------------------------------------
// One joystick press. About eight paces — small enough to steer with, big
// enough that leaving the route takes a deliberate few taps rather than one.
const STEP_M = 20;
// How far off the recommended line counts as "off it". Comfortably wider than
// a city block's worth of GPS wobble, so crossing to the other pavement is not
// a departure.
const OFF_PATH_M = 50;
// …and for how long. This is the number that stops a single GPS jump — the
// kind that happens every time you walk past a tall building — from firing an
// alert. Being 60 m off for one reading is noise; being 60 m off for ten
// seconds is a wrong turn.
const SUSTAINED_MS = 10_000;
// Within this of the destination, the walk is over.
const ARRIVE_M = 40;
// The detector re-checks on a timer as well as on movement, so standing still
// in the wrong place still raises an alert.
const TICK_MS = 2_000;
// Live positions are written to the database at most this often. A trip is a
// few dozen rows, not a few thousand.
const WRITE_EVERY_MS = 4_000;

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
  flood_exposure: number;
  flooded_segments: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
};
type Borough = { mm_h: number | null; raining: boolean; armed: boolean };
type Weather = {
  override: Rain;
  available: boolean;
  armed_anywhere: boolean;
  threshold_mm_h: number;
  age_s: number | null;
  boroughs: Record<string, Borough>;
};
type RouteResponse = {
  shortest: Path;
  safest: Path;
  reason: string;
  weather: Weather;
};

/** Whether the flood term is armed: by the weather, or by hand. */
type Rain = "auto" | "on" | "off";

const BOROUGH_LABEL: Record<string, string> = {
  manhattan: "Manhattan",
  brooklyn: "Brooklyn",
  queens: "Queens",
  bronx: "the Bronx",
  staten_island: "Staten Island",
};

const PRESET = {
  label: "Times Sq → Washington Sq",
  fromText: "Times Square",
  toText: "Washington Square Park",
  from: { lat: 40.758, lng: -73.9855 },
  to: { lat: 40.7308, lng: -73.9973 },
};

/**
 * The saved walk the dry-vs-rain comparison runs on.
 *
 * Not chosen by hand: every pair of downtown landmarks was routed twice, dry
 * and armed, and this one came back with the largest change for the smallest
 * detour. The shortest way crosses five blocks FloodNet has measured
 * underwater; the rain-aware route crosses none, for 34 m. Short enough to be
 * a walk someone would actually take (~21 min), which the multi-kilometre
 * pairs that also diverge are not.
 */
const STORM = {
  label: "Alphabet City → Delancey St",
  fromText: "Alphabet City",
  toText: "Delancey & Essex",
  from: { lat: 40.725, lng: -73.977 },
  to: { lat: 40.7183, lng: -73.988 },
};

const EMPTY = { type: "FeatureCollection" as const, features: [] };

// --- the colour system ----------------------------------------------------
//
// Four things have to stay apart on a dark map seen from the back of a room:
// the safe walk, the fast walk, crash risk, and flooding. These were validated
// as a set rather than picked by eye — worst pair ΔE 9.7 under deuteranopia,
// 20.6 with normal vision, all four above 3:1 against the basemap.
//
// The rule that makes it readable: **hazards own the hue ramps, routes own the
// bright end.** Neither ramp is allowed near a route colour, and every route
// gets a dark casing so it never blends into the hazard it is avoiding.
const SAFEST = "#00E58A"; // the recommended walk
const FASTEST = "#FFFFFF"; // what your phone would give you — dashed, achromatic
const RAIN_ROUTE = "#FFB020"; // the same walk, re-solved for a storm
const CASING = "#05070A"; // the halo that lifts a route off the heatmap

// Sequential, single-hue, monotone in lightness: dark where risk is low, bright
// where it is high.
//
// The previous ramp ran blue → cyan → yellow → orange → red, which is a rainbow
// and peaked in brightness at *medium* risk (OKLab L 0.46, 0.66, 0.84, 0.69,
// 0.62). The loudest streets on the map were not the worst ones, and its blue
// low end was the same colour as the route. Both are fixed by ramping one hue.
const CRASH_RAMP = ["#4A1620", "#8C1D2B", "#D42A36", "#FF5347"] as const;
const FLOOD_RAMP = ["#12345E", "#2F6FD0", "#6FB2FF"] as const;

/**
 * Sources and layers for the routes and the heatmap.
 *
 * Extracted so it can run against whichever style ends up loading — a
 * `setStyle` call wipes every source and layer, so the fallback needs to
 * rebuild them rather than inherit them.
 */
function addLayers(m: MapLibreMap) {
  if (m.getSource("risk")) return;

  m.addSource("flood", { type: "geojson", data: EMPTY });
  m.addSource("risk", { type: "geojson", data: EMPTY });
  m.addSource("shortest", { type: "geojson", data: EMPTY });
  m.addSource("rain", { type: "geojson", data: EMPTY });
  m.addSource("safest", { type: "geojson", data: EMPTY });

  // Flooding sits at the bottom of the stack, ramping one blue. Water reads
  // cold and traffic reads hot, so the two hazards never have to be told apart
  // by position, and both can be on at once.
  m.addLayer({
    id: "flood",
    type: "line",
    source: "flood",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": [
        "interpolate", ["linear"], ["get", "risk"],
        0, FLOOD_RAMP[0],
        0.5, FLOOD_RAMP[1],
        1, FLOOD_RAMP[2],
      ],
      // Width answers to the score *and* the zoom. Five thousand segments at
      // street width is a solid wash when the whole island is on screen; the
      // same widths are too thin to see once you are down at block level.
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        11, ["interpolate", ["linear"], ["get", "risk"], 0, 0.4, 1, 2],
        14, ["interpolate", ["linear"], ["get", "risk"], 0, 1, 1, 4.5],
        17, ["interpolate", ["linear"], ["get", "risk"], 0, 1.5, 1, 8],
      ],
      // Barely-scored segments stay nearly invisible on purpose. Painting every
      // scored block at one strength is what turned this into a wash of colour;
      // the eye should land on the blocks that actually flood.
      "line-opacity": [
        "interpolate", ["linear"], ["get", "risk"],
        0, 0.2, 0.5, 0.7, 1, 0.95,
      ],
    },
  });

  // Crash risk above it, ramping one red. Colour, width and opacity all climb
  // with the same number — three encodings of one value, so the worst blocks
  // are unmistakable even projected onto a wall from the back of a room.
  m.addLayer({
    id: "risk",
    type: "line",
    source: "risk",
    layout: { "line-cap": "round" },
    paint: {
      "line-color": [
        "interpolate", ["linear"], ["get", "risk"],
        0, CRASH_RAMP[0],
        0.33, CRASH_RAMP[1],
        0.66, CRASH_RAMP[2],
        1, CRASH_RAMP[3],
      ],
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        11, ["interpolate", ["linear"], ["get", "risk"], 0, 0.4, 1, 2.2],
        14, ["interpolate", ["linear"], ["get", "risk"], 0, 1, 1, 5],
        17, ["interpolate", ["linear"], ["get", "risk"], 0, 1.5, 1, 9],
      ],
      "line-opacity": [
        "interpolate", ["linear"], ["get", "risk"],
        0, 0.25, 0.5, 0.75, 1, 1,
      ],
    },
  });

  // Routes on top, each one a bright line over a dark casing. Without the
  // casing, a route crossing a hot segment takes on its colour and the eye
  // loses the line exactly where the story is.
  //
  // Order matters: fastest at the bottom — it is the reference, not the answer
  // — then the storm route, then the recommended walk, which nothing covers.
  for (const [id, color, width, dashed] of [
    ["shortest", FASTEST, 3, true],
    ["rain", RAIN_ROUTE, 5, false],
    ["safest", SAFEST, 5.5, false],
  ] as const) {
    m.addLayer({
      id: `${id}-casing`,
      type: "line",
      source: id,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": CASING,
        "line-width": width + 4,
        "line-opacity": dashed ? 0.45 : 0.85,
      },
    });
    m.addLayer({
      id,
      type: "line",
      source: id,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": width,
        // The fastest line is deliberately recessive — it is the thing being
        // argued against. Its dashes carry identity as well as its colour
        // does, which is what lets it stay legible without competing.
        "line-opacity": dashed ? 0.85 : 1,
        ...(dashed ? { "line-dasharray": [1.5, 1.75] } : {}),
      },
    });
  }
}

/**
 * The same walk solved twice — once with the flood term off, once with it
 * armed. Holding both at the same time is the only way to show that the
 * weather changes the answer rather than just the wording.
 */
type Compare = { dry: RouteResponse; storm: RouteResponse };

type Painted = {
  risk: unknown | null;
  flood: unknown | null;
  result: RouteResponse | null;
  compare: Compare | null;
  heat: boolean;
  wet: boolean;
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

  for (const [key, data, on] of [
    ["risk", state.risk, state.heat],
    ["flood", state.flood, state.wet],
  ] as const) {
    if (data) {
      (m.getSource(key) as GeoJSONSource).setData(data as GeoJSON.FeatureCollection);
    }
    m.setLayoutProperty(key, "visibility", on ? "visible" : "none");
  }

  // In compare mode the three lines mean: what your phone gives you, what we
  // give you on a dry night, and what we give you in a storm. Out of it, the
  // storm line is empty and it is the usual two.
  const lines = state.compare
    ? {
        // The length-only search ignores the weather, so either response's
        // shortest path is the same line. Take the armed one, because that is
        // the one whose flooded-block count the panel quotes.
        shortest: state.compare.storm.shortest.geometry,
        safest: state.compare.dry.safest.geometry,
        rain: state.compare.storm.safest.geometry,
      }
    : {
        shortest: state.result?.shortest.geometry ?? null,
        safest: state.result?.safest.geometry ?? null,
        rain: null,
      };

  for (const key of ["shortest", "safest", "rain"] as const) {
    const geometry = lines[key];
    (m.getSource(key) as GeoJSONSource).setData(
      geometry ? { type: "Feature", properties: {}, geometry } : EMPTY,
    );
  }
}

type Trip = { routeId: string | null; path: LngLat[]; dest: LngLat };
type Fired = { id: number; kind: AlertKind; at: number; delivery: string; detail?: string };

export function MapDemo({
  account,
  saved,
  consent,
  userId,
  defaultEmail,
}: {
  account?: React.ReactNode;
  /** Present only on /app, where there is a session to own them. */
  saved?: SavedRoute[];
  consent?: Consent | null;
  userId?: string;
  defaultEmail?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const liveMarker = useRef<Marker | null>(null);
  const router = useRouter();

  const [ready, setReady] = useState(false);
  const [pins, setPins] = useState<{ from: Point | null; to: Point | null }>({
    from: null,
    to: null,
  });
  const { from, to } = pins;
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [result, setResult] = useState<RouteResponse | null>(null);
  // Set only by the dry-vs-rain button. `mode` is what the routing effect
  // dispatches on, so placing pins any other way drops back to a single route
  // instead of silently re-running the comparison.
  const [compare, setCompare] = useState<Compare | null>(null);
  const [mode, setMode] = useState<"single" | "compare">("single");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [heat, setHeat] = useState(true);
  const [heatCount, setHeatCount] = useState<number | null>(null);
  const [wet, setWet] = useState(false);
  const [floodCount, setFloodCount] = useState<number | null>(null);
  const [rain, setRain] = useState<Rain>("auto");
  const [weather, setWeather] = useState<Weather | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // --- the walk in progress ------------------------------------------------
  const [trip, setTrip] = useState<Trip | null>(null);
  const [pos, setPos] = useState<LngLat | null>(null);
  const [offBy, setOffBy] = useState(0);
  const [fired, setFired] = useState<Fired[]>([]);
  const [tripMsg, setTripMsg] = useState<string | null>(null);
  const [gps, setGps] = useState(false);
  const [alertEmail, setAlertEmail] = useState(defaultEmail ?? "");
  const [phone, setPhone] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const [consentMsg, setConsentMsg] = useState<string | null>(null);

  // Detector state lives in refs: the timer and the keyboard handler are
  // registered once and would otherwise compare against a stale position.
  const tripRef = useRef<Trip | null>(null);
  const posRef = useRef<LngLat | null>(null);
  const offSince = useRef<number | null>(null);
  const alerted = useRef(false);
  const lastWrite = useRef(0);
  const watchId = useRef<number | null>(null);
  // Mirrors of the map's data, so it can be replayed after a style swap
  // destroys every source. Refs, not state: the map listeners that read this
  // are registered once and would otherwise close over stale values.
  const painted = useRef<Painted>({
    risk: null,
    flood: null,
    result: null,
    compare: null,
    heat: true,
    wet: false,
  });
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

  // --- load both hazard layers once ---------------------------------------
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      for (const [path, key, count] of [
        ["/risk", "risk", setHeatCount],
        ["/flood", "flood", setFloodCount],
      ] as const) {
        try {
          const res = await fetch(`${ROUTER}${path}`);
          if (!res.ok) continue;
          const data = await res.json();
          if (cancelled) return;
          painted.current[key] = data;
          if (map.current) applyData(map.current, painted.current);
          count(data.features.length);
        } catch {
          // The overlays are decoration; routing is the product. Fail quietly.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  useEffect(() => {
    painted.current.heat = heat;
    painted.current.wet = wet;
    const m = map.current;
    if (!m || !ready || !m.getLayer("risk")) return;
    m.setLayoutProperty("risk", "visibility", heat ? "visible" : "none");
    m.setLayoutProperty("flood", "visibility", wet ? "visible" : "none");
  }, [heat, wet, ready]);

  // --- the weather gate ----------------------------------------------------
  // Read once per override change, so the panel can say whether the flood term
  // is armed before anyone runs a route. The router caches Open-Meteo for an
  // hour, so this is cheap however often it is called.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ROUTER}/weather?rain=${rain}`);
        if (!res.ok) return;
        const data: Weather = await res.json();
        if (!cancelled) setWeather(data);
      } catch {
        if (!cancelled) setWeather(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rain]);

  // --- click to place pins -------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;

    const onClick = (e: MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      setError(null);
      setMode("single");
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
    // Start is achromatic, destination is the safe-route green: the pin and the
    // line that reaches it say the same thing.
    for (const [p, color] of [
      [from, "#FFFFFF"],
      [to, SAFEST],
    ] as const) {
      if (!p) continue;
      markers.current.push(
        new Marker({ color }).setLngLat([p.lng, p.lat]).addTo(m),
      );
    }
  }, [from, to]);

  // --- the live position marker -------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!pos) {
      liveMarker.current?.remove();
      liveMarker.current = null;
      return;
    }
    if (!liveMarker.current) {
      liveMarker.current = new Marker({ color: "#22C55E" }).setLngLat(pos).addTo(m);
    } else {
      liveMarker.current.setLngLat(pos);
    }
  }, [pos]);

  useEffect(() => {
    return () => {
      liveMarker.current?.remove();
      liveMarker.current = null;
    };
  }, []);

  // --- routing -------------------------------------------------------------
  const ask = useCallback(
    async (a: Point, b: Point, wx: Rain): Promise<RouteResponse> => {
      const res = await fetch(
        `${ROUTER}/route?from_lat=${a.lat}&from_lng=${a.lng}` +
          `&to_lat=${b.lat}&to_lng=${b.lng}&rain=${wx}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `router returned ${res.status}`);
      }
      return res.json();
    },
    [],
  );

  /** Frame every line that is currently drawn, clear of the panel. */
  const frame = useCallback((paths: Path[]) => {
    const m = map.current;
    const coords = paths.flatMap((p) => p.geometry.coordinates);
    if (!m || !coords.length) return;
    const first = coords[0] as [number, number];
    const bounds = coords.reduce(
      (acc, c) => acc.extend(c as [number, number]),
      new LngLatBounds(first, first),
    );
    m.fitBounds(bounds, {
      padding: { top: 80, bottom: 80, left: 440, right: 80 },
      duration: 700,
    });
  }, []);

  const explain = useCallback(
    (e: unknown) =>
      e instanceof Error && /fetch|network/i.test(e.message)
        ? `Can't reach the routing service at ${ROUTER}. Start it with: python -m uvicorn backend.app.main:app --port 8000`
        : e instanceof Error
          ? e.message
          : "Routing failed.",
    [],
  );

  // `rain` is a dependency, not a captured value: changing the override has to
  // re-run the search, because it changes the cost function the router uses.
  const run = useCallback(
    async (a: Point, b: Point) => {
      setBusy(true);
      setError(null);
      setSaveMsg(null);
      try {
        const data = await ask(a, b, rain);
        setResult(data);
        setCompare(null);
        setWeather(data.weather);
        painted.current.result = data;
        painted.current.compare = null;

        if (!map.current) return;
        applyData(map.current, painted.current);
        frame([data.shortest, data.safest]);
      } catch (e) {
        setResult(null);
        setError(explain(e));
      } finally {
        setBusy(false);
      }
    },
    [rain, ask, frame, explain],
  );

  /**
   * The same two points, solved under both weathers at once.
   *
   * Both searches are asked for explicitly rather than read off the live gate:
   * the whole point is to show the dry answer and the storm answer side by
   * side, which is impossible if the weather has to actually change first. The
   * flood layer is switched on because the storm line is unreadable without the
   * hazard it is bending around.
   */
  const runCompare = useCallback(
    async (a: Point, b: Point) => {
      setBusy(true);
      setError(null);
      setSaveMsg(null);
      try {
        const [dry, storm] = await Promise.all([
          ask(a, b, "off"),
          ask(a, b, "on"),
        ]);
        const pair = { dry, storm };
        setCompare(pair);
        // The storm answer is the one a walk would start from, so the rest of
        // the panel keeps working off it.
        setResult(storm);
        // Deliberately *not* setWeather(storm.weather). That snapshot has every
        // borough armed because the request forced it, and writing it into the
        // panel would make the gate claim it is raining outside right now. The
        // storm route is a simulation; the gate keeps reporting the real sky.
        setWet(true);
        painted.current.compare = pair;
        painted.current.result = storm;

        if (!map.current) return;
        applyData(map.current, painted.current);
        frame([dry.shortest, dry.safest, storm.safest]);
      } catch (e) {
        setCompare(null);
        setResult(null);
        setError(explain(e));
      } finally {
        setBusy(false);
      }
    },
    [ask, frame, explain],
  );

  useEffect(() => {
    if (!from || !to) return;
    if (mode === "compare") void runCompare(from, to);
    else void run(from, to);
  }, [from, to, mode, run, runCompare]);

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
      setMode("single");
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
    setCompare(null);
    setMode("single");
    setError(null);
    setSaveMsg(null);
    painted.current.result = null;
    painted.current.compare = null;
    if (map.current) applyData(map.current, painted.current);
  };

  /** The saved storm walk: load it and solve it under both weathers at once. */
  const runStormDemo = () => {
    setSaveMsg(null);
    setError(null);
    setFromText(STORM.fromText);
    setToText(STORM.toText);
    setHeat(true);
    setMode("compare");
    setPins({ from: STORM.from, to: STORM.to });
  };

  // --- saved walks ---------------------------------------------------------
  const save = () => {
    if (!result || !from || !to) return;
    const typed = fromText.trim() && toText.trim()
      ? `${fromText.trim()} → ${toText.trim()}`
      : null;
    startTransition(async () => {
      const res = await saveRoute({
        name: typed,
        origin: from,
        dest: to,
        coordinates: result.safest.geometry.coordinates,
        distanceM: result.safest.distance_m,
        riskExposure: result.safest.risk_exposure,
      });
      setSaveMsg(res.ok ? "Saved." : res.error);
      // The list is rendered on the server, so it only changes when the server
      // re-renders the page.
      if (res.ok) router.refresh();
    });
  };

  const remove = (id: string) => {
    startTransition(async () => {
      const res = await deleteRoute(id);
      if (res.ok) router.refresh();
      else setSaveMsg(res.error);
    });
  };

  // --- the safety loop -----------------------------------------------------
  const fire = useCallback(
    (kind: AlertKind, at: LngLat, offByM?: number) => {
      // Read now, not inside the transition: arrival ends the walk immediately
      // and would clear the trip out from under the async call, filing the
      // alert against no route at all.
      const routeId = tripRef.current?.routeId ?? null;
      startTransition(async () => {
        const res = await raiseAlert({
          kind,
          routeId,
          lat: at[1],
          lng: at[0],
          offByM: offByM ?? null,
        });
        setFired((prev) => [
          {
            id: Date.now(),
            kind,
            at: Date.now(),
            delivery: res.ok ? res.delivery : "failed",
            detail: res.ok ? res.detail : res.error,
          },
          ...prev,
        ]);
      });
    },
    [],
  );

  const stopWalk = useCallback((announce = true) => {
    tripRef.current = null;
    setTrip(null);
    setPos(null);
    posRef.current = null;
    setOffBy(0);
    offSince.current = null;
    alerted.current = false;
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setGps(false);
    if (announce) setTripMsg("Tracking stopped.");
  }, []);

  /** One position update: store it, judge it, and act if it has gone on too long. */
  const observe = useCallback(
    (p: LngLat) => {
      const t = tripRef.current;
      posRef.current = p;
      setPos(p);
      if (!t) return;

      const away = metresFromPath(p, t.path);
      setOffBy(away);

      // Persist the track. Throttled — the detector runs on every update, but
      // the database does not need a row for each one.
      const now = Date.now();
      if (userId && now - lastWrite.current > WRITE_EVERY_MS) {
        lastWrite.current = now;
        void createClient()
          .from("locations")
          .insert({
            user_id: userId,
            route_id: t.routeId,
            lat: p[1],
            lng: p[0],
          })
          .then(({ error }) => {
            // Not surfaced in the panel — a dropped position is not something
            // the walker can act on — but never swallowed either, because a
            // policy that rejects every write would otherwise look identical
            // to a walk that recorded fine.
            if (error) console.warn("[SafeNYC] location not recorded:", error.message);
          });
      }

      if (metresBetween(p, t.dest) <= ARRIVE_M) {
        fire("arrived", p);
        setTripMsg("Arrived. Tracking stopped.");
        stopWalk(false);
        return;
      }

      if (away > OFF_PATH_M) {
        // Sustained, not instantaneous: the clock starts on the first reading
        // off the line and only an unbroken run of them raises anything.
        if (offSince.current === null) offSince.current = now;
        if (!alerted.current && now - offSince.current >= SUSTAINED_MS) {
          alerted.current = true;
          fire("deviation", p, away);
        }
      } else {
        // Back on the route: reset, so a second departure alerts again.
        offSince.current = null;
        alerted.current = false;
      }
    },
    [userId, fire, stopWalk],
  );

  const startWalk = () => {
    if (!result || !from || !to) return;
    if (!consent?.consentedAt) {
      setTripMsg("Authorise location tracking first.");
      return;
    }
    const path = result.safest.geometry.coordinates as LngLat[];
    if (path.length < 2) return;

    setTripMsg(null);
    setFired([]);
    startTransition(async () => {
      // A walk is always tied to a stored route: it is what the live positions
      // and any alert hang off, and what Phase D compares against later.
      const res = await saveRoute({
        name:
          fromText.trim() && toText.trim()
            ? `${fromText.trim()} → ${toText.trim()}`
            : `Walk at ${new Date().toLocaleTimeString()}`,
        origin: from,
        dest: to,
        coordinates: path,
        distanceM: result.safest.distance_m,
        riskExposure: result.safest.risk_exposure,
      });
      const t: Trip = {
        routeId: res.ok ? res.id : null,
        path,
        dest: path[path.length - 1],
      };
      tripRef.current = t;
      setTrip(t);
      lastWrite.current = 0;
      observe(path[0]);
      router.refresh();
      if (!res.ok) setTripMsg("Walking without saving — " + res.error);
    });
  };

  /** Joystick: one press, one step, in metres rather than degrees. */
  const step = (east: number, north: number) => {
    const p = posRef.current;
    if (!p || !tripRef.current) return;
    observe(offsetMetres(p, east * STEP_M, north * STEP_M));
  };

  const toggleGps = () => {
    if (!trip) return;
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      setGps(false);
      return;
    }
    if (!navigator.geolocation) {
      setTripMsg("This browser has no geolocation.");
      return;
    }
    // The browser asks its own permission on top of the consent already on
    // file. Both have to say yes; neither substitutes for the other.
    watchId.current = navigator.geolocation.watchPosition(
      (p) => observe([p.coords.longitude, p.coords.latitude]),
      (err) => {
        setTripMsg(`Location unavailable: ${err.message}`);
        setGps(false);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
    );
    setGps(true);
  };

  const saveConsent = () => {
    setConsentMsg(null);
    startTransition(async () => {
      const res = await grantConsent({ email: alertEmail, phone, authorised });
      if (res.ok) {
        setPhone("");
        setAuthorised(false);
        router.refresh();
      } else {
        setConsentMsg(res.error);
      }
    });
  };

  const stopSharing = () => {
    startTransition(async () => {
      stopWalk(false);
      const res = await revokeConsent();
      if (res.ok) router.refresh();
      else setConsentMsg(res.error);
    });
  };

  // The detector on a clock, not only on movement: standing still 80 m off the
  // route is exactly the case that should raise an alert, and no position
  // update would ever arrive to trigger it.
  useEffect(() => {
    if (!trip) return;
    const id = window.setInterval(() => {
      if (posRef.current) observe(posRef.current);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [trip, observe]);

  // Arrow keys drive the joystick, so the walk can be steered without hunting
  // for four small buttons mid-demo.
  useEffect(() => {
    if (!trip) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const moves: Record<string, [number, number]> = {
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const p = posRef.current;
      if (p) observe(offsetMetres(p, move[0] * STEP_M, move[1] * STEP_M));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trip, observe]);

  const load = (r: SavedRoute) => {
    setSaveMsg(null);
    setFromText("");
    setToText("");
    setMode("single");
    // Re-routed rather than replayed from the stored geometry, on purpose: the
    // scores and the weather have both moved on since it was saved, and the
    // honest answer is today's safest walk between the same two points.
    setPins({
      from: { lat: r.origin_lat, lng: r.origin_lng },
      to: { lat: r.dest_lat, lng: r.dest_lng },
    });
  };

  const extra = result
    ? Math.round(result.safest.distance_m - result.shortest.distance_m)
    : 0;

  // What the dry-vs-rain readout is actually claiming. `shift` is the only one
  // that compares the two recommendations to each other; the rest compare each
  // recommendation to the fastest walk under its own weather.
  const dryExtra = compare
    ? Math.round(compare.dry.safest.distance_m - compare.dry.shortest.distance_m)
    : 0;
  const stormExtra = compare
    ? Math.round(compare.storm.safest.distance_m - compare.storm.shortest.distance_m)
    : 0;
  const stormAvoided = compare
    ? compare.storm.shortest.flooded_segments - compare.storm.safest.flooded_segments
    : 0;
  const shift = compare
    ? Math.round(compare.storm.safest.distance_m - compare.dry.safest.distance_m)
    : 0;

  // What the gate is doing, in one sentence.
  const armedBoroughs = weather
    ? Object.entries(weather.boroughs)
        .filter(([, b]) => b.armed)
        .map(([key]) => BOROUGH_LABEL[key] ?? key)
    : [];
  const gateLine = !weather
    ? "Weather unavailable — flood risk is off."
    : rain === "on"
      ? "Forced on — flood risk counts in all five boroughs."
      : rain === "off"
        ? "Forced off — flood risk is ignored."
        : !weather.available
          ? "Weather unavailable — flood risk is off."
          : armedBoroughs.length
            ? `Heavy rain in ${armedBoroughs.join(", ")} — flood risk counts there.`
            : `No heavy rain right now — flood risk is off.`;

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

          {compare && (
            <>
              <p className="mt-5 text-[17px] leading-[1.45] font-medium text-pretty">
                Same walk, two weathers — and the answer moves.
              </p>

              <dl className="mt-4 flex flex-col gap-2.5">
                {(
                  [
                    [
                      "fastest",
                      "Fastest",
                      FASTEST,
                      true,
                      compare.storm.shortest,
                      `${compare.storm.shortest.flooded_segments} flooded · ${compare.storm.shortest.risky_segments} crash`,
                    ],
                    [
                      "dry",
                      "Dry",
                      SAFEST,
                      false,
                      compare.dry.safest,
                      `${dryExtra >= 0 ? "+" : ""}${dryExtra} m`,
                    ],
                    [
                      "rain",
                      "In rain",
                      RAIN_ROUTE,
                      false,
                      compare.storm.safest,
                      `${stormExtra >= 0 ? "+" : ""}${stormExtra} m · ${compare.storm.safest.flooded_segments} flooded`,
                    ],
                  ] as const
                ).map(([key, label, color, dashed, p, note]) => (
                  <div key={key} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="h-[3px] w-6 shrink-0 rounded-full"
                      style={
                        dashed
                          ? {
                              background: `repeating-linear-gradient(90deg,${color} 0 4px,transparent 4px 7px)`,
                            }
                          : { background: color }
                      }
                    />
                    <dt className="w-[62px] text-[14px] text-white/70">{label}</dt>
                    <dd className="text-[14px] tabular-nums text-white">
                      {(p.distance_m / 1000).toFixed(2)} km
                      <span className="ml-2 text-white/45">{note}</span>
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="mt-3 flex flex-col gap-1.5 text-[13px] leading-[1.55]">
                <p className="text-white/45">
                  <span style={{ color: SAFEST }}>Dry</span> — {compare.dry.reason}
                </p>
                <p className="text-white/45">
                  <span style={{ color: RAIN_ROUTE }}>In rain</span> —{" "}
                  {compare.storm.reason}
                </p>
              </div>

              <p className="mt-3 text-[13px] leading-[1.55] text-white/60">
                {stormAvoided > 0
                  ? `Rain moves the route ${Math.abs(shift)} m and takes you off ` +
                    `${stormAvoided} block${stormAvoided === 1 ? "" : "s"} FloodNet has ` +
                    `measured underwater. Dry, none of that costs you anything — ` +
                    `the flood term contributes exactly zero.`
                  : `Rain moves the route ${Math.abs(shift)} m on this pair.`}
              </p>

              <p className="mt-2 text-[12px] leading-[1.5] text-white/35">
                Both lines were solved just now, with the flood term forced off
                and then on. The live gate below still reports the real sky.
              </p>
            </>
          )}

          {result && !compare && (
            <>
              <p className="mt-5 text-[17px] leading-[1.45] font-medium text-pretty">
                {result.reason}
              </p>

              <dl className="mt-4 flex flex-col gap-2.5">
                {(
                  [
                    ["safest", "Safest", SAFEST, false, result.safest],
                    ["shortest", "Fastest", FASTEST, true, result.shortest],
                  ] as const
                ).map(([key, label, color, dashed, p]) => (
                  <div key={key} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="h-[3px] w-6 shrink-0 rounded-full"
                      style={
                        dashed
                          ? {
                              background: `repeating-linear-gradient(90deg,${color} 0 4px,transparent 4px 7px)`,
                            }
                          : { background: color }
                      }
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

          {result && saved && (
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="rounded-lg border border-white/25 px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:border-white/60 disabled:opacity-40"
              >
                {pending ? "Saving…" : "Save this walk"}
              </button>
              {saveMsg && (
                <span
                  role="status"
                  className={`text-[13px] ${saveMsg === "Saved." ? "text-white/45" : "text-[#FF8A80]"}`}
                >
                  {saveMsg}
                </span>
              )}
            </div>
          )}

          {/* The safety loop — only where there is an account to consent */}
          {consent !== undefined && (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h2 className="text-[14px] font-medium">Walk with me</h2>

              {!consent?.consentedAt ? (
                <>
                  <p className="mt-2 text-[12px] leading-[1.5] text-white/40">
                    To follow your walk and raise the alarm if you leave the safe
                    route, SafeNYC needs somewhere to send alerts and your
                    say-so. Both stay on your account, and you can withdraw
                    either at any time.
                  </p>
                  <input
                    value={alertEmail}
                    onChange={(e) => setAlertEmail(e.target.value)}
                    inputMode="email"
                    autoComplete="email"
                    placeholder="Where alerts go — an email address"
                    className={`${field} mt-3`}
                  />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel"
                    placeholder="Mobile (optional) — kept for when SMS is enabled"
                    className={`${field} mt-2`}
                  />
                  <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={authorised}
                      onChange={(e) => setAuthorised(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#22C55E]"
                    />
                    <span className="text-[12px] leading-[1.5] text-white/70">
                      I authorise SafeNYC to record my location while a walk is
                      active, and to email this address if I leave the route or
                      press SOS.
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={saveConsent}
                    disabled={pending || !alertEmail.trim() || !authorised}
                    className="mt-3 rounded-lg bg-white px-4 py-2.5 text-[13px] font-medium text-black transition-opacity hover:opacity-85 disabled:opacity-40"
                  >
                    {pending ? "Saving…" : "Authorise tracking"}
                  </button>
                  {consentMsg && (
                    <p role="alert" className="mt-2 text-[12px] text-[#FF8A80]">
                      {consentMsg}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="mt-2 text-[12px] leading-[1.5] text-white/40">
                    Alerts go to {consent.email}.{" "}
                    {consent.ready
                      ? "Email is live."
                      : "Email isn't configured yet — alerts will be recorded but not sent."}{" "}
                    <button
                      type="button"
                      onClick={stopSharing}
                      disabled={pending}
                      className="underline underline-offset-2 transition-colors hover:text-white disabled:opacity-40"
                    >
                      Stop sharing
                    </button>
                  </p>

                  {!trip ? (
                    <button
                      type="button"
                      onClick={startWalk}
                      disabled={pending || !result}
                      className="mt-3 rounded-lg bg-[#22C55E] px-4 py-2.5 text-[13px] font-medium text-black transition-opacity hover:opacity-85 disabled:opacity-40"
                    >
                      {result ? "Start this walk" : "Find a route first"}
                    </button>
                  ) : (
                    <>
                      <div className="mt-3 flex items-start gap-4">
                        {/* Four-way joystick. Arrow keys do the same thing. */}
                        <div className="grid shrink-0 grid-cols-3 gap-1">
                          {(
                            [
                              ["", 0, 0], ["↑", 0, 1], ["", 0, 0],
                              ["←", -1, 0], ["", 0, 0], ["→", 1, 0],
                              ["", 0, 0], ["↓", 0, -1], ["", 0, 0],
                            ] as const
                          ).map(([label, east, north], i) =>
                            label ? (
                              <button
                                key={i}
                                type="button"
                                aria-label={
                                  { "↑": "north", "↓": "south", "←": "west", "→": "east" }[label]
                                }
                                onClick={() => step(east, north)}
                                className="h-9 w-9 rounded-lg border border-white/20 text-[15px] text-white transition-colors hover:border-white/60 active:bg-white/15"
                              >
                                {label}
                              </button>
                            ) : (
                              <span key={i} className="h-9 w-9" />
                            ),
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] leading-[1.5] text-white">
                            {offBy > OFF_PATH_M ? (
                              <span className="text-[#F5C518]">
                                {Math.round(offBy)} m off route
                              </span>
                            ) : (
                              <>On route · {Math.round(offBy)} m from the line</>
                            )}
                          </p>
                          <p className="mt-1 text-[12px] leading-[1.5] text-white/40">
                            {STEP_M} m a press, or use the arrow keys. An alert
                            fires after {SUSTAINED_MS / 1000}s more than{" "}
                            {OFF_PATH_M} m off.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => posRef.current && fire("sos", posRef.current)}
                              disabled={pending}
                              className="rounded-lg bg-[#EE352E] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
                            >
                              SOS
                            </button>
                            <button
                              type="button"
                              onClick={toggleGps}
                              className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                                gps
                                  ? "border-[#22C55E] text-[#22C55E]"
                                  : "border-white/25 text-white hover:border-white/60"
                              }`}
                            >
                              {gps ? "Using real GPS" : "Use real GPS"}
                            </button>
                            <button
                              type="button"
                              onClick={() => stopWalk()}
                              className="rounded-lg border border-white/25 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-white/60"
                            >
                              End walk
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {tripMsg && (
                    <p className="mt-2 text-[12px] leading-[1.5] text-white/45">{tripMsg}</p>
                  )}

                  {fired.length > 0 && (
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {fired.map((a) => (
                        <li key={a.id} className="text-[12px] leading-[1.5]">
                          <span
                            className={
                              a.kind === "sos"
                                ? "text-[#FF8A80]"
                                : a.kind === "arrived"
                                  ? "text-[#22C55E]"
                                  : "text-[#F5C518]"
                            }
                          >
                            {a.kind}
                          </span>
                          <span className="text-white/40">
                            {" "}
                            · {new Date(a.at).toLocaleTimeString()} ·{" "}
                            {a.delivery === "sent"
                              ? "emailed"
                              : a.delivery === "not_configured"
                                ? "recorded, email not configured"
                                : `recorded, not sent${a.detail ? ` (${a.detail})` : ""}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          {/* What each line on the map means. Colour alone never carries it:
              every line is named, and the fastest one is dashed as well. */}
          <div className="mt-5 border-t border-white/10 pt-4">
            <h2 className="text-[14px] font-medium">On the map</h2>
            <ul className="mt-2.5 flex flex-col gap-2">
              {(
                [
                  [SAFEST, false, "Safest walk", "risk-weighted A*"],
                  [FASTEST, true, "Fastest walk", "distance only — your phone"],
                  [RAIN_ROUTE, false, "Safest in rain", "flood term armed"],
                  [CRASH_RAMP[3], false, "Crash risk", "darker red = lower"],
                  [FLOOD_RAMP[2], false, "Street flooding", "darker blue = lower"],
                ] as const
              ).map(([color, dashed, label, note]) => (
                <li key={label} className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="h-[3px] w-6 shrink-0 rounded-full"
                    style={
                      dashed
                        ? {
                            background: `repeating-linear-gradient(90deg,${color} 0 4px,transparent 4px 7px)`,
                          }
                        : { background: color }
                    }
                  />
                  <span className="text-[13px] text-white">{label}</span>
                  <span className="text-[12px] text-white/40">{note}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Heatmap control + legend */}
          <div className="mt-5 border-t border-white/10 pt-4">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-[14px] font-medium">Crash risk heatmap</span>
              <input
                type="checkbox"
                checked={heat}
                onChange={(e) => setHeat(e.target.checked)}
                className="h-4 w-4"
                style={{ accentColor: CRASH_RAMP[3] }}
              />
            </label>

            {heat && (
              <>
                <div
                  aria-hidden
                  className="mt-3 h-1.5 w-full rounded-full"
                  style={{
                    background: `linear-gradient(90deg,${CRASH_RAMP.join(",")})`,
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

            <label className="mt-4 flex cursor-pointer items-center justify-between gap-3">
              <span className="text-[14px] font-medium">Street flooding</span>
              <input
                type="checkbox"
                checked={wet}
                onChange={(e) => setWet(e.target.checked)}
                className="h-4 w-4"
                style={{ accentColor: FLOOD_RAMP[2] }}
              />
            </label>

            {wet && (
              <>
                <div
                  aria-hidden
                  className="mt-3 h-1.5 w-full rounded-full"
                  style={{ background: `linear-gradient(90deg,${FLOOD_RAMP.join(",")})` }}
                />
                <div className="mt-1.5 flex justify-between font-mono text-[10px] tracking-wider text-white/40 uppercase">
                  <span>Lower</span>
                  <span>Higher</span>
                </div>
                <p className="mt-2.5 text-[12px] leading-[1.5] text-white/40">
                  {floodCount === null
                    ? "Loading…"
                    : `${floodCount.toLocaleString()} segments within 200 m of a FloodNet sensor, weighted by how often and how deep it floods.`}
                </p>
              </>
            )}
          </div>

          {/* The weather gate — what decides whether flooding counts at all */}
          <div className="mt-5 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-medium">Rain</span>
              <div
                role="group"
                aria-label="Rain override"
                className="flex overflow-hidden rounded-lg border border-white/15"
              >
                {(
                  [
                    ["auto", "Auto"],
                    ["on", "Rain"],
                    ["off", "Dry"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={rain === value}
                    onClick={() => {
                      // Overriding the weather by hand is a single-route
                      // question, so it drops out of the two-line comparison
                      // rather than silently re-solving it underneath.
                      setMode("single");
                      setRain(value);
                    }}
                    className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      rain === value
                        ? "bg-white text-black"
                        : "text-white/60 hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <p className="mt-2.5 text-[12px] leading-[1.5] text-white/40">{gateLine}</p>

            {weather?.available && rain === "auto" && (
              <p className="mt-1.5 font-mono text-[10px] leading-[1.6] text-white/30">
                {Object.entries(weather.boroughs)
                  .map(([key, b]) => `${BOROUGH_LABEL[key] ?? key} ${b.mm_h ?? "–"}`)
                  .join(" · ")}{" "}
                mm/h · arms above {weather.threshold_mm_h}
              </p>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={() => {
                setMode("single");
                setFromText(PRESET.fromText);
                setToText(PRESET.toText);
                setPins({ from: PRESET.from, to: PRESET.to });
              }}
              className="rounded-lg border border-white/25 px-4 py-2.5 text-[13px] font-medium text-white transition-colors hover:border-white/60"
            >
              Try {PRESET.label}
            </button>
            <button
              onClick={runStormDemo}
              disabled={busy}
              className="rounded-lg border px-4 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-40"
              style={{ borderColor: `${RAIN_ROUTE}66`, color: RAIN_ROUTE }}
            >
              {busy && mode === "compare"
                ? "Solving both…"
                : `Dry vs rain — ${STORM.label}`}
            </button>
          </div>

          {/* Saved walks — only rendered where there is a session to own them */}
          {saved && (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h2 className="text-[14px] font-medium">Saved walks</h2>
              {saved.length === 0 ? (
                <p className="mt-2 text-[12px] leading-[1.5] text-white/40">
                  Nothing saved yet. Run a route and press Save.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1">
                  {saved.map((r) => (
                    <li key={r.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => load(r)}
                        className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10"
                      >
                        <span className="block truncate text-[13px] text-white">
                          {r.name ?? "Dropped pins"}
                        </span>
                        <span className="block text-[11px] tabular-nums text-white/40">
                          {r.distance_m ? `${(r.distance_m / 1000).toFixed(2)} km · ` : ""}
                          {new Date(r.created_at).toLocaleDateString()}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        disabled={pending}
                        aria-label={`Delete ${r.name ?? "saved walk"}`}
                        className="shrink-0 rounded-lg px-2 py-1.5 text-[12px] text-white/40 transition-colors hover:text-[#FF8A80] disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
