// Value parsing helpers (numbers, dates, coordinates) and colour utilities.

/** Parse a number, accepting thousands separators like 1,00,000 or 1,000.50 and a leading currency sign. */
export function parseNumber(s: string): number {
  if (!s) return NaN;
  let t = s.trim();
  if (!t) return NaN;
  const c0 = t.charCodeAt(0);
  if (c0 === 8377 /* ₹ */ || c0 === 36 /* $ */ || c0 === 8364 /* € */ || c0 === 163 /* £ */) t = t.slice(1).trim();
  if (t.indexOf(',') !== -1) {
    if (!/^[-+]?\d{1,3}(,\d{2,3})*(\.\d+)?$/.test(t)) return NaN;
    t = t.replace(/,/g, '');
  }
  if (t.length === 0 || /^[-+]?0[xob]/i.test(t)) return NaN;
  const x = Number(t);
  return Number.isFinite(x) ? x : NaN;
}

/** Strict coordinate parsing: plain decimal degrees only. Never modifies the original text. */
export function parseCoord(s: string): number {
  if (s === undefined || s === null) return NaN;
  const t = s.trim();
  if (!t || /^[-+]?0[xob]/i.test(t)) return NaN;
  const x = Number(t);
  return Number.isFinite(x) ? x : NaN;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const RE_YMD = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const RE_DMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const RE_DMONY = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]+(\d{2,4})/;
const RE_MONDY = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/;

function mk(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): number {
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return NaN;
  const t = Date.UTC(y, m - 1, d, hh, mm, ss);
  const dt = new Date(t);
  if (dt.getUTCDate() !== d) return NaN; // e.g. 31 Feb
  return t;
}

/** Parse common date formats to a UTC timestamp (ms). Returns NaN if not a date. */
export function parseDate(s: string, dayFirst = true): number {
  if (!s) return NaN;
  const t = s.trim();
  if (t.length < 6 || t.length > 40) return NaN;
  let m = RE_YMD.exec(t);
  if (m) return mk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = RE_DMY.exec(t);
  if (m) {
    let a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) return mk(+m[3], b, a, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (b > 12 && a <= 12) return mk(+m[3], a, b, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (!dayFirst) [a, b] = [b, a];
    return mk(+m[3], b, a, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  m = RE_DMONY.exec(t);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return mk(+m[3], mon, +m[1]);
  }
  m = RE_MONDY.exec(t);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return mk(+m[3], mon, +m[2]);
  }
  return NaN;
}

export function dateInputToMs(s: string | null, endOfDay = false): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return endOfDay ? t + 86399999 : t;
}

export function msToDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------------- colours ----------------

/** Calm, distinguishable categorical palette (no neon). */
export const CATEGORY_PALETTE = [
  '#2f9e5b', '#d64545', '#e8912d', '#3d7cc9', '#8a5cc2', '#c9a227', '#1f9aa8', '#c2548f',
  '#6b8e23', '#a0522d', '#5f6f86', '#e06c9f', '#4caf9a', '#b0703c', '#7d7fd6', '#9aa33a',
];
export const DATASET_PALETTE = ['#2f6f47', '#3d7cc9', '#d97a2b', '#8a5cc2', '#c2548f', '#1f9aa8', '#b8862b', '#d64545'];
export const NUMERIC_RAMP = ['#2f9e5b', '#c9b52a', '#e8912d', '#d64545', '#8e2c2c', '#5b1f4f'];
export const OTHERS_COLOR = '#9aa1ab';

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-IN');
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  if (n < 10000000) return (n / 100000).toFixed(n < 1000000 ? 1 : 0).replace(/\.0$/, '') + 'L';
  return (n / 10000000).toFixed(1).replace(/\.0$/, '') + 'Cr';
}
