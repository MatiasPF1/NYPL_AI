-- Phase C step 5/6: which borough's weather arms a segment's flood term.
--
-- The cost function is
--
--     length x (1 + a*crash_risk + b*flood_risk*raining)
--
-- and `raining` is per borough, not citywide — rain genuinely varies across a
-- 50 km city. That means each edge has to know which of the five readings
-- applies to it, which is what this column holds.
--
-- It is written by score_flood_risk.py as the borough of the FloodNet sensors
-- that put the risk there in the first place, weighted by how much each one
-- contributed. That is a better boundary than "nearest borough centroid":
-- with five centroids, the Financial District comes out closer to the Brooklyn
-- centroid than to the Manhattan one, and every edge down there would end up
-- gated on the wrong reading.
--
-- Null is the normal state — an edge with no flood risk has no borough to be
-- gated on, and with flood_risk = 0 the term is zero regardless.

alter table graph.edges
  add column if not exists flood_borough text
    check (flood_borough in
      ('manhattan', 'brooklyn', 'queens', 'bronx', 'staten_island'));
