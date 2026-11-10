// Streaming CSV parser and file-format detection. No dependencies; runs in a Web Worker.

export const ENCODINGS = [
  { value: 'utf-8', label: 'UTF-8 (standard)' },
  { value: 'windows-1252', label: 'Windows-1252 (Excel, Western)' },
  { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'gb18030', label: 'GB18030 (Chinese)' },
  { value: 'shift_jis', label: 'Shift_JIS (Japanese)' },
];

export const DELIMITERS = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];

/**
 * Incremental RFC-4180 style parser. Feed decoded text with push(); call end() at the end.
 * Handles quoted fields, escaped quotes (""), CR/LF/CRLF and newlines inside quotes,
 * across chunk boundaries.
 */
export class CsvParser {
  private buf = '';
  private dc: number;
  constructor(delimiter: string, private onRow: (row: string[]) => boolean | void) {
    this.dc = delimiter.charCodeAt(0);
  }
  stopped = false;

  push(text: string) {
    this.buf = this.buf.length ? this.buf + text : text;
    this.run(false);
  }
  end() {
    this.run(true);
    this.buf = '';
  }

  private run(final: boolean) {
    const s = this.buf;
    const n = s.length;
    let i = 0;
    while (i < n && !this.stopped) {
      const r = this.parseRecord(s, i, n, final);
      if (!r) break; // incomplete record: wait for more data
      i = r.next;
      const row = r.row;
      if (row.length === 1 && row[0] === '') continue; // blank line
      if (this.onRow(row) === false) {
        this.stopped = true;
        break;
      }
    }
    this.buf = i >= n ? '' : s.slice(i);
  }

  private parseRecord(s: string, start: number, n: number, final: boolean): { row: string[]; next: number } | null {
    const D = this.dc;
    const row: string[] = [];
    let i = start;
    for (;;) {
      let val: string;
      if (i < n && s.charCodeAt(i) === 34) {
        // quoted field
        let j = i + 1;
        let seg = j;
        val = '';
        for (;;) {
          const q = s.indexOf('"', j);
          if (q === -1) {
            if (!final) return null;
            val += s.slice(seg);
            i = n;
            break;
          }
          if (q + 1 >= n && !final) return null; // can't tell if it's an escaped quote yet
          if (s.charCodeAt(q + 1) === 34) {
            val += s.slice(seg, q + 1);
            j = q + 2;
            seg = j;
            continue;
          }
          val += s.slice(seg, q);
          i = q + 1;
          break;
        }
        // lenient: keep any stray characters after the closing quote
        if (i < n) {
          let k = i;
          while (k < n) {
            const c = s.charCodeAt(k);
            if (c === D || c === 10 || c === 13) break;
            k++;
          }
          if (k > i) {
            if (k >= n && !final) return null;
            val += s.slice(i, k);
            i = k;
          }
        }
      } else {
        let j = i;
        while (j < n) {
          const c = s.charCodeAt(j);
          if (c === D || c === 10 || c === 13) break;
          j++;
        }
        if (j >= n && !final) return null;
        val = s.slice(i, j);
        i = j;
      }
      row.push(val);
      if (i >= n) {
        if (!final) return null;
        return { row, next: n };
      }
      const c = s.charCodeAt(i);
      if (c === D) {
        i++;
        if (i >= n) {
          if (!final) return null;
          row.push('');
          return { row, next: n };
        }
        continue;
      }
      // newline
      if (c === 13) {
        if (i + 1 >= n && !final) return null;
        i++;
        if (i < n && s.charCodeAt(i) === 10) i++;
      } else {
        i++;
      }
      return { row, next: i };
    }
  }
}

/** Detect encoding from a byte sample. */
export function detectEncoding(bytes: Uint8Array): { encoding: string; bomLength: number } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', bomLength: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', bomLength: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', bomLength: 2 };
  // Trim up to 3 bytes so a multi-byte character cut by the sample boundary is not mistaken for invalid UTF-8
  let end = bytes.length;
  if (end >= 4) {
    let k = end - 1;
    let back = 0;
    while (k > 0 && back < 3 && (bytes[k] & 0xc0) === 0x80) {
      k--;
      back++;
    }
    if (bytes[k] >= 0xc0) end = k;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    return { encoding: 'utf-8', bomLength: 0 };
  } catch {
    return { encoding: 'windows-1252', bomLength: 0 };
  }
}

