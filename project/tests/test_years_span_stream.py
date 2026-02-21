import json
import re
import os
import sys
import pytest

# Import the Flask app by adjusting sys.path for backend simple imports
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BACKEND_DIR = os.path.join(BASE_DIR, 'backend')
if BACKEND_DIR not in sys.path:
    sys.path.append(BACKEND_DIR)
import app as backend_app  # type: ignore
app = backend_app.app

@pytest.mark.parametrize("hist_start,hist_years", [(2016, 7), (2015, 10)])
def test_route_event_includes_years_span(hist_start, hist_years):
    client = app.test_client()
    # Use dry_run to avoid heavy weather fetching
    url = f"/api/map_stream?date=02-24&step_km=60&tour_planning=0&mode=single_day&total_days=7&start_date=2025-02-24&hist_years={hist_years}&hist_start={hist_start}&dry_run=1"
    resp = client.get(url)
    assert resp.status_code == 200
    body = resp.data.decode('utf-8')
    # Find the route event data JSON
    # Expect a line starting with 'event: route' followed by 'data: {json}\n\n'
    m = re.search(r"event: route\s*data:\s*(\{.*\})", body)
    assert m, f"route event not found in SSE body: {body[:300]}"
    data = json.loads(m.group(1))
    ys = data.get('years_start')
    ye = data.get('years_end')
    assert isinstance(ys, int) and isinstance(ye, int), f"years_start/years_end missing or not int: {ys}, {ye}"
    # Span must match parameters
    assert ys == hist_start, f"years_start expected {hist_start}, got {ys}"
    assert ye == (hist_start + hist_years - 1), f"years_end expected {hist_start + hist_years - 1}, got {ye}"
