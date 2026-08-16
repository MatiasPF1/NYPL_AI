/**
 * Distance helpers for the deviation detector.
 *
 * Everything is equirectangular: latitude and longitude are flattened to
 * metres around a local origin before any arithmetic. Over a few hundred
 * metres in New York the error against a proper geodesic is centimetres, and
 * the detector's threshold is tens of metres — the cheap projection is not the
 * limiting factor, GPS accuracy is.
 */

const R = 6_371_000;

export type LngLat = [number, number];

/** Metres per degree at a given latitude, as [east-west, north-south]. */
function scale(lat: number): [number, number] {
  return [(Math.PI / 180) * R * Math.cos((lat * Math.PI) / 180), (Math.PI / 180) * R];
}

export function metresBetween(a: LngLat, b: LngLat): number {
  const [mx, my] = scale((a[1] + b[1]) / 2);
  const dx = (a[0] - b[0]) * mx;
  const dy = (a[1] - b[1]) * my;
  return Math.hypot(dx, dy);
}

/** Move a point a given number of metres east and north. */
export function offsetMetres(p: LngLat, east: number, north: number): LngLat {
  const [mx, my] = scale(p[1]);
  return [p[0] + east / mx, p[1] + north / my];
}

/**
 * How far a point is from a polyline, in metres.
 *
 * Perpendicular distance to the nearest *segment*, not to the nearest vertex.
 * Vertex distance would report someone standing in the middle of a long
 * straight block as far off route, which is exactly when they are most on it.
 */
export function metresFromPath(point: LngLat, path: LngLat[]): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return metresBetween(point, path[0]);

  const [mx, my] = scale(point[1]);
  const px = point[0] * mx;
  const py = point[1] * my;

  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0] * mx;
    const ay = path[i][1] * my;
    const bx = path[i + 1][0] * mx;
    const by = path[i + 1][1] * my;

    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;

    // Clamped projection onto the segment: t outside [0, 1] means the closest
    // point is an endpoint, which is the case at every corner of the route.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
    const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
    if (d < best) best = d;
  }
  return best;
}
