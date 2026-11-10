import { useEffect, useMemo, useRef, useState } from 'react';
import type { DataClient } from '../lib/workerClient';
import { WorkerError } from '../lib/workerClient';
import type { CsvExportOptions, ExportEstimate, ExportScope, FieldInfo, KmlExportOptions, ViewResult } from '../lib/types';
import type { DsEntry } from '../state';
import { fmtBytes, fmtInt } from '../lib/values';
import { Modal, Progress, Seg } from './Shell';

type Meta = Omit<ViewResult, 'positions' | 'colors' | 'ids'>;

interface Props {
  client: DataClient;
  entries: DsEntry[];
  fields: FieldInfo[];
  meta: Meta | null;
  selectedCount: number;
  coordFields: Set<string>;
  tooltipFields: string[];
  filtersActive: boolean;
  notify: (s: string) => void;
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}
function safe(s: string) {
  return (s || 'export').replace(/[^\w\-. ]+/g, '_').trim().replace(/\s+/g, '_').slice(0, 80) || 'export';
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ExportStep({ client, entries, fields, meta, selectedCount, coordFields, tooltipFields, filtersActive, notify }: Props) {
  const ready = entries.filter((e) => e.info);
  const [files, setFiles] = useState<number[]>(ready.map((e) => e.id));
  const [scope, setScope] = useState<ExportScope>(filtersActive ? 'filtered' : 'all');
  // CSV options
  const [cols, setCols] = useState<{ name: string; on: boolean }[]>(() => fields.map((f) => ({ name: f.name, on: !coordFields.has(f.name) })));
  const [latLon, setLatLon] = useState(true);
  const [source, setSource] = useState(ready.length > 1);
  const [invalid, setInvalid] = useState(false);
  // KML options
  const guessName = fields.find((f) => /consumer.*(no|num)|name/i.test(f.name))?.name || tooltipFields[0] || '';
  const [docName, setDocName] = useState('CSV Map export');
  const [nameField, setNameField] = useState(guessName);
  const [descFields, setDescFields] = useState<string[]>(tooltipFields.length ? tooltipFields : fields.slice(0, 6).map((f) => f.name));
  const [extFields, setExtFields] = useState<string[]>(fields.filter((f) => !coordFields.has(f.name)).map((f) => f.name));
  const [folderBy, setFolderBy] = useState<KmlExportOptions['folderBy']>(ready.length > 1 ? 'source' : 'none');
  const [folderField, setFolderField] = useState(fields.find((f) => f.type === 'category')?.name || fields[0]?.name || '');
  const [useColors, setUseColors] = useState(true);
  const [labels, setLabels] = useState(false);
  const [format, setFormat] = useState<KmlExportOptions['format']>('kml');
  const [splitSize, setSplitSize] = useState(100000);
  const [csvEst, setCsvEst] = useState<ExportEstimate | null>(null);
  const [kmlEst, setKmlEst] = useState<ExportEstimate | null>(null);
  const [running, setRunning] = useState<{ job: number; kind: string; done: number; total: number } | null>(null);
  const [error, setError] = useState('');

  // include newly loaded files, drop removed ones
  const readyKey = ready.map((e) => e.id).join(',');
  const prevReady = useRef(readyKey);
  useEffect(() => {
    const prev = new Set(prevReady.current.split(',').filter(Boolean).map(Number));
    prevReady.current = readyKey;
    setFiles((f) => [...f.filter((id) => ready.some((e) => e.id === id)), ...ready.filter((e) => !prev.has(e.id)).map((e) => e.id)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey]);

  // keep column list in sync with fields
  useEffect(() => {
    setCols((c) => {
      const known = new Set(c.map((x) => x.name));
      const names = new Set(fields.map((f) => f.name));
      return [...c.filter((x) => names.has(x.name)), ...fields.filter((f) => !known.has(f.name)).map((f) => ({ name: f.name, on: !coordFields.has(f.name) }))];
    });
  }, [fields, coordFields]);

  const csvOpts: CsvExportOptions = useMemo(() => ({
    datasets: files, scope, columns: cols.filter((c) => c.on).map((c) => c.name), includeLatLon: latLon, includeSource: source, includeInvalid: scope === 'all' && invalid,
  }), [files, scope, cols, latLon, source, invalid]);
  const kmlOpts: KmlExportOptions = useMemo(() => ({
    datasets: files, scope, nameField, descFields, extendedFields: extFields, folderBy, folderField, useColors, showLabels: labels, docName, format, splitSize,
  }), [files, scope, nameField, descFields, extFields, folderBy, folderField, useColors, labels, docName, format, splitSize]);

  useEffect(() => {
    const t = setTimeout(() => {
      client.call('estimateCsv', [csvOpts]).then(setCsvEst).catch(() => {});
      client.call('estimateKml', [kmlOpts]).then(setKmlEst).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [csvOpts, kmlOpts, client, meta?.version, selectedCount]);

  const move = (i: number, d: number) => setCols((c) => {
    const j = i + d;
    if (j < 0 || j >= c.length) return c;
    const n = [...c];
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });

  const run = async (kind: 'csv' | 'kml') => {
    setError('');
    const est = kind === 'csv' ? csvEst : kmlEst;
    const ext = kind === 'csv' ? 'csv' : format === 'kml' ? 'kml' : format === 'kmz' ? 'kmz' : 'zip';
    const name = kind === 'csv' ? `csv-map_${scope}_${stamp()}.csv` : `${safe(docName)}_${stamp()}.${ext}`;
    let handle: unknown;
    const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<unknown> };
    if (w.showSaveFilePicker && est && est.bytes > 300e6) {
      try {
        handle = await w.showSaveFilePicker({ suggestedName: name });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        handle = undefined;
      }
    }
    const [p, job] = client.start(kind === 'csv' ? 'exportCsv' : 'exportKml', [kind === 'csv' ? csvOpts : kmlOpts, handle], (pr) => setRunning((r) => (r ? { ...r, done: pr.done, total: pr.total } : r)));
    setRunning({ job, kind, done: 0, total: est?.count || 0 });
    try {
      const r = await p;
      if (r.blob) downloadBlob(r.blob, name);
      notify(`Exported ${fmtInt(r.count)} records${r.parts > 1 ? ` in ${r.parts} files` : ''}${handle ? ' to the chosen file' : ''}.`);
    } catch (e) {
      if (!(e instanceof WorkerError && e.cancelled)) setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  const scopeCount = (s: ExportScope) => {
    const sel = new Set(files);
    if (!meta) return 0;
    if (s === 'all') return ready.filter((e) => sel.has(e.id)).reduce((n, e) => n + (invalid ? e.info!.rows : e.info!.valid), 0);
    if (s === 'filtered') return meta.perDataset.filter((p) => sel.has(p.id)).reduce((n, p) => n + p.filtered, 0);
    return selectedCount;
  };
  const csvCols = csvOpts.columns.length + (latLon ? 2 : 0) + (source ? 1 : 0);
  const toggleIn = (list: string[], set: (l: string[]) => void, name: string, on: boolean) => set(on ? fields.map((f) => f.name).filter((n) => n === name || list.includes(n)) : list.filter((x) => x !== name));

  return (
    <div className="page">
      <h1 className="page-title">Which records do you want to export?</h1>
      <p className="page-sub">Download a CSV for Excel, or a KML/KMZ file for Google Earth and GIS software. Exports include every matching record, not just the points visible on screen.</p>

      <div className="card">
        <div className="card-title">Records</div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 28 }}>
          <div>
            <div className="small muted" style={{ marginBottom: 6 }}>Which records</div>
            <Seg value={scope} onChange={setScope} options={[
              { value: 'all', label: `All (${fmtInt(scopeCount('all'))})` },
              { value: 'filtered', label: `Filtered (${fmtInt(scopeCount('filtered'))})` },
              { value: 'selected', label: `Selected (${fmtInt(selectedCount)})` },
            ]} />
          </div>
          {ready.length > 1 && (
            <div>
              <div className="small muted" style={{ marginBottom: 6 }}>From files</div>
              {ready.map((e) => (
                <label key={e.id} className="check" style={{ padding: '2px 0' }}>
                  <input type="checkbox" checked={files.includes(e.id)} onChange={(ev) => setFiles(ev.target.checked ? [...files, e.id] : files.filter((x) => x !== e.id))} />
                  {e.name}
                </label>
              ))}
            </div>
          )}
        </div>
        {scope === 'selected' && selectedCount === 0 && <div className="note warn" style={{ marginTop: 10 }}>No records are selected. Select points on the map (click, rectangle tool) or in the table first.</div>}
      </div>

      <div className="two-col" style={{ marginTop: 14 }}>
        {/* ---------------- CSV ---------------- */}
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-title">CSV file <span className="tag">Excel</span></div>
          <div className="row small" style={{ marginBottom: 6 }}>
            <span className="muted grow">Columns — tick to include, arrows to reorder</span>
            <button className="linklike" onClick={() => setCols((c) => c.map((x) => ({ ...x, on: true })))}>All</button>
            <button className="linklike" onClick={() => setCols((c) => c.map((x) => ({ ...x, on: false })))}>None</button>
          </div>
          <div className="col-picker">
            {cols.map((c, i) => (
              <div className="col-row" key={c.name}>
                <input type="checkbox" checked={c.on} onChange={(e) => setCols((l) => l.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)))} aria-label={`Include ${c.name}`} />
                <span className="lbl" title={c.name}>{c.name}</span>
                <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => move(i, 1)} disabled={i === cols.length - 1} aria-label="Move down">↓</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            <label className="check"><input type="checkbox" checked={latLon} onChange={(e) => setLatLon(e.target.checked)} />Add “Latitude” and “Longitude” columns (from each file’s chosen columns)</label>
            <label className="check"><input type="checkbox" checked={source} onChange={(e) => setSource(e.target.checked)} />Add a “Source File” column</label>
            {scope === 'all' && <label className="check"><input type="checkbox" checked={invalid} onChange={(e) => setInvalid(e.target.checked)} />Include rows without valid coordinates</label>}
          </div>
          <div className="hr" />
          <dl className="summary-list">
            <dt>Records</dt><dd className="strong">{csvEst ? fmtInt(csvEst.count) : '…'}</dd>
            <dt>Columns</dt><dd>{csvCols}</dd>
            <dt>Size (approx.)</dt><dd>{csvEst ? fmtBytes(csvEst.bytes) : '…'}</dd>
            <dt>Format</dt><dd>CSV, UTF-8, comma-separated</dd>
          </dl>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={!csvEst?.count || !csvCols || !!running} onClick={() => run('csv')}>⬇ Download CSV</button>
          </div>
        </div>

        {/* ---------------- KML ---------------- */}
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-title">KML / KMZ <span className="tag">Google Earth</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label className="field">Document name
              <input className="input" value={docName} onChange={(e) => setDocName(e.target.value)} />
            </label>
            <label className="field">Name each location using
              <select className="input" value={nameField} onChange={(e) => setNameField(e.target.value)}>
                <option value="">Row number</option>
                {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
            </label>
            <FieldChecklist label="Show in the description balloon" fields={fields} chosen={descFields} onToggle={(n, on) => toggleIn(descFields, setDescFields, n, on)} onSet={setDescFields} />
            <FieldChecklist label="Attach as data properties (ExtendedData)" fields={fields} chosen={extFields} onToggle={(n, on) => toggleIn(extFields, setExtFields, n, on)} onSet={setExtFields} />
            <div className="row">
              <label className="field">Group into folders by
                <select className="input" value={folderBy} onChange={(e) => setFolderBy(e.target.value as KmlExportOptions['folderBy'])}>
                  <option value="none">No folders</option>
                  <option value="source">Source file</option>
                  <option value="field">A column…</option>
                </select>
              </label>
              {folderBy === 'field' && (
                <label className="field grow">Column
                  <select className="input" value={folderField} onChange={(e) => setFolderField(e.target.value)}>
                    {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <label className="check"><input type="checkbox" checked={useColors} onChange={(e) => setUseColors(e.target.checked)} />Use the map colours</label>
            <label className="check"><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />Show names as labels on the map (slower for many points)</label>
            <div className="field">File type
              <Seg value={format} onChange={setFormat} options={[{ value: 'kml', label: 'KML' }, { value: 'kmz', label: 'KMZ (compressed)' }, { value: 'split', label: 'Split into parts (.zip)' }]} />
            </div>
            {format === 'split' && (
              <label className="field">Locations per part
                <select className="input" value={splitSize} onChange={(e) => setSplitSize(Number(e.target.value))}>
                  {[25000, 50000, 100000, 200000].map((n) => <option key={n} value={n}>{fmtInt(n)}</option>)}
                </select>
              </label>
            )}
            {kmlEst && kmlEst.count > 150000 && format === 'kml' && (
              <div className="note warn">Google Earth becomes slow above roughly 1–1.5 lakh points in one file. Consider KMZ or splitting into parts.</div>
            )}
            {kmlEst && kmlEst.skippedInvalid > 0 && (
              <div className="note">{fmtInt(kmlEst.skippedInvalid)} records without valid coordinates cannot be placed in KML and will be left out.</div>
            )}
          </div>
          <div className="hr" />
          <dl className="summary-list">
            <dt>Locations</dt><dd className="strong">{kmlEst ? fmtInt(kmlEst.count) : '…'}</dd>
            <dt>Size (approx.)</dt><dd>{kmlEst ? fmtBytes(kmlEst.bytes) : '…'}</dd>
            <dt>Format</dt><dd>{format === 'kml' ? 'KML 2.2, UTF-8' : format === 'kmz' ? 'KMZ (zipped KML)' : `ZIP of ${kmlEst ? Math.max(1, Math.ceil(kmlEst.count / splitSize)) : '…'} KML files`}</dd>
          </dl>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={!kmlEst?.count || !!running} onClick={() => run('kml')}>⬇ Download {format === 'kml' ? 'KML' : format === 'kmz' ? 'KMZ' : 'KML parts (ZIP)'}</button>
          </div>
        </div>
      </div>

      {error && <div className="note bad" style={{ marginTop: 14 }}>{error}</div>}

      {running && (
        <Modal title={`Preparing ${running.kind.toUpperCase()} file…`} onClose={() => {}} footer={<button className="btn" onClick={() => client.cancel(running.job)}>Cancel</button>}>
          <Progress value={running.total ? running.done / running.total : 0} />
          <div className="small muted" style={{ marginTop: 8 }}>{fmtInt(running.done)} of {fmtInt(running.total)} records written</div>
        </Modal>
      )}
    </div>
  );
}

function FieldChecklist({ label, fields, chosen, onToggle, onSet }: { label: string; fields: FieldInfo[]; chosen: string[]; onToggle: (n: string, on: boolean) => void; onSet: (l: string[]) => void }) {
  return (
    <details className="more" style={{ marginTop: 0 }}>
      <summary>{label} ({chosen.length})</summary>
      <div className="row small" style={{ margin: '6px 0' }}>
        <button className="linklike" onClick={() => onSet(fields.map((f) => f.name))}>All</button>
        <button className="linklike" onClick={() => onSet([])}>None</button>
      </div>
      <div className="col-picker" style={{ maxHeight: 200 }}>
        {fields.map((f) => (
          <label className="col-row check" key={f.name}>
            <input type="checkbox" checked={chosen.includes(f.name)} onChange={(e) => onToggle(f.name, e.target.checked)} />
            <span className="lbl">{f.name}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
