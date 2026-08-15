# RiskMap

**Safest-route navigation for New York City — build plan v4**

---

**What we want:** a mobile app where you say where you are and where you're going. Instead of the fastest route, it returns the **safest** one — steering around streets with a history of injury crashes, around violent-crime clusters, and around known street-flooding locations when the weather API says heavy rain is hitting that borough. Two routes are drawn side by side so the difference is obvious.

**Changed in v4:** the frontend is now Expo (native mobile) instead of Next.js, the backend is a standalone FastAPI service instead of Next.js API routes, and a LangGraph agent sits in front of the router to handle natural-language requests and explain its answers. The data analysis in §3 and the cost model in §4 are unchanged from v3 — they were never web-specific.

---

## 1 · Stack

| Layer | Choice | Why this one |
|---|---|---|
| Mobile | **Expo** (React Native, Expo Router) | Native map rendering, real GPS, ships to a phone the judges can hold |
| Map | **`expo-maps`** — Apple Maps on iOS, Google Maps on Android | Native polyline overlays, which is all we need to draw two routes |
| Backend | **FastAPI** | Python on both sides — the same `networkx`/`pandas` code preps the graph and serves it |
| Orchestration | **LangGraph** | Turns a sentence into tool calls, then explains the result. See §5 |
| Reasoning | **External model API** (Claude) | Intent parsing + the route explanation. Never touches routing math |
| Database | **Supabase** Postgres + PostGIS | Auth, road graph, saved routes, file storage. PostGIS gives us "snap point to nearest road" in SQL |
| Routing | **A\*** via `networkx`, in FastAPI | Graph loaded once at startup, held in memory |
| Weather | **Open-Meteo** | No API key, no signup. 5 calls, one per borough |
| Prep | Python (**pandas**) → Supabase | One-off notebooks. Never runs during the demo |

> **Be honest about the cost of this stack.** v3 was one deploy. v4 is a phone build, a Python service, and a hosted database — three things that can each be broken independently, and a device that cannot reach `localhost`. That buys real mobile and real agent orchestration, but the integration tax is front-loaded. §9 is ordered to pay it first, on day one, before any data work.

---

## 2 · Architecture

```
┌─────────────────────┐
│  Expo app (phone)   │  Supabase anon key only — no other secrets on device
│  map · inputs · auth│
└──────────┬──────────┘
           │ HTTPS
           ▼
┌─────────────────────┐        ┌──────────────────┐
│  FastAPI            │───────▶│  Model API       │  intent + explanation
│                     │        └──────────────────┘
│  /route   ← fast    │        ┌──────────────────┐
│  /ask     ← agent   │───────▶│  Open-Meteo      │  5 booleans, 15-min cache
│                     │        └──────────────────┘
│  A* over in-memory  │        ┌──────────────────┐
│  graph (networkx)   │◀──────▶│  Supabase        │  graph, hazards, saved routes
└─────────────────────┘        │  Postgres+PostGIS│
                               └──────────────────┘
```

Two rules hold this together:

**Every secret lives in FastAPI.** The Mapbox geocoding token, the model API key, and the Supabase service-role key stay server-side. An Expo bundle is extractable — anything shipped in the app is public. The device carries only the Supabase anon key, which is designed to be public and is fenced by RLS (§7).

**`/route` never depends on the agent.** `POST /route` takes two coordinate pairs and returns two polylines, deterministically, in well under a second. `POST /ask` takes a sentence, runs the LangGraph agent, and calls that same `/route` logic internally. If the model API is slow, rate-limited, or down mid-demo, the map still routes. Build `/route` first and never let the agent become load-bearing for it.

---

## 3 · The three data layers

| Layer | File | Size | State |
|---|---|---|---|
| **Crashes** | `Motor_Vehicle_Collisions_…csv` | 2,269,187 rows | ✅ ready |
| **Flooding** | `FloodNet__Street_Flooding_…csv` | 2,929 events | ⚠️ needs geocoding |
| **Crime** | `sample_complaints.csv` | 20,000 rows | ⚠️ scored, but input is synthetic |

### Crashes — the strong layer

- **2.27M** crashes, 2012–2026 · **756,353** injured · **3,617** killed
- Clean `LATITUDE`/`LONGITUDE` on 89% of rows, plus injury and fatality counts

**Use 2022 onward only** (413,780 rows). Crash volume fell from ~230k/year pre-COVID to ~86k in 2025, so older data describes traffic that no longer exists.

