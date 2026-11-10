import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataClient } from '../lib/workerClient';
import type { FieldInfo, RecordDetail, ViewConfig, ViewResult } from '../lib/types';
import { schemeLabel, type DisplaySettings, type DsEntry } from '../state';
import { fmtInt } from '../lib/values';
import { MapView, type Buffers, type MapHandle } from './MapView';
import { FilterPanel, LayersPanel } from './FilterPanel';
import { InfoPanel } from './InfoPanel';
import { AttributeTable } from './AttributeTable';
import { SearchBox } from './SearchBox';

type Meta = Omit<ViewResult, 'positions' | 'colors' | 'ids'>;

interface Props {
  client: DataClient;
  entries: DsEntry[];
  fields: FieldInfo[];
  view: ViewConfig;
  setView: (f: (v: ViewConfig) => ViewConfig) => void;
  display: DisplaySettings;
  setDisplay: (f: (d: DisplaySettings) => DisplaySettings) => void;
  meta: Meta | null;
  buffers: React.MutableRefObject<Buffers | null>;
  busy: boolean;
  selectedCount: number;
  selVersion: number;
  onSelectionChanged: (count: number) => void;
  tableColumns: string[];
  setTableColumns: (c: string[]) => void;
  notify: (s: string) => void;
  onError: (s: string) => void;
}

