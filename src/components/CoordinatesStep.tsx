import type { DsEntry } from '../state';
import { INVALID_REASONS } from '../lib/types';
import { fmtInt } from '../lib/values';

interface Props {
  entries: DsEntry[];
  onSetCoords: (id: number, lat: number, lon: number) => void;
  onDownloadInvalid: (id: number) => void;
}

export function CoordinatesStep({ entries, onSetCoords, onDownloadInvalid }: Props) {
  const ready = entries.filter((e) => e.status === 'ready' && e.info);
  const rows = ready.reduce((s, e) => s + e.info!.rows, 0);
  const valid = ready.reduce((s, e) => s + e.info!.valid, 0);
  const suspect = ready.reduce((s, e) => s + e.info!.suspect, 0);
  return (
    <div className="page">
      <h1 className="page-title">Which columns hold the coordinates?</h1>
      <p className="page-sub">We picked the likely Latitude and Longitude columns for each file. Check them and review any problem rows.</p>

      <div className="tiles">
        <div className="tile"><div className="v">{ready.length}</div><div className="l">Files</div></div>
        <div className="tile"><div className="v">{fmtInt(rows)}</div><div className="l">Rows</div></div>
        <div className="tile"><div className="v" style={{ color: 'var(--strong)' }}>{fmtInt(valid)}</div><div className="l">Valid locations</div></div>
        <div className="tile"><div className="v">{fmtInt(rows - valid)}</div><div className="l">Cannot be plotted{suspect ? ` · ${fmtInt(suspect)} suspicious` : ''}</div></div>
      </div>

      <div className="note" style={{ marginBottom: 16 }}>
        Coordinates must be WGS84 decimal degrees (for example 25.6123, 85.1376) — the format used by GPS and Google Maps.
        Original values are never changed; rows that cannot be plotted stay in your data and can be downloaded for correction.
      </div>

      {ready.length === 0 && <div className="empty">No files are ready yet. Go back and add a CSV file.</div>}

      {ready.map((e) => {
        const info = e.info!;
        const cols = info.columns;
        const problems = info.rows - info.valid;
        return (
          <div className="card" key={e.id}>
            <div className="card-title">
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              {info.valid === info.rows ? <span className="tag ok">All rows valid</span>
                : info.valid === 0 ? <span className="tag bad">No valid locations</span>
                  : <span className="tag warn">{fmtInt(problems)} problem rows</span>}
            </div>
            <div className="coord-grid">
              <label className="field">Latitude column (north–south, −90 to 90)
                <select className="input" value={info.latCol} onChange={(ev) => onSetCoords(e.id, Number(ev.target.value), info.lonCol)}>
                  <option value={-1}>— choose —</option>
                  {cols.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
                </select>
              </label>
              <label className="field">Longitude column (east–west, −180 to 180)
                <select className="input" value={info.lonCol} onChange={(ev) => onSetCoords(e.id, info.latCol, Number(ev.target.value))}>
                  <option value={-1}>— choose —</option>
                  {cols.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
                </select>
              </label>
              <button className="btn swap" title="Swap the two columns" onClick={() => onSetCoords(e.id, info.lonCol, info.latCol)} disabled={info.latCol < 0 || info.lonCol < 0}>⇄ Swap</button>
            </div>
            <div className="stat-list">
              <div><span>Valid locations</span><b className="strong">{fmtInt(info.valid)}</b></div>
              {INVALID_REASONS.map((r, i) => (i > 0 && info.invalid[i] > 0 ? <div key={r}><span>{r}</span><b>{fmtInt(info.invalid[i])}</b></div> : null))}
              {info.suspect > 0 && <div><span>Possibly swapped (still plotted)</span><b>{fmtInt(info.suspect)}</b></div>}
              {info.duplicates > 0 && <div><span>Share a location with another row</span><b>{fmtInt(info.duplicates)}</b></div>}
            </div>
            {info.warnings.length > 0 && <div style={{ marginTop: 12 }}>{info.warnings.map((w) => <div key={w} className="note warn">{w}</div>)}</div>}
            {(problems > 0 || info.suspect > 0) && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn small" onClick={() => onDownloadInvalid(e.id)}>⬇ Download problem rows (CSV)</button>
                <span className="small muted">All original columns plus a “Problem” column explaining each row.</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