Two traps:
- 7,591 rows sit at exactly `(0, 0)` — filter by NYC bounding box, not just `NOT NULL`
- 30% of rows have no `BOROUGH` — filter by coordinates instead of that column

### Flooding — real, but no coordinates

2,929 measured flood events from 294 FloodNet sensors, Nov 2020 → Aug 2026, and **accelerating**: 142 events in 2022 versus 1,021 already in 2026. Median peak depth 3.5 inches; 1,295 events reached 4 inches or more.

> **The file has no latitude or longitude column.** Location lives only inside `Sensor Name` as a borough prefix plus a street: `Q - Beach 84 St`, `BX - Ditmars St/Hunter Ave 2`. Fix: strip the prefix and trailing number, geocode the 294 unique names once with Mapbox, store in Supabase. One-time script, not a runtime cost.

Flooding is highly concentrated, which helps us: Queens alone accounts for 1,710 of 2,929 events (mostly the Rockaways), then Bronx 485, Brooklyn 425, Staten Island 223, Manhattan 79. `Q - Beach 84 St` alone logged 438 floods. A small number of avoid-zones covers most of the real risk.

### Crime — scored and cleaned, but the input is synthetic

The pipeline is built and verified: [`classify_complaints.ipynb`](classify_complaints.ipynb).

**Severity scale** — ranked by danger to someone *walking past*, which is what the router cares about:

| # | Meaning | Matched offenses |
|---|---|---|
| **5** | Force or threat against a person | murder, rape, shooting, felony assault, **robbery** |
| **4** | Violence or weapons, lesser degree | weapons, **assault 3**, harassment, arson |
| **3** | Intrusion into occupied space | **burglary**, trespass |
| **2** | Property loss or damage | **grand larceny**, **criminal mischief** |
| **1** | Petty property | **petit larceny**, fraud, forgery |

Rules are keyword-based rather than exact-string, so they survive this file's truncated labels (`CRIMINAL MISCHIEF & RELATED OF`) **and** already cover the full NYPD taxonomy — swapping in the real file needs no code changes. Order matters: `FELONY ASSAULT` is tested before plain `ASSAULT`. An audit cell surfaces anything falling through to the default instead of letting it be silently scored 1.

Pipeline result: **20,000 → 14,326** on-street **→ 4,823** at severity ≥ 4.

#### But the input file is fabricated

The coordinates are *not* pure noise — they cluster (variance/mean = 479, where random would be 1.0). But they don't sit on the city. Fraction of points within 50 m of a real NYC street:

| | |
|---|---|
| Real crash locations *(ceiling)* | **100.0%** |
| `sample_complaints.csv` | **62.6%** |
| Uniform random in the same box *(floor)* | **45.1%** |

It lands closer to the random floor than to real data. Roughly **1 point in 3 is somewhere a crime cannot have happened** — the 90th percentile is 1.5 km from the nearest street, the maximum 8.1 km, which is open water.

The labels are separately broken:
- Stated borough vs. borough-by-coordinate agrees **exactly 25.0%** — chance for a 4-way guess. `BORO_NM` is shuffled relative to the coordinates.
- All 20,000 rows share the timestamp `12:00:00` — no time-of-day signal exists.
- Only 6 offense types, each ~3,300 rows — so filtering to assault returns a random quarter of the same cloud.

**What to do:** download the real **NYPD Complaint Data Historic** from NYC Open Data — identical column names, so the notebook runs unchanged and produces a genuine layer. If there's no time, ship crashes + flooding and drop crime. Two real layers beat three where one is fabricated.

---

## 4 · How risk becomes a route

Every hazard collapses to one number per street segment. No model, no training — a weighted sum tuned by eye.

```
cost = length × (1 + α·crash_risk + β·flood_risk·raining + γ·crime_risk)
```

| Term | Range | Source |
|---|---|---|
| `crash_risk` | 0 – 1 | Crashes within 50 m of the segment, weighted `1 + 3·injuries + 10·deaths`, percentile-ranked |
| `flood_risk` | 0 – 1 | Segment within 200 m of a FloodNet sensor, scaled by that sensor's event count |
| `crime_risk` | 0 – 1 | Scored complaints within 100 m, weighted by severity, percentile-ranked |
| `raining` | 0 or 1 | Open-Meteo says heavy rain in *that segment's borough* |
| `α, β, γ` | ~2 – 5 | Hand-tuned. Exposed as sliders, and settable by the agent (§5) |