export function MapStep(p: Props) {
  const { client, entries, fields, view, setView, display, setDisplay, meta, buffers, busy, selectedCount, selVersion, onSelectionChanged, notify } = p;
  const mapRef = useRef<MapHandle>(null);
  const wsRef = useRef<HTMLDivElement>(null);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 980;
  const [leftOpen, setLeftOpen] = useState(!narrow);
  const [tab, setTab] = useState<'filters' | 'layers'>('filters');
  const [tableOpen, setTableOpen] = useState(false);
  const [rectMode, setRectMode] = useState(false);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  const [locate, setLocate] = useState<{ id: number; n: number } | null>(null);
  const fitted = useRef(false);

  // fit to data the first time the map has data
  useEffect(() => {
    if (!fitted.current && meta?.bbox && mapRef.current) {
      fitted.current = true;
      mapRef.current.fitBounds(meta.bbox);
    }
  }, [meta]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setRectMode(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const pick = useCallback(async (id: number, zoom = false) => {
    const r = await client.call<RecordDetail | null>('record', [id]);
    if (!r) return;
    setRecord(r);
    setHighlight(true);
    if (zoom) mapRef.current?.flyTo(r.lon, r.lat);
    setLocate({ id, n: Date.now() });
  }, [client]);

  // refresh the open record's selected flag after selection changes
  useEffect(() => {
    if (!record) return;
    client.call<RecordDetail | null>('record', [record.id]).then((r) => { if (r) setRecord(r); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selVersion]);

  const select = async (op: unknown) => onSelectionChanged(await client.call<number>('select', [op]));

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wsRef.current?.requestFullscreen?.().catch(() => notify('Full screen is not available in this browser.'));
  };

  const titleField = display.tooltipFields[0];
  const legend = meta?.legend ?? [];
  const hidden = new Set(view.hiddenClasses);
  const toggleClass = (c: number) => setView((v) => ({ ...v, hiddenClasses: hidden.has(c) ? v.hiddenClasses.filter((x) => x !== c) : [...v.hiddenClasses, c] }));
  const onlyClass = (c: number) => setView((v) => ({ ...v, hiddenClasses: legend.map((l) => l.cls).filter((x) => x !== c) }));
  const searchDefault = fields.find((f) => /consumer.*(no|num)/i.test(f.name))?.name || '';

  return (
    <div className="workspace" ref={wsRef}>
      {leftOpen && (
        <aside className="side" aria-label="Filters and layers">
          <div className="side-head">
            <div className="side-tabs">
              <button className={tab === 'filters' ? 'on' : ''} onClick={() => setTab('filters')}>Filters{view.filters.length ? ` (${view.filters.length})` : ''}</button>
              <button className={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')}>Layers</button>
            </div>
            <button className="icon-btn" onClick={() => setLeftOpen(false)} title="Hide panel" aria-label="Hide panel">«</button>
          </div>
          <div className="side-body">
            {tab === 'filters'
              ? <FilterPanel client={client} fields={fields} entries={entries} view={view} setView={setView} meta={meta} selectedCount={selectedCount}
                  onSelect={(op) => select(op === 'filtered' ? { kind: 'filtered' } : { kind: 'clear' })} />
              : <LayersPanel entries={entries} view={view} setView={setView} meta={meta} display={display} setDisplay={setDisplay} />}
          </div>
        </aside>
      )}

      <div className="map-col">
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <MapView ref={mapRef} client={client} buffers={buffers} version={meta?.version ?? 0} renderCount={meta?.renderCount ?? 0}
            display={display} selVersion={selVersion} active={record ? { id: record.id, lon: record.lon, lat: record.lat } : null}
            highlight={highlight} rectMode={rectMode}
            onRectDone={async (b) => {
              setRectMode(false);
              if (!b) return;
              const before = selectedCount;
              const n = await client.call<number>('select', [{ kind: 'bbox', bbox: b, hiddenDatasets: view.hiddenDatasets }]);
              onSelectionChanged(n);
              notify(`${fmtInt(n - before)} records added to the selection (${fmtInt(n)} selected).`);
            }}
            onPick={(id) => pick(id)} onError={p.onError} />

          <div className="map-toolbar">
            {!leftOpen && <div className="floating tool-group"><button className="icon-btn" onClick={() => setLeftOpen(true)} title="Show filters" aria-label="Show filters">☰</button></div>}
            <SearchBox client={client} fields={fields} dataVersion={meta?.version ?? 0} defaultField={searchDefault}
              onGo={(bbox, single) => { mapRef.current?.fitBounds(bbox); if (single !== null) pick(single); }} />
            <div className="floating tool-group">
              <button className="icon-btn" title="Zoom to all filtered points" aria-label="Fit to data" onClick={() => meta?.bbox && mapRef.current?.fitBounds(meta.bbox)}>⤢</button>
              <button className={`icon-btn ${rectMode ? 'on' : ''}`} title="Select points with a rectangle" aria-label="Rectangle select" onClick={() => setRectMode((r) => !r)}>⬚</button>
              <button className={`icon-btn ${tableOpen ? 'on' : ''}`} title="Show the records table" aria-label="Table" onClick={() => setTableOpen((t) => !t)}>▦</button>
              <button className="icon-btn" title="Full screen" aria-label="Full screen" onClick={fullscreen}>⛶</button>
            </div>
          </div>

          {busy && <div className="busy floating">Updating…</div>}

          {legend.length > 0 && (
            <div className="map-status floating legend">
              <div className="legend-head">
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Colour: {schemeLabel(view.color)}</span>
                {hidden.size > 0 && <button className="linklike" onClick={() => setView((v) => ({ ...v, hiddenClasses: [] }))}>Show all</button>}
                <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setLegendOpen((o) => !o)} aria-label="Toggle legend">{legendOpen ? '▾' : '▸'}</button>
              </div>
              {legendOpen && legend.map((l) => (
                <div key={l.cls} className={`legend-item ${hidden.has(l.cls) ? 'off' : ''}`} onClick={() => toggleClass(l.cls)} onDoubleClick={() => onlyClass(l.cls)}
                  title="Click to hide/show · double-click to show only this">
                  <span className="swatch" style={{ background: l.color }} />
                  <span className="lbl">{l.label}</span>
                  <span className="cnt">{fmtInt(l.count)}</span>
                </div>
              ))}
              {legendOpen && <div className="small muted" style={{ marginTop: 4 }}>Click to hide · double-click for only</div>}
            </div>
          )}

          <div className="map-summary floating">
            <b>{fmtInt(meta?.filteredCount ?? 0)}</b> matching
            {meta?.sampled && <> · {fmtInt(meta.renderCount)} drawn (even sample)</>}
            {selectedCount > 0 && <> · <b>{fmtInt(selectedCount)}</b> selected</>}
          </div>
        </div>

        {tableOpen && (
          <AttributeTable client={client} fields={fields} columns={p.tableColumns} setColumns={p.setTableColumns}
            dataVersion={meta?.version ?? 0} selVersion={selVersion} activeId={record?.id ?? null} locate={locate}
            onRowClick={(id) => pick(id, true)} onSelectionChanged={onSelectionChanged} onClose={() => setTableOpen(false)} />
        )}
      </div>

      {record && (
        <aside className="side right" aria-label="Record details">
          <InfoPanel rec={record} titleField={titleField} highlight={highlight}
            onClose={() => setRecord(null)}
            onZoom={() => mapRef.current?.flyTo(record.lon, record.lat)}
            onToggleHighlight={() => setHighlight((h) => !h)}
            onToggleSelect={() => select({ kind: 'ids', ids: [record.id], mode: record.selected ? 'remove' : 'add' })}
            onShowInTable={() => { setTableOpen(true); setLocate({ id: record.id, n: Date.now() }); }}
            onCopied={notify} />
        </aside>
      )}
    </div>
  );
}
