# Office skylines

These compact snapshots contain OpenStreetMap building footprints and heights around the placeholder office centers. The app loads only the selected local JSON file; it never queries a map service.

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). These derived building databases remain under ODbL, independently of the application's MIT license. Each JSON records its source timestamp and height coverage.

To change an address, edit `CITIES` in `scripts/bake-city.mjs`, then run from the repository root with Node 18 or newer:

```sh
node scripts/bake-city.mjs          # both cities
node scripts/bake-city.mjs gangnam  # one city
```

Set `OVERPASS_URL` to use another public Overpass interpreter if the default endpoint is unavailable. The bake logs building counts, byte sizes, explicit height coverage, level-derived heights, and 15 m defaults. Commit the regenerated JSON files.

Coordinates are meters east (+x) and south (+z), rounded to 0.1 m. Each building has `h` (meters) and `rings` (outer footprint, followed by courtyard holes). The query covers 4.4 km square for SF and 1.2 km square for Gangnam, configured by `CITY_RADIUS_M` in the bake script; complete footprints crossing its edge are retained. Footprints within 25 m of the origin are excluded to leave room for the office tower.

Gangnam also has a stylized Lotte World Tower in the scene: its actual bearing is preserved, but its distance is compressed to 380 m and its 555 m height to 330 m so the tapered tip remains visible in the fog.

## San Francisco landmark reconstructions

SF adds three hand-modeled, stylized buildings: Salesforce Tower (326.1 m), Transamerica Pyramid (260 m), and 181 Fremont (250.1 m to the tip). Their curved crown, pyramid/spire, and diagonal frame use original geometry and canvas facade drawings. These are visual interpretations, not scans or survey-accurate models; no Google/VWorld imagery, mesh data, API key, or streaming service is used.

The fictional office viewpoint is at 37.7843, -122.3995, roughly 630 m southwest of the baked center. All SF footprints are translated together into that coordinate frame; building landmark positions and heights are not compressed. The two existing landmark footprints are replaced at runtime, while Salesforce fills the original bake's office clearance. The runtime does not alter source footprints. Footprints within 25 m of the new office are omitted. The SF snapshot now covers all four sides of the office, extending roughly 1.6–2.8 km from this offset viewpoint.

| Landmark | Latitude, longitude | Reference |
| --- | --- | --- |
| Salesforce Tower | 37.7897, -122.3972 | [Building facts](https://salesforcetower.com/about/), [crown designer](https://front.global/project/salesforce-tower-crown-illumination/) |
| Transamerica Pyramid | 37.795169, -122.402602 | [Building site](https://transamericapyramid.com/transamerica-pyramid); center/height from baked OSM footprint |
| 181 Fremont | 37.789788, -122.395356 | [Council on Vertical Urbanism](https://www.skyscrapercenter.com/building/181-fremont/664); center from baked OSM footprint |

Choose **Customize → San Francisco → View SF skyline** for a wider rooftop camera angle. The 3D button restores the office camera. SF uses fog from 800–6,000 m and a 7,000 m camera far plane; switching cities restores the shorter range. Both facade lights and structural trim follow the selected office theme.

**View Golden Gate** turns northwest toward a handmade suspension bridge with two open steel towers, curved main cables, suspenders, deck trusses, and orange paint. It retains the bearing of the approximate bridge center (37.8199, -122.4783), but is brought to 3,600 m from the fictional office, beyond the enlarged city sample, with a 1,280 m main span. The towers use 227 m height, with simplified decorative caps. Continuous water, a shaped peninsula and three-dimensional hill surfaces replace the rectangular water patch and flat shore cards. These are illustrative scenery, not surveyed coastline/terrain data. This is deliberately a scenic reconstruction, not the real visibility or scale from this address. Design references: [Bridge District dimensions](https://www.goldengate.org/bridge/history-research/statistics-data/design-construction-stats/) and [International Orange / Art Deco styling](https://www.goldengate.org/bridge/history-research/bridge-features/color-art-deco-styling/).

The bridge, coastline, water and hills share the structural-trim batch through vertex colors. SF hides the generic ground plane and uses its own land/water geometry in that batch: six surrounding-building batches, two landmark/backdrop batches, and the office tower, for nine city meshes. Switching cities disposes all SF geometry and restores the generic ground.

`npm test`: 35 passed. Tests execute the geometry with three.js r128, checking finite positions/normals/UVs, landmark heights, footprint replacement, source preservation, NW bridge placement, upward terrain faces, mapped buildings in all four quadrants, and the batch limit. Browser checked the bridge-facing view, hills beyond the span, and a steep camera rotation over the formerly empty side. The expanded JSON is 2.28 MB, with more geometry to build and render despite the fixed batch count; mobile/VR performance has not been benchmarked for this larger snapshot. The measurements below predate the expanded SF data and handmade scenery.

## Baked snapshots

| City | Buildings | JSON bytes | Explicit height | Levels fallback | Default 15 m | OSM snapshot (UTC) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| San Francisco | 11,054 | 2,282,586 | 7,594 (68.7%) | 431 | 3,029 | 2026-09-28 13:44:36 |
| Gangnam | 1,643 | 147,090 | 235 (14.3%) | 18 | 1,390 | 2026-09-28 12:01:57 |

Gangnam is missing useful height data for 84.6% of its footprints, so most buildings use 15 m. VWorld or another height source could improve this later. San Francisco was refreshed from Overpass for the expanded area; timestamps above are the source data dates.

## Verification (2026-09-28)

Chromium, three.js r128, 1440 × 1000, fixed initial office camera, no agents, daylight. Measurements use `renderer.info.render.calls`. “Before” renders each generated building separately in a diagnostic version; “after” uses the shipped material batches. Generic generation is seeded for reproducibility. City-only totals include the ground, office tower, rooftop details, and Gangnam landmark; frustum culling is disabled for those totals to measure the entire city. Full-frame counts use normal culling and include the office and its shadow passes.

| City | Entire city before → after | Full frame before → after |
| --- | ---: | ---: |
| Generic | 494 → 9 | 1,100 → 1,017 |
| San Francisco | 624 → 8 | 1,102 → 1,016 |
| Gangnam | 1,646 → 9 | 1,151 → 1,016 |

The original unchanged app measured 1,124 full-frame calls, 92 visible city calls, and 494 city calls without culling with the same seeded skyline. Full-frame counts vary with procedural office details, camera, and agents; the material batch limits do not.

Verified first-run selection, saved reload, Customize switching, lazy city requests, failed requests without saving, rapid switching, night emission, flat roof UVs, geometry disposal across repeated switches, and light/dark layouts at 320/390 px. `npm test`: 30 passed. Desktop Rust tests: 31 passed. The Node server serves city files as `application/json`; the desktop server's existing `mime_guess` mapping does too. The packaged macOS UI and VR were not exercised.
