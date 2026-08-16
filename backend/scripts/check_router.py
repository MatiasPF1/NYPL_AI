"""Phase C acceptance check - does the flood layer and the weather gate work?

Runs a handful of walks against a live router twice, once with the flood term
disarmed and once with it forced on, and prints what changed. Then it re-runs
the risk-weighted search with Dijkstra and compares total cost against A*.

    python backend/scripts/check_router.py
    python backend/scripts/check_router.py --url http://127.0.0.1:8001

What a good run looks like:

  * The dry and wet routes are identical where there is no flood risk. Rain
    must not perturb a route it has nothing to say about.
  * Where there is flood risk, the wet route is longer and its flooded-segment
    count is lower. Paying metres to avoid water is the entire feature.
  * A* and Dijkstra agree on total cost to the last decimal. They are different
    algorithms over the same weights, so agreement is evidence the heuristic
    is still admissible under the new cost term - the failure this catches is
    silent, and it is the one worth catching.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import httpx
import networkx as nx

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Walks chosen to straddle the flood clusters that fall inside the default
# manhattan96 extent, plus one that avoids them entirely as a control.
WALKS = [
    ("South Street waterfront",
     (40.7035, -74.0110), (40.7145, -73.9885)),
    ("Williamsburg, Marcy Ave cluster",
     (40.7050, -73.9600), (40.6990, -73.9500)),
    ("Long Island City, Vernon Blvd",
     (40.7450, -73.9600), (40.7380, -73.9500)),
    ("Times Sq -> Washington Sq (control, no flood risk)",
     (40.7580, -73.9855), (40.7308, -73.9973)),
]


def fetch(url: str, a, b, rain: str) -> dict:
    res = httpx.get(
        f"{url}/route",
        params={
            "from_lat": a[0], "from_lng": a[1],
            "to_lat": b[0], "to_lng": b[1],
            "rain": rain,
        },
        timeout=30.0,
    )
    res.raise_for_status()
    return res.json()


def check_optimality() -> list[str]:
    """A* against Dijkstra over the same weights, with every borough raining.

    Loads its own copy of the graph from the same database the router reads, so
    this is the real cost function over the real scores, not a fixture. Also
    scans for NaN: a NaN score would pass the 0..1 check constraint (a CHECK
    whose result is NULL passes) and then poison every comparison A* makes.
    """
    from backend.app.main import GRAPH, edge_cost  # noqa: PLC0415
    from backend.app.weather import BOROUGHS  # noqa: PLC0415

    problems: list[str] = []
    print("\nloading the graph for the optimality check ...")
    GRAPH.load()

    bad = 0
    for _, _, data in GRAPH.g.edges(data=True):
        if (math.isnan(data["crash"]) or math.isnan(data["flood"])
                or math.isnan(data["length"])):
            bad += 1
    if bad:
        problems.append(f"{bad:,} edges carry NaN in length or a risk score")
    print(f"  NaN scan: {bad} bad edges")

    armed = {boro: 1.0 for boro in BOROUGHS}

    def weight(u: int, v: int, data: dict) -> float:
        return edge_cost(data, armed)

    for label, a, b in WALKS:
        src = GRAPH.nearest(*a)
        dst = GRAPH.nearest(*b)
        star = nx.astar_path(GRAPH.g, src, dst,
                             heuristic=GRAPH.heuristic(dst), weight=weight)
        dijk = nx.dijkstra_path(GRAPH.g, src, dst, weight=weight)

        def total(path: list[int]) -> float:
            return sum(edge_cost(GRAPH.g[u][v], armed)
                       for u, v in zip(path, path[1:]))

        c_star, c_dijk = total(star), total(dijk)
        ok = abs(c_star - c_dijk) < 1e-6
        print(f"  {label[:44]:<46} A* {c_star:>10.2f}  Dijkstra {c_dijk:>10.2f}"
              f"  {'ok' if ok else 'MISMATCH'}")
        if not ok:
            problems.append(
                f"{label}: A* cost {c_star:.4f} != Dijkstra {c_dijk:.4f} - "
                f"the heuristic is no longer admissible"
            )
    return problems


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--no-optimality", action="store_true",
                        help="skip the A*/Dijkstra comparison (it reloads the graph)")
    args = parser.parse_args()

    try:
        health = httpx.get(f"{args.url}/health", timeout=10.0).json()
    except httpx.HTTPError as exc:
        sys.exit(f"no router at {args.url}: {exc}")

    print(f"router at {args.url}")
    print(f"  {health['nodes']:,} nodes, {health['edges']:,} edges")
    print(f"  {health['risk_segments']:,} crash segments, "
          f"{health.get('flood_segments', 0):,} flood segments")
    print(f"  alpha {health['alpha']}, beta {health.get('beta')}")

    w = health.get("weather", {})
    print(f"  weather: {'live' if w.get('available') else 'UNAVAILABLE'}"
          f", armed anywhere: {w.get('armed_anywhere')}"
          f", age {w.get('age_s')}s")
    for boro, r in (w.get("boroughs") or {}).items():
        print(f"    {boro:<14} {r['mm_h']} mm/h  {'RAINING' if r['raining'] else 'dry'}")

    if not health.get("flood_segments"):
        sys.exit("\nFAIL: no flood segments loaded - run score_flood_risk.py, "
                 "then restart the router so it re-reads the graph")

    print("\n" + "=" * 72)
    failures = []
    for label, a, b in WALKS:
        dry = fetch(args.url, a, b, "off")
        wet = fetch(args.url, a, b, "on")

        d, x = dry["safest"], wet["safest"]
        changed = d["geometry"]["coordinates"] != x["geometry"]["coordinates"]
        print(f"\n{label}")
        print(f"  dry safest: {d['distance_m']:>7.0f} m   crash exposure "
              f"{d['risk_exposure']:>6.0f}   flooded blocks {d['flooded_segments']}")
        print(f"  wet safest: {x['distance_m']:>7.0f} m   crash exposure "
              f"{x['risk_exposure']:>6.0f}   flooded blocks {x['flooded_segments']}"
              f"   (shortest would cross {wet['shortest']['flooded_segments']})")
        print(f"  route changed under rain: {changed}")
        print(f"  reason (wet): {wet['reason']}")

        # The dry run reports no flood exposure by construction: the term is
        # disarmed, so nothing on the path counts. If it ever does, the gate is
        # leaking.
        if d["flood_exposure"] != 0 or d["flooded_segments"] != 0:
            failures.append(f"{label}: flood exposure reported with rain off")

        # The two invariants that actually have to hold. Note it is *not* one
        # of them that the wet route is longer in metres: rain changes the
        # objective, so the wet optimum can be shorter on the ground and still
        # correct. What must hold is that each route is the cheapest under the
        # weights it was computed with.
        for tag, payload in (("dry", dry), ("wet", wet)):
            a_, b_ = payload["alpha"], payload["beta"]
            cost = lambda p: (  # noqa: E731
                p["distance_m"] + a_ * p["risk_exposure"] + b_ * p["flood_exposure"]
            )
            if cost(payload["safest"]) > cost(payload["shortest"]) + 1e-6:
                failures.append(
                    f"{label} ({tag}): the risk-weighted route costs more than "
                    f"the plain shortest one - A* did not find the optimum"
                )
            if payload["shortest"]["distance_m"] > payload["safest"]["distance_m"] + 1e-6:
                failures.append(
                    f"{label} ({tag}): the shortest route is longer than the "
                    f"safest one, which is a contradiction"
                )

    if not args.no_optimality:
        failures.extend(check_optimality())

    print("\n" + "=" * 72)
    if failures:
        print("\nFAILURES")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
