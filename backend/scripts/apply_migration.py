"""Apply pending SQL migrations over the direct Postgres connection.

A stand-in for `supabase db push` on machines without the CLI installed. It
reads supabase/migrations/, compares against supabase_migrations.schema_migrations
— the same ledger the CLI keeps — and runs only what is missing, in version
order, each in its own transaction. A migration the CLI already applied is
skipped, and a migration applied here is recorded, so the two never disagree
about what has run.

    python backend/scripts/apply_migration.py            # show what is pending
    python backend/scripts/apply_migration.py --apply    # run it

Dry by default on purpose: this is DDL against the live project database.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
PROJECT_REF = "efzqnabzygbyxlersuki"

# 20260816010000_edge_flood_borough.sql -> ("20260816010000", "edge_flood_borough")
NAME_RE = re.compile(r"^(\d+)_(.+)\.sql$")


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="actually run the pending migrations")
    args = parser.parse_args()

    on_disk = []
    for path in sorted(MIGRATIONS.glob("*.sql")):
        m = NAME_RE.match(path.name)
        if not m:
            sys.exit(f"{path.name} does not match <version>_<name>.sql")
        on_disk.append((m.group(1), m.group(2), path))

    with psycopg2.connect(connection_string()) as conn:
        # Autocommit off; each migration commits on its own below.
        with conn.cursor() as cur:
            cur.execute("select version from supabase_migrations.schema_migrations")
            applied = {row[0] for row in cur.fetchall()}

        pending = [row for row in on_disk if row[0] not in applied]
        for version, name, _ in on_disk:
            mark = "pending" if version in {p[0] for p in pending} else "applied"
            print(f"  [{mark:>7}] {version}  {name}")

        if not pending:
            print("\nnothing to do")
            return

        if not args.apply:
            print(f"\n{len(pending)} pending - re-run with --apply to execute")
            return

        for version, name, path in pending:
            sql = path.read_text(encoding="utf-8")
            print(f"\napplying {version} {name} ...")
            with conn.cursor() as cur:
                cur.execute(sql)
                # Recorded exactly as the CLI records it, so a later
                # `supabase db push` sees this as done rather than re-running it.
                cur.execute(
                    """
                    insert into supabase_migrations.schema_migrations
                        (version, name, statements)
                    values (%s, %s, %s)
                    on conflict (version) do nothing
                    """,
                    (version, name, [sql]),
                )
            conn.commit()
            print("  ok")


if __name__ == "__main__":
    main()
