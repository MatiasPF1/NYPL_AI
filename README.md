# SafeNYC

**Safest-route navigation for New York City.**

Google Maps gives you the *fastest* route. SafeNYC gives you the *safest* one — routing around streets with a history of injury crashes, around violent-crime clusters, and around known street-flooding locations when heavy rain is forecast for that borough.

You enter where you are and where you're going. The app draws **two lines**: the shortest path, and the risk-weighted path, with a one-line reason for the difference.

Full technical plan: **[RiskMap_Plan.md](RiskMap_Plan.md)** (also as [PDF](RiskMap_Plan_v3.pdf)).

---

## Datasets

**None of the raw data is committed** — the crash file alone is 567 MB, well over GitHub's 100 MB per-file limit. Download the files below into `Matias_Section/` before running the notebooks.

### 1. Motor Vehicle Collisions — Crashes

| | |
|---|---|
| **File** | `Motor_Vehicle_Collisions_-_Crashes_20260815.csv` |
| **Size** | 567 MB · 2,269,187 rows × 29 cols |
| **Source** | [NYC Open Data](https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95) |
| **Covers** | 2012-07-01 → 2026-06-11 |
| **Status** | ✅ Ready to use |

One row per crash. 756,353 people injured, 3,617 killed. Clean `LATITUDE`/`LONGITUDE` on 89% of rows, plus per-category injury and fatality counts.

**Use 2022 onward only** (413,780 rows) — crash volume fell from ~230k/year pre-COVID to ~86k in 2025, so older data describes traffic that no longer exists.

Two traps:
- 7,591 rows sit at exactly `(0, 0)`. Filter by NYC bounding box, not just `NOT NULL`.
- 30% of rows have no `BOROUGH`. Filter by coordinates instead of that column.

### 2. FloodNet — Street Flooding Events

