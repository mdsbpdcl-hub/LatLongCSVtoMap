// Streaming CSV / KML / KMZ writers. Output is written in ~1 MB pieces to a sink, never as one huge string.

import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import { csvEscape, type DataStore, type Dataset } from './store';
import type { CsvExportOptions, ExportEstimate, KmlExportOptions } from '../lib/types';

export interface Sink {
  write(chunk: string | Uint8Array): Promise<void>;
  close(): Promise<Blob | null>;
}

export class BlobSink implements Sink {
  private parts: BlobPart[] = [];
  constructor(private type: string) {}
  async write(chunk: string | Uint8Array) { this.parts.push(chunk as BlobPart); }
  async close() {
    const b = new Blob(this.parts, { type: this.type });
    this.parts = [];
    return b;
  }
}

/** Writes straight to a file chosen with the browser's Save dialog (Chrome / Edge). */
export class FileSink implements Sink {
  private enc = new TextEncoder();
  constructor(private w: FileSystemWritableFileStream) {}
  async write(chunk: string | Uint8Array) {
    await this.w.write((typeof chunk === 'string' ? this.enc.encode(chunk) : chunk) as BufferSource);
  }
  async close() { await this.w.close(); return null; }
}

/** Streams ZIP entries into an outer sink. */
export class ZipWriter {
  private zip: Zip;
  private queue: Uint8Array[] = [];
  private err: Error | null = null;
  constructor(private out: Sink) {
    this.zip = new Zip((err, data) => {
      if (err) this.err = err;
      else this.queue.push(data);
    });
  }
  private async flush() {
    if (this.err) throw this.err;
    while (this.queue.length) await this.out.write(this.queue.shift()!);
  }
  async file(name: string, write: (put: (s: string) => Promise<void>) => Promise<void>, compress = true) {
    const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    this.zip.add(entry);
    await write(async (s: string) => {
      entry.push(strToU8(s));
      await this.flush();
    });
    entry.push(new Uint8Array(0), true);
    await this.flush();
  }
  async end() {
    this.zip.end();
    await this.flush();
    return this.out.close();
  }
}

/** Buffers small strings and hands ~1 MB chunks to an async writer. */
class Chunker {
  private buf: string[] = [];
  private len = 0;
  constructor(private put: (s: string) => Promise<void>) {}
  async add(s: string) {
    this.buf.push(s);
    this.len += s.length;
    if (this.len > 1_000_000) await this.flush();
  }
  async flush() {
    if (!this.buf.length) return;
    const s = this.buf.join('');
    this.buf = [];
    this.len = 0;
    await this.put(s);
  }
}

type Progress = (done: number, total: number) => void;

/** Let the worker receive messages (e.g. Cancel) during long synchronous loops. */
const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ CSV
function csvHeader(opts: CsvExportOptions): string[] {
  const h = [...opts.columns];
  if (opts.includeLatLon) {
    h.push(opts.columns.includes('Latitude') ? 'Latitude (WGS84)' : 'Latitude');
    h.push(opts.columns.includes('Longitude') ? 'Longitude (WGS84)' : 'Longitude');
  }
  if (opts.includeSource) h.push(opts.columns.includes('Source File') ? 'Source File (app)' : 'Source File');
  return h;
}

function csvLineMaker(opts: CsvExportOptions) {
  const cache = new Map<number, (number | undefined)[]>();
  return (ds: Dataset, r: number): string => {
    let idx = cache.get(ds.id);
    if (!idx) { idx = opts.columns.map((f) => ds.colIndex.get(f)); cache.set(ds.id, idx); }
    const vals: string[] = idx.map((ci) => (ci === undefined ? '' : csvEscape(ds.cols[ci].dict[ds.cols[ci].codes[r]])));
    if (opts.includeLatLon) {
      const la = ds.cols[ds.opts.latCol], lo = ds.cols[ds.opts.lonCol];
      vals.push(la ? csvEscape(la.dict[la.codes[r]].trim()) : '', lo ? csvEscape(lo.dict[lo.codes[r]].trim()) : '');
    }
    if (opts.includeSource) vals.push(csvEscape(ds.name));
    return vals.join(',');
  };
}

export async function exportCsv(store: DataStore, opts: CsvExportOptions, sink: Sink, progress: Progress, isCancelled: () => boolean) {
  const total = estimateCount(store, opts.datasets, opts.scope, opts.includeInvalid);
  const ch = new Chunker((s) => sink.write(s));
  await ch.add('﻿' + csvHeader(opts).map(csvEscape).join(',') + '\r\n');
  const line = csvLineMaker(opts);
  let n = 0;
  for (const [ds, r] of store.iterate(opts.datasets, opts.scope, opts.includeInvalid)) {
    await ch.add(line(ds, r) + '\r\n');
    if (++n % 50000 === 0) {
      await yieldToEvents();
      if (isCancelled()) throw new Error('cancelled');
      progress(n, total);
    }
  }
  await ch.flush();
  progress(n, total);
  return { blob: await sink.close(), count: n };
}

