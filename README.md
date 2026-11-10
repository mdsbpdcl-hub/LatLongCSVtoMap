# CSV Map — map, filter and export large CSV files in the browser

A free, browser-only GIS-style tool. Load several large CSV files (lakhs of rows), plot their latitude/longitude on an interactive map, filter and colour the points by any column, and export the records you need as **CSV** or **KML/KMZ** (Google Earth).

**Your files stay on your computer.** CSV files are read inside the browser tab. They are never uploaded, including to GitHub. The only internet requests are for background map tiles (see [Privacy](#privacy)).

---

## What it does

| Step | What you do |
|---|---|
| 1. Import Files | Drag in one or more CSV files. Encoding and delimiter are detected automatically (and can be changed). Preview the first 100 rows. See rows and valid locations per file. Cancel a slow import or remove a file. |
| 2. Configure Coordinates | Check the suggested Latitude/Longitude columns for each file (or choose/swap them). See valid, missing, non-numeric, out-of-range, 0,0, possibly-swapped and duplicate-location counts. Download the problem rows as CSV for correction. Original values are never changed. |
| 3. Configure Display | Colour points by source file, by the values of one or more columns (merge values into categories, pick colours), or by number ranges with your own thresholds. Choose hover fields, point size, transparency, background map and clustering. |
| 4. Explore Map | WebGL map with clustering when zoomed out. Filters built from your columns: pick-lists with counts that cascade (District → Division → Feeder), number ranges, date ranges, text search, file selection. Clickable legend with counts. Hover tooltips, a detail panel for each point, rectangle selection, records table (sort, search, choose columns), search-and-zoom box, fit-to-data, full screen. |
| 5. Export Results | Choose all / filtered / selected records and which files. **CSV**: choose and reorder columns, add Latitude/Longitude and Source File columns. **KML/KMZ**: choose the name column, description fields, ExtendedData fields, folders (by file or by a column), map colours; compressed KMZ or split into parts. Shows record count and estimated size first. |

A **Reset** button clears everything; **⚙ Privacy & storage** lets you optionally keep files in this browser between visits.

---

## Publish it on GitHub Pages (free) — step by step

You need a free GitHub account. No software has to be installed on your computer.

1. **Create a repository.** On github.com click **+ → New repository**. Give it a name, e.g. `csv-map`. Choose **Public** (free GitHub Pages needs a public repository on a free account — only the app code is public; your CSV files never go there). Click **Create repository**.

2. **Upload the project files.** Unzip `csv-geo-mapper.zip` on your computer. In the new repository click **uploading an existing file** (or **Add file → Upload files**). Open the unzipped folder, select **everything inside it** (not the folder itself) and drag it onto the page. Click **Commit changes**.
   - Check that the folder **`.github/workflows`** was uploaded (some computers hide folders starting with a dot). If you do not see a `.github` folder in the repository, click **Add file → Create new file**, type the name `.github/workflows/deploy.yml`, paste in the contents of that file from the ZIP, and commit.
   - Do **not** upload any real data files.

3. **Turn on GitHub Pages.** In the repository go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.

4. **Start the deployment.** Go to the **Actions** tab. If you see a yellow banner about workflows, click **I understand… enable them**. Open **Deploy to GitHub Pages** and click **Run workflow → Run workflow** (it also runs automatically on every change).

5. **Check it built.** Wait 1–3 minutes until the run shows a green tick ✓. A red ✗ means something failed — click it to read the message (see Troubleshooting).

6. **Open the app.** The address is shown in the finished run and under **Settings → Pages**. It looks like
   `https://YOUR-USERNAME.github.io/csv-map/`
   Bookmark it — it works from any computer with a modern browser.

7. **Test it.** On the first screen click **Load the sample files**, then go through the steps. Then try your own CSV files.

8. **Update later.** Edit or upload changed files in the repository (or push from your computer). Each commit to `main` rebuilds and republishes automatically within a few minutes. Refresh the page (Ctrl+F5) to see the new version.

The Vite base path is set automatically by the workflow from the repository name, so renaming the repository just works. A repository named `YOUR-USERNAME.github.io` is published at the root.

---

## Run it on your own computer (optional, for developers)

Requires Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build into dist/
npm run preview      # serve the build
npm run make-samples # regenerate the sample CSVs in public/samples
node scripts/make-samples.mjs big 1000000   # 10 lakh-row test file in test-data/ (git-ignored)
```

---

## How it works (architecture)

| Part | Technology |
|---|---|
| Interface | React 19 + TypeScript + Vite |
| Map | MapLibre GL JS (open-source), raster basemaps |
| Points | deck.gl `ScatterplotLayer` (WebGL), binary attributes, 64-bit positions |
| CSV reading | Own streaming parser (RFC 4180: quotes, embedded commas/newlines), 4 MB pieces |
| Background work | One Web Worker holds all data and does parsing, filtering, colouring, clustering, sorting and export |
| Storage of records | Dictionary-encoded columns in worker memory (each distinct value stored once; rows hold integer codes) |
| Optional saving | IndexedDB, only if you switch it on |
| CSV / KML export | Streamed in ~1 MB pieces into a Blob, or straight to disk with the browser Save dialog for very large files (Chrome/Edge); KMZ/ZIP via `fflate` |
| Hosting | GitHub Actions → GitHub Pages (static files only, no server) |

### Changes from the suggested architecture, and why

- **No DuckDB-WASM.** DuckDB-WASM adds a ~30 MB engine download from a CDN and copies the data into its own format. The operations this app needs (filter by value lists, ranges, dates, text; count categories; sort; colour) are simple column scans. A purpose-built dictionary-encoded store does these in well under a second for 20 lakh rows, starts instantly, works offline after the first load, and keeps memory lower. If SQL-style joins are ever needed, DuckDB-WASM can be added later.
- **Own streaming CSV parser instead of a library.** It runs inside the worker with no dependency, handles quoted fields and line breaks split across read pieces, and was tested with 1-character pieces.
- **OPFS not used.** Records must be in memory anyway for instant filtering; IndexedDB is enough for the optional “remember files” feature (it stores the original files, which are re-read on restore).
- **Clustering is a fast grid clustering** computed in the worker for the current zoom level (instead of Supercluster), which takes milliseconds for 10 lakh points and needs no extra index memory.
- **Map drawing** uses an even sample only if more than 15 lakh points (adjustable) would be drawn at once. **Filters, counts and exports always use every record.**

### Rules worth knowing

- Coordinates must be **WGS84 decimal degrees**. Values are never changed. Rows that are empty, not numbers, out of range, or exactly 0,0 are not plotted but stay in your data (and can be exported with “All records → Include rows without valid coordinates”). Projected coordinates (e.g. UTM metres), degrees-minutes-seconds and decimal commas are detected and explained.
- Points whose latitude/longitude look individually swapped (they would sit with the rest of the data if reversed) are flagged as suspicious but still plotted as given.
- Files may have different columns. Columns with the same heading are treated as the same field. A filter on a column applies to all files that have it; records from files without that column are left out while the filter is active, unless you set the filter to “Only in <file>”.
- The legend can hide categories; hidden categories count as a filter (they affect “Filtered” counts and exports). The **Layers** tab hides whole files from the map only (counts and exports are unaffected); the **Source files** ticks in the Filters tab do affect counts and exports.
- Dates are read as day-first (03/04/2024 = 3 April) by default; change it under Configure Display → Advanced options.
- CSV exports are UTF-8 with a byte-order mark so Excel shows Hindi and other scripts correctly.

---

## Large data: tested performance and limits

Measured with synthetic consumer files (12 columns: IDs, names, district/division/feeder, status, dates, amounts, coordinates), headless Chrome on a Linux server with **software** (CPU) WebGL. A normal laptop with a graphics chip will draw faster.

| Test | Result |
|---|---|
| 10 lakh rows, 127 MB, one file | Read and indexed in **17 s**; map ready in 0.8 s |
| 20 lakh rows, two files | Read in **34 s**; map ready in 0.6 s; total browser memory about **1.5 GB** |
| Category filter (10 lakh) | 0.4 s |
| Search across all columns (20 lakh) | about 1 s |
| Number-range filter (20 lakh) | 0.3 s |
| Sort table by a number column | under 0.1 s |
| CSV export of 1,43,015 filtered records | 1.2 s, 18 MB |
| KMZ export of 1,43,015 records | 8.5 s, 9.4 MB (164 MB uncompressed KML) — validated as well-formed KML |

Practical guidance:

- **Comfortable:** up to about 10–20 lakh rows in total on a laptop with 8 GB RAM, using 64-bit Chrome or Edge. Data memory was roughly 0.3–0.6 GB per 10 lakh rows of 12 columns, on top of the browser itself; more columns and more unique text (names, addresses) need more.
- **Possible with care:** 30–50 lakh rows on machines with 16 GB or more. Close other tabs.
- **Not supported:** files larger than the memory available to one browser tab. If the browser runs out of memory, the app shows a message; reload and use fewer or smaller files.
- **KML for Google Earth:** Google Earth Pro becomes slow above roughly 1–1.5 lakh placemarks per file. Use KMZ, or “Split into parts”, or export filtered subsets.
- Mobile phones work for viewing and filtering smaller files; large files need a desktop browser.

These numbers are measurements on test data, not guarantees. Your speed depends on the computer, the browser and the shape of your files.

---

## Privacy

- CSV files are processed only in your browser tab (in a Web Worker). No data is sent anywhere.
- The published app contains only code and the synthetic sample files. Nothing you load is ever written to GitHub.
- **Map tiles are external:** to draw the background map, the browser downloads image tiles from the selected provider (OpenStreetMap, CARTO, Esri or EOX). The provider sees which map area you view (like any web map), never your CSV data. Choose **“No background (works offline)”** for no external requests at all.
- Nothing is stored after you close the tab unless you switch on **⚙ → Remember files in this browser**. Switching it off, or **Reset → Reset and delete saved data**, deletes everything stored.

## Background maps and licences

| Option | Terms |
|---|---|
| Street map (OpenStreetMap) | © OpenStreetMap contributors (ODbL). Tiles under the OSM tile usage policy: light use, attribution shown. |
| Light grey (CARTO Positron) | © OpenStreetMap contributors © CARTO. Free for non-commercial use under CARTO’s terms. |
| Satellite (Esri World Imagery) | © Esri, Maxar, Earthstar Geographics. Free with attribution for non-commercial/light use under Esri’s terms; organisational or heavy use may need an ArcGIS account — check before official use. |
| Satellite (Sentinel-2 cloudless, EOX) | CC BY-NC-SA 4.0 (non-commercial), 10 m resolution. |
| Custom tile server | Any `{z}/{x}/{y}` raster tile URL you are licensed to use, with your own attribution. |

Attribution is shown on the map for every option. No API keys are needed. To change the list, edit `src/lib/basemaps.ts`.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| Actions run fails at “Install dependencies” | Make sure `package-lock.json` was uploaded. |
| The site shows a blank page | Settings → Pages → Source must be **GitHub Actions**. Wait for the green tick, then hard-refresh (Ctrl+F5). |
| No workflow appears in Actions | The `.github/workflows/deploy.yml` file is missing — create it as described in step 2. |
| Strange characters in text | ⚙ next to the file → change **Encoding** (try Windows-1252 for old Excel exports). |
| Everything is in one column | ⚙ next to the file → change **Delimiter**. |
| No points / few points | Step 2: check the Latitude and Longitude columns; use **Swap** if reversed; read the warnings. |
| “Ran out of memory” | Close other tabs, load fewer files, or use a computer with more RAM (64-bit Chrome/Edge). |
| Background map is blank | Your network may block the tile provider; pick another background or “No background”. The points still work. |

---

## Project structure

```
.github/workflows/deploy.yml   GitHub Actions: build + publish to Pages
index.html                     Page shell
vite.config.ts                 Build settings (base path from BASE_PATH)
public/samples/                Synthetic test CSVs (no real data)
scripts/make-samples.mjs       Generates small and very large test files
src/main.tsx, App.tsx          App entry and step workflow / state
src/state.ts                   Defaults, colour presets, helpers
src/styles/app.css             “My Application Style” design
src/lib/types.ts               Shared TypeScript types
src/lib/csv.ts                 Streaming CSV parser, encoding/delimiter/lat-lon detection
src/lib/values.ts              Number/date/coordinate parsing, colours, formatting
src/lib/basemaps.ts            Background map providers and attribution
src/lib/storage.ts             Optional IndexedDB storage
src/lib/workerClient.ts        Promise-based messaging with the worker
src/worker/data.worker.ts      Worker entry: request handlers
src/worker/store.ts            Columnar data store: load, validate, filter, colour, cluster, sort, select
src/worker/exporters.ts        Streaming CSV, KML, KMZ and split-ZIP writers
src/components/                Shell, ImportStep, CoordinatesStep, DisplayStep, MapStep, MapView,
                               FilterPanel, InfoPanel, AttributeTable, SearchBox, ExportStep
TESTING.md                     Validation checklist and results
```
