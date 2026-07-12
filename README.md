# ☀️ Sunshine Simulator

Interactive 3D sun-exposure simulator and PV planner for a house in the Stuttgart area
(works for any location — it defaults to Stuttgart, 48.7758 N / 9.1829 E).

Model your house, balconies, terraces, pergolas, neighbor buildings, trees and hedges in
the browser; compute the real solar position for any date and time; watch the actual
shadows; and get ray-traced annual insolation (kWh/m²·yr) and estimated PV yield for
every candidate surface — roof faces, pergola roofs, balcony railings
(Balkonkraftwerk!), terraces and free-standing panels.

## Run it

```bash
npm start          # or: python3 -m http.server 8123 --bind 127.0.0.1
# then open http://localhost:8123
```

No build step, no dependencies to install — three.js is vendored in `vendor/`.
(A static server is required because the app uses ES modules; opening `index.html`
directly from disk won't work.)

## Using it

- **Build the scene** (left panel). Add buildings (gable / hip / shed / flat roofs,
  adjustable pitch, ridge axis, eave height, overhang), trees (broadleaf/conifer with
  seasonal light transmittance), hedges, terraces, roofed terraces, balconies, chimneys
  (they auto-sit on whatever roof is below them) and free PV panels. Click an object to
  select it, **⌘/Ctrl-click to multi-select**, drag to move (a multi-selection moves as a
  group), **shift-drag to rotate** — a multi-selection rotates together around its center,
  and negative angles (counterclockwise) are fine everywhere. Every dimension is editable
  in the Properties panel, and everything is undoable (**⌘Z / Ctrl+Z**, redo with
  ⇧⌘Z / Ctrl+Y). **Arrow keys** nudge the selection 0.5 m north/south/east/west,
  **Shift+←/→** rotates it in 5° steps (hold **Alt** for 0.1 m / 1° fine steps) —
  key-repeat runs coalesce into a single undo step. With exactly
  **two objects selected**, the app measures the distance
  between them — nearest gap (marked by a dashed line in the 3D view) and
  center-to-center — live while you drag. A 🚗 Garage preset button creates a
  ready-made flat-roof garage. The scene autosaves to your browser and can be
  saved/loaded as JSON.
- **Explore the sun** (bottom bar). Pick any date (solstice/equinox shortcuts), scrub
  through the day, or press ▶ to animate. Shadows are the real ones for your
  latitude/longitude (NOAA solar position algorithm, ±0.1°). The orange arc is the
  sun's path for the selected day.
- **Run analysis** (top bar). For every surface marked "Analyze", the app lays a sample
  grid over it and ray-casts toward the sun across the whole year (12 representative
  days × 30-minute steps), plus a hemisphere pass for diffuse-sky obstruction. Trees and
  hedges attenuate rather than block (more light through bare winter canopies).
- **Read the results** (right panel): annual plane-of-array insolation, shading loss,
  direct-sun hours per day, estimated kWp / kWh per year per surface, monthly
  distribution chart, and a heatmap draped over the 3D geometry — annual kWh/m² or
  direct-sun hours on the selected day.
- **Export**: OBJ+MTL (SketchUp Pro, Blender, FreeCAD…) or COLLADA `.dae`, which every
  desktop SketchUp imports natively (File → Import). Y-up, meters, world transforms
  baked.

## Weather data

Two irradiance sources drive the energy numbers:

1. **Built-in climatology** (default, offline): long-term monthly GHI means for
   Stuttgart (~1,149 kWh/m²·yr, PVGIS/DWD magnitude), expanded to hourly direct/diffuse
   profiles with a two-state (clear/overcast) sky model calibrated to each month's
   total.
2. **Open-Meteo historical weather** ("Fetch real weather"): downloads 2020–2024 hourly
   GHI, DNI and DHI from the [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
   (ERA5 reanalysis, free for non-commercial use, no API key) for your exact
   coordinates and aggregates it into a month × hour climatology. Cached locally.
   For 2020–2024 Stuttgart this gives ≈ 1,250 kWh/m²·yr GHI — recent years have been
   sunnier than the long-term mean.

If you move the location away from Stuttgart, fetch real weather — the built-in monthly
totals are Stuttgart's.

### Cross-checks

- **[PVGIS](https://re.jrc.ec.europa.eu/pvg_tools/en/)** (EU JRC) — the European
  reference tool, satellite-based, knows Stuttgart well.
- **[PVWatts](https://pvwatts.nrel.gov/pvwatts.php)** (NREL) — the US industry-standard
  estimator, also works for Europe.

For an unshaded south roof at ~35–40° in Stuttgart both report ≈ 1,300–1,380 kWh/m²·yr
POA and ≈ 950–1,100 kWh/kWp — this simulator lands in the same range (validated in
`tests/run-tests.mjs`).

## Model & assumptions

- **Solar position**: NOAA algorithm (declination, equation of time, hour angle);
  times are your browser's local time zone.
- **Transposition**: beam = DNI·cos(AOI)·shade factor (ray-cast per sample point);
  diffuse = isotropic sky × per-point hemisphere obstruction factor;
  ground-reflected = GHI·albedo·(1−cos β)/2 (albedo 0.2 default).
- **Trees**: canopies attenuate by a seasonal transmittance (default broadleaf
  0.15 summer / 0.55 winter; set both ≈ 0.1 for conifers). Visual shadows in the 3D
  view are always fully opaque — the analysis is what applies transmittance.
- **PV estimate**: panel-based, per surface. Pick a panel type and count for each
  analyzed surface in the Results panel — Anker SOLIX 500 W bifacial (1961 × 1134 mm)
  or 440 W (1762 × 1134 mm); the default is the maximum number that fits
  (face area × packing factor ÷ panel area). Counts go in half-panel steps, and
  balconies expose each railing side separately (front / left / right, each with its
  own orientation and shading) — so "one panel on the left railing, half a panel on
  the front" is directly expressible. Exceeding the flush fit is allowed for
  overhanging mounts, with a warning. kWh/yr = count × watts × POA × performance
  ratio (0.8 default). Changing panels recomputes instantly without re-running the
  shading analysis. Packing factor, performance ratio and albedo are
  in the "PV assumptions" panel.
- **Simplifications**: isotropic diffuse (slightly conservative for steep south
  faces), no horizon/terrain beyond your modeled objects, no snow, monthly
  representative days. Treat results as planning-grade (±10%), and run PVGIS/PVWatts
  before buying hardware.

## Development

```
index.html  css/style.css          UI shell (3-panel layout + time bar)
js/solar.js                        NOAA solar position, clear-sky models
js/climate.js                      month×hour climatology (built-in synthesis)
js/weather.js                      Open-Meteo ERA5 fetch + aggregation
js/objects.js                      parametric objects → meshes + analysis faces
js/analysis.js                     sampling, ray-cast shading, insolation integration
js/heatmap.js  js/charts.js        heatmap overlay, monthly SVG chart
js/exporters.js                    OBJ+MTL and COLLADA writers
js/ui.js  js/main.js               DOM layer / three.js scene + wiring
tests/run-tests.mjs                headless test suite (solar, geometry, energy, exports)
```

`npm test` runs 50 checks headlessly in Node (no browser needed): solar-position ground
truths for Stuttgart, face geometry/orientation for every roof type, plausibility gates
on the energy numbers, and OBJ/DAE structural validation.