export function estimateCount(store: DataStore, datasets: number[], scope: 'all' | 'filtered' | 'selected', includeInvalid: boolean): number {
  let n = 0;
  for (const ds of store.datasets) {
    if (!datasets.includes(ds.id)) continue;
    if (scope === 'all') { n += includeInvalid ? ds.rows : ds.valid; continue; }
    const a = scope === 'filtered' ? ds.pass : ds.selected;
    for (let r = 0; r < ds.rows; r++) n += a[r];
  }
  return n;
}

export function estimateCsv(store: DataStore, opts: CsvExportOptions): ExportEstimate {
  const count = estimateCount(store, opts.datasets, opts.scope, opts.includeInvalid);
  const line = csvLineMaker(opts);
  let sample = 0, len = 0;
  for (const [ds, r] of store.iterate(opts.datasets, opts.scope, opts.includeInvalid)) {
    len += new TextEncoder().encode(line(ds, r)).length + 2;
    if (++sample >= 400) break;
  }
  const header = csvHeader(opts).join(',').length + 5;
  return { count, bytes: header + (sample ? (len / sample) * count : 0), skippedInvalid: 0 };
}

// ------------------------------------------------------------------ KML
export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!))
    // remove characters that are not allowed in XML 1.0
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

function kmlColor(hex: string): string {
  const h = hex.replace('#', '').padEnd(6, '0');
  return 'ff' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}

function kmlHead(opts: KmlExportOptions, colors: string[], partLabel: string): string {
  const styles = opts.useColors
    ? colors.map((c, i) => `<Style id="c${i}"><IconStyle><color>${kmlColor(c)}</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>${opts.showLabels ? 0.8 : 0}</scale></LabelStyle></Style>\n`).join('')
    : `<Style id="c0"><IconStyle><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>${opts.showLabels ? 0.8 : 0}</scale></LabelStyle></Style>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>${xmlEscape(opts.docName + partLabel)}</name>\n${styles}`;
}
const KML_TAIL = '</Document>\n</kml>\n';

function placemarkMaker(opts: KmlExportOptions) {
  const cache = new Map<number, { name?: number; desc: (number | undefined)[]; ext: (number | undefined)[] }>();
  return (ds: Dataset, r: number): string => {
    let c = cache.get(ds.id);
    if (!c) {
      c = {
        name: opts.nameField ? ds.colIndex.get(opts.nameField) : undefined,
        desc: opts.descFields.map((f) => ds.colIndex.get(f)),
        ext: opts.extendedFields.map((f) => ds.colIndex.get(f)),
      };
      cache.set(ds.id, c);
    }
    const val = (ci: number | undefined) => (ci === undefined ? '' : ds.cols[ci].dict[ds.cols[ci].codes[r]]);
    const name = c.name !== undefined ? val(c.name) : `Record ${r + 1}`;
    let s = `<Placemark><name>${xmlEscape(name)}</name>`;
    if (opts.descFields.length) {
      let html = '<table>';
      opts.descFields.forEach((f, i) => {
        html += `<tr><td><b>${xmlEscape(f)}</b></td><td>${xmlEscape(val(c!.desc[i]))}</td></tr>`;
      });
      html += '</table>';
      s += `<Snippet maxLines="0"></Snippet><description><![CDATA[${html.replace(/]]>/g, ']]]]><![CDATA[>')}]]></description>`;
    }
    s += `<styleUrl>#c${opts.useColors ? ds.cls[r] : 0}</styleUrl>`;
    if (opts.extendedFields.length) {
      s += '<ExtendedData>';
      opts.extendedFields.forEach((f, i) => {
        s += `<Data name="${xmlEscape(f)}"><value>${xmlEscape(val(c!.ext[i]))}</value></Data>`;
      });
      s += '</ExtendedData>';
    }
    s += `<Point><coordinates>${ds.lon[r]},${ds.lat[r]}</coordinates></Point></Placemark>\n`;
    return s;
  };
}

/** Ordered records for KML with their folder names. Only records with valid coordinates. */
function kmlOrder(store: DataStore, opts: KmlExportOptions): { list: [Dataset, number][] | null; groups: [string, number[]][] | null } {
  if (opts.folderBy !== 'field') return { list: null, groups: null };
  const groups = new Map<string, number[]>();
  for (const [ds, r] of store.iterate(opts.datasets, opts.scope, false)) {
    if (ds.reason[r] !== 0) continue;
    const ci = ds.colIndex.get(opts.folderField);
    const v = ci === undefined ? '' : ds.cols[ci].dict[ds.cols[ci].codes[r]].trim();
    let g = groups.get(v);
    if (!g) { g = []; groups.set(v, g); }
    g.push(ds.offset + r);
  }
  const coll = new Intl.Collator(undefined, { numeric: true });
  return { list: null, groups: [...groups.entries()].sort((a, b) => coll.compare(a[0], b[0])) };
}

