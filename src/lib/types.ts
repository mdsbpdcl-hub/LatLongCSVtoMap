// Shared types used by the UI and the data worker.

export type ColType = 'number' | 'date' | 'category' | 'text';

export type RGB = [number, number, number];

/** Reasons a record cannot be plotted. 0 = valid. */
export const INVALID_REASONS = [
  'Valid',
  'Missing latitude or longitude',
  'Not a number',
  'Latitude outside -90 to +90',
  'Longitude outside -180 to +180',
  'Zero coordinates (0, 0)',
] as const;
export type InvalidCounts = number[]; // index = reason code

export interface ColumnInfo {
  name: string;
  type: ColType;
  distinct: number;
  empty: number;
  min?: number;
  max?: number;
}

export interface InspectResult {
  encoding: string;
  delimiter: string;
  hasHeader: boolean;
  headers: string[];
  preview: string[][];
  latGuess: number;
  lonGuess: number;
  warnings: string[];
}

export interface LoadOptions {
  encoding: string;
  delimiter: string;
  hasHeader: boolean;
  latCol: number;
  lonCol: number;
}

export type DatasetStatus = 'inspecting' | 'loading' | 'ready' | 'error' | 'cancelled';

export interface DatasetInfo {
  id: number;
  name: string;
  size: number;
  rows: number;
  columns: ColumnInfo[];
  encoding: string;
  delimiter: string;
  hasHeader: boolean;
  latCol: number;
  lonCol: number;
  valid: number;
  invalid: InvalidCounts;
  duplicates: number;
  suspect: number;
  warnings: string[];
  raggedRows: number;
  loadMs: number;
}

export interface FieldInfo {
  name: string;
  type: ColType;
  datasets: number[]; // dataset ids having this column
  distinct: number;
}

// ---------- Filters ----------
export type FilterScope = 'all' | number;

export interface BaseFilter {
  id: string;
  field: string;
  scope: FilterScope;
}
export interface CategoryFilter extends BaseFilter {
  kind: 'category';
  values: string[];
}
export interface RangeFilter extends BaseFilter {
  kind: 'range';
  min: number | null;
  max: number | null;
}
export interface DateFilter extends BaseFilter {
  kind: 'date';
  from: string | null; // yyyy-mm-dd
  to: string | null;
}
export interface TextFilter extends BaseFilter {
  kind: 'text';
  query: string;
}
export type Filter = CategoryFilter | RangeFilter | DateFilter | TextFilter;

// ---------- Colouring ----------
export interface CategoryGroup {
  label: string;
  values: string[];
  color: string; // hex
}
export interface NumericBin {
  label: string;
  min: number | null; // inclusive
  max: number | null; // inclusive
  color: string;
}
export type ColorScheme =
  | { mode: 'dataset' }
  | { mode: 'category'; fields: string[]; groups: CategoryGroup[]; othersColor: string }
  | { mode: 'numeric'; field: string; bins: NumericBin[]; noValueColor: string };

export interface ViewConfig {
  filters: Filter[];
  search: string; // free text across all columns
  hiddenClasses: number[]; // legend classes hidden (acts as a filter)
  hiddenDatasets: number[]; // map layer visibility only
  datasetColors: Record<number, string>;
  sourceFiles: number[] | null; // null = all files; acts as a filter
  selectedOnly: boolean;
  color: ColorScheme;
  maxPoints: number;
  dateDayFirst: boolean;
}

export interface LegendEntry {
  cls: number;
  label: string;
  color: string;
  count: number; // within filtered records (ignoring legend hiding)
}

export interface ViewResult {
  version: number;
  filteredCount: number; // records passing all filters (valid coordinates)
  totalValid: number;
  perDataset: { id: number; filtered: number; valid: number; rows: number }[];
  legend: LegendEntry[];
  renderCount: number; // points sent to the map
  sampled: boolean;
  bbox: [number, number, number, number] | null;
  positions: Float64Array;
  colors: Uint8Array;
  ids: Uint32Array;
  selectedCount: number;
}

export interface ClusterResult {
  positions: Float64Array;
  counts: Uint32Array;
  ids: Uint32Array; // first id inside each cluster
  colors: Uint8Array; // point colour for single-record clusters, accent otherwise
  radiusPx: number;
}

export interface RecordDetail {
  id: number;
  datasetId: number;
  datasetName: string;
  row: number;
  fields: [string, string][];
  lat: number;
  lon: number;
  latRaw: string;
  lonRaw: string;
  latName: string;
  lonName: string;
  selected: boolean;
}

export type ExportScope = 'all' | 'filtered' | 'selected';

export interface CsvExportOptions {
  datasets: number[];
  scope: ExportScope;
  columns: string[]; // ordered list of field names
  includeLatLon: boolean;
  includeSource: boolean;
  includeInvalid: boolean; // only for scope 'all'
}

export interface KmlExportOptions {
  datasets: number[];
  scope: ExportScope;
  nameField: string; // '' = record number
  descFields: string[];
  extendedFields: string[];
  folderBy: 'none' | 'source' | 'field';
  folderField: string;
  useColors: boolean;
  showLabels: boolean;
  docName: string;
  format: 'kml' | 'kmz' | 'split';
  splitSize: number;
}

export interface ExportEstimate {
  count: number;
  bytes: number;
  skippedInvalid: number;
}
