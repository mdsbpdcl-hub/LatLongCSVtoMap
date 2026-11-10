import { useEffect, useRef, useState } from 'react';
import type { DataClient } from '../lib/workerClient';
import type { FieldInfo } from '../lib/types';
import { fmtInt } from '../lib/values';

type Hit = { value: string; count: number; bbox: [number, number, number, number]; firstId: number };

export function SearchBox({ client, fields, dataVersion, defaultField, onGo }: {
  client: DataClient; fields: FieldInfo[]; dataVersion: number; defaultField: string;
  onGo: (bbox: [number, number, number, number], singleId: number | null) => void;
}) {
  const [field, setField] = useState(defaultField);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => { setField((f) => (f === '' || fields.some((x) => x.name === f) ? f : defaultField)); }, [fields, defaultField]);

  useEffect(() => {
    if (q.trim().length < 1) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => {
      client.call<Hit[]>('searchValues', [field, q, 25]).then((h) => { if (live) { setHits(h); setOpen(true); } }).catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, field, dataVersion, client]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = (h: Hit) => { onGo(h.bbox, h.count === 1 ? h.firstId : null); setOpen(false); };

  return (
    <div className="search-box" ref={wrap}>
      <div className="floating">
        <span aria-hidden className="muted">⌕</span>
        <input placeholder="Find a consumer, feeder, village…" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => hits.length && setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) go(hits[0]); if (e.key === 'Escape') setOpen(false); }} aria-label="Search the map" />
        <select value={field} onChange={(e) => setField(e.target.value)} aria-label="Search in column" title="Column to search">
          <option value="">All columns</option>
          {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
      </div>
      {open && q && (
        <div className="search-results floating">
          {hits.length === 0 && <div className="small muted" style={{ padding: 8 }}>No matching records among the filtered points.</div>}
          {hits.map((h) => (
            <button key={h.value} onClick={() => go(h)}>
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.value || '(blank)'}</span>
              <span className="muted small">{h.count === 1 ? 'zoom to point' : `${fmtInt(h.count)} records`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
