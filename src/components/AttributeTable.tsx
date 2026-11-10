import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { DataClient } from '../lib/workerClient';
import type { FieldInfo } from '../lib/types';
import { fmtInt } from '../lib/values';

const ROW_H = 30;
const PAGE = 100;
const COL_W = 160;

type Row = { id: number; source: string; selected: boolean; values: string[] };

interface Props {
  client: DataClient;
  fields: FieldInfo[];
  columns: string[];
  setColumns: (c: string[]) => void;
  dataVersion: number;
  selVersion: number;
  activeId: number | null;
  locate: { id: number; n: number } | null;
  onRowClick: (id: number) => void;
  onSelectionChanged: (count: number) => void;
  onClose: () => void;
}

export function AttributeTable({ client, fields, columns, setColumns, dataVersion, selVersion, activeId, locate, onRowClick, onSelectionChanged, onClose }: Props) {
  const [count, setCount] = useState(0);
  const [search, setSearch] = useState('');
  const [dSearch, setDSearch] = useState('');
  const [sort, setSort] = useState<{ field: string; dir: 1 | -1 }>({ field: '', dir: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<number, Row>());
  const loading = useRef(new Set<number>());
  const gen = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const colsKey = columns.join('\u0001');

  useEffect(() => { const t = setTimeout(() => setDSearch(search), 350); return () => clearTimeout(t); }, [search]);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => setHeight(box.current?.clientHeight || 300));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const loadPage = useCallback((p: number, g: number) => {
    if (loading.current.has(p)) return;
    loading.current.add(p);
    client.call<Row[]>('tableRows', [p * PAGE, PAGE, columns]).then((rows) => {
      loading.current.delete(p);
      if (g !== gen.current) return;
      rows.forEach((r, i) => cache.current.set(p * PAGE + i, r));
      setTick((t) => t + 1);
    }).catch(() => loading.current.delete(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, colsKey]);

  const reset = () => {
    gen.current++;
    cache.current.clear();
    loading.current.clear();
  };

  // re-query when data, search or sort change
  useEffect(() => {
    let live = true;
    setBusy(true);
    client.call<number>('tableQuery', [dSearch, sort.field, sort.dir]).then((n) => {
      if (!live) return;
      reset();
      setCount(n);
      setBusy(false);
      setTick((t) => t + 1);
    }).catch(() => setBusy(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion, dSearch, sort.field, sort.dir]);

  // refresh rows when columns or selection change
  useEffect(() => { reset(); setTick((t) => t + 1); }, [colsKey, selVersion]);

  // locate a record (from a map click)
  useEffect(() => {
    if (!locate) return;
    client.call<number>('tableIndexOf', [locate.id]).then((i) => {
      if (i >= 0 && box.current) box.current.scrollTop = Math.max(0, i * ROW_H - box.current.clientHeight / 2 + ROW_H);
    });
  }, [locate, client]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(count - 1, Math.ceil((scrollTop + height) / ROW_H) + 5);
  useEffect(() => {
    if (count === 0) return;
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) {
      if (!cache.current.has(p * PAGE)) loadPage(p, gen.current);
    }
  });

  const toggleSel = async (id: number) => {
    const n = await client.call<number>('select', [{ kind: 'ids', ids: [id], mode: 'toggle' }]);
    onSelectionChanged(n);
  };
  const headerClick = (f: string) => setSort((s) => (s.field === f ? (s.dir === 1 ? { field: f, dir: -1 } : { field: '', dir: 1 }) : { field: f, dir: 1 }));
  const width = 36 + 60 + COL_W + columns.length * COL_W;
  const rows: ReactElement[] = [];
  for (let i = first; i <= last; i++) {
    const r = cache.current.get(i);
    rows.push(
      <div key={i} className={`vt-row ${r?.selected ? 'sel' : ''} ${r && r.id === activeId ? 'active' : ''}`} style={{ top: 32 + i * ROW_H, height: ROW_H, width }}
        onClick={() => r && onRowClick(r.id)}>
        <div className="vt-cell" style={{ width: 36 }} onClick={(e) => e.stopPropagation()}>
          {r && <input type="checkbox" checked={r.selected} onChange={() => toggleSel(r.id)} aria-label="Select row" />}
        </div>
        <div className="vt-cell muted" style={{ width: 60 }}>{i + 1}</div>
        <div className="vt-cell muted" style={{ width: COL_W }} title={r?.source}>{r?.source ?? '…'}</div>
        {columns.map((c, k) => <div key={c} className="vt-cell" style={{ width: COL_W }} title={r?.values[k]}>{r ? r.values[k] : ''}</div>)}
      </div>,
    );
  }
  const arrow = (f: string) => (sort.field === f ? (sort.dir === 1 ? ' ▲' : ' ▼') : '');

  return (
    <div className="table-drawer">
      <div className="table-tools">
        <strong>Records</strong>
        <span className="small muted">{busy ? 'Updating…' : `${fmtInt(count)} matching`}</span>
        <input className="input" style={{ width: 220 }} placeholder="Search in table…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <details style={{ position: 'relative' }}>
          <summary className="btn small" style={{ listStyle: 'none' }}>Columns ({columns.length})</summary>
          <div className="floating" style={{ position: 'absolute', zIndex: 30, top: 34, left: 0, width: 280, maxHeight: 300, overflow: 'auto', padding: 8 }}>
            <div className="row small" style={{ marginBottom: 6 }}>
              <button className="linklike" onClick={() => setColumns(fields.map((f) => f.name))}>All</button>
              <button className="linklike" onClick={() => setColumns([])}>None</button>
            </div>
            {fields.map((f) => (
              <label key={f.name} className="check" style={{ padding: '2px 0' }}>
                <input type="checkbox" checked={columns.includes(f.name)} onChange={(e) => setColumns(e.target.checked ? fields.map((x) => x.name).filter((n) => n === f.name || columns.includes(n)) : columns.filter((x) => x !== f.name))} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              </label>
            ))}
          </div>
        </details>
        <button className="btn small" disabled={!count} onClick={async () => onSelectionChanged(await client.call('select', [{ kind: 'table' }]))}>Select all {fmtInt(count)}</button>
        <div className="grow" />
        <button className="icon-btn" onClick={onClose} title="Close table" aria-label="Close table">×</button>
      </div>
      <div className="vt" ref={box} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
        <div className="vt-inner" style={{ height: 32 + count * ROW_H, width }}>
          <div className="vt-head" style={{ width }}>
            <div className="vt-cell" style={{ width: 36 }} />
            <div className="vt-cell" style={{ width: 60 }}>#</div>
            <div className="vt-cell" style={{ width: COL_W }} onClick={() => headerClick('__source__')}>Source file{arrow('__source__')}</div>
            {columns.map((c) => <div key={c} className="vt-cell" style={{ width: COL_W }} title={`Sort by ${c}`} onClick={() => headerClick(c)}>{c}{arrow(c)}</div>)}
          </div>
          {rows}
        </div>
        {count === 0 && !busy && <div className="empty">No records match the current filters.</div>}
      </div>
    </div>
  );
}