> **Keep the penalty multiplicative.** Risk only ever pushes cost *upward*, so `cost ≥ length` always holds — which keeps straight-line distance a valid A\* heuristic and the routes correct. If safe streets were ever made *cheaper* than their true length, A\* would return wrong paths and nothing would visibly break.

In FastAPI this is one `networkx` call per route, with the weight computed on the fly:

```python
def edge_cost(u, v, d, w):                     # w = the α/β/γ profile
    risk = (w.alpha * d["crash_risk"]
          + w.beta  * d["flood_risk"] * raining[d["borough"]]
          + w.gamma * d["crime_risk"])
    return d["length_m"] * (1 + risk)

fast = nx.astar_path(G, src, dst, heuristic=haversine, weight=lambda u,v,d: d["length_m"])
safe = nx.astar_path(G, src, dst, heuristic=haversine, weight=lambda u,v,d: edge_cost(u,v,d,w))
```

---

## 5 · What LangGraph actually does

The agent's job is to decide **what to ask for**, never **what the route is**. Routing stays A\* over a fixed cost function — reproducible, explainable, and unchanged from v3. Keeping that boundary sharp is what makes the project defensible when a judge asks whether the AI is making up the route.

```
       ┌──────────────────────────────────────────────┐
       │  "walking home to Bushwick, it's late and    │
       │   I'd rather not deal with flooding"         │
       └───────────────────────┬──────────────────────┘
                               ▼
                       ┌───────────────┐
                       │  parse_intent │  model API → structured JSON
                       └───────┬───────┘
                               │  origin, destination, mode, concerns[]
                               ▼
                       ┌───────────────┐
                       │  set_profile  │  concerns → α/β/γ  (deterministic table)
                       └───────┬───────┘
                               ▼
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌───────────┐    ┌───────────┐    ┌───────────┐
       │  geocode  │    │  weather  │    │  (tools)  │   parallel
       └─────┬─────┘    └─────┬─────┘    └───────────┘
             └────────────────┼────────────────┘
                              ▼
                      ┌───────────────┐
                      │  compute_route│  A* ×2 — deterministic, no model
                      └───────┬───────┘
                              ▼
                      ┌───────────────┐
                      │   explain     │  model API, fed only real numbers
                      └───────┬───────┘
                              ▼
              two polylines + "+4 min, avoids 3 intersections
              with 2,000 crashes on record and the Rockaways
              flood cluster"
```

Four nodes deserve comment:

- **`set_profile`** is a lookup table, not a model call. `"late at night"` → γ up. `"flooding"` → β up. `"I have a stroller"` → α up. The model extracts the *concern*; a hardcoded dict turns it into numbers. A model choosing its own routing weights is unreproducible and impossible to defend.
- **`compute_route`** calls the identical function `/route` uses. One implementation, two entry points.
- **`explain`** receives the computed diff — segment counts, crash totals, minutes added — and writes prose. It is never asked what the route *should* be, only to describe what it *was*. That's the difference between an explanation and a hallucination.
- **State is a `TypedDict`** carrying `intent`, `profile`, `coords`, `weather`, `routes`, `explanation`. Persist it to `agent_runs` (§7) so a failed demo run can be replayed and shown.

---

## 6 · Weather, per borough

Open-Meteo, five calls — one per borough centroid. No key required. Now in FastAPI, cached in Supabase for 15 minutes so repeated routing requests don't re-hit the API.

```python
BOROS = {
    "manhattan":     (40.7831, -73.9712),
    "brooklyn":      (40.6782, -73.9442),
    "queens":        (40.7282, -73.7949),
    "bronx":         (40.8448, -73.8648),
    "staten_island": (40.5795, -74.1502),
}

# GET api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=precipitation
# raining[boro] = max(precipitation, next 3h) > 4mm/h
```

Five booleans is the entire weather payload.

> **Per-borough is the right resolution, and it's honest.** Rain genuinely varies across a 50 km city, so five readings beat one. But it does not vary block to block — the *geography* of flood risk comes from the FloodNet sensors, not the weather API. If a judge asks how granular the weather is: "five boroughs, and the flood sensors supply the street-level detail."

---

## 7 · Supabase schema