| | |
|---|---|
| **File** | `FloodNet__Street_Flooding_Events_Measured_by_FloodNet_Sensors_20260815.csv` |
| **Size** | 4.8 MB · 2,929 events from 294 sensors |
| **Source** | [NYC Open Data](https://data.cityofnewyork.us/Environment/FloodNet-Street-Flooding-Events/9i7c-xyvv) |
| **Covers** | 2020-11 → 2026-08 |
| **Status** | ⚠️ Needs geocoding before use |

Real sensor measurements of street flooding. Median peak depth 3.5 inches; 1,295 events reached 4 inches or more. Flooding is **accelerating** — 142 events in 2022 versus 1,021 already in 2026.

> **⚠️ This file has no latitude or longitude column.** Location exists only inside `Sensor Name`, as a borough prefix plus a street: `Q - Beach 84 St`, `BX - Ditmars St/Hunter Ave 2`. Strip the prefix and trailing number, then geocode the 294 unique names once with Mapbox and store the results. One-time script, not a runtime cost.

Usefully concentrated: Queens alone accounts for 1,710 of 2,929 events (mostly the Rockaways), then Bronx 485, Brooklyn 425, Staten Island 223, Manhattan 79. `Q - Beach 84 St` alone logged 438 floods — so a handful of avoid-zones covers most of the real risk.

### 3. Complaints (crime)

| | |
|---|---|
| **File** | `sample_complaints_not_Proccesed.csv` |
| **Size** | 1.5 MB · 20,000 rows |
| **Status** | 🚫 **Synthetic — replace before demoing** |

This file is **not real data**. Four independent checks:

| Check | Result |
|---|---|
| Points within 50 m of a real NYC street | **62.6%** (real data scores 100%, uniform random scores 45.1%) |
| `BORO_NM` vs. borough-by-coordinate | **exactly 25.0%** agreement — chance for a 4-way guess |
| Timestamps | all 20,000 rows are `12:00:00` |
| Offense types | only 6, each ~3,300 rows — uniformly flat |

The coordinates *do* cluster (variance/mean = 479, where pure noise is 1.0), so they aren't random — but roughly **1 point in 3 sits somewhere a crime cannot have happened**. The 90th percentile is 1.5 km from the nearest street; the maximum is 8.1 km, which is open water.

**Fix:** download the real [NYPD Complaint Data Historic](https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Historic/qgea-i56i). Column names are identical, so `classify_complaints.ipynb` runs unchanged and produces a genuine layer. If there's no time, ship crashes + flooding and drop crime — two real layers beat three where one is fabricated.

### Derived output

`Matias_Section/complaints_scored.csv` (315 KB) — the scored, cleaned crime layer produced by the notebook. **This one is committed** (an explicit exception in `.gitignore`) since the app consumes it directly.

---

## Repo layout

```
.
├── README.md                    ← you are here
├── RiskMap_Plan.md              full technical plan
├── RiskMap_Plan_v3.pdf          same plan, for sharing
├── .gitignore                   excludes all *.csv and .env
└── Matias_Section/
    ├── *.csv                    the datasets (not committed)
    ├── classify_complaints.ipynb   crime severity scoring 1–5
    ├── complaints_scored.csv    notebook output (committed)
    ├── safenycv1/               Next.js 16 + React 19 + Tailwind 4 frontend
    └── safenycv_backend/        (empty)
```

---

## Crime severity scale

`classify_complaints.ipynb` scores every complaint **1–5**, ranked by danger to someone *walking past* — which is what a router cares about.

| # | Meaning | Matched offenses |
|---|---|---|
| **5** | Force or threat against a person | murder, rape, shooting, felony assault, **robbery** |
| **4** | Violence or weapons, lesser degree | weapons, **assault 3**, harassment, arson |
| **3** | Intrusion into occupied space | **burglary**, trespass |
| **2** | Property loss or damage | **grand larceny**, **criminal mischief** |
| **1** | Petty property | **petit larceny**, fraud, forgery |

Rules are keyword-based rather than exact-string, so they survive truncated labels (`CRIMINAL MISCHIEF & RELATED OF`) **and** already cover the full NYPD taxonomy — swapping in the real file needs no code changes.

Pipeline: **20,000 rows → 14,326 on-street → 4,823 at severity ≥ 4.**

---

## How risk becomes a route

Every hazard collapses to one number per street segment. No model, no training — a weighted sum tuned by eye.

```
cost = length × (1 + α·crash_risk + β·flood_risk·raining + γ·crime_risk)
```

> **Keep the penalty multiplicative.** Risk only ever pushes cost *upward*, so `cost ≥ length` always holds — which keeps straight-line distance a valid A\* heuristic and the routes correct. If safe streets were ever made *cheaper* than their true length, A\* would return wrong paths and nothing would visibly break.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 · React 19 · Tailwind 4 · TypeScript |
| Database | Supabase Postgres + PostGIS |
| Map | Mapbox GL JS (rendering + geocoding) |
| Weather | Open-Meteo — no API key, 5 calls, one per borough |
| Routing | A\* in a Next.js API route |
| Data prep | Python + pandas (notebooks) |

---

## Getting started

```bash
# frontend
cd Matias_Section/safenycv1
npm install
npm run dev            # http://localhost:3000

# data prep
pip install pandas pyarrow matplotlib scipy
# then run Matias_Section/classify_complaints.ipynb
```

Create `.env.local` in `safenycv1/` (git-ignored):

```
NEXT_PUBLIC_MAPBOX_TOKEN=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

---

## Status

- [x] Crash data profiled and understood
- [x] Crime severity scoring pipeline (`classify_complaints.ipynb`)
- [x] Technical plan written
- [ ] Street graph loaded into Supabase
- [ ] `crash_risk` computed per segment
- [ ] Two-route comparison in the UI ← *the demo moment*
- [ ] Flood sensor geocoding
- [ ] Open-Meteo integration

> **Protect one thing:** finish the two-route comparison early. Crashes alone make a complete, defensible project. Crime, flood and weather make it better — they aren't prerequisites for having something that works.

---

*Built for a hackathon. Crash and flood layers use real NYC Open Data; the crime layer needs its real source file swapped in before the numbers mean anything.*
