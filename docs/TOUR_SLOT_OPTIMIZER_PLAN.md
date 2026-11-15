# Tour Simulation Run — Implementation Reference

> **Status: Implemented.** The feature described in this document is live in `project/backend/tour_slot_optimizer.py`, the `/api/tour_slot_optimizer/*` endpoint family, and the Simulation Run UI in `project/frontend/map.js` / `index.html`.
> This document serves as the original design blueprint and score-model reference.

---

## Goal
Add a wizard that recommends the best departure time window for the currently prepared TourBook (ride days + rest days + stage boundaries), with outputs at week-level confidence and optional day-level refinement.

The simulation run should prioritize practical planning quality over exact meteorological precision.

---

## Product Scope

### User problem
After users have arranged:
- number of ride days
- rest-day positions
- stage boundaries (distance/elevation effort shape)

they still need to decide when to start the tour.

### Wizard outcome
Return ranked candidate start windows, e.g.:
- Best Week: Week 24 (Mon 2027-06-14 to Sun 2027-06-20)
- Direction: Forward or Reverse (route flipped)
- Alternatives: Week 23, Week 25
- Confidence: High / Medium / Low
- Why: short explanation (rain lower, heat moderate, headwind risk lower, stability better)

### Forecasting promise
- Primary reliability target: calendar week (not exact day)
- Optional exact-day refinement around top windows

---

## Data Inputs and Reuse

## Existing components to reuse
- Route + profile sampling from `project/backend/route_sampling.py`
- Weather retrieval and provenance logic in `project/backend/app.py`
- Offline tile weather and climatology stores (year-scoped)
- Tour summary/day-summary conventions already used in map stream
- Session-scoped stream token cancellation/progress patterns

### New logical input model
- GPX route (active session GPX)
- TourBook shape:
  - total logical days
  - ride/rest day sequence
  - boundaries per ride day
- Direction mode:
  - `forward`
  - `reverse`
  - `auto_compare` (evaluate both and rank globally)
- Candidate climatology horizon:
  - `1y` (last year)
  - `3y` (last 3 years)
  - `5y` (last 5 years)
- User preference profile:
  - comfort-first (balanced)
  - dry-first
  - cool-first
  - tailwind-first
  - custom weights

---

## Algorithm Design (Smart Search, No Full Brute Force)

### Why not brute force all 365 starts
A full day-by-day brute force is possible but unnecessary for first ranking. Week-level signal is more robust and cheaper.

### Recommended search strategy
1. Coarse pass:
- Evaluate week-aligned start slots only (about 52 candidates).
- Compute full tour score per candidate using historical years.
- Evaluate configured direction mode (`forward`, `reverse`, or both).

2. Keep top-K windows:
- K configurable (default 6).

3. Local refinement:
- For each top week, evaluate day offsets in a narrow neighborhood (default +-10 days).
- Keep best refined candidates and recalculate confidence.

4. Return top-N results:
- default N=5 with explanation fields.
- Include route direction for each candidate.

This yields near-optimal windows while avoiding a global 365-day sweep.

---

## Scoring Model

### Day weather score
For each logical day index `d`:
- If rest day: optional low weight (or weather-only comfort impact)
- If ride day: weighted by effort

Let effort weight per ride day be:

$w_d = 1 + a \cdot \text{normDistance}_d + b \cdot \text{normAscent}_d$

where defaults can be `a=0.6`, `b=0.8`.

### Weather penalties / rewards
For each day sample:
- Temperature comfort penalty (outside preferred band)
- Rain penalty (amount and probability)
- Wind penalty/reward from effective head/tail component
- Optional severe-event penalties (extreme heat/cold/rain/wind)

Direction sensitivity note:
- Reversing the route changes heading per segment/day and can materially change effective head/tail wind.
- Temperature and rain are usually less direction-sensitive than wind, but day-to-segment mapping shifts can still alter weighted outcomes.

### Multi-year aggregation
For each candidate start slot:
- Compute score distribution across selected years
- Use robust central tendency (median) as base score
- Add uncertainty penalty from spread (IQR or MAD)

Final candidate score:

$S = \text{median}(S_y) - \lambda \cdot \text{dispersion}(S_y)$

Lower is better (penalty interpretation) or invert for higher-is-better UI.

### Confidence classification
Based on separation and variance:
- High: top score clearly better and low spread
- Medium: moderate spread or small top-2 gap
- Low: high spread and weak separation

---

## API and Backend Plan

