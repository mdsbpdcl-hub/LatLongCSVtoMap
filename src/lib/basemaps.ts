// Basemap (background map) providers. All are free to use within their published terms and need no API key.
// Map tiles are the ONLY network requests the app makes after loading; CSV data never leaves the browser.

import type { StyleSpecification } from 'maplibre-gl';

export interface Basemap {
  id: string;
  name: string;
  tiles: string[];
  attribution: string;
  maxzoom: number;
  note: string;
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'osm',
    name: 'Street map (OpenStreetMap)',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxzoom: 19,
    note: 'Free under the OpenStreetMap tile usage policy (light use, attribution required).',
  },
  {
    id: 'carto-light',
    name: 'Light grey (CARTO Positron)',
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`),
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    maxzoom: 20,
    note: 'Quiet background that makes coloured points stand out. Free for non-commercial use under CARTO terms.',
  },
  {
    id: 'esri-imagery',
    name: 'Satellite (Esri World Imagery)',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics and the GIS User Community',
    maxzoom: 19,
    note: 'Free with attribution under Esri’s terms of use for non-commercial/light use; organisational or heavy use may need an ArcGIS account. Check the terms before official use.',
  },
  {
    id: 's2cloudless',
    name: 'Satellite (Sentinel-2 cloudless, EOX)',
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
    attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless by EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2020) — CC BY-NC-SA 4.0',
    maxzoom: 15,
    note: '10 m resolution (good for district/feeder level, not individual buildings). Licence: CC BY-NC-SA 4.0 (non-commercial).',
  },
  {
    id: 'none',
    name: 'No background (works offline)',
    tiles: [],
    attribution: '',
    maxzoom: 22,
    note: 'Plain background; makes no network requests.',
  },
];

export interface CustomTiles {
  url: string;
  attribution: string;
  maxzoom: number;
}

export function basemapStyle(id: string, custom: CustomTiles | null): StyleSpecification {
  let tiles: string[] = [];
  let attribution = '';
  let maxzoom = 19;
  if (id === 'custom' && custom?.url) {
    tiles = [custom.url];
    attribution = custom.attribution || 'Custom tiles';
    maxzoom = custom.maxzoom || 19;
  } else {
    const b = BASEMAPS.find((x) => x.id === id) || BASEMAPS[0];
    tiles = b.tiles;
    attribution = b.attribution;
    maxzoom = b.maxzoom;
  }
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef1f4' } }],
  };
  if (tiles.length) {
    style.sources.base = { type: 'raster', tiles, tileSize: 256, attribution, maxzoom };
    style.layers.push({ id: 'base', type: 'raster', source: 'base' });
  }
  return style;
}
