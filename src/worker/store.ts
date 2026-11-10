// In-worker columnar data store. All heavy data lives here, never in React state.
// Columns are dictionary-encoded: each distinct text value is stored once and rows hold integer codes.

import {
  CsvParser, bomLengthFor, detectDelimiter, detectEncoding, guessLatLon, normaliseHeaders,
} from '../lib/csv';
import {
  CATEGORY_PALETTE, DATASET_PALETTE, OTHERS_COLOR, dateInputToMs, hexToRgb, parseCoord, parseDate, parseNumber,
} from '../lib/values';
import type {
  ClusterResult, ColType, ColumnInfo, DatasetInfo, FieldInfo, Filter, InspectResult, LegendEntry, LoadOptions,
  RecordDetail, ViewConfig, ViewResult,
} from '../lib/types';

const CHUNK_ROWS = 65536;
const READ_BYTES = 4 * 1024 * 1024;

export interface Column {
  name: string;
  codes: Int32Array;
  dict: string[];
  counts: Uint32Array;
  info: ColumnInfo;
  _lower?: string[];
  _num?: Float64Array;
  _date?: Float64Array;
  _dateDayFirst?: boolean;
}

export interface Dataset {
  id: number;
  name: string;
  size: number;
  file: Blob;
  opts: LoadOptions;
  rows: number;
  cols: Column[];
  colIndex: Map<string, number>;
  offset: number; // global id = offset + row
  lat: Float64Array;
  lon: Float64Array;
  reason: Uint8Array; // 0 = valid coordinates
  suspect: Uint8Array; // 1 = plotted but looks like an individually swapped lat/lon
  suspectCount: number;
  valid: number;
  invalid: number[];
  duplicates: number;
  warnings: string[];
  raggedRows: number;
  badChars?: boolean;
  loadMs: number;
  cls: Uint16Array;
  selected: Uint8Array;
  pass: Uint8Array;
}

/** Ensure a substring does not keep the whole 4 MB read buffer alive (V8 sliced strings). */
function detach(s: string): string {
  return s.length >= 13 ? (' ' + s).slice(1) : s;
}

export function lowerOf(c: Column): string[] {
  if (!c._lower) c._lower = c.dict.map((v) => v.toLowerCase());
  return c._lower;
}
export function numOf(c: Column): Float64Array {
  if (!c._num) {
    const a = new Float64Array(c.dict.length);
    for (let k = 0; k < c.dict.length; k++) a[k] = parseNumber(c.dict[k]);
    c._num = a;
  }
  return c._num;
}
export function dateOf(c: Column, dayFirst: boolean): Float64Array {
  if (!c._date || c._dateDayFirst !== dayFirst) {
    const a = new Float64Array(c.dict.length);
    for (let k = 0; k < c.dict.length; k++) a[k] = parseDate(c.dict[k], dayFirst);
    c._date = a;
    c._dateDayFirst = dayFirst;
  }
  return c._date;
}