### New endpoint family
1. `POST /api/tour_slot_optimizer/start`
- Starts optimization job
- Request:
  - horizonYears: 1/3/5
  - mode: comfort profile id or custom weights
  - directionMode: `forward|reverse|auto_compare`
  - granularity: week (default)
  - refineExactDay: bool
  - topK/topN parameters (optional)
- Response:
  - job_id

2. `GET /api/tour_slot_optimizer/progress/<job_id>`
- Reuse progress pattern and session scoping

3. `GET /api/tour_slot_optimizer/result/<job_id>`
- Ranked windows + explanation + diagnostics
- Each ranked window includes direction (`forward|reverse`)

Optional future: SSE stream endpoint for progressive candidate updates.

### Backend service module
Create `project/backend/tour_slot_optimizer.py` containing:
- Candidate generation (week starts + local refinement)
- Direction handling and route-reversal evaluation
- Day-mapping from TourBook structure
- Weather lookup adapter (offline first; online optional fallback)
- Scoring + confidence logic
- Result serializer for UI

### Caching
Memoize heavy sub-results:
- Per (route-segment, calendar-day, year) weather feature vectors
- Per candidate/year day aggregation

Cache key dimensions:
- session route fingerprint
- TourBook boundaries/rest layout fingerprint
- horizon years
- scoring profile/version

---

## Frontend Wizard Plan

### UX entry point
Add button in Tour Planning near weather controls:
- "Start Simulation Run"

### Wizard steps
1. Scope:
- horizon years (1/3/5)
- profile preset (comfort/dry/cool/tailwind/custom)
- direction mode (forward / reverse / compare both)

2. Strategy:
- week-only or week+day refinement

3. Run:
- progress bar and phase text
- cancel support

4. Result:
- ranked window cards
- score and confidence
- short reason bullets
- explicit direction badge per candidate
- apply button: set tour start date to selected window/day

### Result visuals
- mini trend strip (score by week)
- confidence badge
- variance indicator

---

## Testing Plan

### Unit tests (backend)
- candidate generation and wrapping at year boundaries
- day-mapping with rest-day patterns
- scoring monotonicity and weight effects
- confidence classification behavior
- forward vs reverse scoring changes under controlled wind fixtures

### Integration tests
- deterministic fixture route with synthetic weather years
- assert expected top week for known pattern
- assert refinement improves or matches coarse best
- assert `auto_compare` can prefer reverse when wind-alignment is better

### Frontend tests
- wizard start/progress/result states
- applying selected slot updates timeline and triggers weather-only refresh path

---

## Performance Targets

### Initial targets
- Coarse pass (52 weeks, 3 years, 21 days): under 5-10s on laptop
- With refinement: under 20-40s typical

### Hard guardrails
- Time budget fallback (return best known partial results)
- Job cancellation on new run or mode switch
- Memory cap through bounded caches

---

## Milestones

### M1 - Backend MVP
- week-level coarse ranking only
- 1/3/5 year horizons
- static comfort profile
- direction mode support (`forward|reverse|auto_compare`)
- JSON result endpoint

### M2 - UX Wizard MVP
- run button + progress + ranked results
- apply start date action

### M3 - Refinement + Confidence
- local day refinement around top-K
- confidence and explanation fields

### M4 - Advanced Preferences
- custom weighting panel
- optional risk-averse mode

### M5 - Quality and Docs
- full regression coverage
- user manual and architecture updates

---

## Risks and Mitigations

1. Data sparsity in some regions/years
- Mitigation: confidence downgrade + provenance in result cards.

2. User over-trust in exact day precision
- Mitigation: week-first wording, uncertainty badges, explicit disclaimer.

3. Runtime cost on long tours
- Mitigation: coarse-to-fine search, caching, cancellation, budget limits.

4. Inconsistent TourBook/runtime state during edits
- Mitigation: snapshot current plan at job start and version it in job payload.

---

## Open Decisions

1. Should rest days contribute to score or be neutral by default?
2. Should we default to offline-only for reproducibility, with optional online blending?
3. How should reverse mode treat TourBook day labels and endpoint naming in result copy?
4. How many top candidates should be shown by default (3 or 5)?
5. Should confidence be categorical only, or categorical + numeric probability proxy?

---

## Recommended First Implementation Choice

Start with:
- week-level optimization
- 3-year default horizon
- comfort profile only
- default direction mode: `auto_compare`
- top 5 windows
- confidence category + concise reason text

This gets user value quickly while staying computationally safe and explainable.