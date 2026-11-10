import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataClient, WorkerError } from './lib/workerClient';
import type { DatasetInfo, FieldInfo, InspectResult, LoadOptions, ViewConfig, ViewResult } from './lib/types';
import { DEFAULT_DISPLAY, DEFAULT_VIEW, STEPS, defaultTooltipFields, type DisplaySettings, type DsEntry } from './state';
import { storage, type StoredFile } from './lib/storage';
import { fmtBytes, fmtInt } from './lib/values';
import { BottomBar, Header, Modal, Stepper, Toast } from './components/Shell';
import { ImportStep } from './components/ImportStep';
import { CoordinatesStep } from './components/CoordinatesStep';
import { DisplayStep } from './components/DisplayStep';
import { MapStep } from './components/MapStep';
import { ExportStep } from './components/ExportStep';
import type { Buffers } from './components/MapView';

type Meta = Omit<ViewResult, 'positions' | 'colors' | 'ids'>;

let nextId = 1;
// One data worker for the lifetime of the page (restarted on Reset).
const sharedClient = new DataClient();

export default function App() {
  const client = sharedClient;
  const [step, setStep] = useState(0);
  const [entries, setEntries] = useState<DsEntry[]>([]);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [view, setViewState] = useState<ViewConfig>(DEFAULT_VIEW);
  const [display, setDisplayState] = useState<DisplaySettings>(() => {
    const saved = storage.loadSettings<DisplaySettings>();
    return saved.persist ? { ...DEFAULT_DISPLAY, ...saved, tooltipFields: [] } : DEFAULT_DISPLAY;
  });
  const [meta, setMeta] = useState<Meta | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [selVersion, setSelVersion] = useState(0);
  const [applyNonce, setApplyNonce] = useState(0);
  const [tableColumns, setTableColumns] = useState<string[]>([]);
  const [toast, setToast] = useState('');
  const [fatal, setFatal] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stored, setStored] = useState<StoredFile[]>([]);
  const buffers = useRef<Buffers | null>(null);
  const prevFieldCount = useRef(0);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const displayRef = useRef(display);
  displayRef.current = display;
  const viewRef = useRef(view);
  viewRef.current = view;

  const setView = useCallback((f: (v: ViewConfig) => ViewConfig) => setViewState(f), []);
  const setDisplay = useCallback((f: (d: DisplaySettings) => DisplaySettings) => setDisplayState(f), []);
  const patch = (id: number, p: Partial<DsEntry>) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...p } : e)));

  useEffect(() => { client.onCrash = (m) => setFatal(m); }, [client]);
  useEffect(() => { if (display.persist) storage.saveSettings({ ...display, tooltipFields: [] }); }, [display]);
  useEffect(() => { if (display.persist) storage.list().then(setStored); }, [display.persist]);
  useEffect(() => {
    // Warn before closing the tab while data is loaded (it is not saved unless the user chose to).
    const h = (e: BeforeUnloadEvent) => { if (entriesRef.current.length && !displayRef.current.persist) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const ready = entries.filter((e) => e.status === 'ready' && e.info);
  const readyKey = ready.map((e) => `${e.id}:${e.info!.latCol}:${e.info!.lonCol}`).join(',');
  const anyLoading = entries.some((e) => e.status === 'loading' || e.status === 'inspecting');
  const totalValid = ready.reduce((s, e) => s + e.info!.valid, 0);
  const coordFields = useMemo(() => {
    const s = new Set<string>();
    for (const e of ready) { const c = e.info!.columns; if (c[e.info!.latCol]) s.add(c[e.info!.latCol].name); if (c[e.info!.lonCol]) s.add(c[e.info!.lonCol].name); }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey]);

  // ---------------------------------------------------------------- dataset changes
  const refreshFields = useCallback(async () => {
    const f = await client.call<FieldInfo[]>('fields');
    setFields(f);
    const names = new Set(f.map((x) => x.name));
    setView((v) => {
      let color = v.color;
      if (color.mode === 'category' && !color.fields.every((x) => names.has(x))) color = { mode: 'dataset' };
      if (color.mode === 'numeric' && !names.has(color.field)) color = { mode: 'dataset' };
      // In “by source file” mode legend classes follow the file order, which changes when files are added/removed.
      const resetHidden = color !== v.color || color.mode === 'dataset';
      return { ...v, filters: v.filters.filter((x) => names.has(x.field)), color, hiddenClasses: resetHidden ? [] : v.hiddenClasses };
    });
    setDisplay((d) => {
      const kept = d.tooltipFields.filter((x) => names.has(x));
      // Suggest fields the first time (or when all chosen fields disappeared); respect a deliberately empty choice.
      const suggest = kept.length === 0 && (prevFieldCount.current === 0 || d.tooltipFields.length > 0);
      return { ...d, tooltipFields: suggest ? defaultTooltipFields(f, new Set()) : kept };
    });
    prevFieldCount.current = f.length;
    setTableColumns((c) => {
      const kept = c.filter((x) => names.has(x));
      return kept.length ? kept : f.slice(0, 10).map((x) => x.name);
    });
    setSelectedCount(await client.call<number>('select', [{ kind: 'ids', ids: [], mode: 'add' }]));
    setSelVersion((v) => v + 1);
  }, [client, setView, setDisplay]);

  const load = useCallback(async (id: number, file: Blob, name: string, opts: LoadOptions) => {
    patch(id, { status: 'loading', progress: 0, rowsSoFar: 0, error: undefined, opts });
    const [p, job] = client.start<DatasetInfo>('load', [id, name, file, opts], (pr) => patch(id, { progress: pr.fraction, rowsSoFar: pr.rows }));
    patch(id, { jobId: job });
    try {
      const info = await p;
      patch(id, { status: 'ready', info, progress: 1, opts: { ...opts, latCol: info.latCol, lonCol: info.lonCol } });
      // a file added while some files are un-ticked in “Source files” should still be shown
      setView((v) => (v.sourceFiles && !v.sourceFiles.includes(id) ? { ...v, sourceFiles: [...v.sourceFiles, id] } : v));
      await refreshFields();
      return info;
    } catch (e) {
      const we = e as WorkerError;
      patch(id, { status: we.cancelled ? 'cancelled' : 'error', error: we.cancelled ? undefined : we.message });
      await refreshFields();
      return null;
    }
  }, [client, refreshFields]);

  const inspectAndLoad = useCallback(async (id: number, file: Blob, name: string, override?: Partial<LoadOptions>, keepCoords?: { lat: number; lon: number }) => {
    patch(id, { status: 'inspecting', error: undefined });
    try {
      const ins = await client.call<InspectResult>('inspect', [file, override]);
      const opts: LoadOptions = {
        encoding: ins.encoding, delimiter: ins.delimiter, hasHeader: ins.hasHeader,
        latCol: keepCoords && keepCoords.lat < ins.headers.length ? keepCoords.lat : ins.latGuess,
        lonCol: keepCoords && keepCoords.lon < ins.headers.length ? keepCoords.lon : ins.lonGuess,
      };
      patch(id, { inspect: ins, opts });
      return await load(id, file, name, opts);
    } catch (e) {
      patch(id, { status: 'error', error: (e as Error).message });
      return null;
    }
  }, [client, load]);

  const addFiles = useCallback(async (files: (File | StoredFile)[]) => {
    const items = files.map((f) => {
      const isStored = 'key' in f && 'opts' in f;
      const file = isStored ? (f as StoredFile).file : (f as File);
      const name = isStored ? (f as StoredFile).name : (f as File).name;
      const id = nextId++;
      const entry: DsEntry = { id, name, size: file.size, file, status: 'inspecting', progress: 0, rowsSoFar: 0, storageKey: isStored ? (f as StoredFile).key : undefined };
      return { entry, stored: isStored ? (f as StoredFile) : null };
    });
    setEntries((list) => [...list, ...items.map((x) => x.entry)]);
    // read files one after another: keeps peak memory lower and progress clearer
    for (const { entry, stored: st } of items) {
      const info = st
        ? await inspectAndLoad(entry.id, entry.file, entry.name, st.opts, { lat: st.opts.latCol, lon: st.opts.lonCol })
        : await inspectAndLoad(entry.id, entry.file, entry.name);
      if (info && displayRef.current.persist && !st) {
        const key = `${entry.name}|${entry.size}|${Date.now()}`;
        const opts: LoadOptions = { encoding: info.encoding, delimiter: info.delimiter, hasHeader: info.hasHeader, latCol: info.latCol, lonCol: info.lonCol };
        storage.save({ key, name: entry.name, file: entry.file, opts, savedAt: Date.now() })
          .then(() => patch(entry.id, { storageKey: key }))
          .catch(() => setToast('Could not save the file in this browser (storage full or blocked).'));
      }
    }
  }, [inspectAndLoad]);

  const removeEntry = async (id: number) => {
    const e = entries.find((x) => x.id === id);
    if (e?.jobId && e.status === 'loading') client.cancel(e.jobId);
    setEntries((list) => list.filter((x) => x.id !== id));
    setView((v) => ({ ...v, hiddenDatasets: v.hiddenDatasets.filter((x) => x !== id), sourceFiles: v.sourceFiles ? v.sourceFiles.filter((x) => x !== id) : null }));
    await client.call('remove', [id]);
    if (e?.storageKey) storage.remove(e.storageKey).then(() => storage.list().then(setStored));
    await refreshFields();
  };

  const reloadEntry = (id: number, o: Partial<LoadOptions>) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const override = { ...e.opts, ...o };
    const headerChange = o.delimiter !== undefined || o.hasHeader !== undefined;
    inspectAndLoad(id, e.file, e.name, override, headerChange || !e.opts ? undefined : { lat: e.opts.latCol, lon: e.opts.lonCol });
  };

  const setCoords = async (id: number, lat: number, lon: number) => {
    const info = await client.call<DatasetInfo>('setCoords', [id, lat, lon]);
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, info, opts: e.opts ? { ...e.opts, latCol: lat, lonCol: lon } : e.opts } : e)));
    const e = entries.find((x) => x.id === id);
    if (e?.storageKey && e.opts) storage.save({ key: e.storageKey, name: e.name, file: e.file, opts: { ...e.opts, latCol: lat, lonCol: lon }, savedAt: Date.now() }).catch(() => {});
    await refreshFields();
  };

  const loadSamples = async () => {
    const base = import.meta.env.BASE_URL;
    const names = ['sample_consumers.csv', 'sample_transformers_semicolon.csv', 'sample_with_errors.csv'];
    try {
      const files = await Promise.all(names.map(async (n) => {
        const r = await fetch(`${base}samples/${n}`);
        if (!r.ok) throw new Error(`Could not load ${n}`);
        return new File([await r.blob()], n, { type: 'text/csv' });
      }));
      addFiles(files);
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  const downloadInvalid = async (id: number) => {
    const blob = await client.call<Blob>('invalidCsv', [id]);
    const e = entries.find((x) => x.id === id);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(e?.name || 'file').replace(/\.[^.]+$/, '')}_problem_rows.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  };

  // ---------------------------------------------------------------- apply view (debounced)
  useEffect(() => {
    if (!ready.length) { buffers.current = null; setMeta(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await client.call<ViewResult>('applyView', [view]);
        if (!live) return;
        buffers.current = { positions: r.positions, colors: r.colors, ids: r.ids, version: r.version };
        const { positions: _p, colors: _c, ids: _i, ...m } = r;
        void _p; void _c; void _i;
        setMeta(m);
        setSelectedCount(r.selectedCount);
      } catch (e) {
        if (live && !(e instanceof WorkerError && e.cancelled)) setToast((e as Error).message);
      } finally {
        if (live) setBusy(false);
      }
    }, 120);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, readyKey, applyNonce, client]);

  const onSelectionChanged = useCallback((n: number) => {
    setSelectedCount(n);
    setSelVersion((v) => v + 1);
    if (viewRef.current.selectedOnly) setApplyNonce((x) => x + 1);
  }, []);

  // ---------------------------------------------------------------- reset
  const doReset = async (alsoStorage: boolean) => {
    client.restart();
    if (alsoStorage) { await storage.clearAll(); setStored([]); }
    setEntries([]);
    setFields([]);
    setViewState(DEFAULT_VIEW);
    setDisplayState(alsoStorage ? DEFAULT_DISPLAY : { ...display, tooltipFields: [] });
    setMeta(null);
    buffers.current = null;
    setSelectedCount(0);
    setTableColumns([]);
    setStep(0);
    setResetOpen(false);
    setFatal('');
    setToast(alsoStorage ? 'Everything cleared, including data saved in this browser.' : 'All loaded data cleared.');
  };

  // ---------------------------------------------------------------- navigation
  const maxReachable = !ready.length ? 0 : totalValid === 0 ? 1 : 4;
  const canNext = step < maxReachable && !(step === 0 && anyLoading && !ready.length);
  const filtersActive = view.filters.length > 0 || !!view.search || !!view.sourceFiles || view.hiddenClasses.length > 0 || view.selectedOnly;
  const info = step === 0
    ? (anyLoading ? 'Reading files…' : ready.length ? `${ready.length} file(s) · ${fmtInt(totalValid)} valid locations` : 'Add at least one CSV file to continue')
    : step === 1 ? (totalValid ? `${fmtInt(totalValid)} locations can be mapped` : 'Choose latitude and longitude columns')
      : meta ? `${fmtInt(meta.filteredCount)} of ${fmtInt(meta.totalValid)} records match${selectedCount ? ` · ${fmtInt(selectedCount)} selected` : ''}` : '';

  return (
    <div className="app">
      <Header onReset={() => setResetOpen(true)} onSettings={() => setSettingsOpen(true)} />
      <Stepper step={step} maxReachable={maxReachable} onGo={setStep} />
      <main className={`main ${step === 3 ? 'map-mode' : ''}`}>
        {fatal && <div className="note bad" style={{ margin: 12 }}>{fatal} <button className="linklike" onClick={() => doReset(false)}>Start again</button></div>}
        {step === 0 && (
          <ImportStep entries={entries} onAdd={addFiles} onRemove={removeEntry} onCancel={(id) => { const e = entries.find((x) => x.id === id); if (e?.jobId) client.cancel(e.jobId); }}
            onReload={reloadEntry} onSamples={loadSamples}
            stored={display.persist ? { count: stored.length, onRestore: () => addFiles(stored), onDelete: async () => { await storage.clearAll(); storage.saveSettings(display); setStored([]); } } : null} />
        )}
        {step === 1 && <CoordinatesStep entries={entries} onSetCoords={setCoords} onDownloadInvalid={downloadInvalid} />}
        {step === 2 && <DisplayStep client={client} fields={fields} entries={ready} view={view} setView={setView} display={display} setDisplay={setDisplay} coordFields={coordFields} />}
        {step === 3 && (
          <MapStep client={client} entries={ready} fields={fields} view={view} setView={setView} display={display} setDisplay={setDisplay}
            meta={meta} buffers={buffers} busy={busy} selectedCount={selectedCount} selVersion={selVersion} onSelectionChanged={onSelectionChanged}
            tableColumns={tableColumns} setTableColumns={setTableColumns} notify={setToast} onError={setFatal} />
        )}
        {step === 4 && (
          <ExportStep client={client} entries={ready} fields={fields} meta={meta} selectedCount={selectedCount} coordFields={coordFields}
            tooltipFields={display.tooltipFields} filtersActive={filtersActive} notify={setToast} />
        )}
      </main>
      <BottomBar step={step} canNext={canNext} info={info} onBack={() => setStep((s) => Math.max(0, s - 1))} onNext={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
        nextLabel={step === 3 ? 'Export' : undefined} />

      {resetOpen && (
        <Modal title="Reset the application?" onClose={() => setResetOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setResetOpen(false)}>Keep working</button>
            {display.persist && <button className="btn danger" onClick={() => doReset(true)}>Reset and delete saved data</button>}
            <button className="btn primary" onClick={() => doReset(!display.persist)}>Reset</button>
          </>}>
          <p className="muted">This removes all loaded files, filters, colours and selections from this tab and frees the memory. Your original CSV files on disk are not touched.</p>
        </Modal>
      )}
      {settingsOpen && <SettingsModal display={display} setDisplay={setDisplay} stored={stored} onClose={() => setSettingsOpen(false)}
        onClearStorage={async () => { await storage.clearAll(); setStored([]); setDisplayState((d) => ({ ...d, persist: false })); setEntries((l) => l.map((e) => ({ ...e, storageKey: undefined }))); setToast('Saved data deleted from this browser.'); }} />}
      {toast && <Toast text={toast} onDone={() => setToast('')} />}
    </div>
  );
}