```sql
create extension if not exists postgis;

-- the routable graph, precomputed offline
create table road_edges (
  id         bigserial primary key,
  from_node  bigint,
  to_node    bigint,
  geom       geography(LineString, 4326),
  length_m   real,
  borough    text,
  crash_risk real,   -- 0-1
  flood_risk real,   -- 0-1
  crime_risk real    -- 0-1
);
create index on road_edges using gist (geom);

-- 294 rows, geocoded once
create table flood_sensors (
  sensor_name  text primary key,
  borough      text,
  geom         geography(Point, 4326),
  event_count  int,
  max_depth_in real
);

-- output of classify_complaints.ipynb
create table crime_points (
  id          bigserial primary key,
  occurred_on date,
  offense     text,
  severity    smallint,   -- 1-5
  bucket      text,       -- violent | intrusion | property
  weight      real,
  geom        geography(Point, 4326)
);
create index on crime_points using gist (geom);

-- 5 rows, refreshed every 15 min
create table weather_cache (
  borough    text primary key,
  raining    bool,
  checked_at timestamptz
);
```

New in v4 — Supabase now also carries users and their results:

```sql
-- saved routes, owned by an auth.users row
create table saved_routes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  label        text,
  origin       geography(Point, 4326),
  destination  geography(Point, 4326),
  fast_path    jsonb,      -- GeoJSON LineString
  safe_path    jsonb,
  profile      jsonb,      -- the α/β/γ used
  stats        jsonb,      -- minutes added, hazards avoided
  created_at   timestamptz default now()
);

-- one row per LangGraph invocation, for replay and debugging
create table agent_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users on delete set null,
  prompt      text,
  state       jsonb,       -- full graph state
  latency_ms  int,
  created_at  timestamptz default now()
);

alter table saved_routes enable row level security;
alter table agent_runs   enable row level security;

create policy "own routes" on saved_routes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own runs" on agent_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

**RLS is not optional here.** The anon key ships inside the app binary and anyone can pull it out. Without those policies, one extracted key reads every user's saved home address. The hazard tables (`road_edges`, `flood_sensors`, `crime_points`, `weather_cache`) are public reference data and can stay readable — but they're also large, so the app should never query them directly. FastAPI does, with the service key.

The three `_risk` columns are written once by the prep notebooks. At request time FastAPI serves from the in-memory graph, applies the weather booleans, and runs A\*. **Nothing heavy happens during the demo.**

---

## 8 · The Expo app

Three screens, Expo Router:

| Route | What |
|---|---|
| `app/index.tsx` | Map + two address inputs + **Safe route** button. The whole demo lives here |
| `app/ask.tsx` | Single text box → `POST /ask` → route drawn + explanation card |
| `app/saved.tsx` | Supabase auth (magic link) + list of `saved_routes` |

Drawing both routes is one prop — `polylines` takes an array, so grey and green go up together:

```tsx
<AppleMaps.View
  style={{ flex: 1 }}
  cameraPosition={{ coordinates: NYC, zoom: 13 }}
  polylines={[
    { coordinates: fastPath, color: "#9ca3af", width: 4 },
    { coordinates: safePath, color: "#22c55e", width: 6 },
  ]}
