# Testing and validation

Results below come from automated runs during development: the data engine was tested directly in Node.js,
and the full app was driven end-to-end in headless Google Chrome (software WebGL) with Playwright.
Test files are synthetic (`scripts/make-samples.mjs`) — no real consumer data was used.

✅ = passed in testing · 👤 = please check yourself on your machine (cannot be automated here)

## Import

| Check | Result |
|---|---|
| One CSV file | ✅ |
| Several files added at once (consumers `,` + transformers `;` + file with errors) | ✅ |
| Files with identical headings (2 × 10 lakh rows) | ✅ fields merged, 19,98,660 valid points |
| Files with different headings and column orders | ✅ union of columns; missing columns shown blank |
| Delimiter detection: comma, semicolon, tab, pipe | ✅ |
| Encoding detection: UTF-8, UTF-8 with BOM, UTF-16 (BOM), Windows-1252 (accents), Hindi (Devanagari) UTF-8 | ✅ |
| Manual encoding / delimiter / header override re-reads the file | ✅ |
| Quoted fields with commas, doubled quotes and line breaks inside, split across read chunks (tested down to 1-character chunks) | ✅ |
| Preview of first 100 rows with suggested lat/lon columns shaded | ✅ |
| Lat/lon detection by name (`Latitude/Longitude`, `Lat/Long`, `lat/lng`, …) and by values | ✅ |
| Progress bar and **Cancel** during a 10 lakh-row import | ✅ status “Cancelled”, Retry offered |
| Remove a file | ✅ |
| 10 lakh rows (127 MB) | ✅ 17 s |
| 20 lakh rows (2 files) | ✅ 34 s, ~1.5 GB browser memory |

## Coordinates

| Check | Result |
|---|---|
| Missing latitude/longitude counted | ✅ |
| Non-numeric (`NA`) counted | ✅ |
| Latitude > 90 counted; swap hint when values fit as longitude | ✅ |
| 0,0 counted as “unknown” and not plotted | ✅ |
| Individually swapped rows (e.g. 85.1, 25.6 in Bihar data) flagged as suspicious, still plotted as given | ✅ 6 of 6 detected in sample |
| Projected (UTM-like) values, DMS (`25°36′N`) and decimal commas explained | ✅ (logic unit-checked) |
| Duplicate locations counted (~1 m precision) | ✅ |
| Download problem rows CSV with all original columns + “Problem” | ✅ |
| Original values unchanged in table, details and exports | ✅ |
| Swap button / manual column choice per file | ✅ |

## Map

| Check | Result |
|---|---|
| Points drawn with WebGL; 10 lakh and 20 lakh points | ✅ (15 lakh drawn as even sample by default above that; adjustable) |
| Automatic clusters when zoomed out over large data, points when zoomed in; click cluster zooms in | ✅ |
| Fit to data ignores a few far-away stray points | ✅ |
| Hover tooltip with chosen fields | ✅ |
| Click → detail panel: all columns, coordinates, source file, row number | ✅ |
| Copy coordinates / details, zoom, highlight, open in Google Maps / OSM, add/remove selection, show in table | ✅ (clipboard 👤) |
| Rectangle selection | ✅ 430 points selected in test |
| Layer on/off per file, show/hide all, counts per file | ✅ |
| Point size / transparency / background map switch | ✅ |
| Search a value and zoom (e.g. consumer number → zoom to point and open it) | ✅ |
| Full screen | 👤 |
| Background tiles load (OSM / CARTO / Esri / EOX) | 👤 the test server had no internet access; attribution verified |

## Colouring and legend

| Check | Result |
|---|---|
| By source file, colour pickers | ✅ |
| By field values, familiar colours for Connected / Disconnected / Pending | ✅ |
| Combine several values into one category; split back; move to Others | ✅ |
| Combine two or three fields (e.g. Category + Status) | ✅ |
| By number ranges with editable thresholds and colours | ✅ |
| Legend counts update with filters; click hides, double-click shows only one | ✅ |
| Colours stay the same while filtering and zooming | ✅ |

## Filters and table

| Check | Result |
|---|---|
| Pick-list filter with search and counts | ✅ |
| Cascading counts (other filters applied) | ✅ |
| Number range | ✅ 0.3 s on 20 lakh rows |
| Date range (DD/MM/YYYY data) | ✅ |
| Contains-text filter; search across all columns | ✅ ~1 s on 20 lakh rows |
| Source-file filter; filter limited to one file | ✅ |
| Clear all filters; hide/reopen panel | ✅ |
| Table: virtual scrolling (only visible rows rendered), sort, search, choose columns, select rows, click row → map | ✅ |
| Map click → table scrolls to the record | ✅ |
| Show only selected records | ✅ |

## Export

| Check | Result |
|---|---|
| CSV: all / filtered / selected; chosen and re-ordered columns; Latitude/Longitude; Source File | ✅ |
| CSV row count equals the on-screen count (1,43,015 filtered of 10 lakh) | ✅ |
| CSV opens in Excel with Hindi text (UTF-8 BOM) | 👤 |
| KML: name field, description table, ExtendedData, styles from map colours, folders by file / by column | ✅ |
| KML well-formed XML, correct `longitude,latitude` order, special characters escaped | ✅ parsed with an XML parser; 1,43,015 placemarks |
| KMZ (zip with `doc.kml`) and split-into-parts ZIP | ✅ |
| Open the KML/KMZ in Google Earth Pro | 👤 |
| Large exports stream (no single giant string); Save dialog used for > 300 MB in Chrome/Edge | ✅ |
| Cancel during export | ✅ (same mechanism as import) |

## Privacy and storage

| Check | Result |
|---|---|
| No network requests except map tiles and the app’s own files | ✅ |
| “Remember files in this browser” off by default; when on, files reopen after reload | ✅ |
| Reset → delete saved data removes stored files | ✅ |

## Layout

| Check | Result |
|---|---|
| Desktop 1400 px | ✅ |
| Phone 390 px (stepper becomes numbered dots, panels slide over the map) | ✅ |
| Firefox, Safari | 👤 |

## Your own acceptance test (10 minutes)

1. Open the published URL → **Load the sample files** → all three show **Ready**.
2. Step 2: `sample_with_errors.csv` shows problem rows → **Download problem rows** opens in Excel with a Problem column.
3. Step 3: **By field values** → Consumer Status → Connected green, Disconnected red.
4. Step 4: add filter **District → Patna**; the count and legend change; click a point; open the table.
5. Step 5: **Download CSV** (filtered) and **Download KML** → open the KML in Google Earth Pro; points sit in Bihar with the right colours and balloons.
6. Repeat with one of your real files (start with ~1 lakh rows, then larger).
