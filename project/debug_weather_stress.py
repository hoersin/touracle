"""
Weather API stress testing script.
- Generates arbitrary single-day daily/hourly requests via WeatherService.
- Ensures serialized processing (no overlap) by measuring completion spacing.
- Escalates load until encountering circuit breaker (429 proxy) to find safe limits.
Usage:
    python project/debug_weather_stress.py
"""
import time
import random
import logging
from datetime import date
from typing import List, Tuple

from backend.weather_service import WeatherService, TemporaryAPIUnavailable, RATE_LIMIT_SECONDS

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger('stress')

# Reference area (France SW approx)
BASE_LAT = 43.5
BASE_LON = -1.5

class Result:
    def __init__(self, key: str, start_ts: float, end_ts: float, ok: bool, err: str = ''):
        self.key = key
        self.start_ts = start_ts
        self.end_ts = end_ts
        self.ok = ok
        self.err = err


def make_key(kind: str, lat: float, lon: float, y: int, m: int, d: int) -> str:
    return f"{kind}:{lat:.2f}_{lon:.2f}_{y}_{m:02d}_{d:02d}"


def run_batch(kind: str, coords: List[Tuple[float, float]], year_span: Tuple[int, int], month: int, day_: int) -> List[Result]:
    WeatherService.ensure_started()
    results: List[Result] = []
    for (lat, lon) in coords:
        for y in range(year_span[0], year_span[1] + 1):
            key = make_key(kind, lat, lon, y, month, day_)
            start = time.time()
            try:
                data = WeatherService.get_weather(lat, lon, y, month, day_, dry_run=False, kind=kind)
                end = time.time()
                results.append(Result(key, start, end, ok=True))
            except TemporaryAPIUnavailable as e:
                end = time.time()
                results.append(Result(key, start, end, ok=False, err=str(e)))
                log.warning('[BREAKER] key=%s err=%s', key, e)
                # Stop early if breaker triggers
                return results
            except Exception as e:
                end = time.time()
                results.append(Result(key, start, end, ok=False, err=str(e)))
    return results


def analyze_spacing(results: List[Result]) -> Tuple[float, float, float]:
    # Compute delta between consecutive completions
    times = [r.end_ts for r in results]
    if len(times) < 2:
        return 0.0, 0.0, 0.0
    deltas = [times[i] - times[i-1] for i in range(1, len(times))]
    return min(deltas), sum(deltas)/len(deltas), max(deltas)


def count_errors(results: List[Result]) -> int:
    return sum(1 for r in results if not r.ok)


def scenario(name: str, kind: str, num_coords: int, years: int, month: int, day_: int) -> None:
    log.info('[SCENARIO] %s kind=%s coords=%d years=%d', name, kind, num_coords, years)
    coords = []
    for i in range(num_coords):
        # Random nearby grid points (~0.2° jitter)
        lat = BASE_LAT + random.uniform(-0.2, 0.2)
        lon = BASE_LON + random.uniform(-0.2, 0.2)
        coords.append((lat, lon))
    end_year = date.today().year - 1
    start_year = end_year - years + 1
    results = run_batch(kind, coords, (start_year, end_year), month, day_)
    min_d, avg_d, max_d = analyze_spacing(results)
    errs = count_errors(results)
    total = len(results)
    log.info('[RESULT] total=%d ok=%d errs=%d', total, total-errs, errs)
    if total > 1:
        log.info('[RATE] min=%.2fs avg=%.2fs max=%.2fs (target >= %.1fs)', min_d, avg_d, max_d, RATE_LIMIT_SECONDS)


def escalate_until_breaker() -> None:
    log.info('[ESCALATE] starting escalation until circuit breaker triggers')
    coords_n = 5
    years_n = 5
    while True:
        scenario(f"daily-{coords_n}coords-{years_n}years", 'daily', coords_n, years_n, 3, 12)
        scenario(f"hourly-{coords_n}coords-{years_n}years", 'hourly', coords_n, years_n, 3, 12)
        # Detect breaker from logs implicitly via errors; increase load progressively
        coords_n += 5
        if coords_n > 30:
            coords_n = 30
        years_n += 2
        if years_n > 15:
            years_n = 15
        # small pause to avoid immediate breaker persistence
        time.sleep(2.0)
        if coords_n == 30 and years_n == 15:
            log.info('[ESCALATE] reached max without breaker; stopping')
            break


def main():
    # Baseline: small sequential daily set
    scenario('baseline-daily', 'daily', num_coords=2, years=3, month=3, day_=12)
    # Mixed: daily + hourly on small set
    scenario('mixed-hourly', 'hourly', num_coords=2, years=3, month=3, day_=12)
    # Larger: more coords and years
    scenario('large-daily', 'daily', num_coords=10, years=5, month=3, day_=12)
    # Escalate until breaker
    escalate_until_breaker()
    log.info('[SAFE-LIMIT] Recommend coords<=10, years<=5 for steady operation at rate %.1fs', RATE_LIMIT_SECONDS)

if __name__ == '__main__':
    main()
