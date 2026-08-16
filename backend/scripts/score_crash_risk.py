"""Phase A step 2 — crash risk per street segment.

Reads the 567 MB collisions CSV in chunks, keeps only what a pedestrian router
cares about, snaps each crash to the nearest walkable segment in PostGIS, and
writes a normalised 0..1 score onto graph.edges.crash_risk.

    python backend/scripts/score_crash_risk.py
    python backend/scripts/score_crash_risk.py --since 2022 --radius 25

Three filters matter, and all three come from the dataset's known traps:

  * 2022 onward only. Crash volume fell from ~230k/year pre-COVID to ~86k in
    2025, so older rows describe traffic patterns that no longer exist.
  * NYC bounding box, not `LATITUDE IS NOT NULL`. 7,591 rows sit at exactly
    (0, 0) — off the coast of Africa — and a null check does not catch them.
  * BOROUGH is ignored entirely. It is missing on ~30% of rows; coordinates
    are the reliable locator.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parents[2]
CSV = ROOT / "data" / "Motor_Vehicle_Collisions_-_Crashes_20260815.csv"
PROJECT_REF = "efzqnabzygbyxlersuki"

# Matches the graph extent loaded by load_graph.py (Manhattan below 96th).
WEST, SOUTH, EAST, NORTH = -74.0200, 40.7000, -73.9280, 40.7900

USE_COLS = [
    "CRASH DATE",
    "LATITUDE",
    "LONGITUDE",
    "NUMBER OF PEDESTRIANS INJURED",
    "NUMBER OF PEDESTRIANS KILLED",
    "NUMBER OF PERSONS INJURED",
    "NUMBER OF PERSONS KILLED",
]


def connection_string() -> str:
    env = ROOT / ".env.supabase.local"
    password = None
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("SUPABASE_DB_PASSWORD="):
            password = line.split("=", 1)[1].strip()
    if not password:
        sys.exit("SUPABASE_DB_PASSWORD not found in .env.supabase.local")
    return (
        f"postgresql://postgres.{PROJECT_REF}:{password}"
        f"@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    )


def load_crashes(since_year: int) -> pd.DataFrame:
    if not CSV.exists():
        sys.exit(f"missing {CSV}")

    kept = []
    rows_read = 0
    for chunk in pd.read_csv(
        CSV, usecols=USE_COLS, chunksize=250_000, low_memory=False
    ):
        rows_read += len(chunk)
        chunk = chunk.rename(
            columns={
                "CRASH DATE": "date",
                "LATITUDE": "lat",
                "LONGITUDE": "lng",
                "NUMBER OF PEDESTRIANS INJURED": "ped_inj",
                "NUMBER OF PEDESTRIANS KILLED": "ped_killed",
                "NUMBER OF PERSONS INJURED": "inj",
                "NUMBER OF PERSONS KILLED": "killed",
            }
        )

        chunk["date"] = pd.to_datetime(chunk["date"], format="%m/%d/%Y", errors="coerce")
        chunk = chunk[chunk["date"].dt.year >= since_year]

        # Bounding box, not a null check — this is what excludes the (0,0) rows.
        chunk = chunk[
            chunk["lat"].between(SOUTH, NORTH) & chunk["lng"].between(WEST, EAST)
        ]

        # Only crashes that hurt someone. A fender bender with no injuries says
        # little about whether a pedestrian should avoid the block.
        for col in ["ped_inj", "ped_killed", "inj", "killed"]:
            chunk[col] = pd.to_numeric(chunk[col], errors="coerce").fillna(0)
        chunk = chunk[(chunk["inj"] > 0) | (chunk["killed"] > 0)]

        if len(chunk):
            kept.append(chunk[["lat", "lng", "ped_inj", "ped_killed", "inj", "killed"]])

    print(f"  read {rows_read:,} rows total")
    if not kept:
        sys.exit("no crashes survived the filters")
    df = pd.concat(kept, ignore_index=True)

    # Weighting: a pedestrian death dominates, a pedestrian injury counts hard,
    # and any other injury still signals a hostile block but counts far less.
    df["weight"] = (
        df["ped_killed"] * 10.0
        + df["ped_inj"] * 3.0
        + df["killed"] * 2.0
        + df["inj"] * 0.5
    )
    return df


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", type=int, default=2022)
    parser.add_argument("--radius", type=float, default=25.0,
                        help="max metres from a crash to a segment")
    args = parser.parse_args()

    print(f"reading {CSV.name} …")
    df = load_crashes(args.since)
    print(f"  {len(df):,} injury crashes in the graph extent since {args.since}")
    print(f"  total weight {df['weight'].sum():,.0f}")

    rows = list(df[["lat", "lng", "weight"]].itertuples(index=False, name=None))

    with psycopg2.connect(connection_string()) as conn:
        with conn.cursor() as cur:
            cur.execute("drop table if exists graph.crash_points")
            cur.execute(
                """
                create table graph.crash_points (
                  id bigserial primary key,
                  weight double precision not null,
                  geom extensions.geometry(Point, 4326) not null
                )
                """
            )
            execute_values(
                cur,
                "insert into graph.crash_points (weight, geom) values %s",
                [(w, lng, lat) for lat, lng, w in rows],
                template="(%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))",
                page_size=5000,
            )
            cur.execute("create index crash_points_gix on graph.crash_points using gist (geom)")
            cur.execute("analyze graph.crash_points")
            print(f"  uploaded {len(rows):,} crash points")

            # Snap each crash to its nearest segment within `radius` metres.
            # LATERAL + the GiST index keeps this a KNN lookup per crash rather
            # than a cross join of 111k edges against every point.
            print("  snapping crashes to segments …")
            cur.execute(
                """
                drop table if exists graph.edge_crash_weight;
                create table graph.edge_crash_weight as
                select e.id as edge_id, sum(c.weight) as w
                from graph.crash_points c
                cross join lateral (
                  select e.id, e.geom
                  from graph.edges e
                  order by e.geom <-> c.geom
                  limit 1
                ) e
                where ST_DWithin(e.geom::geography, c.geom::geography, %s)
                group by e.id
                """,
                (args.radius,),
            )
            cur.execute("select count(*), sum(w) from graph.edge_crash_weight")
            n_edges, total_w = cur.fetchone()
            print(f"  {n_edges:,} segments carry crash weight (total {total_w:,.0f})")

            # Normalise to 0..1. The 95th percentile is the ceiling rather than
            # the max: a handful of pathological intersections would otherwise
            # compress every ordinary block into near-zero and the router would
            # stop distinguishing between them.
            print("  normalising and writing scores …")
            cur.execute(
                """
                with cap as (
                  select percentile_cont(0.95) within group (order by w) as p95
                  from graph.edge_crash_weight
                )
                update graph.edges e
                set crash_risk = least(1.0, ecw.w / nullif((select p95 from cap), 0))
                from graph.edge_crash_weight ecw
                where e.id = ecw.edge_id
                """
            )
            cur.execute("drop table graph.crash_points")

            cur.execute(
                """
                select count(*) filter (where crash_risk > 0) as scored,
                       round(max(crash_risk)::numeric, 3) as max_risk,
                       round(avg(crash_risk) filter (where crash_risk > 0)::numeric, 3) as avg_scored,
                       count(*) filter (where crash_risk >= 1.0) as at_ceiling
                from graph.edges
                """
            )
            scored, mx, avg, ceil_ = cur.fetchone()
            print(f"\nscored {scored:,} of 111,072 segments")
            print(f"  max {mx}, mean of scored {avg}, at ceiling {ceil_:,}")


if __name__ == "__main__":
    main()
