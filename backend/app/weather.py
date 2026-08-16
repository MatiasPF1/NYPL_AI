"""Phase C step 6 - the weather gate.

Open-Meteo, no API key, five calls: one per borough centroid. Its only job is
to decide whether the flood term in the cost function is armed, per borough:

    cost = length x (1 + a*crash_risk + b*flood_risk*raining[borough])

Rain genuinely varies across a 50 km city, so five readings beat one. It does
not vary block to block - the street-level geography of flood risk comes from
the FloodNet sensors, not from here.

Failure is designed to be boring. If Open-Meteo is slow or down, the last good
reading is kept; if there has never been one, every borough reads dry. A dead
weather API degrades the router to the crash-only cost function, which is
exactly what it did before this file existed. It never blocks a route.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

# Borough centroids, from the build plan.
BOROUGHS: dict[str, tuple[float, float]] = {
    "manhattan": (40.7831, -73.9712),
    "brooklyn": (40.6782, -73.9442),
    "queens": (40.7282, -73.7949),
    "bronx": (40.8448, -73.8648),
    "staten_island": (40.5795, -74.1502),
}

# mm/h. Below this it is drizzle: the streets the sensors sit on do not pond,
# and detouring a pedestrian around them would be a false alarm.
HEAVY_MM_H = 4.0

# Open-Meteo publishes hourly. Polling faster returns the same numbers.
TTL_SECONDS = 3600.0

# A refresh happens inside whichever request finds the readings stale, so it is
# on somebody's route latency. Five calls take about two seconds; this is the
# point at which we give up and route on what we already have.
BUDGET_SECONDS = 6.0

# After a failure, do not try again for this long. Without it, an outage turns
# every single request into a fresh round of timeouts.
RETRY_AFTER_SECONDS = 120.0

ENDPOINT = "https://api.open-meteo.com/v1/forecast"


class WeatherGate:
    """Five booleans and the millimetres behind them."""

    def __init__(self) -> None:
        # borough -> {"mm": float, "raining": bool}
        self.readings: dict[str, dict[str, Any]] = {}
        self.fetched_at: float | None = None
        self.attempted_at: float | None = None
        self.error: str | None = None

    # -- fetching -------------------------------------------------------------

    def stale(self) -> bool:
        return (
            self.fetched_at is None
            or time.time() - self.fetched_at > TTL_SECONDS
        )

    def refresh(self, force: bool = False) -> None:
        """Re-read all five boroughs. Safe to call on every request."""
        now = time.time()
        if not force:
            if not self.stale():
                return
            if (
                self.attempted_at is not None
                and now - self.attempted_at < RETRY_AFTER_SECONDS
                and self.error is not None
            ):
                return

        self.attempted_at = now
        deadline = now + BUDGET_SECONDS
        fresh: dict[str, dict[str, Any]] = {}
        failures: list[str] = []
        try:
            with httpx.Client(timeout=3.0) as client:
                for boro, (lat, lng) in BOROUGHS.items():
                    if time.time() > deadline:
                        failures.append(f"{boro}: skipped, out of time")
                        continue
                    try:
                        res = client.get(
                            ENDPOINT,
                            params={
                                "latitude": lat,
                                "longitude": lng,
                                "current": "precipitation",
                                "hourly": "precipitation",
                                # The next three hours: someone setting off now
                                # is still out in whatever arrives shortly.
                                "forecast_hours": 3,
                                "timezone": "UTC",
                            },
                        )
                        res.raise_for_status()
                        fresh[boro] = _reading(res.json())
                    except (httpx.HTTPError, KeyError, ValueError, TypeError) as exc:
                        failures.append(f"{boro}: {exc.__class__.__name__}")
        except Exception as exc:  # noqa: BLE001 - never let weather kill a route
            failures.append(str(exc))

        if not fresh:
            # Keep whatever we had. An hour-old reading beats pretending it is
            # dry, and pretending it is dry is still better than a 500.
            self.error = "; ".join(failures) or "no response"
            return

        # A partial result is worth keeping, but only the boroughs that
        # answered; the rest stay on their previous value.
        self.readings.update(fresh)
        self.fetched_at = time.time()
        self.error = "; ".join(failures) or None

    # -- what the router asks for --------------------------------------------

    def armed(self, override: str = "auto") -> dict[str, float]:
        """borough -> 1.0 if the flood term applies there, else 0.0.

        `override` exists because it is usually not raining during a demo.
        It is a request parameter rather than server state on purpose: two
        people hitting the router at once cannot change each other's routes.
        """
        if override == "on":
            return {boro: 1.0 for boro in BOROUGHS}
        if override == "off":
            return {boro: 0.0 for boro in BOROUGHS}

        self.refresh()
        return {
            boro: 1.0 if self.readings.get(boro, {}).get("raining") else 0.0
            for boro in BOROUGHS
        }

    def snapshot(self, override: str = "auto") -> dict[str, Any]:
        """The gate as the UI shows it."""
        armed = self.armed(override)
        return {
            "override": override,
            "threshold_mm_h": HEAVY_MM_H,
            "fetched_at": self.fetched_at,
            "age_s": None if self.fetched_at is None
            else round(time.time() - self.fetched_at),
            "available": bool(self.readings),
            "error": self.error,
            "armed_anywhere": any(v > 0 for v in armed.values()),
            "boroughs": {
                boro: {
                    "mm_h": self.readings.get(boro, {}).get("mm"),
                    "raining": bool(self.readings.get(boro, {}).get("raining")),
                    "armed": armed[boro] > 0,
                }
                for boro in BOROUGHS
            },
        }


def _reading(payload: dict[str, Any]) -> dict[str, Any]:
    """Worst of now and the next three hours, in mm/h."""
    hourly = payload.get("hourly", {}).get("precipitation") or []
    values = [float(v) for v in hourly if v is not None]
    current = payload.get("current", {}).get("precipitation")
    if current is not None:
        values.append(float(current))
    mm = max(values) if values else 0.0
    return {"mm": round(mm, 2), "raining": mm > HEAVY_MM_H}
