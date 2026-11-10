import { useEffect, useState } from 'react';
import type { DataClient } from '../lib/workerClient';
import type { FieldInfo, Filter, ViewConfig, ViewResult } from '../lib/types';
import { uid, type DisplaySettings, type DsEntry } from '../state';
import { DATASET_PALETTE, fmtInt, msToDateInput } from '../lib/values';
import { BASEMAPS } from '../lib/basemaps';

type Meta = Omit<ViewResult, 'positions' | 'colors' | 'ids'>;

interface Props {
  client: DataClient;
  fields: FieldInfo[];
  entries: DsEntry[];
  view: ViewConfig;
  setView: (f: (v: ViewConfig) => ViewConfig) => void;
  meta: Meta | null;
  selectedCount: number;
  onSelect: (op: 'filtered' | 'clear') => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function FilterPanel({ client, fields, entries, view, setView, meta, selectedCount, onSelect }: Props) {
  const ready = entries.filter((e) => e.info);
  const [search, setSearch] = useState(view.search);
  const ds = useDebounced(search, 350);
  useEffect(() => { setView((v) => (v.search === ds ? v : { ...v, search: ds })); }, [ds, setView]);
  useEffect(() => { if (view.search === '') setSearch(''); }, [view.search]);

  const update = (id: string, patch: Partial<Filter>) =>
    setView((v) => ({ ...v, filters: v.filters.map((f) => (f.id === id ? ({ ...f, ...patch } as Filter) : f)) }));
  const remove = (id: string) => setView((v) => ({ ...v, filters: v.filters.filter((f) => f.id !== id) }));
  const add = (name: string) => {
    const f = fields.find((x) => x.name === name);
    if (!f) return;
    const base = { id: uid(), field: name, scope: 'all' as const };
    const nf: Filter = f.type === 'number' ? { ...base, kind: 'range', min: null, max: null }
      : f.type === 'date' ? { ...base, kind: 'date', from: null, to: null }
        : f.type === 'text' ? { ...base, kind: 'text', query: '' }
          : { ...base, kind: 'category', values: [] };
    setView((v) => ({ ...v, filters: [...v.filters, nf] }));
  };
  const anyActive = view.filters.length > 0 || view.search || view.sourceFiles || view.hiddenClasses.length || view.selectedOnly;

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="grow">
          <div className="strong" style={{ fontSize: 18 }}>{fmtInt(meta?.filteredCount ?? 0)}</div>
          <div className="small muted">of {fmtInt(meta?.totalValid ?? 0)} mapped records match</div>
        </div>
        <button className="btn small" disabled={!anyActive} onClick={() => setView((v) => ({ ...v, filters: [], search: '', sourceFiles: null, hiddenClasses: [], selectedOnly: false }))}>Clear all filters</button>
      </div>

      <input className="input" style={{ width: '100%' }} placeholder="Search all columns…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search all columns" />

      {ready.length > 1 && (
        <div style={{ marginTop: 12 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>Source files</div>
          {ready.map((e) => {
            const on = !view.sourceFiles || view.sourceFiles.includes(e.id);
            return (
              <label className="check" key={e.id} style={{ padding: '2px 0' }}>
                <input type="checkbox" checked={on} onChange={(ev) => setView((v) => {
                  const cur = v.sourceFiles ?? ready.map((x) => x.id);
                  const next = ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id);
                  return { ...v, sourceFiles: next.length === ready.length ? null : next };
                })} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              </label>
            );
          })}
        </div>
      )}

      <div className="hr" />
      {view.filters.map((f) => (
        <FilterCard key={f.id} f={f} client={client} view={view} fields={fields} entries={ready} meta={meta}
          onChange={(p) => update(f.id, p)} onRemove={() => remove(f.id)} />
      ))}
      <select className="input" style={{ width: '100%' }} value="" onChange={(e) => { add(e.target.value); e.target.value = ''; }}>
        <option value="">+ Add a filter…</option>
        {fields.map((f) => <option key={f.name} value={f.name}>{f.name}{f.datasets.length < ready.length ? ` (${f.datasets.length} of ${ready.length} files)` : ''}</option>)}
      </select>
      <div className="small muted" style={{ marginTop: 6 }}>
        Add filters in order (e.g. District, then Division, then Feeder): each list only shows values that still match the other filters.
        Records from files that do not have a filter’s column are excluded while that filter is active, unless you limit the filter to one file.
      </div>

      <div className="hr" />
      <div className="small muted" style={{ marginBottom: 6 }}>Selection · {fmtInt(selectedCount)} records selected</div>
      <div className="row">
        <button className="btn small" onClick={() => onSelect('filtered')} disabled={!meta?.filteredCount}>Select all matching</button>
        <button className="btn small" onClick={() => onSelect('clear')} disabled={!selectedCount}>Clear selection</button>
      </div>
      <label className="check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={view.selectedOnly} onChange={(e) => setView((v) => ({ ...v, selectedOnly: e.target.checked }))} disabled={!selectedCount && !view.selectedOnly} />
        Show only selected records
      </label>
    </div>
  );
}

function FilterCard({ f, client, view, fields, entries, meta, onChange, onRemove }: {
  f: Filter; client: DataClient; view: ViewConfig; fields: FieldInfo[]; entries: DsEntry[]; meta: Meta | null;
  onChange: (p: Partial<Filter>) => void; onRemove: () => void;
}) {
  const field = fields.find((x) => x.name === f.field);
  const filesWith = entries.filter((e) => field?.datasets.includes(e.id));
  const kinds: { v: Filter['kind']; l: string }[] = [{ v: 'category', l: 'Pick values' }, { v: 'text', l: 'Contains text' }];
  if (field?.type === 'number') kinds.unshift({ v: 'range', l: 'Number range' });
  if (field?.type === 'date') kinds.unshift({ v: 'date', l: 'Date range' });
  const switchKind = (k: Filter['kind']) => {
    const base = { id: f.id, field: f.field, scope: f.scope };
    const nf: Filter = k === 'range' ? { ...base, kind: k, min: null, max: null } : k === 'date' ? { ...base, kind: k, from: null, to: null }
      : k === 'text' ? { ...base, kind: k, query: '' } : { ...base, kind: 'category', values: [] };
    onChange(nf);
  };
  return (
    <div className="filter-card">
      <div className="filter-head">
        <span className="name" title={f.field}>{f.field}</span>
        <select className="input" style={{ height: 28, fontSize: 12.5, padding: '0 6px' }} value={f.kind} onChange={(e) => switchKind(e.target.value as Filter['kind'])}>
          {kinds.map((k) => <option key={k.v} value={k.v}>{k.l}</option>)}
        </select>
        <button className="icon-btn" onClick={onRemove} title="Remove filter" aria-label="Remove filter">×</button>
      </div>
      {entries.length > 1 && (
        <select className="input" style={{ width: '100%', height: 28, fontSize: 12.5, marginBottom: 6 }} value={String(f.scope)}
          onChange={(e) => onChange({ scope: e.target.value === 'all' ? 'all' : Number(e.target.value) })}>
          <option value="all">Apply to all files</option>
          {filesWith.map((e) => <option key={e.id} value={e.id}>Only in {e.name}</option>)}
        </select>
      )}
      {f.kind === 'category' && <CategoryBody f={f} client={client} view={view} meta={meta} onChange={onChange} />}
      {f.kind === 'range' && <RangeBody f={f} entries={entries} onChange={onChange} />}
      {f.kind === 'date' && <DateBody f={f} onChange={onChange} />}
      {f.kind === 'text' && <TextBody f={f} onChange={onChange} />}
    </div>
  );
}

function CategoryBody({ f, client, view, meta, onChange }: { f: Extract<Filter, { kind: 'category' }>; client: DataClient; view: ViewConfig; meta: Meta | null; onChange: (p: Partial<Filter>) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const [list, setList] = useState<{ value: string; count: number }[]>([]);
  const [distinct, setDistinct] = useState(0);
  const version = meta?.version ?? 0;
  useEffect(() => {
    let live = true;
    client.call('filterValues', [view, f.id, f.field, f.scope, dq, 300]).then((r) => {
      if (live) { setList(r.values); setDistinct(r.distinct); }
    }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, dq, f.field, f.scope]);
  const sel = new Set(f.values);
  const shown = [...f.values.filter((v) => !list.some((x) => x.value === v)).map((v) => ({ value: v, count: 0 })), ...list];
  const toggle = (v: string, on: boolean) => onChange({ values: on ? [...f.values, v] : f.values.filter((x) => x !== v) });
  return (
    <div>
      <input className="input" style={{ width: '100%', height: 30 }} placeholder={`Search ${fmtInt(distinct)} values…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row small" style={{ marginTop: 4 }}>
        <button className="linklike" onClick={() => onChange({ values: [...new Set([...f.values, ...list.map((x) => x.value)])] })}>Select shown</button>
        <button className="linklike" onClick={() => onChange({ values: [] })}>Clear</button>
        <span className="muted">{f.values.length ? `${f.values.length} chosen` : 'None chosen = no filter'}</span>
      </div>
      <div className="value-list">
        {shown.map((x) => (
          <label key={x.value} className={`value-row ${x.count === 0 ? 'zero' : ''}`}>
            <input type="checkbox" checked={sel.has(x.value)} onChange={(e) => toggle(x.value, e.target.checked)} />
            <span className="lbl" title={x.value}>{x.value || '(blank)'}</span>
            <span className="cnt">{fmtInt(x.count)}</span>
          </label>
        ))}
        {shown.length === 0 && <div className="small muted" style={{ padding: 6 }}>No values match.</div>}
      </div>
    </div>
  );
}

function RangeBody({ f, entries, onChange }: { f: Extract<Filter, { kind: 'range' }>; entries: DsEntry[]; onChange: (p: Partial<Filter>) => void }) {
  const cols = entries.flatMap((e) => e.info!.columns.filter((c) => c.name === f.field));
  const lo = Math.min(...cols.map((c) => c.min ?? Infinity));
  const hi = Math.max(...cols.map((c) => c.max ?? -Infinity));
  const parse = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')));
  return (
    <div className="row">
      <input className="input grow" type="number" placeholder={Number.isFinite(lo) ? `Min ${lo}` : 'Min'} defaultValue={f.min ?? ''} key={`a${f.min}`}
        onBlur={(e) => onChange({ min: parse(e.target.value) })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="Minimum" />
      <span className="muted">to</span>
      <input className="input grow" type="number" placeholder={Number.isFinite(hi) ? `Max ${hi}` : 'Max'} defaultValue={f.max ?? ''} key={`b${f.max}`}
        onBlur={(e) => onChange({ max: parse(e.target.value) })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label="Maximum" />
    </div>
  );
}

function DateBody({ f, onChange }: { f: Extract<Filter, { kind: 'date' }>; onChange: (p: Partial<Filter>) => void }) {
  return (
    <div className="row">
      <input className="input grow" type="date" value={f.from ?? ''} max={f.to ?? msToDateInput(Date.now() + 365 * 864e5 * 50)} onChange={(e) => onChange({ from: e.target.value || null })} aria-label="From date" />
      <span className="muted">to</span>
      <input className="input grow" type="date" value={f.to ?? ''} min={f.from ?? undefined} onChange={(e) => onChange({ to: e.target.value || null })} aria-label="To date" />
    </div>
  );
}

function TextBody({ f, onChange }: { f: Extract<Filter, { kind: 'text' }>; onChange: (p: Partial<Filter>) => void }) {
  const [q, setQ] = useState(f.query);
  const d = useDebounced(q, 350);
  useEffect(() => { if (d !== f.query) onChange({ query: d }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [d]);
  return <input className="input" style={{ width: '100%' }} placeholder="Contains…" value={q} onChange={(e) => setQ(e.target.value)} />;
}

// ------------------------------------------------------------------ layers tab
export function LayersPanel({ entries, view, setView, meta, display, setDisplay }: {
  entries: DsEntry[]; view: ViewConfig; setView: (f: (v: ViewConfig) => ViewConfig) => void; meta: Meta | null;
  display: DisplaySettings; setDisplay: (f: (d: DisplaySettings) => DisplaySettings) => void;
}) {
  const ready = entries.filter((e) => e.info);
  const allOn = view.hiddenDatasets.length === 0;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="small muted grow">Show or hide each file on the map (does not change counts or exports).</span>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn small" disabled={allOn} onClick={() => setView((v) => ({ ...v, hiddenDatasets: [] }))}>Show all</button>
        <button className="btn small" disabled={view.hiddenDatasets.length === ready.length} onClick={() => setView((v) => ({ ...v, hiddenDatasets: ready.map((e) => e.id) }))}>Hide all</button>
      </div>
      {ready.map((e, i) => {
        const pd = meta?.perDataset.find((p) => p.id === e.id);
        const on = !view.hiddenDatasets.includes(e.id);
        return (
          <label className="group-row check" key={e.id}>
            <input type="checkbox" checked={on} onChange={(ev) => setView((v) => ({ ...v, hiddenDatasets: ev.target.checked ? v.hiddenDatasets.filter((x) => x !== e.id) : [...v.hiddenDatasets, e.id] }))} />
            {view.color.mode === 'dataset' && <span className="swatch" style={{ background: view.datasetColors[e.id] || DATASET_PALETTE[i % DATASET_PALETTE.length] }} />}
            <span className="lbl" title={e.name}>{e.name}</span>
            <span className="cnt">{fmtInt(pd?.filtered ?? 0)} / {fmtInt(e.info!.valid)}</span>
          </label>
        );
      })}
      <div className="hr" />
      <label className="field">Background map
        <select className="input" value={display.basemap} onChange={(e) => setDisplay((d) => ({ ...d, basemap: e.target.value }))}>
          {BASEMAPS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          {display.custom.url && <option value="custom">Custom tile server</option>}
        </select>
      </label>
      <label className="field" style={{ marginTop: 10 }}>Point size: {display.pointSize}px
        <input type="range" min={1} max={14} step={0.5} value={display.pointSize} onChange={(e) => setDisplay((d) => ({ ...d, pointSize: Number(e.target.value) }))} />
      </label>
      <label className="field" style={{ marginTop: 6 }}>Transparency: {Math.round((1 - display.opacity) * 100)}%
        <input type="range" min={0.1} max={1} step={0.05} value={display.opacity} onChange={(e) => setDisplay((d) => ({ ...d, opacity: Number(e.target.value) }))} />
      </label>
      <label className="field" style={{ marginTop: 6 }}>Grouping of dense points
        <select className="input" value={display.mode} onChange={(e) => setDisplay((d) => ({ ...d, mode: e.target.value as DisplaySettings['mode'] }))}>
          <option value="auto">Automatic</option>
          <option value="points">Always points</option>
          <option value="clusters">Always clusters</option>
        </select>
      </label>
    </div>
  );
}
