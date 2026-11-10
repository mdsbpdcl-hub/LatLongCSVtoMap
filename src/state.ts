import type { ColorScheme, DatasetInfo, DatasetStatus, FieldInfo, InspectResult, LoadOptions, NumericBin, ViewConfig, CategoryGroup } from './lib/types';
import type { CustomTiles } from './lib/basemaps';
import { CATEGORY_PALETTE, NUMERIC_RAMP, OTHERS_COLOR } from './lib/values';

export interface DsEntry {
  id: number;
  name: string;
  size: number;
  file: File | Blob;
  status: DatasetStatus;
  progress: number;
  rowsSoFar: number;
  jobId?: number;
  inspect?: InspectResult;
  opts?: LoadOptions;
  info?: DatasetInfo;
  error?: string;
  storageKey?: string;
}

export type DisplayMode = 'auto' | 'points' | 'clusters';

export interface DisplaySettings {
  basemap: string;
  custom: CustomTiles;
  pointSize: number;
  opacity: number;
  mode: DisplayMode;
  tooltipFields: string[];
  persist: boolean;
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  basemap: 'carto-light',
  custom: { url: '', attribution: '', maxzoom: 19 },
  pointSize: 4,
  opacity: 0.85,
  mode: 'auto',
  tooltipFields: [],
  persist: false,
};

export const DEFAULT_VIEW: ViewConfig = {
  filters: [],
  search: '',
  hiddenClasses: [],
  hiddenDatasets: [],
  datasetColors: {},
  sourceFiles: null,
  selectedOnly: false,
  color: { mode: 'dataset' },
  maxPoints: 1_500_000,
  dateDayFirst: true,
};

export const STEPS = ['Import Files', 'Configure Coordinates', 'Configure Display', 'Explore Map', 'Export Results'];

/** Pick sensible tooltip fields from available headings. */
export function defaultTooltipFields(fields: FieldInfo[], exclude: Set<string>): string[] {
  const pref = [/consumer.*(no|num|id)|^con(s)?_?no|account/i, /name/i, /district/i, /division/i, /feeder/i, /status/i, /category/i];
  const out: string[] = [];
  for (const re of pref) {
    const f = fields.find((x) => re.test(x.name) && !exclude.has(x.name) && !out.includes(x.name));
    if (f) out.push(f.name);
  }
  for (const f of fields) {
    if (out.length >= 5) break;
    if (!exclude.has(f.name) && !out.includes(f.name)) out.push(f.name);
  }
  return out.slice(0, 6);
}

const SEMANTIC: [RegExp, string][] = [
  [/^(connected|active|working|live|yes|ok|paid|completed?|energi[sz]ed|functional|regular)$/i, '#2f9e5b'],
  [/^(disconnected|failed|faulty|no|inactive|dead|defaulter|unpaid|burnt|damaged|pd|permanent(ly)? disconnected)$/i, '#d64545'],
  [/^(pending|in ?progress|under ?repair|temporary|temp(orary)? disconnected|td|partial|hold)$/i, '#e8912d'],
];

/** Default groups: the most frequent values get their own colours; the rest fall into “Others”.
 *  Familiar status words get familiar colours (Connected = green, Disconnected = red, Pending = orange). */
export function defaultGroups(values: { value: string; count: number }[], max = 12): CategoryGroup[] {
  const top = values.slice(0, max);
  const used = new Set<string>();
  const colors: (string | null)[] = top.map((v) => {
    if (v.value.replace(/\s*\|\s*/g, '').trim() === '') return BLANK_COLOR;
    const sem = SEMANTIC.find(([re]) => re.test(v.value.trim()));
    if (sem && !used.has(sem[1])) { used.add(sem[1]); return sem[1]; }
    return null;
  });
  let pi = 0;
  return top.map((v, i) => {
    let color = colors[i];
    if (!color) {
      while (used.has(CATEGORY_PALETTE[pi % CATEGORY_PALETTE.length]) && pi < 64) pi++;
      color = CATEGORY_PALETTE[pi % CATEGORY_PALETTE.length];
      pi++;
      used.add(color);
    }
    return { label: v.value.split(' | ').map((p) => p.trim() || '(blank)').join(' | '), values: [v.value], color };
  });
}

const BLANK_COLOR = '#c3c8cf';

function nice(x: number): number {
  if (x === 0) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(Math.abs(x))));
  const m = Math.abs(x) / p;
  const n = m < 2 ? 1 : m < 2.5 ? 2 : m < 5 ? 2.5 : m < 10 ? 5 : 10;
  return Math.sign(x) * n * p;
}

export function binLabel(b: { min: number | null; max: number | null }): string {
  const f = (x: number) => x.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (b.min === null && b.max === null) return 'All values';
  if (b.min === null) return `Up to ${f(b.max!)}`;
  if (b.max === null) return `${f(b.min)} and above`;
  return `${f(b.min)} – ${f(b.max)}`;
}

export function defaultBins(min: number, max: number): NumericBin[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [{ min: null, max: null, color: NUMERIC_RAMP[0], label: 'All values' }];
  }
  const step = nice((max - min) / 4);
  const start = Math.floor(min / step) * step;
  const bins: NumericBin[] = [];
  for (let i = 0; i < 4; i++) {
    const lo = i === 0 ? null : start + step * i;
    const hi = i === 3 ? null : start + step * (i + 1);
    bins.push({ min: lo, max: hi, color: NUMERIC_RAMP[i], label: '' });
  }
  // make ranges non-overlapping for integer-like data: 0–1000, 1000.01… shown as next bin's start
  return bins.map((b) => ({ ...b, label: binLabel(b) }));
}

export function schemeLabel(s: ColorScheme): string {
  if (s.mode === 'dataset') return 'Source file';
  if (s.mode === 'category') return s.fields.join(' + ');
  return s.field;
}

export const NEW_OTHERS = OTHERS_COLOR;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