function inferColumn(name: string, dict: string[], counts: Uint32Array, rows: number): ColumnInfo {
  let empty = 0;
  let numericRows = 0, dateRows = 0;
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < dict.length; k++) {
    const v = dict[k];
    if (v.trim() === '') { empty += counts[k]; continue; }
    const x = parseNumber(v);
    if (!Number.isNaN(x)) {
      numericRows += counts[k];
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  const nonEmpty = rows - empty;
  let type: ColType;
  if (nonEmpty > 0 && numericRows >= nonEmpty * 0.95) {
    type = 'number';
  } else {
    for (let k = 0; k < dict.length && dateRows < nonEmpty; k++) {
      if (dict[k].trim() && !Number.isNaN(parseDate(dict[k], true))) dateRows += counts[k];
    }
    if (nonEmpty > 0 && dateRows >= nonEmpty * 0.9) type = 'date';
    else if (dict.length <= 10000 && dict.length <= Math.max(60, rows * 0.5)) type = 'category';
    else type = 'text';
  }
  const info: ColumnInfo = { name, type, distinct: dict.length, empty };
  if (type === 'number') { info.min = min; info.max = max; }
  return info;
}

export class DataStore {
  datasets: Dataset[] = [];
  private nextOffset = 0;
  private filterCache = new Map<string, Uint8Array>();
  private classKey = '';
  private classColors: [number, number, number][] = [];
  private legendBase: { label: string; color: string }[] = [];
  private lastConfig: ViewConfig | null = null;
  private renderPositions = new Float64Array(0);
  private renderIds = new Uint32Array(0);
  private renderColors = new Uint8Array(0);
  private version = 0;
  private clusterCache = new Map<number, ClusterResult>();
  tableIds = new Uint32Array(0);

  // ------------------------------------------------------------ import
  async inspect(file: Blob, override?: Partial<LoadOptions>): Promise<InspectResult> {
    const sample = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const det = detectEncoding(sample);
    const encoding = override?.encoding || det.encoding;
    const bom = bomLengthFor(sample, encoding);
    let text: string;
    try {
      text = new TextDecoder(encoding).decode(sample.subarray(bom));
    } catch {
      text = new TextDecoder('utf-8').decode(sample.subarray(bom));
    }
    const delimiter = override?.delimiter || detectDelimiter(text);
    const hasHeader = override?.hasHeader ?? true;
    const rows: string[][] = [];
    const p = new CsvParser(delimiter, (r) => {
      rows.push(r);
      return rows.length < 102;
    });
    // only parse up to the last complete line of the sample
    const cut = sample.length < file.size ? text.lastIndexOf('\n') : text.length;
    p.push(cut > 0 ? text.slice(0, cut + 1) : text);
    p.end();
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const headerRow = hasHeader ? rows[0] || [] : [];
    // Same column count as the full load uses: the header row (or the first row when there is no header).
    const ncols = hasHeader ? headerRow.length : (rows[0] || []).length;
    const headers = normaliseHeaders(Array.from({ length: ncols }, (_, i) => (hasHeader ? headerRow[i] ?? '' : `Column ${i + 1}`)));
    const preview = rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 100);
    const g = guessLatLon(headers, preview);
    const warnings: string[] = [];
    if (text.includes('�') && encoding === 'utf-8') warnings.push('Some characters could not be read as UTF-8. Try another encoding.');
    if (headers.length < 2) warnings.push('Only one column was found. Check the delimiter.');
    if (width > headers.length) warnings.push(`Some rows have more values than there are column names (${width} vs ${headers.length}). Extra values will be ignored — check the delimiter or the header row.`);
    return { encoding, delimiter, hasHeader, headers, preview, latGuess: g.lat, lonGuess: g.lon, warnings };
  }

  async load(
    id: number, name: string, file: Blob, opts: LoadOptions,
    onProgress: (fraction: number, rows: number) => void, isCancelled: () => boolean,
  ): Promise<DatasetInfo> {
    const t0 = performance.now();
    this.remove(id);
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const bom = bomLengthFor(head, opts.encoding);
    const decoder = new TextDecoder(opts.encoding);
    let headers: string[] | null = null;
    let builders: { map: Map<string, number> | null; dict: string[]; chunks: Int32Array[]; cur: Int32Array; pos: number }[] = [];
    let rows = 0;
    let ragged = 0;
    const newBuilder = () => ({ map: new Map<string, number>(), dict: [] as string[], chunks: [] as Int32Array[], cur: new Int32Array(CHUNK_ROWS), pos: 0 });
    const addRow = (r: string[]) => {
      if (!headers) {
        if (opts.hasHeader) {
          headers = normaliseHeaders(r);
          builders = headers.map(newBuilder);
          return;
        }
        headers = normaliseHeaders(r.map((_, i) => `Column ${i + 1}`));
        builders = headers.map(newBuilder);
      }
      const nc = builders.length;
      if (r.length !== nc) ragged++;
      for (let c = 0; c < nc; c++) {
        const b = builders[c];
        const v = c < r.length ? r[c] : '';
        let code = b.map!.get(v);
        if (code === undefined) {
          code = b.dict.length;
          const dv = detach(v);
          b.dict.push(dv);
          b.map!.set(dv, code);
        }
        b.cur[b.pos++] = code;
        if (b.pos === CHUNK_ROWS) {
          b.chunks.push(b.cur);
          b.cur = new Int32Array(CHUNK_ROWS);
          b.pos = 0;
        }
      }
      rows++;
    };
    const parser = new CsvParser(opts.delimiter, addRow);
    let badChars = false;
    let offset = bom;
    while (offset < file.size) {
      if (isCancelled()) throw new Error('cancelled');
      const end = Math.min(file.size, offset + READ_BYTES);
      const buf = await file.slice(offset, end).arrayBuffer();
      const text = decoder.decode(new Uint8Array(buf), { stream: end < file.size });
      if (!badChars && text.indexOf('\uFFFD') !== -1) badChars = true;
      parser.push(text);
      offset = end;
      onProgress(offset / file.size, rows);
    }
    parser.push(decoder.decode());
    parser.end();
    if (!headers) throw new Error('The file is empty.');

    const cols: Column[] = (headers as string[]).map((h, c) => {
      const b = builders[c];
      const codes = new Int32Array(rows);
      let p = 0;
      for (const ch of b.chunks) { codes.set(ch, p); p += ch.length; }
      codes.set(b.cur.subarray(0, b.pos), p);
      b.map = null;
      const counts = new Uint32Array(b.dict.length);
      for (let r = 0; r < rows; r++) counts[codes[r]]++;
      return { name: h, codes, dict: b.dict, counts, info: inferColumn(h, b.dict, counts, rows) };
    });
    builders = [];

    const ds: Dataset = {
      id, name, size: file.size, file, opts: { ...opts }, rows, cols,
      colIndex: new Map(cols.map((c, i) => [c.name, i])),
      offset: this.nextOffset,
      lat: new Float64Array(rows), lon: new Float64Array(rows), reason: new Uint8Array(rows),
      suspect: new Uint8Array(rows), suspectCount: 0,
      valid: 0, invalid: [], duplicates: 0, warnings: [], raggedRows: ragged, loadMs: 0,
      cls: new Uint16Array(rows), selected: new Uint8Array(rows), pass: new Uint8Array(rows),
    };
    this.nextOffset += rows + 1;
    ds.badChars = badChars;
    this.computeCoords(ds, opts.latCol, opts.lonCol);
    ds.loadMs = Math.round(performance.now() - t0);
    this.datasets.push(ds);
    this.invalidate();
    return this.info(ds);
  }

  remove(id: number) {
    const i = this.datasets.findIndex((d) => d.id === id);
    if (i >= 0) {
      this.datasets.splice(i, 1);
      this.invalidate();
    }
  }

  clear() {
    this.datasets = [];
    this.invalidate();
    this.tableIds = new Uint32Array(0);
  }

  private invalidate() {
    this.filterCache.clear();
    this.classKey = '';
    this.clusterCache.clear();
  }

  setCoords(id: number, latCol: number, lonCol: number): DatasetInfo {
    const ds = this.get(id);
    this.computeCoords(ds, latCol, lonCol);
    ds.selected.fill(0);
    this.invalidate();
    return this.info(ds);
  }

  private computeCoords(ds: Dataset, latCol: number, lonCol: number) {
    ds.opts.latCol = latCol;
    ds.opts.lonCol = lonCol;
    const invalid = [0, 0, 0, 0, 0, 0];
    ds.warnings = [];
    if (ds.badChars) ds.warnings.push(`Some characters could not be read with the ${ds.opts.encoding.toUpperCase()} encoding (shown as �). Go back to Import Files, click ⚙ next to the file and try another encoding, e.g. Windows-1252.`);
    if (ds.raggedRows > 0) ds.warnings.push(`${ds.raggedRows.toLocaleString('en-IN')} rows have a different number of values from the header row. Missing values were left blank and extra values ignored.`);
    if (latCol < 0 || lonCol < 0 || latCol >= ds.cols.length || lonCol >= ds.cols.length || latCol === lonCol) {
      ds.reason.fill(1);
      ds.lat.fill(NaN);
      ds.lon.fill(NaN);
      invalid[1] = ds.rows;
      ds.valid = 0;
      ds.invalid = invalid;
      ds.duplicates = 0;
      ds.warnings.push('Choose two different columns for Latitude and Longitude.');
      return;
    }
    const la = ds.cols[latCol], lo = ds.cols[lonCol];
    const laN = new Float64Array(la.dict.length), loN = new Float64Array(lo.dict.length);
    const laE = new Uint8Array(la.dict.length), loE = new Uint8Array(lo.dict.length);
    for (let k = 0; k < la.dict.length; k++) { laN[k] = parseCoord(la.dict[k]); laE[k] = la.dict[k].trim() === '' ? 1 : 0; }
    for (let k = 0; k < lo.dict.length; k++) { loN[k] = parseCoord(lo.dict[k]); loE[k] = lo.dict[k].trim() === '' ? 1 : 0; }
    let valid = 0, swapFixable = 0, projected = 0;
    for (let r = 0; r < ds.rows; r++) {
      const a = la.codes[r], o = lo.codes[r];
      const lat = laN[a], lon = loN[o];
      ds.lat[r] = lat;
      ds.lon[r] = lon;
      let reason = 0;
      if (laE[a] || loE[o]) reason = 1;
      else if (Number.isNaN(lat) || Number.isNaN(lon)) reason = 2;
      else if (lat < -90 || lat > 90) reason = 3;
      else if (lon < -180 || lon > 180) reason = 4;
      else if (lat === 0 && lon === 0) reason = 5;
      ds.reason[r] = reason;
      invalid[reason]++;
      if (reason === 0) valid++;
      else if (reason === 3 && Math.abs(lon) <= 90 && Math.abs(lat) <= 180) swapFixable++;
      if ((reason === 3 || reason === 4) && (Math.abs(lat) > 1000 || Math.abs(lon) > 1000)) projected++;
    }
    invalid[0] = 0;
    ds.valid = valid;
    ds.invalid = invalid;

    const latName = la.name.toLowerCase(), lonName = lo.name.toLowerCase();
    if (/(lon|lng|long)/.test(latName) && !/lat/.test(latName) || /lat/.test(lonName) && !/(lon|lng)/.test(lonName)) {
      ds.warnings.push('The column names suggest Latitude and Longitude may be the wrong way round.');
    }
    if (swapFixable > ds.rows * 0.2) {
      ds.warnings.push(`${swapFixable.toLocaleString('en-IN')} rows have a latitude above 90 that would be valid as a longitude. The columns are probably swapped — use “Swap”.`);
    }
    if (projected > ds.rows * 0.2) {
      ds.warnings.push('Many values are far larger than 180. These look like projected coordinates (for example UTM metres), not WGS84 decimal degrees. Convert them to latitude/longitude in decimal degrees before mapping.');
    }
    const sampleBad = [...la.dict.slice(0, 2000), ...lo.dict.slice(0, 2000)];
    if (sampleBad.some((v) => /[°º'′"″]|\d\s*[NSEW]\s*$/i.test(v))) {
      ds.warnings.push('Some values look like degrees-minutes-seconds (e.g. 25°36′N). Only decimal degrees (e.g. 25.6012) can be plotted.');
    }
    if (invalid[2] > 0 && sampleBad.some((v) => /^-?\d+,\d+$/.test(v.trim()))) {
      ds.warnings.push('Some values use a decimal comma (e.g. 25,6012). Use a decimal point instead.');
    }
    if (invalid[5] > 0) ds.warnings.push(`${invalid[5].toLocaleString('en-IN')} rows have 0, 0 coordinates, which usually means “unknown”. They are not plotted.`);

    // individually swapped rows: a point whose (lon, lat) sits where most of the data's (lat, lon) is
    ds.suspect.fill(0);
    ds.suspectCount = 0;
    if (valid > 20) {
      const step = Math.max(1, Math.floor(valid / 20000));
      const ys: number[] = [], xs: number[] = [];
      for (let r = 0, k = 0; r < ds.rows; r++) if (ds.reason[r] === 0 && k++ % step === 0) { ys.push(ds.lat[r]); xs.push(ds.lon[r]); }
      ys.sort((a, b) => a - b); xs.sort((a, b) => a - b);
      const my = ys[ys.length >> 1], mx = xs[xs.length >> 1];
      if (Math.abs(my - mx) > 5) {
        for (let r = 0; r < ds.rows; r++) {
          if (ds.reason[r] !== 0) continue;
          if (Math.abs(ds.lat[r] - mx) < 3 && Math.abs(ds.lon[r] - my) < 3) { ds.suspect[r] = 1; ds.suspectCount++; }
        }
      }
      if (ds.suspectCount > 0) {
        ds.warnings.push(`${ds.suspectCount.toLocaleString('en-IN')} rows look like their latitude and longitude were entered the wrong way round (they would sit with the rest of the data if swapped). They are still plotted as given; download the problem records to check them.`);
      }
    }

    // duplicates at ~1 m (5 decimals): sort compact keys and count runs
    const keys = new Float64Array(valid);
    let p = 0;
    for (let r = 0; r < ds.rows; r++) {
      if (ds.reason[r] === 0) keys[p++] = (Math.round(ds.lat[r] * 1e5) + 9e6) * 3.7e7 + (Math.round(ds.lon[r] * 1e5) + 1.8e7);
    }
    keys.sort();
    let dup = 0;
    for (let i = 1; i < keys.length; i++) {
      if (keys[i] === keys[i - 1]) dup += i >= 2 && keys[i - 1] === keys[i - 2] ? 1 : 2;
    }
    ds.duplicates = dup;
  }

  get(id: number): Dataset {
    const d = this.datasets.find((x) => x.id === id);
    if (!d) throw new Error('Dataset not found');
    return d;
  }

  info(ds: Dataset): DatasetInfo {
    return {
      id: ds.id, name: ds.name, size: ds.size, rows: ds.rows,
      columns: ds.cols.map((c) => c.info),
      encoding: ds.opts.encoding, delimiter: ds.opts.delimiter, hasHeader: ds.opts.hasHeader,
      latCol: ds.opts.latCol, lonCol: ds.opts.lonCol, valid: ds.valid, invalid: ds.invalid,
      duplicates: ds.duplicates, suspect: ds.suspectCount, warnings: ds.warnings, raggedRows: ds.raggedRows, loadMs: ds.loadMs,
    };
  }

  fields(): FieldInfo[] {
    const map = new Map<string, FieldInfo>();
    for (const ds of this.datasets) {
      for (const c of ds.cols) {
        const f = map.get(c.name);
        if (!f) map.set(c.name, { name: c.name, type: c.info.type, datasets: [ds.id], distinct: c.info.distinct });
        else {
          f.datasets.push(ds.id);
          f.distinct = Math.max(f.distinct, c.info.distinct);
          if (f.type !== c.info.type) {
            // mixed types across files: fall back to the most general
            const order: ColType[] = ['number', 'date', 'category', 'text'];
            f.type = order[Math.max(order.indexOf(f.type), order.indexOf(c.info.type))];
            if (f.type === 'date' && (c.info.type === 'number')) f.type = 'category';
          }
        }
      }
    }
    return [...map.values()];
  }

  /** Records whose coordinates are invalid, with a Problem column. */
  invalidCsv(id: number, reasons: readonly string[]): Blob {
    const ds = this.get(id);
    const parts: string[] = [];
    let buf: string[] = ['﻿' + [...ds.cols.map((c) => c.name), 'Problem'].map(csvEscape).join(',')];
    for (let r = 0; r < ds.rows; r++) {
      if (ds.reason[r] === 0 && !ds.suspect[r]) continue;
      const problem = ds.reason[r] === 0 ? 'Possibly swapped latitude/longitude (plotted as given)' : reasons[ds.reason[r]];
      const line = ds.cols.map((c) => csvEscape(c.dict[c.codes[r]])).join(',') + ',' + csvEscape(problem);
      buf.push(line);
      if (buf.length >= 5000) { parts.push(buf.join('\r\n') + '\r\n'); buf = []; }
    }
    if (buf.length) parts.push(buf.join('\r\n') + '\r\n');
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
  }

  // ------------------------------------------------------------ distinct values
  /** Distinct values (or combined values) of fields across valid records, by count. */
  distinctCombos(fields: string[], limit = 200): { value: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const ds of this.datasets) {
      const cols = fields.map((f) => ds.colIndex.get(f));
      if (fields.length === 1) {
        const ci = cols[0];
        if (ci === undefined) { counts.set('', (counts.get('') || 0) + ds.valid); continue; }
        const c = ds.cols[ci];
        const per = new Uint32Array(c.dict.length);
        for (let r = 0; r < ds.rows; r++) if (ds.reason[r] === 0) per[c.codes[r]]++;
        for (let k = 0; k < per.length; k++) if (per[k]) { const v = c.dict[k].trim(); counts.set(v, (counts.get(v) || 0) + per[k]); }
      } else {
        for (let r = 0; r < ds.rows; r++) {
          if (ds.reason[r] !== 0) continue;
          const key = cols.map((ci) => (ci === undefined ? '' : ds.cols[ci].dict[ds.cols[ci].codes[r]].trim())).join(' | ');
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
    return [...counts.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /** Values for a category filter, counted with all OTHER filters applied (cascading). */
  filterValues(cfg: ViewConfig, filterId: string | null, field: string, scope: 'all' | number, query: string, limit = 300): { values: { value: string; count: number }[]; distinct: number } {
    const q = query.trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const ds of this.datasets) {
      if (scope !== 'all' && ds.id !== scope) continue;
      const ci = ds.colIndex.get(field);
      if (ci === undefined) continue;
      const c = ds.cols[ci];
      const arrays = this.passArrays(ds, cfg, filterId);
      if (arrays === null) continue;
      const hidden = this.hiddenMask(cfg);
      const per = new Uint32Array(c.dict.length);
      const sel = cfg.selectedOnly ? ds.selected : null;
      outer: for (let r = 0; r < ds.rows; r++) {
        if (ds.reason[r] !== 0) continue;
        for (let a = 0; a < arrays.length; a++) if (!arrays[a][r]) continue outer;
        if (sel && !sel[r]) continue;
        if (hidden && hidden[ds.cls[r]]) continue;
        per[c.codes[r]]++;
      }
      for (let k = 0; k < per.length; k++) {
        if (!per[k]) continue;
        const v = c.dict[k].trim();
        counts.set(v, (counts.get(v) || 0) + per[k]);
      }
    }
    let list = [...counts.entries()].map(([value, count]) => ({ value, count }));
    const distinct = list.length;
    if (q) list = list.filter((x) => x.value.toLowerCase().includes(q));
    list.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return { values: list.slice(0, limit), distinct };
  }

  // ------------------------------------------------------------ filters
  private filterApplies(f: Filter, ds: Dataset) {
    return f.scope === 'all' || f.scope === ds.id;
  }

  private filterArray(ds: Dataset, f: Filter, dayFirst: boolean): Uint8Array {
    const { id: _ignore, ...rest } = f;
    void _ignore;
    const key = `${ds.id}|${dayFirst}|${JSON.stringify(rest)}`;
    const hit = this.filterCache.get(key);
    if (hit) return hit;
    const out = new Uint8Array(ds.rows);
    const ci = ds.colIndex.get(f.field);
    if (ci !== undefined) {
      const c = ds.cols[ci];
      const ok = new Uint8Array(c.dict.length);
      if (f.kind === 'category') {
        const set = new Set(f.values);
        for (let k = 0; k < c.dict.length; k++) ok[k] = set.has(c.dict[k].trim()) ? 1 : 0;
      } else if (f.kind === 'range') {
        const num = numOf(c);
        const lo = f.min ?? -Infinity, hi = f.max ?? Infinity;
        for (let k = 0; k < num.length; k++) ok[k] = num[k] >= lo && num[k] <= hi ? 1 : 0;
      } else if (f.kind === 'date') {
        const d = dateOf(c, dayFirst);
        const lo = dateInputToMs(f.from) ?? -Infinity, hi = dateInputToMs(f.to, true) ?? Infinity;
        for (let k = 0; k < d.length; k++) ok[k] = d[k] >= lo && d[k] <= hi ? 1 : 0;
      } else {
        const q = f.query.trim().toLowerCase();
        const low = lowerOf(c);
        for (let k = 0; k < low.length; k++) ok[k] = !q || low[k].includes(q) ? 1 : 0;
      }
      const codes = c.codes;
      for (let r = 0; r < ds.rows; r++) out[r] = ok[codes[r]];
    }
    this.filterCache.set(key, out);
    return out;
  }

  private searchArray(ds: Dataset, query: string): Uint8Array {
    const q = query.trim().toLowerCase();
    const key = `${ds.id}|search|${q}`;
    const hit = this.filterCache.get(key);
    if (hit) return hit;
    const out = new Uint8Array(ds.rows);
    for (const c of ds.cols) {
      const low = lowerOf(c);
      const ok = new Uint8Array(low.length);
      let any = false;
      for (let k = 0; k < low.length; k++) if (low[k].includes(q)) { ok[k] = 1; any = true; }
      if (!any) continue;
      const codes = c.codes;
      for (let r = 0; r < ds.rows; r++) if (ok[codes[r]]) out[r] = 1;
    }
    this.filterCache.set(key, out);
    return out;
  }

  /** Pass arrays for a dataset (excluding one filter). null = dataset excluded entirely. */
  private passArrays(ds: Dataset, cfg: ViewConfig, excludeFilterId: string | null): Uint8Array[] | null {
    if (cfg.sourceFiles && !cfg.sourceFiles.includes(ds.id)) return null;
    const arrays: Uint8Array[] = [];
    for (const f of cfg.filters) {
      if (f.id === excludeFilterId || !this.filterApplies(f, ds) || !isActive(f)) continue;
      arrays.push(this.filterArray(ds, f, cfg.dateDayFirst));
    }
    if (cfg.search.trim()) arrays.push(this.searchArray(ds, cfg.search));
    return arrays;
  }

  private hiddenMask(cfg: ViewConfig): Uint8Array | null {
    if (!cfg.hiddenClasses.length) return null;
    const m = new Uint8Array(65536);
    for (const c of cfg.hiddenClasses) m[c] = 1;
    return m;
  }

  // ------------------------------------------------------------ colouring
  private computeClasses(cfg: ViewConfig) {
    const scheme = cfg.color;
    const key = JSON.stringify(scheme) + (scheme.mode === 'dataset' ? JSON.stringify(cfg.datasetColors) + this.datasets.map((d) => d.id).join(',') : '');
    if (key === this.classKey) return;
    this.classKey = key;
    const legend: { label: string; color: string }[] = [];
    if (scheme.mode === 'dataset') {
      this.datasets.forEach((ds, i) => {
        legend.push({ label: ds.name, color: cfg.datasetColors[ds.id] || DATASET_PALETTE[i % DATASET_PALETTE.length] });
        ds.cls.fill(i);
      });
    } else if (scheme.mode === 'category') {
      const G = scheme.groups.length;
      scheme.groups.forEach((g, i) => legend.push({ label: g.label, color: g.color || CATEGORY_PALETTE[i % CATEGORY_PALETTE.length] }));
      legend.push({ label: 'Others', color: scheme.othersColor || OTHERS_COLOR });
      const valueToGroup = new Map<string, number>();
      scheme.groups.forEach((g, i) => g.values.forEach((v) => { if (!valueToGroup.has(v)) valueToGroup.set(v, i); }));
      for (const ds of this.datasets) {
        const cols = scheme.fields.map((f) => ds.colIndex.get(f));
        if (cols.length === 1) {
          const ci = cols[0];
          if (ci === undefined) {
            const g = valueToGroup.get('');
            ds.cls.fill(g ?? G);
            continue;
          }
          const c = ds.cols[ci];
          const map = new Uint16Array(c.dict.length);
          for (let k = 0; k < c.dict.length; k++) map[k] = valueToGroup.get(c.dict[k].trim()) ?? G;
          for (let r = 0; r < ds.rows; r++) ds.cls[r] = map[c.codes[r]];
        } else {
          const cache = new Map<string, number>();
          for (let r = 0; r < ds.rows; r++) {
            const k = cols.map((ci) => (ci === undefined ? '' : ds.cols[ci].dict[ds.cols[ci].codes[r]].trim())).join(' | ');
            let g = cache.get(k);
            if (g === undefined) { g = valueToGroup.get(k) ?? G; cache.set(k, g); }
            ds.cls[r] = g;
          }
        }
      }
    } else {
      const bins = scheme.bins;
      const B = bins.length;
      bins.forEach((b) => legend.push({ label: b.label, color: b.color }));
      legend.push({ label: 'No value', color: scheme.noValueColor || OTHERS_COLOR });
      for (const ds of this.datasets) {
        const ci = ds.colIndex.get(scheme.field);
        if (ci === undefined) { ds.cls.fill(B); continue; }
        const c = ds.cols[ci];
        const num = numOf(c);
        const map = new Uint16Array(c.dict.length);
        for (let k = 0; k < num.length; k++) {
          const x = num[k];
          let cls = B;
          if (!Number.isNaN(x)) {
            for (let b = 0; b < B; b++) {
              const lo = bins[b].min ?? -Infinity, hi = bins[b].max ?? Infinity;
              if (x >= lo && x <= hi) { cls = b; break; }
            }
          }
          map[k] = cls;
        }
        for (let r = 0; r < ds.rows; r++) ds.cls[r] = map[c.codes[r]];
      }
    }
    this.legendBase = legend;
    this.classColors = legend.map((l) => hexToRgb(l.color));
  }

  // ------------------------------------------------------------ view
  applyView(cfg: ViewConfig): ViewResult {
    this.lastConfig = cfg;
    this.computeClasses(cfg);
    this.clusterCache.clear();
    // prune caches for filters no longer used
    if (this.filterCache.size > 64) this.filterCache.clear();
    const hidden = this.hiddenMask(cfg);
    const legendCounts = new Float64Array(this.legendBase.length + 1);
    let filtered = 0, totalValid = 0, selectedCount = 0;
    const perDataset: ViewResult['perDataset'] = [];
    let renderable = 0;
    for (const ds of this.datasets) {
      totalValid += ds.valid;
      const arrays = this.passArrays(ds, cfg, null);
      const pass = ds.pass;
      let n = 0;
      const sel = ds.selected;
      if (arrays === null) {
        pass.fill(0);
      } else {
        const na = arrays.length;
        const cls = ds.cls, reason = ds.reason;
        for (let r = 0; r < ds.rows; r++) {
          let ok = reason[r] === 0;
          if (ok) for (let a = 0; a < na; a++) if (!arrays[a][r]) { ok = false; break; }
          if (ok && cfg.selectedOnly && !sel[r]) ok = false;
          if (ok) {
            legendCounts[cls[r]]++;
            if (hidden && hidden[cls[r]]) ok = false;
          }
          pass[r] = ok ? 1 : 0;
          if (ok) n++;
        }
      }
      for (let r = 0; r < ds.rows; r++) selectedCount += sel[r];
      filtered += n;
      if (!cfg.hiddenDatasets.includes(ds.id)) renderable += n;
      perDataset.push({ id: ds.id, filtered: n, valid: ds.valid, rows: ds.rows });
    }

    const sampled = renderable > cfg.maxPoints;
    const take = sampled ? cfg.maxPoints : renderable;
    const positions = new Float64Array(take * 2);
    const colors = new Uint8Array(take * 4);
    const ids = new Uint32Array(take);
    let p = 0;
    let acc = 0;
    const step = sampled ? renderable / cfg.maxPoints : 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ds of this.datasets) {
      if (cfg.hiddenDatasets.includes(ds.id)) continue;
      const { pass, lat, lon, cls } = ds;
      for (let r = 0; r < ds.rows && p < take; r++) {
        if (!pass[r]) continue;
        if (sampled) {
          acc += 1;
          if (acc < step) continue;
          acc -= step;
        }
        const x = lon[r], y = lat[r];
        positions[p * 2] = x;
        positions[p * 2 + 1] = y;
        const col = this.classColors[cls[r]] || [150, 150, 150];
        colors[p * 4] = col[0];
        colors[p * 4 + 1] = col[1];
        colors[p * 4 + 2] = col[2];
        colors[p * 4 + 3] = 255;
        ids[p] = ds.offset + r;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        p++;
      }
    }
    this.renderPositions = positions;
    this.renderIds = ids;
    this.renderColors = colors;
    this.version++;
    const bbox = p ? robustBBox(positions, p, [minX, minY, maxX, maxY]) : null;
    const legend: LegendEntry[] = this.legendBase.map((l, i) => ({ cls: i, label: l.label, color: l.color, count: legendCounts[i] }));
    return {
      version: this.version, filteredCount: filtered, totalValid, perDataset, legend,
      renderCount: p, sampled,
      bbox,
      positions, colors, ids, selectedCount,
    };
  }

  /** Grid clustering of the rendered points in Web-Mercator pixel space. */
  clusters(zoom: number, cellPx = 70): ClusterResult {
    const z = Math.max(0, Math.min(22, Math.floor(zoom)));
    const hit = this.clusterCache.get(z);
    if (hit) return hit;
    const W = 512 * Math.pow(2, z);
    const cells = W / cellPx;
    const pos = this.renderPositions;
    const n = this.renderIds.length;
    const index = new Map<number, number>();
    let sx: number[] = [], sy: number[] = [], cnt: number[] = [], first: number[] = [], firstIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      const lon = pos[i * 2], lat = pos[i * 2 + 1];
      const x = (lon + 180) / 360;
      const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
      const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
      const key = cx * 1e8 + cy;
      let c = index.get(key);
      if (c === undefined) {
        c = cnt.length;
        index.set(key, c);
        sx.push(0); sy.push(0); cnt.push(0); first.push(this.renderIds[i]); firstIdx.push(i);
      }
      sx[c] += lon; sy[c] += lat; cnt[c]++;
    }
    const m = cnt.length;
    const positions = new Float64Array(m * 2);
    const counts = new Uint32Array(m);
    const ids = new Uint32Array(m);
    const colors = new Uint8Array(m * 4);
    const rc = this.renderColors;
    for (let c = 0; c < m; c++) {
      positions[c * 2] = sx[c] / cnt[c];
      positions[c * 2 + 1] = sy[c] / cnt[c];
      counts[c] = cnt[c];
      ids[c] = first[c];
      const k = firstIdx[c] * 4;
      if (cnt[c] === 1) { colors[c * 4] = rc[k]; colors[c * 4 + 1] = rc[k + 1]; colors[c * 4 + 2] = rc[k + 2]; colors[c * 4 + 3] = 255; }
      else { colors[c * 4] = 106; colors[c * 4 + 1] = 168; colors[c * 4 + 2] = 130; colors[c * 4 + 3] = 215; }
    }
    sx = sy = cnt = first = firstIdx = [];
    const res = { positions, counts, ids, colors, radiusPx: cellPx };
    this.clusterCache.set(z, res);
    return res;
  }

  // ------------------------------------------------------------ records
  locate(id: number): { ds: Dataset; row: number } | null {
    for (const ds of this.datasets) if (id >= ds.offset && id < ds.offset + ds.rows) return { ds, row: id - ds.offset };
    return null;
  }

  record(id: number): RecordDetail | null {
    const l = this.locate(id);
    if (!l) return null;
    const { ds, row } = l;
    const la = ds.cols[ds.opts.latCol], lo = ds.cols[ds.opts.lonCol];
    return {
      id, datasetId: ds.id, datasetName: ds.name, row: row + 1,
      fields: ds.cols.map((c) => [c.name, c.dict[c.codes[row]]]),
      lat: ds.lat[row], lon: ds.lon[row],
      latRaw: la ? la.dict[la.codes[row]] : '', lonRaw: lo ? lo.dict[lo.codes[row]] : '',
      latName: la?.name || '', lonName: lo?.name || '',
      selected: !!ds.selected[row],
    };
  }

  tooltip(id: number, fields: string[]): { title: string; rows: [string, string][] } | null {
    const l = this.locate(id);
    if (!l) return null;
    const { ds, row } = l;
    const rows: [string, string][] = [];
    for (const f of fields) {
      const ci = ds.colIndex.get(f);
      if (ci !== undefined) rows.push([f, ds.cols[ci].dict[ds.cols[ci].codes[row]]]);
    }
    return { title: ds.name, rows };
  }

  /** Map search: distinct matching values of a field among filtered records, with extents. */
  searchValues(field: string, query: string, limit = 20) {
    const q = query.trim().toLowerCase();
    const out = new Map<string, { value: string; count: number; bbox: [number, number, number, number]; firstId: number }>();
    if (!q) return [];
    for (const ds of this.datasets) {
      const fieldsToScan = field ? [ds.colIndex.get(field)] : ds.cols.map((_, i) => i);
      for (const ci of fieldsToScan) {
        if (ci === undefined) continue;
        const c = ds.cols[ci];
        const low = lowerOf(c);
        const match = new Int32Array(low.length).fill(-1);
        let any = false;
        for (let k = 0; k < low.length; k++) if (low[k].includes(q)) { match[k] = 1; any = true; }
        if (!any) continue;
        for (let r = 0; r < ds.rows; r++) {
          if (!ds.pass[r]) continue;
          const code = c.codes[r];
          if (match[code] < 0) continue;
          const v = field ? c.dict[code].trim() : `${c.name}: ${c.dict[code].trim()}`;
          let e = out.get(v);
          if (!e) {
            if (out.size >= 2000) continue;
            e = { value: v, count: 0, bbox: [Infinity, Infinity, -Infinity, -Infinity], firstId: ds.offset + r };
            out.set(v, e);
          }
          e.count++;
          const x = ds.lon[r], y = ds.lat[r];
          if (x < e.bbox[0]) e.bbox[0] = x;
          if (y < e.bbox[1]) e.bbox[1] = y;
          if (x > e.bbox[2]) e.bbox[2] = x;
          if (y > e.bbox[3]) e.bbox[3] = y;
        }
      }
    }
    return [...out.values()]
      .sort((a, b) => {
        // exact match first, then values starting with the text, then the rest (by count)
        const rank = (v: string) => {
          const t = field ? v.toLowerCase() : v.toLowerCase().slice(v.indexOf(': ') + 2);
          return t === q ? 0 : t.startsWith(q) ? 1 : 2;
        };
        const ea = rank(a.value), eb = rank(b.value);
        return ea - eb || b.count - a.count;
      })
      .slice(0, limit);
  }

  // ------------------------------------------------------------ selection
  select(op: { kind: 'ids'; ids: number[]; mode: 'add' | 'remove' | 'toggle' } | { kind: 'filtered' } | { kind: 'bbox'; bbox: [number, number, number, number]; hiddenDatasets: number[] } | { kind: 'clear' } | { kind: 'table' }): number {
    if (op.kind === 'clear') for (const ds of this.datasets) ds.selected.fill(0);
    else if (op.kind === 'ids') {
      for (const id of op.ids) {
        const l = this.locate(id);
        if (!l) continue;
        const s = l.ds.selected;
        s[l.row] = op.mode === 'add' ? 1 : op.mode === 'remove' ? 0 : s[l.row] ? 0 : 1;
      }
    } else if (op.kind === 'filtered') {
      for (const ds of this.datasets) for (let r = 0; r < ds.rows; r++) if (ds.pass[r]) ds.selected[r] = 1;
    } else if (op.kind === 'table') {
      for (const id of this.tableIds) { const l = this.locate(id); if (l) l.ds.selected[l.row] = 1; }
    } else {
      const [x0, y0, x1, y1] = op.bbox;
      for (const ds of this.datasets) {
        if (op.hiddenDatasets.includes(ds.id)) continue;
        for (let r = 0; r < ds.rows; r++) {
          if (!ds.pass[r]) continue;
          const x = ds.lon[r], y = ds.lat[r];
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) ds.selected[r] = 1;
        }
      }
    }
    return this.selectedCount();
  }

  selectedCount(): number {
    let n = 0;
    for (const ds of this.datasets) for (let r = 0; r < ds.rows; r++) n += ds.selected[r];
    return n;
  }

  selectedPositions(cap = 200000): { positions: Float64Array; ids: Uint32Array } {
    const pos: number[] = [];
    const ids: number[] = [];
    for (const ds of this.datasets) {
      for (let r = 0; r < ds.rows && ids.length < cap; r++) {
        if (ds.selected[r] && ds.reason[r] === 0) { pos.push(ds.lon[r], ds.lat[r]); ids.push(ds.offset + r); }
      }
    }
    return { positions: Float64Array.from(pos), ids: Uint32Array.from(ids) };
  }

  // ------------------------------------------------------------ table
  tableQuery(search: string, sortField: string, sortDir: 1 | -1): number {
    const q = search.trim().toLowerCase();
    const list: number[] = [];
    for (const ds of this.datasets) {
      const s = q ? this.searchArray(ds, q) : null;
      for (let r = 0; r < ds.rows; r++) if (ds.pass[r] && (!s || s[r])) list.push(ds.offset + r);
    }
    let ids = Uint32Array.from(list);
    if (sortField) {
      const keys = new Float64Array(ids.length);
      const isNum = sortField === '__source__' ? false : this.fields().find((f) => f.name === sortField)?.type === 'number';
      const isDate = !isNum && this.fields().find((f) => f.name === sortField)?.type === 'date';
      let rank: Map<string, number> | null = null;
      if (!isNum && !isDate) {
        const all = new Set<string>();
        for (const ds of this.datasets) {
          if (sortField === '__source__') { all.add(ds.name); continue; }
          const ci = ds.colIndex.get(sortField);
          if (ci !== undefined) for (const v of ds.cols[ci].dict) all.add(v);
        }
        const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const sorted = [...all].sort(coll.compare);
        rank = new Map(sorted.map((v, i) => [v, i]));
      }
      let i = 0;
      for (const ds of this.datasets) {
        const ci = ds.colIndex.get(sortField);
        const c = ci === undefined ? null : ds.cols[ci];
        const num = c && isNum ? numOf(c) : null;
        const dt = c && isDate ? dateOf(c, this.lastConfig?.dateDayFirst ?? true) : null;
        const rk = c && rank ? Float64Array.from(c.dict, (v) => rank!.get(v)!) : null;
        const srcRank = sortField === '__source__' ? rank!.get(ds.name)! : 0;
        while (i < ids.length && ids[i] < ds.offset + ds.rows && ids[i] >= ds.offset) {
          const r = ids[i] - ds.offset;
          let k: number;
          if (sortField === '__source__') k = srcRank;
          else if (!c) k = NaN;
          else if (num) k = num[c.codes[r]];
          else if (dt) k = dt[c.codes[r]];
          else k = rk![c.codes[r]];
          keys[i] = k;
          i++;
        }
      }
      const idx = new Uint32Array(ids.length);
      for (let j = 0; j < idx.length; j++) idx[j] = j;
      idx.sort((a, b) => {
        const ka = keys[a], kb = keys[b];
        const na = Number.isNaN(ka), nb = Number.isNaN(kb);
        if (na || nb) return na === nb ? a - b : na ? 1 : -1; // blanks last
        return ka === kb ? a - b : (ka < kb ? -1 : 1) * sortDir;
      });
      const sortedIds = new Uint32Array(ids.length);
      for (let j = 0; j < idx.length; j++) sortedIds[j] = ids[idx[j]];
      ids = sortedIds;
    }
    this.tableIds = ids;
    return ids.length;
  }

  tableRows(start: number, count: number, columns: string[]) {
    const out: { id: number; source: string; selected: boolean; values: string[] }[] = [];
    const end = Math.min(this.tableIds.length, start + count);
    for (let i = start; i < end; i++) {
      const id = this.tableIds[i];
      const l = this.locate(id);
      if (!l) continue;
      const { ds, row } = l;
      out.push({
        id, source: ds.name, selected: !!ds.selected[row],
        values: columns.map((f) => {
          const ci = ds.colIndex.get(f);
          return ci === undefined ? '' : ds.cols[ci].dict[ds.cols[ci].codes[row]];
        }),
      });
    }
    return out;
  }

  tableIndexOf(id: number): number {
    const t = this.tableIds;
    for (let i = 0; i < t.length; i++) if (t[i] === id) return i;
    return -1;
  }

  /** Iterate (dataset,row) pairs for an export scope. */
  *iterate(datasetIds: number[], scope: 'all' | 'filtered' | 'selected', includeInvalid: boolean): Generator<[Dataset, number]> {
    for (const ds of this.datasets) {
      if (!datasetIds.includes(ds.id)) continue;
      for (let r = 0; r < ds.rows; r++) {
        if (scope === 'filtered' && !ds.pass[r]) continue;
        if (scope === 'selected' && !ds.selected[r]) continue;
        if (scope === 'all' && !includeInvalid && ds.reason[r] !== 0) continue;
        yield [ds, r];
      }
    }
  }

  classColorHex(): string[] {
    return this.legendBase.map((l) => l.color);
  }
}

/** Extent of the points, ignoring far-away outliers (beyond the 1–99% range plus a margin) so a few stray coordinates don't zoom the map out to the world. */
function robustBBox(pos: Float64Array, n: number, full: [number, number, number, number]): [number, number, number, number] {
  if (n < 500) return full;
  const step = Math.max(1, Math.floor(n / 50000));
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i += step) { xs.push(pos[i * 2]); ys.push(pos[i * 2 + 1]); }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
  const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99);
  const px = Math.max((x1 - x0) * 0.25, 0.01), py = Math.max((y1 - y0) * 0.25, 0.01);
  return [Math.max(full[0], x0 - px), Math.max(full[1], y0 - py), Math.min(full[2], x1 + px), Math.min(full[3], y1 + py)];
}

export function isActive(f: Filter): boolean {
  switch (f.kind) {
    case 'category': return f.values.length > 0;
    case 'range': return f.min !== null || f.max !== null;
    case 'date': return !!f.from || !!f.to;
    case 'text': return f.query.trim().length > 0;
  }
}

export function csvEscape(v: string): string {
  if (v === undefined || v === null) return '';
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