export function bomLengthFor(bytes: Uint8Array, encoding: string): number {
  const e = encoding.toLowerCase();
  if (e === 'utf-8' && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 3;
  if (e === 'utf-16le' && bytes[0] === 0xff && bytes[1] === 0xfe) return 2;
  if (e === 'utf-16be' && bytes[0] === 0xfe && bytes[1] === 0xff) return 2;
  return 0;
}

/** Guess the delimiter from the first lines of text. */
export function detectDelimiter(text: string): string {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < 30 && start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const line = text.slice(start, nl).replace(/\r$/, '');
    if (line.trim()) lines.push(line);
    start = nl + 1;
  }
  if (lines.length > 1 && start < text.length) lines.pop(); // last line may be cut
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) || 0) + 1);
    let modeCount = 0;
    let mode = 0;
    for (const [c, f] of freq) if (f > modeCount || (f === modeCount && c > mode)) { modeCount = f; mode = c; }
    if (mode === 0) continue;
    const consistency = modeCount / lines.length;
    const score = consistency * 100 + Math.min(mode, 50);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let inQ = false;
  let c = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === d) c++;
  }
  return c;
}

/** Make header names unique and non-empty while keeping the original text where possible. */
export function normaliseHeaders(raw: string[]): string[] {
  const used = new Set<string>();
  return raw.map((h, i) => {
    const base = h.replace(/^﻿/, '').trim() || `Column ${i + 1}`;
    let name = base;
    let k = 2;
    while (used.has(name)) name = `${base} (${k++})`;
    used.add(name);
    return name;
  });
}

const LAT_EXACT = /^(lat|latitude|lat_dd|latitude_dd|gps_lat|gps_latitude|y_lat|lat_deg|lat\.?|ycoord|y_coord|y)$/i;
const LON_EXACT = /^(lon|lng|long|longitude|lon_dd|longitude_dd|gps_lon|gps_long|gps_longitude|gps_lng|x_lon|lon_deg|long\.?|xcoord|x_coord|x)$/i;
const LAT_PART = /(^|[^a-z])lat(itude)?([^a-z]|$)|latitude/i;
const LON_PART = /(^|[^a-z])(lon|lng|long)(gitude)?([^a-z]|$)|longitude/i;

/** Guess latitude and longitude columns from header names, then from values. */
export function guessLatLon(headers: string[], preview: string[][]): { lat: number; lon: number } {
  const norm = headers.map((h) => h.trim().replace(/[\s-]+/g, '_'));
  let lat = norm.findIndex((h) => LAT_EXACT.test(h));
  let lon = norm.findIndex((h) => LON_EXACT.test(h));
  if (lat === -1) lat = norm.findIndex((h) => LAT_PART.test(h));
  if (lon === -1) lon = norm.findIndex((h, i) => i !== lat && LON_PART.test(h));
  if (lat !== -1 && lon !== -1 && lat !== lon) return { lat, lon };

  // value-based fallback: decimal numbers in the right ranges
  const stats = headers.map((_, c) => {
    let n = 0, inLat = 0, inLon = 0, dec = 0;
    for (const r of preview) {
      const v = (r[c] ?? '').trim();
      if (!v) continue;
      const x = Number(v);
      if (!Number.isFinite(x)) return null;
      n++;
      if (Math.abs(x) <= 90) inLat++;
      if (Math.abs(x) <= 180) inLon++;
      if (v.includes('.') && v.split('.')[1].length >= 3) dec++;
    }
    return n ? { n, inLat, inLon, dec } : null;
  });
  const cand = stats
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s && x.s.dec / x.s.n > 0.8 && x.s.inLon === x.s.n);
  if (lat === -1) {
    const c = cand.find((x) => x.s!.inLat === x.s!.n && x.i !== lon);
    if (c) lat = c.i;
  }
  if (lon === -1) {
    const c = cand.find((x) => x.i !== lat);
    if (c) lon = c.i;
  }
  return { lat, lon };
}