function SettingsModal({ display, setDisplay, stored, onClose, onClearStorage }: {
  display: DisplaySettings; setDisplay: (f: (d: DisplaySettings) => DisplaySettings) => void; stored: StoredFile[]; onClose: () => void; onClearStorage: () => void;
}) {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => { storage.estimate().then(setUsage); }, [stored.length]);
  return (
    <Modal title="Privacy & storage" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="note" style={{ marginBottom: 12 }}>
        Your CSV files are read and processed only inside this browser tab. They are never uploaded to any server, including GitHub.
        The only internet requests are for background map tiles from the selected map provider (which sees the map area you view, not your data).
      </div>
      <label className="check" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={display.persist} onChange={(e) => {
          const on = e.target.checked;
          setDisplay((d) => ({ ...d, persist: on }));
          if (!on) onClearStorage();
        }} style={{ marginTop: 4 }} />
        <span>
          <b>Remember files in this browser</b><br />
          <span className="small muted">Keeps copies of files you add from now on, plus your map settings, in this browser’s private storage so they can be reopened after closing the tab. Off by default. Turning it off deletes everything saved.</span>
        </span>
      </label>
      {display.persist && (
        <div className="small muted" style={{ marginTop: 10 }}>
          {stored.length} file(s) saved{usage ? ` · ${fmtBytes(usage.usage)} used of ${fmtBytes(usage.quota)} available` : ''}.
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn danger" onClick={onClearStorage}>Delete all data saved in this browser</button>
      </div>
    </Modal>
  );
}
