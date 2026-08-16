"""Phase C step 5 - flood risk per street segment.

Takes the geocoded FloodNet sensors in data/flood_sensors.csv, spreads each
one's history over the walkable segments around it, and writes a normalised
0..1 score onto graph.edges.flood_risk, plus the borough whose weather arms it
onto graph.edges.flood_borough.

    python backend/scripts/score_flood_risk.py
    python backend/scripts/score_flood_risk.py --extent all3 --radius 250

Two things differ from score_crash_risk.py, and both come from what the data
actually measures.

  * A crash happened at a point. A flood sensor reports that a low-lying place
    floods - and the water does not stop at the corner the sensor is bolted to.
    So a sensor is not snapped to one nearest segment; it contributes to every
    segment within `radius`, falling off linearly with distance. 200 m is the
    figure from the build plan.
  * Not all events are equal. A 4-inch flood is the point where a street stops
    being walkable, so those events count triple. The rest still signal a block
    that ponds, and count once.

Re-running is idempotent: every score is reset before the new one is written,
so a run with a smaller radius or a narrower extent does not leave last run's
scores stranded on segments this run never touched.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parents[2]
CSV = ROOT / "data" / "flood_sensors.csv"
PROJECT_REF = "efzqnabzygbyxlersuki"

# Same extents as load_graph.py. Scoring a wider box than the graph covers is
# harmless (there are no segments out there to hit) but pointless, so the
# default matches the default graph.
EXTENTS = {
    "manhattan96": (-74.0200, 40.7000, -73.9280, 40.7900),
    "all3": (-74.0450, 40.5700, -73.7000, 40.8200),
}

# The five weather readings the router gates on. Sensor boroughs arrive
# title-cased in the CSV; the router keys on these slugs.
BOROUGH_SLUG = {
    "Manhattan": "manhattan",
    "Brooklyn": "brooklyn",
    "Queens": "queens",
    "Bronx": "bronx",
    "Staten Island": "staten_island",
}

# An event at or over 4 inches is roughly where a curb-to-curb puddle turns
# into water you cannot walk through. Everything shallower still counts, but
# far less.
DEEP_WEIGHT = 3.0
SHALLOW_WEIGHT = 1.0


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


def load_sensors(bbox: tuple[float, float, float, float]) -> pd.DataFrame:
    if not CSV.exists():
        sys.exit(f"missing {CSV}")

    west, south, east, north = bbox
    df = pd.read_csv(CSV)

    missing = {"borough", "lat", "lon", "event_count", "events_over_4in"} - set(df.columns)
    if missing:
        sys.exit(f"{CSV.name} is missing columns: {sorted(missing)}")

    total = len(df)
    df = df[df["lat"].between(south, north) & df["lon"].between(west, east)].copy()

    unknown = set(df["borough"]) - set(BOROUGH_SLUG)
    if unknown:
        sys.exit(f"unrecognised borough values: {sorted(unknown)}")
    df["boro"] = df["borough"].map(BOROUGH_SLUG)

    # events_over_4in is a subset of event_count, so the shallow term is the
    # remainder. Clamping at zero guards against a row where the two disagree.
    deep = df["events_over_4in"].clip(lower=0)
    shallow = (df["event_count"] - deep).clip(lower=0)
    df["weight"] = deep * DEEP_WEIGHT + shallow * SHALLOW_WEIGHT

    df = df[df["weight"] > 0]
    print(f"  {len(df):,} of {total:,} sensors inside the extent, "
          f"{int(df['event_count'].sum()):,} recorded events")
    if df.empty:
        sys.exit("no sensors in this extent - nothing to score")
    return df


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extent", choices=sorted(EXTENTS), default="manhattan96")
    parser.add_argument("--radius", type=float, default=200.0,
                        help="metres of influence around each sensor")
    args = parser.parse_args()

    print(f"reading {CSV.name} ...")
    df = load_sensors(EXTENTS[args.extent])
    by_boro = df.groupby("boro")["weight"].agg(["count", "sum"])
    for boro, row in by_boro.iterrows():
        print(f"    {boro:<14} {int(row['count']):>3} sensors, weight {row['sum']:,.0f}")

    rows = list(
        df[["lat", "lon", "weight", "boro"]].itertuples(index=False, name=None)
    )

    # ST_Expand takes degrees, and this only has to be an over-estimate: the
    # exact ST_DWithin below does the real filtering. One degree of longitude is
    # shortest at the top of the extent, so divide by that to stay generous.
    pad = args.radius / 84_000.0

    with psycopg2.connect(connection_string()) as conn:
        with conn.cursor() as cur:
            cur.execute("drop table if exists graph.flood_points")
            cur.execute(
                """
                create table graph.flood_points (
                  id bigserial primary key,
                  weight double precision not null,
                  boro text not null,
                  geom extensions.geometry(Point, 4326) not null
                )
                """
            )
            execute_values(
                cur,
                "insert into graph.flood_points (weight, boro, geom) values %s",
                [(w, boro, lon, lat) for lat, lon, w, boro in rows],
                template="(%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))",
                page_size=1000,
            )
            cur.execute("create index flood_points_gix on graph.flood_points using gist (geom)")
            cur.execute("analyze graph.flood_points")
            print(f"  uploaded {len(rows):,} sensor points")

            # Every segment within `radius` of a sensor, weighted by a linear
            # falloff. The `&&` against the expanded envelope is what keeps the
            # GiST index in play - a bare ST_DWithin on the geography casts
            # cannot use the geometry index and degrades to a full scan of
            # 111k edges per sensor.
            print(f"  spreading sensors over segments within {args.radius:.0f} m ...")
            cur.execute(
                """
                drop table if exists graph.edge_flood_weight;
                create table graph.edge_flood_weight as
                with hits as (
                  select e.id as edge_id,
                         f.boro,
                         f.weight * (1.0 - ST_Distance(e.geom::geography,
                                                       f.geom::geography) / %(radius)s) as w
                  from graph.flood_points f
                  join graph.edges e
                    on e.geom && ST_Expand(f.geom, %(pad)s)
                   and ST_DWithin(e.geom::geography, f.geom::geography, %(radius)s)
                ),
                per_edge as (
                  select edge_id, sum(w) as w from hits group by edge_id
                ),
                -- Which borough's rain arms this segment: the one whose sensors
                -- contributed the most of its score, not the nearest centroid.
                per_boro as (
                  select edge_id, boro,
                         row_number() over (
                           partition by edge_id order by sum(w) desc, boro
                         ) as rn
                  from hits group by edge_id, boro
                )
                select p.edge_id, p.w, b.boro
                from per_edge p
                join per_boro b on b.edge_id = p.edge_id and b.rn = 1
                """,
                {"radius": args.radius, "pad": pad},
            )
            cur.execute("select count(*), sum(w) from graph.edge_flood_weight")
            n_edges, total_w = cur.fetchone()
            if not n_edges:
                sys.exit("no segments fell within radius of any sensor")
            print(f"  {n_edges:,} segments in range (total weight {total_w:,.0f})")

            # Clear first: without this, a re-run over a smaller radius or a
            # narrower extent leaves the previous run's scores behind on
            # segments this run never visits.
            cur.execute(
                """
                update graph.edges
                set flood_risk = 0, flood_borough = null
                where flood_risk > 0 or flood_borough is not null
                """
            )

            # Same 95th-percentile ceiling as the crash layer: a couple of
            # chronically flooded corners would otherwise flatten every other
            # block to near-zero and the router would stop telling them apart.
            print("  normalising and writing scores ...")
            cur.execute(
                """
                with cap as (
                  select percentile_cont(0.95) within group (order by w) as p95
                  from graph.edge_flood_weight
                )
                update graph.edges e
                set flood_risk = least(1.0, efw.w / nullif((select p95 from cap), 0)),
                    flood_borough = efw.boro
                from graph.edge_flood_weight efw
                where e.id = efw.edge_id
                """
            )
            cur.execute("drop table graph.flood_points")

            cur.execute(
                """
                select count(*) filter (where flood_risk > 0),
                       round(max(flood_risk)::numeric, 3),
                       round(avg(flood_risk) filter (where flood_risk > 0)::numeric, 3),
                       count(*) filter (where flood_risk >= 1.0),
                       count(*) filter (where flood_risk >= 0.5),
                       count(*)
                from graph.edges
                """
            )
            scored, mx, avg, at_ceiling, over_half, total = cur.fetchone()
            print(f"\nscored {scored:,} of {total:,} segments")
            print(f"  max {mx}, mean of scored {avg}, "
                  f"at ceiling {at_ceiling:,}, above 0.5 {over_half:,}")

            cur.execute(
                """
                select flood_borough, count(*), round(avg(flood_risk)::numeric, 3)
                from graph.edges
                where flood_borough is not null
                group by flood_borough
                order by 2 desc
                """
            )
            for boro, n, avg_b in cur.fetchall():
                print(f"    {boro:<14} {n:>6,} segments, mean {avg_b}")


if __name__ == "__main__":
    main()
