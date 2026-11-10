import type { RecordDetail } from '../lib/types';

interface Props {
  rec: RecordDetail;
  titleField: string | undefined;
  highlight: boolean;
  onClose: () => void;
  onZoom: () => void;
  onToggleHighlight: () => void;
  onToggleSelect: () => void;
  onShowInTable: () => void;
  onCopied: (what: string) => void;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function InfoPanel({ rec, titleField, highlight, onClose, onZoom, onToggleHighlight, onToggleSelect, onShowInTable, onCopied }: Props) {
  const title = (titleField && rec.fields.find(([k]) => k === titleField)?.[1]) || `Row ${rec.row}`;
  const coordText = `${rec.latRaw.trim()}, ${rec.lonRaw.trim()}`;
  const details = [
    ...rec.fields.map(([k, v]) => `${k}: ${v}`),
    `Latitude: ${rec.latRaw.trim()}`,
    `Longitude: ${rec.lonRaw.trim()}`,
    `Source file: ${rec.datasetName} (row ${rec.row})`,
  ].join('\n');
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${rec.lat},${rec.lon}`;
  const osm = `https://www.openstreetmap.org/?mlat=${rec.lat}&mlon=${rec.lon}#map=17/${rec.lat}/${rec.lon}`;
  return (
    <>
      <div className="side-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>{title}</div>
          <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rec.datasetName} · row {rec.row}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details" title="Close">×</button>
      </div>
      <div className="side-body">
        <div className="note" style={{ marginBottom: 8 }}>
          <div className="mono">{coordText}</div>
          <div className="small muted">{rec.latName} / {rec.lonName} · WGS84</div>
        </div>
        <div className="actions">
          <button className="btn small" onClick={async () => onCopied((await copy(coordText)) ? 'Coordinates copied' : 'Copy failed')}>Copy coordinates</button>
          <button className="btn small" onClick={async () => onCopied((await copy(details)) ? 'Record details copied' : 'Copy failed')}>Copy details</button>
          <button className="btn small" onClick={onZoom}>Zoom to point</button>
          <button className={`btn small ${highlight ? 'primary' : ''}`} onClick={onToggleHighlight}>{highlight ? 'Highlighted' : 'Highlight'}</button>
          <button className="btn small" onClick={onToggleSelect}>{rec.selected ? '− Remove from selection' : '+ Add to selection'}</button>
          <button className="btn small" onClick={onShowInTable}>Show in table</button>
        </div>
        <div className="row small" style={{ marginBottom: 10 }}>
          <span className="muted">Open in</span>
          <a href={gmaps} target="_blank" rel="noopener noreferrer">Google Maps</a>
          <a href={osm} target="_blank" rel="noopener noreferrer">OpenStreetMap</a>
        </div>
        <table className="detail-table">
          <tbody>
            {rec.fields.map(([k, v], i) => <tr key={i}><td>{k}</td><td>{v === '' ? <span className="muted">—</span> : v}</td></tr>)}
            <tr><td>Source file</td><td>{rec.datasetName}</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
