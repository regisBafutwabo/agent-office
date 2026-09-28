# Office skylines

These compact snapshots contain OpenStreetMap building footprints and heights around the placeholder office centers. The app loads only the selected local JSON file; it never queries a map service.

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). These derived building databases remain under ODbL, independently of the application's MIT license. Each JSON records its source timestamp and height coverage.

To change an address, edit `CITIES` in `scripts/bake-city.mjs`, then run from the repository root with Node 18 or newer:

```sh
node scripts/bake-city.mjs          # both cities
node scripts/bake-city.mjs gangnam  # one city
```

Set `OVERPASS_URL` to use another public Overpass interpreter if the default endpoint is unavailable. The bake logs building counts, byte sizes, explicit height coverage, level-derived heights, and 15 m defaults. Commit the regenerated JSON files.

Coordinates are meters east (+x) and south (+z), rounded to 0.1 m. Each building has `h` (meters) and `rings` (outer footprint, followed by courtyard holes). The query covers roughly 1.2 km square; complete footprints crossing its edge are retained. Footprints within 25 m of the origin are excluded to leave room for the office tower.

Gangnam also has a stylized Lotte World Tower in the scene: its actual bearing is preserved, but its distance is compressed to 380 m and its 555 m height to 330 m so the tapered tip remains visible in the fog.

## Baked snapshots

| City | Buildings | JSON bytes | Explicit height | Levels fallback | Default 15 m | OSM snapshot (UTC) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| San Francisco | 622 | 110,240 | 483 (77.7%) | 71 | 68 | 2026-07-15 15:22:01 |
| Gangnam | 1,643 | 147,090 | 235 (14.3%) | 18 | 1,390 | 2026-09-28 12:01:57 |

Gangnam is missing useful height data for 84.6% of its footprints, so most buildings use 15 m. VWorld or another height source could improve this later. The San Francisco mirror supplied an older snapshot; the timestamp above is the data date, not the bake date.

## Verification (2026-09-28)

Chromium, three.js r128, 1440 × 1000, fixed initial office camera, no agents, daylight. Measurements use `renderer.info.render.calls`. “Before” renders each generated building separately in a diagnostic version; “after” uses the shipped material batches. Generic generation is seeded for reproducibility. City-only totals include the ground, office tower, rooftop details, and Gangnam landmark; frustum culling is disabled for those totals to measure the entire city. Full-frame counts use normal culling and include the office and its shadow passes.

| City | Entire city before → after | Full frame before → after |
| --- | ---: | ---: |
| Generic | 494 → 9 | 1,100 → 1,017 |
| San Francisco | 624 → 8 | 1,102 → 1,016 |
| Gangnam | 1,646 → 9 | 1,151 → 1,016 |

The original unchanged app measured 1,124 full-frame calls, 92 visible city calls, and 494 city calls without culling with the same seeded skyline. Full-frame counts vary with procedural office details, camera, and agents; the material batch limits do not.

Verified first-run selection, saved reload, Customize switching, lazy city requests, failed requests without saving, rapid switching, night emission, flat roof UVs, geometry disposal across repeated switches, and light/dark layouts at 320/390 px. `npm test`: 30 passed. Desktop Rust tests: 31 passed. The Node server serves city files as `application/json`; the desktop server's existing `mime_guess` mapping does too. The packaged macOS UI and VR were not exercised.