/>
```

Four constraints to plan around, all of them capable of eating an afternoon:

- **`expo-maps` does not run in Expo Go.** It's alpha and needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (`npx expo run:ios`, or EAS). Do this on day one — discovering it at hour 20 is fatal.
- **Demo on iOS if you can.** Apple Maps needs zero configuration. Google Maps on Android requires a Google Cloud project, the Maps SDK enabled, and an API key restricted to your package name *and* your build's SHA-1 fingerprint. That's the same billing-account friction v3 avoided by picking Mapbox — it comes back on Android, and only on Android.
- **The phone cannot reach `localhost`.** Run FastAPI bound to `0.0.0.0` and point the app at your machine's LAN IP, or tunnel it. Put the base URL in one `EXPO_PUBLIC_API_URL` env var so switching between laptop and deployed backend is a one-line change.
- **Geocoding stays server-side.** The app sends the typed string to FastAPI, which calls Mapbox and returns coordinates. Keeps the token off the device and means one geocoding implementation shared with the agent's `geocode` node.

---

## 9 · Build order

| # | Phase | Time | What |
|---|---|---|---|
| 0 | **Skeleton, end to end** | ~1.5 hr | Dev build on a real phone showing a map with a hardcoded polyline, fetched from a FastAPI `/health` on your LAN. No data, no agent. **This proves the three-tier stack talks to itself** — every hour spent here is repaid twice. |
| 1 | **Map + graph** | ~1 hr | Two address inputs → FastAPI `/geocode`. Load the Manhattan street graph (OSMnx → `road_edges`), hold it in memory, run plain A\* on distance. *No risk data yet* — but already a working routing app, so we can never end with nothing. |
| 2 | **Crash layer** | ~2 hrs | Filter 2022+, drop the `(0,0)` rows, snap to nearest edge with PostGIS, aggregate injury-weighted score, percentile-rank, write `crash_risk`. Test on 10k rows before running all 414k. |
| 3 | **Two-route comparison** | ~30 min | Run A\* twice per request. Return both as GeoJSON, draw grey and green. **This is where it becomes a demo instead of a map.** |
| 4 | **Crime layer** | ~30 min | Load `complaints_scored.csv` into `crime_points`, set `crime_risk` on edges within 100 m. *Notebook already done.* |
| 5 | **Flood layer** | ~1 hr | Geocode the 294 sensor names, load `flood_sensors`, set `flood_risk` on edges within 200 m, add the β term behind a manual rain toggle. |
| 6 | **Weather API** | ~20 min | Replace the toggle with 5 live Open-Meteo calls. **Keep the manual override** — it probably won't be raining during the demo. |
| 7 | **LangGraph agent** | ~2 hrs | The §5 graph behind `/ask`, plus the `ask` screen. Wire `parse_intent` → `set_profile` → `compute_route` → `explain`. Log every run to `agent_runs`. |
| 8 | **Auth + saved routes** | ~1 hr | Supabase magic-link sign-in, save a computed route, list it back. RLS policies on from the start, not bolted on after. |
| 9 | **Polish** | what's left | Heat-map overlays, α/β/γ sliders judges can drag, and a nicer explanation card. |

> **Protect one thing:** finish phase 3 early. Crashes + two-route comparison on a phone is already a complete, defensible project. Crime, flood, weather, the agent and auth all make it better — none of them are prerequisites for having something that works.

---

## 10 · Demo

1. Open the app on a phone. Enter start and destination. Grey line appears — "this is what Google gives you."
2. Hit **Safe route**. Green line diverges around the high-crash corridors. "+4 minutes, avoids three intersections with 2,000 crashes on record."
3. Switch to the **Ask** tab and type *"walking home to Bushwick, it's late and I'd rather not deal with flooding."* The agent parses it, weights crime and flood higher, and the route redraws with a written explanation.
4. Flip heavy rain on for Queens. The green route **moves again**, now dodging the Rockaways flood cluster.
5. Sign in, save the route, show it persisting under your account.

---

## 11 · Repo

```
expo-app/          Expo Router app
  app/_layout.tsx      auth gate — Stack.Protected on session state
  app/login.tsx        Apple (native) + Google (browser OAuth) + guest
  app/(app)/index.tsx  "Where to?" — the main screen
  lib/theme.ts         colors, spacing, type. No hex values live outside it
  lib/auth.tsx         session context, the three sign-in paths
  lib/supabase.ts      anon-key client, AsyncStorage-backed sessions
backend/           FastAPI
  main.py              /health  →  /geocode /route /ask
  routing.py           graph load + A*  (the only place cost is computed)
  agent/graph.py       LangGraph nodes and state
  weather.py           Open-Meteo + 15-min cache
Matias_Section/
  inspect_dataset.ipynb        generic dataset profiler
  classify_complaints.ipynb    crime severity 1-5 → complaints_scored.csv
  build_graph.ipynb            OSMnx → road_edges
  score_edges.ipynb            crash/flood/crime → the three _risk columns
  RiskMap_Plan.md              this plan
.gitignore                     all *.csv (the crash file alone is 567 MB), .env
```

Datasets are **not** committed. Re-download from NYC Open Data, or use `git add -f` for small derived files. Secrets live in `backend/.env` (model API key, Mapbox token, Supabase service key) and `expo-app/.env` (`EXPO_PUBLIC_API_URL`, Supabase URL + anon key — those two are safe to ship).

---

*RiskMap build plan v4 · Expo + FastAPI + LangGraph + Supabase/PostGIS + Open-Meteo · crash data 2,269,187 records (2012-07-01 → 2026-06-11) · FloodNet 2,929 events across 294 sensors · 4,823 complaints scored at severity ≥ 4*
