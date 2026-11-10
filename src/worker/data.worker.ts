/// <reference lib="webworker" />
// The data worker: owns all parsed records and does every heavy computation off the UI thread.

import { DataStore } from './store';
import { BlobSink, FileSink, estimateCsv, estimateKml, exportCsv, exportKml, type Sink } from './exporters';
import { INVALID_REASONS } from '../lib/types';

const store = new DataStore();
const cancelled = new Set<number>();
const ctx = self as unknown as DedicatedWorkerGlobalScope;

type Msg = { id: number; type: string; args: any[] };

function progress(id: number, p: unknown) {
  ctx.postMessage({ id, progress: p });
}

async function makeSink(handle: FileSystemFileHandle | undefined, type: string): Promise<Sink> {
  if (handle) return new FileSink(await handle.createWritable());
  return new BlobSink(type);
}

const handlers: Record<string, (id: number, ...a: any[]) => unknown> = {
  inspect: (_id, file, override) => store.inspect(file, override),
  load: (id, dsId, name, file, opts) =>
    store.load(dsId, name, file, opts, (f, rows) => progress(id, { fraction: f, rows }), () => cancelled.has(id)),
  cancel: (_id, jobId: number) => { cancelled.add(jobId); return true; },
  remove: (_id, dsId) => { store.remove(dsId); return true; },
  clear: () => { store.clear(); return true; },
  setCoords: (_id, dsId, lat, lon) => store.setCoords(dsId, lat, lon),
  fields: () => store.fields(),
  invalidCsv: (_id, dsId) => store.invalidCsv(dsId, INVALID_REASONS),
  distinctCombos: (_id, fields, limit) => store.distinctCombos(fields, limit),
  filterValues: (_id, cfg, filterId, field, scope, q, limit) => store.filterValues(cfg, filterId, field, scope, q, limit),
  applyView: (_id, cfg) => store.applyView(cfg),
  clusters: (_id, zoom, cell) => store.clusters(zoom, cell),
  record: (_id, rid) => store.record(rid),
  tooltip: (_id, rid, fields) => store.tooltip(rid, fields),
  searchValues: (_id, field, q, limit) => store.searchValues(field, q, limit),
  select: (_id, op) => store.select(op),
  selectedPositions: (_id, cap) => store.selectedPositions(cap),
  tableQuery: (_id, search, sortField, sortDir) => store.tableQuery(search, sortField, sortDir),
  tableRows: (_id, start, count, cols) => store.tableRows(start, count, cols),
  tableIndexOf: (_id, rid) => store.tableIndexOf(rid),
  estimateCsv: (_id, opts) => estimateCsv(store, opts),
  estimateKml: (_id, opts) => estimateKml(store, opts),
  exportCsv: async (id, opts, handle) =>
    exportCsv(store, opts, await makeSink(handle, 'text/csv;charset=utf-8'), (d, t) => progress(id, { done: d, total: t }), () => cancelled.has(id)),
  exportKml: async (id, opts, handle) =>
    exportKml(store, opts, await makeSink(handle, opts.format === 'kml' ? 'application/vnd.google-earth.kml+xml' : opts.format === 'kmz' ? 'application/vnd.google-earth.kmz' : 'application/zip'),
      (d, t) => progress(id, { done: d, total: t }), () => cancelled.has(id)),
};

ctx.onmessage = async (e: MessageEvent<Msg>) => {
  const { id, type, args } = e.data;
  const h = handlers[type];
  if (!h) { ctx.postMessage({ id, ok: false, error: `Unknown request ${type}` }); return; }
  try {
    const result = await h(id, ...args);
    // Typed arrays are copied (structured clone) rather than transferred, because the store keeps
    // its own references to the render buffers for clustering.
    ctx.postMessage({ id, ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const oom = /allocation|out of memory|array buffer|invalid array length|invalid typed array length|invalid string length/i.test(msg);
    ctx.postMessage({
      id, ok: false, cancelled: msg === 'cancelled',
      error: oom ? 'The browser ran out of memory for this operation. Close other tabs, load fewer or smaller files, or use a desktop browser with more memory (Chrome or Edge, 64-bit).' : msg,
    });
  } finally {
    cancelled.delete(id);
  }
};
