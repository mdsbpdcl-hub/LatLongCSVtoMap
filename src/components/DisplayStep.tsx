import { useEffect, useMemo, useState } from 'react';
import type { DataClient } from '../lib/workerClient';
import type { CategoryGroup, ColorScheme, FieldInfo, NumericBin, ViewConfig } from '../lib/types';
import { binLabel, defaultBins, defaultGroups, NEW_OTHERS, type DisplaySettings, type DsEntry } from '../state';
import { BASEMAPS } from '../lib/basemaps';
import { CATEGORY_PALETTE, DATASET_PALETTE, NUMERIC_RAMP, fmtInt } from '../lib/values';
import { Seg } from './Shell';

interface Props {
  client: DataClient;
  fields: FieldInfo[];
  entries: DsEntry[];
  view: ViewConfig;
  setView: (f: (v: ViewConfig) => ViewConfig) => void;
  display: DisplaySettings;
  setDisplay: (f: (d: DisplaySettings) => DisplaySettings) => void;
  coordFields: Set<string>;
}

export function DisplayStep(p: Props) {
  return (
    <div className="page">
      <h1 className="page-title">How should the points look?</h1>
      <p className="page-sub">Choose what decides the colour of each point, what shows when you hover, and the background map.</p>
      <div className="card">
        <div className="card-title">Point colours</div>
        <ColorEditor {...p} />
      </div>
      <div className="two-col" style={{ marginTop: 14 }}>
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-title">Hover information</div>
          <TooltipPicker {...p} />
        </div>
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-title">Map settings</div>
          <MapSettings {...p} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ colours
export function ColorEditor({ client, fields, entries, view, setView, coordFields }: Props) {
  const scheme = view.color;
  const setScheme = (s: ColorScheme) => setView((v) => ({ ...v, color: s, hiddenClasses: [] }));
  const catFields = fields.filter((f) => !coordFields.has(f.name));
  const numFields = fields.filter((f) => f.type === 'number' && !coordFields.has(f.name));
  const [distinct, setDistinct] = useState<{ value: string; count: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const catKey = scheme.mode === 'category' ? scheme.fields.join('\u0001') : '';

  useEffect(() => {
    if (scheme.mode !== 'category' || !scheme.fields.length) { setDistinct([]); return; }
    let live = true;
    setLoading(true);
    client.call('distinctCombos', [scheme.fields, 500]).then((d) => { if (live) { setDistinct(d); setLoading(false); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catKey, entries.length]);

  const startCategory = async (flds: string[]) => {
    if (!flds.length) return;
    const d = await client.call('distinctCombos', [flds, 500]);
    setScheme({ mode: 'category', fields: flds, groups: defaultGroups(d), othersColor: NEW_OTHERS });
  };
  const startNumeric = (name: string) => {
    const mins = entries.flatMap((e) => e.info?.columns.filter((c) => c.name === name && c.min !== undefined).map((c) => c.min!) || []);
    const maxs = entries.flatMap((e) => e.info?.columns.filter((c) => c.name === name && c.max !== undefined).map((c) => c.max!) || []);
    setScheme({ mode: 'numeric', field: name, bins: defaultBins(Math.min(...mins), Math.max(...maxs)), noValueColor: NEW_OTHERS });
  };

  const changeMode = (m: string) => {
    if (m === 'dataset') setScheme({ mode: 'dataset' });
    else if (m === 'category') {
      const pick = catFields.find((f) => /status/i.test(f.name) && f.type === 'category')
        || catFields.filter((f) => f.type === 'category').sort((a, b) => a.distinct - b.distinct).find((f) => f.distinct > 1)
        || catFields[0];
      if (pick) startCategory([pick.name]);
    } else {
      const pick = numFields.find((f) => /amount|outstanding|due|arrear|load|kw|kva|bill/i.test(f.name)) || numFields[0];
      if (pick) startNumeric(pick.name);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Seg value={scheme.mode} onChange={changeMode} options={[
          { value: 'dataset', label: 'By source file' },
          { value: 'category', label: 'By field values' },
          { value: 'numeric', label: 'By number ranges' },
        ]} />
        <div className="grow" />
        <button className="btn small" onClick={() => { setScheme({ mode: 'dataset' }); setView((v) => ({ ...v, datasetColors: {} })); }}>Reset colours</button>
      </div>
      {scheme.mode === 'numeric' && numFields.length === 0 && <div className="note warn">No numeric columns were found.</div>}

      {scheme.mode === 'dataset' && (
        <div className="group-list">
          {entries.filter((e) => e.info).map((e, i) => (
            <div className="group-row" key={e.id}>
              <input type="color" className="color-in" value={view.datasetColors[e.id] || DATASET_PALETTE[i % DATASET_PALETTE.length]}
                onChange={(ev) => setView((v) => ({ ...v, datasetColors: { ...v.datasetColors, [e.id]: ev.target.value } }))} />
              <span className="lbl">{e.name}</span>
              <span className="cnt">{fmtInt(e.info!.valid)}</span>
            </div>
          ))}
        </div>
      )}

      {scheme.mode === 'category' && (
        <CategoryEditor scheme={scheme} setScheme={setScheme} fields={catFields} distinct={distinct} loading={loading} onFields={startCategory} />
      )}
      {scheme.mode === 'numeric' && numFields.length > 0 && (
        <NumericEditor scheme={scheme} setScheme={setScheme} fields={numFields} onField={startNumeric} />
      )}
    </div>
  );
}

function CategoryEditor({ scheme, setScheme, fields, distinct, loading, onFields }: {
  scheme: Extract<ColorScheme, { mode: 'category' }>; setScheme: (s: ColorScheme) => void; fields: FieldInfo[];
  distinct: { value: string; count: number }[]; loading: boolean; onFields: (f: string[]) => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const counts = useMemo(() => new Map(distinct.map((d) => [d.value, d.count])), [distinct]);
  const grouped = useMemo(() => new Set(scheme.groups.flatMap((g) => g.values)), [scheme.groups]);
  const total = distinct.reduce((s, d) => s + d.count, 0);
  const groupCount = (g: CategoryGroup) => g.values.reduce((s, v) => s + (counts.get(v) || 0), 0);
  const othersCount = total - scheme.groups.reduce((s, g) => s + groupCount(g), 0);
  const ungrouped = distinct.filter((d) => !grouped.has(d.value));
  const update = (groups: CategoryGroup[]) => { setSel([]); setScheme({ ...scheme, groups }); };

  const combine = () => {
    if (sel.length < 2) return;
    const s = [...sel].sort((a, b) => a - b);
    const merged: CategoryGroup = {
      label: s.map((i) => scheme.groups[i].label).join(' + '),
      values: s.flatMap((i) => scheme.groups[i].values),
      color: scheme.groups[s[0]].color,
    };
    const groups = scheme.groups.filter((_, i) => !s.includes(i));
    groups.splice(s[0], 0, merged);
    update(groups);
    setSel([]);
  };
  const split = (i: number) => {
    const g = scheme.groups[i];
    const parts = g.values.map((v, k) => ({ label: v || '(blank)', values: [v], color: k === 0 ? g.color : CATEGORY_PALETTE[(i + k) % CATEGORY_PALETTE.length] }));
    const groups = [...scheme.groups];
    groups.splice(i, 1, ...parts);
    update(groups);
  };

  return (
    <div>
      <div className="row">
        <span className="small muted">Colour by</span>
        {scheme.fields.map((f) => (
          <span key={f} className="chip on">{f}
            {scheme.fields.length > 1 && <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => onFields(scheme.fields.filter((x) => x !== f))} aria-label={`Remove ${f}`}>×</button>}
          </span>
        ))}
        <select className="input" value="" onChange={(e) => { if (e.target.value) onFields([e.target.value]); }}>
          <option value="">Change field…</option>
          {fields.map((f) => <option key={f.name} value={f.name}>{f.name} ({fmtInt(f.distinct)} values)</option>)}
        </select>
        {scheme.fields.length < 3 && (
          <select className="input" value="" onChange={(e) => { if (e.target.value && !scheme.fields.includes(e.target.value)) onFields([...scheme.fields, e.target.value]); }}>
            <option value="">+ Combine with another field…</option>
            {fields.filter((f) => !scheme.fields.includes(f.name)).map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        )}
      </div>
      <div className="row small" style={{ marginTop: 10 }}>
        <span className="muted">{loading ? 'Counting values…' : `${fmtInt(distinct.length)}${distinct.length >= 500 ? '+' : ''} different values. Tick two or more rows to combine them into one category.`}</span>
        <div className="grow" />
        <button className="btn small" disabled={sel.length < 2} onClick={combine}>Combine selected ({sel.length})</button>
        <button className="btn small" onClick={() => update(defaultGroups(distinct))}>Reset</button>
      </div>
      <div className="group-list">
        {scheme.groups.map((g, i) => (
          <div className="group-row" key={i}>
            <input type="checkbox" checked={sel.includes(i)} onChange={(e) => setSel(e.target.checked ? [...sel, i] : sel.filter((x) => x !== i))} aria-label="Select for combining" />
            <input type="color" className="color-in" value={g.color} onChange={(e) => update(scheme.groups.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)))} />
            <input className="input grow" value={g.label} onChange={(e) => update(scheme.groups.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} />
            {g.values.length > 1 && <span className="tag" title={g.values.join(', ')}>{g.values.length} values</span>}
            <span className="cnt">{fmtInt(groupCount(g))}</span>
            {g.values.length > 1 && <button className="icon-btn" title="Split into separate values" onClick={() => split(i)}>⤢</button>}
            <button className="icon-btn" title="Move to Others" onClick={() => update(scheme.groups.filter((_, k) => k !== i))}>×</button>
          </div>
        ))}
        <div className="group-row">
          <span style={{ width: 13 }} />
          <input type="color" className="color-in" value={scheme.othersColor} onChange={(e) => setScheme({ ...scheme, othersColor: e.target.value })} />
          <span className="lbl">Others</span>
          <span className="cnt">{fmtInt(Math.max(0, othersCount))}</span>
          <span style={{ width: 30 }} />
        </div>
      </div>
      {ungrouped.length > 0 && (
        <details className="more">
          <summary>Values currently in “Others” ({fmtInt(ungrouped.length)})</summary>
          <div className="group-list">
            {ungrouped.slice(0, 200).map((d) => (
              <div className="group-row" key={d.value}>
                <span className="lbl">{d.value || '(blank)'}</span>
                <span className="cnt">{fmtInt(d.count)}</span>
                <button className="btn small" onClick={() => update([...scheme.groups, { label: d.value || '(blank)', values: [d.value], color: CATEGORY_PALETTE[scheme.groups.length % CATEGORY_PALETTE.length] }])}>Give own colour</button>
                {sel.length === 1 && <button className="btn small" onClick={() => update(scheme.groups.map((x, k) => (k === sel[0] ? { ...x, values: [...x.values, d.value] } : x)))}>Add to ticked</button>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function NumericEditor({ scheme, setScheme, fields, onField }: {
  scheme: Extract<ColorScheme, { mode: 'numeric' }>; setScheme: (s: ColorScheme) => void; fields: FieldInfo[]; onField: (f: string) => void;
}) {
  const setBin = (i: number, b: Partial<NumericBin>) => {
    const bins = scheme.bins.map((x, k) => (k === i ? { ...x, ...b } : x)).map((x) => ({ ...x, label: binLabel(x) }));
    setScheme({ ...scheme, bins });
  };
  const num = (s: string) => { const x = Number(s.replace(/,/g, '').trim()); return s.trim() === '' || !Number.isFinite(x) ? null : x; };
  return (
    <div>
      <div className="row">
        <label className="field">Number field
          <select className="input" value={scheme.field} onChange={(e) => onField(e.target.value)}>
            {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        </label>
        <div className="grow" />
        <button className="btn small" onClick={() => onField(scheme.field)}>Reset ranges</button>
      </div>
      <div className="group-list">
        {scheme.bins.map((b, i) => (
          <div className="group-row" key={i}>
            <input type="color" className="color-in" value={b.color} onChange={(e) => setBin(i, { color: e.target.value })} />
            <input className="input" style={{ width: 120 }} placeholder="No minimum" defaultValue={b.min ?? ''} key={`min${i}-${b.min}`}
              onBlur={(e) => setBin(i, { min: num(e.target.value) })} aria-label="From" />
            <span className="muted">to</span>
            <input className="input" style={{ width: 120 }} placeholder="No maximum" defaultValue={b.max ?? ''} key={`max${i}-${b.max}`}
              onBlur={(e) => setBin(i, { max: num(e.target.value) })} aria-label="To" />
            <span className="lbl muted">{b.label}</span>
            <button className="icon-btn" title="Remove range" onClick={() => setScheme({ ...scheme, bins: scheme.bins.filter((_, k) => k !== i) })}>×</button>
          </div>
        ))}
        <div className="group-row">
          <input type="color" className="color-in" value={scheme.noValueColor} onChange={(e) => setScheme({ ...scheme, noValueColor: e.target.value })} />
          <span className="lbl">No value / not a number</span>
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => {
          const last = scheme.bins[scheme.bins.length - 1];
          const nb: NumericBin = { min: last?.max ?? null, max: null, color: NUMERIC_RAMP[scheme.bins.length % NUMERIC_RAMP.length], label: '' };
          setScheme({ ...scheme, bins: [...scheme.bins, { ...nb, label: binLabel(nb) }] });
        }}>+ Add range</button>
        <span className="small muted">Ranges include both ends. A value on a boundary goes to the first matching range. Press Tab or click away to apply a typed number.</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tooltip
function TooltipPicker({ fields, display, setDisplay }: Props) {
  const [q, setQ] = useState('');
  const list = fields.filter((f) => f.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (name: string, on: boolean) =>
    setDisplay((d) => ({ ...d, tooltipFields: on ? [...d.tooltipFields, name] : d.tooltipFields.filter((x) => x !== name) }));
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>Shown when you hover over a point. Click a point to see every column.</div>
      <input className="input" style={{ width: '100%' }} placeholder="Find a column…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="group-list" style={{ maxHeight: 260 }}>
        {list.map((f) => (
          <label className="check group-row" key={f.name}>
            <input type="checkbox" checked={display.tooltipFields.includes(f.name)} onChange={(e) => toggle(f.name, e.target.checked)} />
            <span className="lbl">{f.name}</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="small muted">{display.tooltipFields.length} selected</span>
        <button className="linklike" onClick={() => setDisplay((d) => ({ ...d, tooltipFields: [] }))}>Clear</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ map settings
export function MapSettings({ display, setDisplay, view, setView }: Props) {
  const b = BASEMAPS.find((x) => x.id === display.basemap);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label className="field">Background map
        <select className="input" value={display.basemap} onChange={(e) => setDisplay((d) => ({ ...d, basemap: e.target.value }))}>
          {BASEMAPS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          <option value="custom">Custom tile server…</option>
        </select>
      </label>
      {b && <div className="small muted">{b.note}</div>}
      {display.basemap === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="field">Tile URL ({'{z}/{x}/{y}'} raster tiles)
            <input className="input" placeholder="https://example.org/tiles/{z}/{x}/{y}.png" value={display.custom.url}
              onChange={(e) => setDisplay((d) => ({ ...d, custom: { ...d.custom, url: e.target.value } }))} />
          </label>
          <label className="field">Attribution (required by most providers)
            <input className="input" value={display.custom.attribution} onChange={(e) => setDisplay((d) => ({ ...d, custom: { ...d.custom, attribution: e.target.value } }))} />
          </label>
          <div className="small muted">Only use a tile server you are licensed to use.</div>
        </div>
      )}
      <label className="field">Point size: {display.pointSize}px
        <input type="range" min={1} max={14} step={0.5} value={display.pointSize} onChange={(e) => setDisplay((d) => ({ ...d, pointSize: Number(e.target.value) }))} />
      </label>
      <label className="field">Transparency: {Math.round((1 - display.opacity) * 100)}%
        <input type="range" min={0.1} max={1} step={0.05} value={display.opacity} onChange={(e) => setDisplay((d) => ({ ...d, opacity: Number(e.target.value) }))} />
      </label>
      <div className="field">Grouping of dense points
        <Seg value={display.mode} onChange={(m) => setDisplay((d) => ({ ...d, mode: m }))} options={[
          { value: 'auto', label: 'Automatic' }, { value: 'points', label: 'Always points' }, { value: 'clusters', label: 'Always clusters' },
        ]} />
        <span className="small muted">Automatic shows numbered clusters when zoomed out over large data, and individual points when zoomed in.</span>
      </div>
      <details className="more">
        <summary>Advanced options</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <label className="field">Most points drawn at once
            <select className="input" value={view.maxPoints} onChange={(e) => setView((v) => ({ ...v, maxPoints: Number(e.target.value) }))}>
              {[250000, 500000, 1000000, 1500000, 3000000, 10000000].map((n) => <option key={n} value={n}>{fmtInt(n)}</option>)}
            </select>
            <span className="small muted">Above this, an even sample is drawn to keep the map smooth. Filters, counts and exports always use every record.</span>
          </label>
          <label className="field">Dates like 03/04/2024 mean
            <select className="input" value={view.dateDayFirst ? 'd' : 'm'} onChange={(e) => setView((v) => ({ ...v, dateDayFirst: e.target.value === 'd' }))}>
              <option value="d">3 April 2024 (day first — India, UK)</option>
              <option value="m">March 4, 2024 (month first — US)</option>
            </select>
          </label>
        </div>
      </details>
    </div>
  );
}
