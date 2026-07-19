# Basemap Evaluation

This sprint establishes a basemap comparison framework for Touracle and documents the current evaluation of the available candidates under tour-planning conditions.

Touracle is not a navigation app. The basemap has to stay visually quiet while still making towns, route context, and terrain readable beneath GPX routes, TourBook cards, weather glyphs, climate rasters, and wind overlays.

## OpenStreetMap Standard

### Advantages
- Familiar and widely recognized cartography.
- Good general-purpose label coverage for towns and roads.
- Strong baseline reference for comparing other styles.
- Works reliably with all Touracle overlays.

### Disadvantages
- Visually busier than the quieter candidates.
- Roads and minor features can compete with weather and route overlays.
- Less calm for long-range planning, especially in dense regions.

### Suitable use cases
- Reference baseline for QA and regression comparison.
- Users who prefer a conventional map style.
- General-purpose fallback when evaluating overlay readability.

### Known limitations
- Can feel dense in urban regions.
- Does not particularly optimize for strategic multi-day bicycle planning.

### Overall impression
- Useful as a baseline, but not the best choice for a planning-first default.

## CARTO Positron

### Advantages
- Very quiet visual background.
- Strong contrast between labels and terrain without excessive clutter.
- Works well with route lines, glyphs, weather cards, and climate overlays.
- Excellent candidate for keeping Touracle's own layers visually dominant.

### Disadvantages
- Less terrain detail than topographic styles.
- Minor roads and local context are intentionally subdued.
- Can feel slightly abstract in mountainous terrain.

### Suitable use cases
- Primary planning mode.
- Comparing multi-day routes where overlays must remain readable.
- Dense weather and climate views where visual calmness matters most.

### Known limitations
- Not ideal when the user wants terrain emphasis.
- Village-level context can be less immediate than on more detailed styles.

### Overall impression
- Best overall balance for strategic route planning. It keeps the map quiet while preserving orientation and overlay readability.

## OpenTopoMap

### Advantages
- Strong terrain readability.
- Useful when elevation context matters, especially in the Alps, Pyrenees, and similar terrain.
- Better for reading mountain shape and valley context than flat light styles.
- Good for checking whether a route is likely to climb, descend, or traverse ridges.

### Disadvantages
- More visually active than Positron.
- Terrain shading can compete with weather overlays in some views.
- Can feel heavy in flatter regions where the terrain emphasis adds little value.

### Suitable use cases
- Mountain routes.
- Comparing passes, valleys, and relief structure.
- Cases where terrain interpretation matters more than pure overlay calmness.

### Known limitations
- Less suitable as a universal default for all tours.
- Can become visually noisy when many overlays are enabled at once.

### Overall impression
- Strong specialist option. Valuable for mountainous tours, but too terrain-forward to be the default for all planning.

## CyclOSM

### Advantages
- Cycling-oriented cartography.
- Good road and path interpretation for bicycle planning.
- Often gives strong practical context for cycle infrastructure and route choice.
- Reads well for riders who want route-adjacent bicycle detail.

### Disadvantages
- More specific and more information-dense than Positron.
- Can be visually busier than the calmest planning styles.
- Cycling detail may compete with weather overlays in dense urban or mixed-feature areas.

### Suitable use cases
- Bicycle-specific route comparison.
- Situations where cycling context is more important than visual restraint.
- Comparing road choice and local infrastructure against Touracle overlays.

### Known limitations
- Not as calm as Positron.
- Not as terrain-revealing as OpenTopoMap.

### Overall impression
- A strong specialist candidate, especially for bicycle context, but not as balanced as Positron for the main planning workflow.

## Recommendation

For Touracle's current default basemap, **OpenTopoMap** is the selected choice.

This aligns with Sprint 5.1's visual direction: route and selected-day legibility are now strengthened through a GIS-style white halo + colored inner line system, so the extra terrain context of OpenTopoMap adds value without sacrificing route clarity. CyclOSM remains a strong cycling-context alternative, and CARTO Positron remains the calmest fallback for users who prefer lower terrain emphasis.

OpenStreetMap Standard should remain available as the reference baseline, but it is no longer the preferred default for Touracle's strategic multi-day planning workflow.