function* kmlRecords(store: DataStore, opts: KmlExportOptions): Generator<[Dataset, number, string]> {
  const { groups } = kmlOrder(store, opts);
  if (groups) {
    for (const [key, ids] of groups) {
      const label = key || '(blank)';
      for (const id of ids) {
        const l = store.locate(id)!;
        yield [l.ds, l.row, label];
      }
    }
    return;
  }
  for (const [ds, r] of store.iterate(opts.datasets, opts.scope, false)) {
    if (ds.reason[r] !== 0) continue;
    yield [ds, r, opts.folderBy === 'source' ? ds.name : ''];
  }
}

export async function exportKml(store: DataStore, opts: KmlExportOptions, sink: Sink, progress: Progress, isCancelled: () => boolean) {
  const total = countKml(store, opts);
  const colors = store.classColorHex();
  const pm = placemarkMaker(opts);
  const parts = opts.format === 'split' ? Math.max(1, Math.ceil(total / Math.max(1000, opts.splitSize))) : 1;
  const perPart = opts.format === 'split' ? Math.max(1000, opts.splitSize) : Infinity;
  let n = 0;
  const it = kmlRecords(store, opts);
  let pending: [Dataset, number, string] | null = null;

  const writePart = async (put: (s: string) => Promise<void>, partNo: number) => {
    const ch = new Chunker(put);
    await ch.add(kmlHead(opts, colors, parts > 1 ? ` (part ${partNo} of ${parts})` : ''));
    let folder: string | null = null;
    let inPart = 0;
    for (;;) {
      const next = pending ?? it.next().value;
      pending = null;
      if (!next) break;
      if (inPart >= perPart) { pending = next; break; }
      const [ds, r, f] = next;
      if (opts.folderBy !== 'none' && f !== folder) {
        if (folder !== null) await ch.add('</Folder>\n');
        await ch.add(`<Folder><name>${xmlEscape(f)}</name>\n`);
        folder = f;
      }
      await ch.add(pm(ds, r));
      inPart++;
      if (++n % 20000 === 0) {
        await yieldToEvents();
        if (isCancelled()) throw new Error('cancelled');
        progress(n, total);
      }
    }
    if (folder !== null) await ch.add('</Folder>\n');
    await ch.add(KML_TAIL);
    await ch.flush();
  };

  let blob: Blob | null;
  if (opts.format === 'kml') {
    await writePart((s) => sink.write(s), 1);
    blob = await sink.close();
  } else {
    const zip = new ZipWriter(sink);
    if (opts.format === 'kmz') {
      await zip.file('doc.kml', (put) => writePart(put, 1));
    } else {
      const base = safeName(opts.docName);
      for (let p = 1; p <= parts; p++) {
        await zip.file(`${base}_part${String(p).padStart(2, '0')}.kml`, (put) => writePart(put, p));
      }
    }
    blob = await zip.end();
  }
  progress(n, total);
  return { blob, count: n, parts };
}

export function countKml(store: DataStore, opts: KmlExportOptions): number {
  let n = 0;
  for (const ds of store.datasets) {
    if (!opts.datasets.includes(ds.id)) continue;
    if (opts.scope === 'all') { n += ds.valid; continue; }
    const a = opts.scope === 'filtered' ? ds.pass : ds.selected;
    for (let r = 0; r < ds.rows; r++) if (a[r] && ds.reason[r] === 0) n++;
  }
  return n;
}

export function estimateKml(store: DataStore, opts: KmlExportOptions): ExportEstimate {
  const count = countKml(store, opts);
  let invalidInScope = 0;
  if (opts.scope === 'all') for (const ds of store.datasets) if (opts.datasets.includes(ds.id)) invalidInScope += ds.rows - ds.valid;
  if (opts.scope === 'selected') for (const ds of store.datasets) if (opts.datasets.includes(ds.id)) for (let r = 0; r < ds.rows; r++) if (ds.selected[r] && ds.reason[r] !== 0) invalidInScope++;
  const pm = placemarkMaker(opts);
  const enc = new TextEncoder();
  let sample = 0, len = 0;
  for (const [ds, r] of store.iterate(opts.datasets, opts.scope, false)) {
    if (ds.reason[r] !== 0) continue;
    len += enc.encode(pm(ds, r)).length;
    if (++sample >= 300) break;
  }
  let bytes = 1000 + (sample ? (len / sample) * count : 0);
  if (opts.format !== 'kml') bytes *= 0.08; // compressed estimate
  return { count, bytes, skippedInvalid: invalidInScope };
}

export function safeName(s: string): string {
  return (s || 'export').replace(/[^\w\-. ]+/g, '_').trim().replace(/\s+/g, '_').slice(0, 80) || 'export';
}
