-- Phase A step 1: PostGIS + the walking street graph.
--
-- The graph lives in its own `graph` schema rather than in `public`, and that
-- is a security decision, not tidiness. Supabase exposes only `public` and
-- `graphql_public` through the Data API, so nothing here is reachable over
-- PostgREST at all. The routing service talks to these tables over a direct
-- Postgres connection.
--
-- The alternative — graph tables in `public` with a permissive read policy —
-- would put a few hundred thousand rows of joinable geometry one query string
-- away from any signed-in user. This is public OpenStreetMap data, so the
-- content is not the concern; being an unmetered bulk-export endpoint is.

create extension if not exists postgis with schema extensions;

create schema if not exists graph;

-- No API role gets anything here. Only the connection the router uses.
revoke all on schema graph from anon, authenticated;

-- ---------------------------------------------------------------------------
-- nodes — intersections and dead ends
-- ---------------------------------------------------------------------------

create table graph.nodes (
  id bigint primary key,                              -- OSM node id, kept as-is
  geom extensions.geometry(Point, 4326) not null
);

create index nodes_geom_gix on graph.nodes using gist (geom);

-- ---------------------------------------------------------------------------
-- edges — walkable street segments
-- ---------------------------------------------------------------------------
-- One row per directed segment. `crash_risk` and `flood_risk` are normalised
-- 0..1 and default to 0, so the graph is routable the moment it loads: with
-- both terms at zero the cost function collapses to plain length, which makes
-- step 3 testable before step 2 has scored anything.

create table graph.edges (
  id bigserial primary key,
  u bigint not null references graph.nodes (id),
  v bigint not null references graph.nodes (id),
  osm_key integer not null default 0,
  name text,
  highway text,
  length_m double precision not null check (length_m >= 0),
  geom extensions.geometry(LineString, 4326) not null,
  crash_risk double precision not null default 0
    check (crash_risk >= 0 and crash_risk <= 1),
  flood_risk double precision not null default 0
    check (flood_risk >= 0 and flood_risk <= 1),
  unique (u, v, osm_key)
);

create index edges_geom_gix on graph.edges using gist (geom);
create index edges_u_idx on graph.edges (u);
create index edges_v_idx on graph.edges (v);

-- ---------------------------------------------------------------------------
-- nearest-node lookup
-- ---------------------------------------------------------------------------
-- Snapping a dropped pin to the graph is the one spatial query the router runs
-- per request, so it gets a function with a GiST-backed KNN ordering rather
-- than a sequential scan over every node.

-- `OPERATOR(extensions.<->)` rather than a bare `<->`: with search_path pinned
-- to empty, an unqualified operator cannot be resolved, and schema-qualifying
-- an operator requires this syntax. Keeping the hardened search_path is worth
-- the noise — it is what stops a shadowing schema from hijacking the lookup.

create function graph.nearest_node(lat double precision, lng double precision)
returns bigint
language sql
stable
set search_path = ''
as $$
  select n.id
  from graph.nodes n
  order by n.geom OPERATOR(extensions.<->)
           extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)
  limit 1;
$$;
