"""Phase A step 1 — load the walking street graph into Postgres.

Downloads the pedestrian network from OpenStreetMap and writes it to
graph.nodes / graph.edges. Run once per extent; re-running the same extent is
idempotent (edges are upserted on the (u, v, osm_key) key).

    python backend/scripts/load_graph.py                 # Manhattan below 96th
    python backend/scripts/load_graph.py --extent all3    # + Brooklyn, Queens
    python backend/scripts/load_graph.py --dry-run        # download, don't write

The connection string is read from NYPL_AI/.env.supabase.local, which is
gitignored. Nothing here belongs in the frontend bundle: this talks to Postgres
directly, not through the Data API.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import osmnx as ox
import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parents[2]
PROJECT_REF = "efzqnabzygbyxlersuki"

# (west, south, east, north)
EXTENTS = {
    # Manhattan, Battery Park up to 96th St. Small enough to iterate on.
    "manhattan96": (-74.0200, 40.7000, -73.9280, 40.7900),
    # The three boroughs the landing page advertises.
    "all3": (-74.0450, 40.5700, -73.7000, 40.8200),
}


def connection_string() -> str:
    env = ROOT / ".env.supabase.local"
    if not env.exists():
        sys.exit(f"missing {env} — it holds the database password")

    password = None
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("SUPABASE_DB_PASSWORD="):
            password = line.split("=", 1)[1].strip()
    if not password:
        sys.exit("SUPABASE_DB_PASSWORD not found in .env.supabase.local")

    # Session-mode pooler: the direct db.<ref>.supabase.co host is IPv6-only on
    # current projects, which fails on most home networks.
    return (
        f"postgresql://postgres.{PROJECT_REF}:{password}"
        f"@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    )


def scalar(value):
    """OSM tags are sometimes lists (a segment carrying two names)."""
    if isinstance(value, list):
        return ", ".join(str(v) for v in value if v is not None) or None
    if value is None:
        return None
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extent", choices=sorted(EXTENTS), default="manhattan96")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bbox = EXTENTS[args.extent]
    print(f"extent {args.extent} = {bbox}")
    print("downloading walking network from OpenStreetMap …")

    # network_type="walk" keeps footways and crossings and drops motorways —
    # routing a pedestrian onto the FDR would be worse than useless.
    graph = ox.graph_from_bbox(bbox=bbox, network_type="walk", simplify=True)
    nodes, edges = ox.graph_to_gdfs(graph, nodes=True, edges=True)
    print(f"  {len(nodes):,} nodes, {len(edges):,} edges")

    node_rows = [
        (int(osmid), row.geometry.wkt)
        for osmid, row in nodes.iterrows()
    ]

    edge_rows = []
    skipped = 0
    for (u, v, key), row in edges.iterrows():
        geom = row.get("geometry")
        length = row.get("length")
        if geom is None or length is None:
            skipped += 1
            continue
        edge_rows.append(
            (
                int(u),
                int(v),
                int(key),
                scalar(row.get("name")),
                scalar(row.get("highway")),
                float(length),
                geom.wkt,
            )
        )

    print(f"  prepared {len(node_rows):,} nodes, {len(edge_rows):,} edges"
          f"{f' ({skipped} skipped, no geometry)' if skipped else ''}")

    if args.dry_run:
        print("dry run — nothing written")
        return

    with psycopg2.connect(connection_string()) as conn:
        with conn.cursor() as cur:
            # Nodes first: edges carry FKs to them.
            execute_values(
                cur,
                """
                insert into graph.nodes (id, geom)
                values %s
                on conflict (id) do nothing
                """,
                node_rows,
                template="(%s, ST_GeomFromText(%s, 4326))",
                page_size=5000,
            )
            print(f"  nodes written")

            execute_values(
                cur,
                """
                insert into graph.edges
                    (u, v, osm_key, name, highway, length_m, geom)
                values %s
                on conflict (u, v, osm_key) do update
                    set name = excluded.name,
                        highway = excluded.highway,
                        length_m = excluded.length_m,
                        geom = excluded.geom
                """,
                edge_rows,
                template="(%s, %s, %s, %s, %s, %s, ST_GeomFromText(%s, 4326))",
                page_size=5000,
            )
            print(f"  edges written")

            cur.execute("select count(*) from graph.nodes")
            n = cur.fetchone()[0]
            cur.execute("select count(*) from graph.edges")
            e = cur.fetchone()[0]
            print(f"database now holds {n:,} nodes and {e:,} edges")


if __name__ == "__main__":
    main()
