"""Phase A step 3 — the A* safest-route service.

Serves two paths between the same pair of points: the plain shortest walk, and
the risk-weighted one. The difference between them is the product.

    uvicorn backend.app.main:app --reload --port 8000

The graph is loaded into memory once at startup (~111k edges, a couple of
seconds) because a per-request round trip to Postgres for the whole network
would dominate the response time.

Phase C added the flood layer and the weather gate, so the cost function is now

    cost = length x (1 + a*crash_risk + b*flood_risk*raining[borough])

with `raining` supplied per borough by weather.py.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any

import httpx
import networkx as nx
import psycopg2
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .weather import WeatherGate

ROOT = Path(__file__).resolve().parents[2]
PROJECT_REF = "efzqnabzygbyxlersuki"

# How hard risk is allowed to push. With crash_risk normalised 0..1, ALPHA=3
# means the worst block in the city costs four times its own length to cross.
ALPHA = float(os.environ.get("SAFEROUTE_ALPHA", "3.0"))

# The same, for flooding — but only while the weather gate says it is raining
# in that segment's borough. Off the clock it contributes exactly nothing, so a
# dry-day route is identical to a Phase A route.
BETA = float(os.environ.get("SAFEROUTE_BETA", "3.0"))


def edge_cost(data: dict[str, Any], rain: dict[str, float]) -> float:
    """The one definition of what a segment costs to walk.

    Multiplicative and strictly non-negative in the risk terms, so cost >=
    length always holds and straight-line distance stays an admissible A*
    heuristic. Make a safe street cheaper than its true length and A* silently
    starts returning wrong paths — nothing throws, the lines just stop being
    the answer to the question asked.
    """
    armed = rain.get(data["boro"], 0.0) if data["boro"] else 0.0
    return data["length"] * (
        1.0 + ALPHA * data["crash"] + BETA * data["flood"] * armed
    )


def connection_string() -> str:
    env = ROOT / ".env.supabase.local"
    password = None
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("SUPABASE_DB_PASSWORD="):
            password = line.split("=", 1)[1].strip()
    if not password:
        raise RuntimeError("SUPABASE_DB_PASSWORD not found in .env.supabase.local")
    return (
        f"postgresql://postgres.{PROJECT_REF}:{password}"
        f"@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    )


class Graph:
    """The walking network, held in memory."""

    def __init__(self) -> None:
        self.g = nx.DiGraph()
        self.coords: dict[int, tuple[float, float]] = {}   # node -> (lng, lat)
        self.geom: dict[tuple[int, int], list[list[float]]] = {}
        self.loaded_at: float | None = None
        # Built once at startup: every segment carrying risk, as GeoJSON. One
        # collection per hazard, so the map can show them apart.
        self.risk_layer: dict[str, Any] = {"type": "FeatureCollection", "features": []}
        self.flood_layer: dict[str, Any] = {"type": "FeatureCollection", "features": []}

    def load(self) -> None:
        started = time.time()
        with psycopg2.connect(connection_string()) as conn:
            with conn.cursor() as cur:
                cur.execute("select id, ST_X(geom), ST_Y(geom) from graph.nodes")
                for nid, lng, lat in cur.fetchall():
                    self.coords[nid] = (lng, lat)

                cur.execute(
                    """
                    select u, v, length_m, crash_risk, flood_risk, flood_borough,
                           ST_AsGeoJSON(geom)
                    from graph.edges
                    """
                )
                for u, v, length_m, crash, flood, boro, gj in cur.fetchall():
                    # No cost is stored on the edge: it depends on the weather,
                    # which changes under a running process. edge_cost() is the
                    # single place that knows the formula.
                    self.g.add_edge(
                        u, v,
                        length=length_m,
                        crash=crash,
                        flood=flood,
                        boro=boro,
                    )
                    self.geom[(u, v)] = json.loads(gj)["coordinates"]

        self.risk_layer = self.build_layer("crash")
        self.flood_layer = self.build_layer("flood")

        self.loaded_at = time.time()
        print(
            f"graph loaded: {self.g.number_of_nodes():,} nodes, "
            f"{self.g.number_of_edges():,} edges, "
            f"{len(self.risk_layer['features']):,} crash segments, "
            f"{len(self.flood_layer['features']):,} flood segments "
            f"in {self.loaded_at - started:.1f}s"
        )

    def build_layer(self, key: str) -> dict[str, Any]:
        """The heatmap payload for one hazard: `crash` or `flood`.

        Only segments that actually carry that hazard. The GeoJSON property is
        `risk` either way, so both layers paint through the same expression.

        Sending all 111k edges would be mostly zeros and several times larger.
        Coordinates are rounded to 5 decimals — about a metre, well under the
        width the line is drawn at — which roughly halves the transfer.
        """
        features = []
        seen: set[tuple[int, int]] = set()
        for u, v, data in self.g.edges(data=True):
            if data[key] <= 0:
                continue
            # OSM stores both directions; drawing both doubles the payload and
            # darkens two-way streets against one-way ones for no reason.
            edge = (min(u, v), max(u, v))
            if edge in seen:
                continue
            seen.add(edge)
            coords = self.geom.get((u, v))
            if not coords:
                continue
            props: dict[str, Any] = {"risk": round(data[key], 3)}
            if key == "flood":
                props["boro"] = data["boro"]
            features.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[round(x, 5), round(y, 5)] for x, y in coords],
                    },
                }
            )
        return {"type": "FeatureCollection", "features": features}

    def nearest(self, lat: float, lng: float) -> int:
        best, best_d = None, float("inf")
        for nid, (nlng, nlat) in self.coords.items():
            d = (nlat - lat) ** 2 + (nlng - lng) ** 2
            if d < best_d:
                best, best_d = nid, d
        if best is None:
            raise HTTPException(503, "graph is empty")
        return best

    def heuristic(self, target: int):
        tlng, tlat = self.coords[target]

        def h(n: int, _t: int = 0) -> float:
            nlng, nlat = self.coords[n]
            # Equirectangular metres — cheap, and an underestimate of the true
            # walking distance, which is what admissibility requires.
            x = math.radians(nlng - tlng) * math.cos(math.radians((nlat + tlat) / 2))
            y = math.radians(nlat - tlat)
            return math.sqrt(x * x + y * y) * 6_371_000

        return h

    def path_stats(self, path: list[int], rain: dict[str, float]) -> dict[str, Any]:
        coords: list[list[float]] = []
        length = 0.0
        exposure = 0.0
        flood_exposure = 0.0
        risky_segments = 0
        flooded_segments = 0
        for u, v in zip(path, path[1:]):
            data = self.g[u][v]
            length += data["length"]
            exposure += data["crash"] * data["length"]
            if data["crash"] >= 0.5:
                risky_segments += 1
            # Flood exposure is only counted where it is actually raining. A
            # segment that floods in a storm is not a hazard on a dry Tuesday,
            # and reporting it as one would make the number mean two things.
            armed = rain.get(data["boro"], 0.0) if data["boro"] else 0.0
            if armed:
                flood_exposure += data["flood"] * data["length"]
                if data["flood"] >= 0.5:
                    flooded_segments += 1
            seg = self.geom.get((u, v)) or [list(self.coords[u]), list(self.coords[v])]
            coords.extend(seg if not coords else seg[1:])
        return {
            "distance_m": round(length, 1),
            "risk_exposure": round(exposure, 1),
            "risky_segments": risky_segments,
            "flood_exposure": round(flood_exposure, 1),
            "flooded_segments": flooded_segments,
            "geometry": {"type": "LineString", "coordinates": coords},
        }


GRAPH = Graph()
WEATHER = WeatherGate()
app = FastAPI(title="SafeNYC routing")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    GRAPH.load()
    # Warm the gate here rather than on the first route request, so nobody's
    # first search pays for five HTTP calls to Open-Meteo.
    WEATHER.refresh()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": GRAPH.loaded_at is not None,
        "nodes": GRAPH.g.number_of_nodes(),
        "edges": GRAPH.g.number_of_edges(),
        "risk_segments": len(GRAPH.risk_layer["features"]),
        "flood_segments": len(GRAPH.flood_layer["features"]),
        "alpha": ALPHA,
        "beta": BETA,
        "weather": WEATHER.snapshot(),
    }


@app.get("/risk")
def risk() -> dict[str, Any]:
    """Every crash-scored segment, for the heatmap overlay."""
    return GRAPH.risk_layer


@app.get("/flood")
def flood() -> dict[str, Any]:
    """Every flood-scored segment, for the second overlay."""
    return GRAPH.flood_layer


@app.get("/weather")
def weather(rain: str = Query("auto", pattern="^(auto|on|off)$")) -> dict[str, Any]:
    """The five readings, and whether the flood term is armed."""
    return WEATHER.snapshot(rain)


@app.get("/geocode")
def geocode(q: str = Query(..., min_length=3, max_length=200)) -> dict[str, Any]:
    """Turn a street or address into coordinates.

    Proxied through this service rather than called from the browser for two
    reasons: Nominatim requires a real User-Agent and refuses anonymous
    browser traffic, and doing it here keeps the usage policy in one place we
    control instead of every client tab.

    `viewbox` + `bounded` restrict results to the loaded graph extent, so
    "Broadway" resolves to the one in Manhattan rather than the one in Denver.
    """
    try:
        res = httpx.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": q,
                "format": "json",
                "limit": 5,
                "viewbox": "-74.0200,40.7900,-73.9280,40.7000",
                "bounded": 1,
            },
            headers={"User-Agent": "SafeNYC/0.1 (hackathon project)"},
            timeout=8.0,
        )
        res.raise_for_status()
        raw = res.json()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"geocoder unavailable: {exc}") from exc

    results = [
        {
            "label": item["display_name"],
            "lat": float(item["lat"]),
            "lng": float(item["lon"]),
        }
        for item in raw
    ]
    return {"query": q, "results": results}


@app.get("/route")
def route(
    from_lat: float = Query(...), from_lng: float = Query(...),
    to_lat: float = Query(...), to_lng: float = Query(...),
    rain: str = Query("auto", pattern="^(auto|on|off)$"),
) -> dict[str, Any]:
    src = GRAPH.nearest(from_lat, from_lng)
    dst = GRAPH.nearest(to_lat, to_lng)
    if src == dst:
        raise HTTPException(400, "origin and destination snap to the same corner")

    # Read the gate once and pass the same vector to both searches and to the
    # stats. A refresh landing between them would otherwise price the two paths
    # under different weather and make the comparison meaningless.
    gate = WEATHER.snapshot(rain)
    armed = {boro: 1.0 if b["armed"] else 0.0 for boro, b in gate["boroughs"].items()}

    h = GRAPH.heuristic(dst)
    try:
        shortest = nx.astar_path(GRAPH.g, src, dst, heuristic=h, weight="length")
        safest = nx.astar_path(
            GRAPH.g, src, dst, heuristic=h,
            weight=lambda u, v, data: edge_cost(data, armed),
        )
    except nx.NetworkXNoPath:
        raise HTTPException(404, "no walking path between those points")

    s = GRAPH.path_stats(shortest, armed)
    r = GRAPH.path_stats(safest, armed)

    extra_m = r["distance_m"] - s["distance_m"]
    avoided = s["risky_segments"] - r["risky_segments"]
    flood_avoided = s["flooded_segments"] - r["flooded_segments"]
    drop = s["risk_exposure"] - r["risk_exposure"]
    flood_drop = s["flood_exposure"] - r["flood_exposure"]

    if r["geometry"]["coordinates"] == s["geometry"]["coordinates"]:
        reason = "The shortest way there is already the safest — no detour needed."
    else:
        # Name the hazards that actually changed the line, in that order.
        avoiding = []
        if avoided > 0:
            avoiding.append(
                f"{avoided} block{'s' if avoided != 1 else ''} with a history "
                f"of injury crashes"
            )
        if flood_avoided > 0:
            avoiding.append(
                f"{flood_avoided} block{'s' if flood_avoided != 1 else ''} that "
                f"flood{'' if flood_avoided != 1 else 's'} in rain like this"
            )
        if avoiding:
            reason = f"{round(extra_m)} m further, avoiding {' and '.join(avoiding)}."
        elif drop > 0:
            reason = (
                f"{round(extra_m)} m further, cutting your exposure to crash-heavy "
                f"streets by {round(100 * drop / max(s['risk_exposure'], 1))}%."
            )
        elif flood_drop > 0:
            reason = (
                f"{round(extra_m)} m further, keeping you off streets that are "
                f"flooding right now."
            )
        else:
            reason = f"{round(extra_m)} m further along quieter streets."

    return {
        "shortest": s,
        "safest": r,
        "reason": reason,
        "alpha": ALPHA,
        "beta": BETA,
        "weather": gate,
    }
