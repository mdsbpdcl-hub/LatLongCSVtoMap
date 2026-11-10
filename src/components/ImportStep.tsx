import { useRef, useState } from 'react';
import type { DsEntry } from '../state';
import type { LoadOptions } from '../lib/types';
import { DELIMITERS, ENCODINGS } from '../lib/csv';
import { fmtBytes, fmtInt } from '../lib/values';
import { Progress } from './Shell';

interface Props {
  entries: DsEntry[];
  onAdd: (files: File[]) => void;
  onRemove: (id: number) => void;
  onCancel: (id: number) => void;
  onReload: (id: number, opts: Partial<LoadOptions>) => void;
  onSamples: () => void;
  stored: { count: number; onRestore: () => void; onDelete: () => void } | null;
}

export function ImportStep({ entries, onAdd, onRemove, onCancel, onReload, onSamples, stored }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const ready = entries.filter((e) => e.status === 'ready');
  const totalRows = ready.reduce((s, e) => s + (e.info?.rows || 0), 0);
  const totalValid = ready.reduce((s, e) => s + (e.info?.valid || 0), 0);

  const take = (list: FileList | null) => {
    if (!list) return;
    const files = [...list].filter((f) => /\.(csv|txt|tsv)$/i.test(f.name) || f.type.includes('csv') || f.type === 'text/plain');
    const skipped = list.length - files.length;
    if (skipped) alert(`${skipped} file(s) skipped: only .csv, .tsv or .txt files can be imported.`);
    if (files.length) onAdd(files);
  };

  return (
    <div className="page">
      <h1 className="page-title">Which CSV files do you want to map?</h1>
      <p className="page-sub">Add one or more files. They are read inside this browser — nothing is uploaded.</p>

      {stored && stored.count > 0 && entries.length === 0 && (
        <div className="note" style={{ marginBottom: 14 }}>
          {stored.count} file(s) are saved in this browser from an earlier visit.{' '}
          <button className="linklike" onClick={stored.onRestore}>Open them</button>{' · '}
          <button className="linklike" onClick={stored.onDelete}>Delete them</button>
        </div>
      )}

      <div
        className={`drop ${over ? 'over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
      >
        <div className="big">Drop CSV files here</div>
        <div className="muted">or <span className="strong">browse files</span> · several files at once · lakhs of rows supported</div>
        <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" multiple hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      </div>
      <div className="row small muted" style={{ marginTop: 8 }}>
        <span>No file handy?</span>
        <button className="linklike" onClick={onSamples}>Load the sample files</button>
      </div>

      {entries.length > 0 && (
        <div className="file-list">
          {entries.map((e) => (
            <FileItem key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)}
              onRemove={() => onRemove(e.id)} onCancel={() => onCancel(e.id)} onReload={(o) => onReload(e.id, o)} />
          ))}
        </div>
      )}

      {ready.length > 0 && (
        <div className="row small muted" style={{ marginTop: 12 }}>
          <span>{ready.length} file(s) ready · {fmtInt(totalRows)} rows · {fmtInt(totalValid)} with usable coordinates</span>
        </div>
      )}

      <details className="more">
        <summary>How large can the files be?</summary>
        <div className="note" style={{ marginTop: 8 }}>
          Files are read in 4 MB pieces in a background thread, so the page stays responsive. In testing, a 10 lakh-row
          file (127 MB, 12 columns) loaded in about 17 seconds and 20 lakh rows in about 34 seconds, using roughly
          1.5 GB of browser memory. On an office laptop with 8 GB RAM, about 10–20 lakh rows in total is a comfortable
          working limit in Chrome or Edge. If the browser runs out of memory you will see a message and can remove a file.
        </div>
      </details>
    </div>
  );
}

function FileItem({ e, open, onToggle, onRemove, onCancel, onReload }: {
  e: DsEntry; open: boolean; onToggle: () => void; onRemove: () => void; onCancel: () => void; onReload: (o: Partial<LoadOptions>) => void;
}) {
  const tag =
    e.status === 'ready' ? <span className="tag ok">Ready</span>
      : e.status === 'loading' ? <span className="tag">Reading {Math.round(e.progress * 100)}%</span>
        : e.status === 'inspecting' ? <span className="tag">Checking…</span>
          : e.status === 'cancelled' ? <span className="tag warn">Cancelled</span>
            : <span className="tag bad">Error</span>;
  const ins = e.inspect;
  const opts = e.opts;
  return (
    <div className="file-item">
      <div className="file-line">
        <div className="grow">
          <div className="file-name" title={e.name}>{e.name}</div>
          <div className="file-meta">
            {fmtBytes(e.size)}
            {e.info && <> · {fmtInt(e.info.rows)} rows · <span className="strong">{fmtInt(e.info.valid)}</span> valid locations · {e.info.columns.length} columns</>}
            {e.status === 'loading' && <> · {fmtInt(e.rowsSoFar)} rows so far</>}
          </div>
        </div>
        {tag}
        {e.status === 'loading' && <button className="btn small" onClick={onCancel}>Cancel</button>}
        {(e.status === 'cancelled' || e.status === 'error') && opts && <button className="btn small" onClick={() => onReload({})}>Retry</button>}
        {ins && <button className={`icon-btn ${open ? 'on' : ''}`} title="Preview & reading settings" onClick={onToggle} aria-label="Settings">⚙</button>}
        <button className="icon-btn" title="Remove this file" onClick={onRemove} aria-label="Remove">×</button>
      </div>
      {e.status === 'loading' && <div style={{ marginTop: 8 }}><Progress value={e.progress} /></div>}
      {e.error && <div className="note bad" style={{ marginTop: 8 }}>{e.error}</div>}
      {ins && ins.warnings.map((w) => <div key={w} className="note warn" style={{ marginTop: 8 }}>{w}</div>)}
      {open && ins && opts && (
        <div className="file-settings">
          <div className="row">
            <label className="field">Encoding
              <select className="input" value={opts.encoding} onChange={(ev) => onReload({ encoding: ev.target.value })}>
                {ENCODINGS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
            <label className="field">Delimiter
              <select className="input" value={opts.delimiter} onChange={(ev) => onReload({ delimiter: ev.target.value })}>
                {DELIMITERS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
            <label className="check" style={{ marginTop: 18 }}>
              <input type="checkbox" checked={opts.hasHeader} onChange={(ev) => onReload({ hasHeader: ev.target.checked })} />
              First row has column names
            </label>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            Detected automatically. Changing a setting reads the file again. Showing the first {ins.preview.length} rows;
            the shaded columns are the suggested latitude/longitude.
          </div>
          <div className="preview-wrap">
            <table className="preview">
              <thead>
                <tr>
                  <th>#</th>
                  {ins.headers.map((h, i) => (
                    <th key={i} className={i === opts.latCol ? 'lat' : i === opts.lonCol ? 'lon' : ''}>{h}{i === opts.latCol ? ' (Lat)' : i === opts.lonCol ? ' (Lon)' : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ins.preview.map((r, ri) => (
                  <tr key={ri}>
                    <td className="muted">{ri + 1}</td>
                    {ins.headers.map((_, ci) => <td key={ci} className={ci === opts.latCol ? 'lat' : ci === opts.lonCol ? 'lon' : ''} title={r[ci]}>{r[ci]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
