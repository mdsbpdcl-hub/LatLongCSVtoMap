import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import type { DataClient } from '../lib/workerClient';
import type { ClusterResult } from '../lib/types';
import { basemapStyle } from '../lib/basemaps';
import type { DisplaySettings } from '../state';
import { fmtCompact, fmtInt } from '../lib/values';

export interface Buffers { positions: Float64Array; colors: Uint8Array; ids: Uint32Array; version: number }

export interface MapHandle {
  fitBounds: (b: [number, number, number, number]) => void;
  flyTo: (lon: number, lat: number, zoom?: number) => void;
  bounds: () => [number, number, number, number] | null;
}

interface Props {
  client: DataClient;
  buffers: React.MutableRefObject<Buffers | null>;
  version: number;
  renderCount: number;
  display: DisplaySettings;
  selVersion: number;
  active: { id: number; lon: number; lat: number } | null;
  highlight: boolean;
  rectMode: boolean;
  onRectDone: (bbox: [number, number, number, number] | null) => void;
  onPick: (id: number) => void;
  onError: (msg: string) => void;
}

const CLUSTER_AUTO_POINTS = 20000;
const CLUSTER_AUTO_MAXZOOM = 10;

export const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const { client, buffers, version, renderCount, display, selVersion, active, highlight, rectMode, onRectDone } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const clustersRef = useRef<ClusterResult | null>(null);
  const selRef = useRef<{ positions: Float64Array; ids: Uint32Array } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [zoomInt, setZoomInt] = useState(4);
  const [clusterVer, setClusterVer] = useState(0);
  const [selVer, setSelVer] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; title: string; rows: [string, string][] } | null>(null);
  const hoverKey = useRef<string>('');
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dataCache = useRef<{ v: number; data: unknown } | null>(null);

  const useClusters = display.mode === 'clusters' || (display.mode === 'auto' && renderCount > CLUSTER_AUTO_POINTS && zoomInt < CLUSTER_AUTO_MAXZOOM);
  const useClustersRef = useRef(useClusters);
  useClustersRef.current = useClusters;

  // ---------- create the map once
  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: basemapStyle(display.basemap, display.custom),
        center: [85.3, 25.6],
        zoom: 6,
        attributionControl: { compact: true },
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch (e) {
      props.onError('The map could not start because WebGL is not available in this browser. Try Chrome, Edge or Firefox with hardware acceleration switched on.');
      void e;
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);
    mapRef.current = map;
    overlayRef.current = overlay;
    map.on('zoom', () => {
      const z = Math.floor(map.getZoom());
      setZoomInt((old) => (old === z ? old : z));
    });
    map.on('movestart', () => setHover(null));
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- basemap
  const styleKey = display.basemap + '|' + display.custom.url + '|' + display.custom.attribution;
  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) { firstStyle.current = false; return; }
    mapRef.current?.setStyle(basemapStyle(display.basemap, display.custom));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  // ---------- clusters
  useEffect(() => {
    if (!useClusters) { clustersRef.current = null; setClusterVer((v) => v + 1); return; }
    let live = true;
    client.call<ClusterResult>('clusters', [zoomInt, 64]).then((c) => {
      if (!live) return;
      clustersRef.current = c;
      setClusterVer((v) => v + 1);
    }).catch(() => {});
    return () => { live = false; };
  }, [useClusters, zoomInt, version, client]);

  // ---------- selection highlight
  useEffect(() => {
    let live = true;
    client.call('selectedPositions', [200000]).then((s) => {
      if (!live) return;
      selRef.current = s.ids.length ? s : null;
      setSelVer((v) => v + 1);
    }).catch(() => {});
    return () => { live = false; };
  }, [selVersion, client]);

  // ---------- layers
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const layers = [];
    const b = buffers.current;
    const size = display.pointSize;
    if (b && b.ids.length && !useClusters) {
      if (!dataCache.current || dataCache.current.v !== b.version) {
        dataCache.current = {
          v: b.version,
          data: { length: b.ids.length, attributes: { getPosition: { value: b.positions, size: 2 }, getFillColor: { value: b.colors, size: 4, normalized: true } } },
        };
      }
      layers.push(new ScatterplotLayer({
        id: 'points',
        data: dataCache.current.data as never,
        radiusUnits: 'pixels',
        getRadius: size,
        radiusMinPixels: 0.5,
        stroked: size >= 5,
        getLineColor: [255, 255, 255, 200],
        lineWidthUnits: 'pixels',
        getLineWidth: 0.6,
        opacity: display.opacity,
        pickable: true,
        updateTriggers: { getRadius: size },
      }));
    }
    const c = clustersRef.current;
    if (useClusters && c && c.counts.length) {
      const m = c.counts.length;
      const radii = new Float32Array(m);
      const labels: { p: [number, number]; t: string }[] = [];
      for (let i = 0; i < m; i++) {
        const n = c.counts[i];
        radii[i] = n === 1 ? size : Math.min(30, 11 + Math.log10(n) * 5);
        if (n > 1) labels.push({ p: [c.positions[i * 2], c.positions[i * 2 + 1]], t: fmtCompact(n) });
      }
      layers.push(new ScatterplotLayer({
        id: 'clusters',
        data: { length: m, attributes: { getPosition: { value: c.positions, size: 2 }, getRadius: { value: radii, size: 1 }, getFillColor: { value: c.colors, size: 4, normalized: true } } } as never,
        radiusUnits: 'pixels',
        stroked: true,
        getLineColor: [255, 255, 255, 235],
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        opacity: Math.max(0.6, display.opacity),
        pickable: true,
      }));
      layers.push(new TextLayer<{ p: [number, number]; t: string }>({
        id: 'cluster-labels',
        data: labels,
        getPosition: (d) => d.p,
        getText: (d) => d.t,
        getSize: 11.5,
        getColor: [23, 58, 37, 255],
        fontFamily: 'Inter, "Segoe UI", Roboto, sans-serif',
        fontWeight: 600,
        characterSet: '0123456789.kLCr',
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
      }));
    }
    const s = selRef.current;
    if (s) {
      layers.push(new ScatterplotLayer({
        id: 'selected',
        data: { length: s.ids.length, attributes: { getPosition: { value: s.positions, size: 2 } } } as never,
        radiusUnits: 'pixels',
        getRadius: size + 2.5,
        filled: false,
        stroked: true,
        getLineColor: [23, 58, 37, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 1.6,
        updateTriggers: { getRadius: size },
      }));
    }
    if (active && highlight) {
      layers.push(new ScatterplotLayer({
        id: 'active',
        data: [active],
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        radiusUnits: 'pixels',
        getRadius: size + 8,
        filled: true,
        getFillColor: [168, 213, 181, 90],
        stroked: true,
        getLineColor: [47, 111, 71, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 2.5,
        updateTriggers: { getRadius: size },
      }));
    }
    overlay.setProps({
      layers,
      onHover: handleHover,
      onClick: handleClick,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, clusterVer, selVer, useClusters, display.pointSize, display.opacity, active, highlight]);

  function setCursor(on: boolean) {
    const cv = mapRef.current?.getCanvas();
    if (cv) cv.style.cursor = on ? 'pointer' : '';
  }

  function idAt(info: PickingInfo): { id: number; count: number } | null {
    if (info.index < 0 || !info.layer) return null;
    if (info.layer.id === 'points') {
      const b = buffers.current;
      return b ? { id: b.ids[info.index], count: 1 } : null;
    }
    if (info.layer.id === 'clusters') {
      const c = clustersRef.current;
      return c ? { id: c.ids[info.index], count: c.counts[info.index] } : null;
    }
    return null;
  }

  function handleHover(info: PickingInfo) {
    const hit = idAt(info);
    setCursor(!!hit);
    if (!hit) { hoverKey.current = ''; setHover(null); return; }
    const key = `${hit.id}:${hit.count}`;
    if (hit.count > 1) {
      hoverKey.current = key;
      setHover({ x: info.x, y: info.y, title: `${fmtInt(hit.count)} records here`, rows: [['', 'Click to zoom in']] });
      return;
    }
    if (hoverKey.current === key) { setHover((h) => (h ? { ...h, x: info.x, y: info.y } : h)); return; }
    hoverKey.current = key;
    const x = info.x, y = info.y;
    client.call('tooltip', [hit.id, propsRef.current.display.tooltipFields]).then((t) => {
      if (hoverKey.current !== key || !t) return;
      setHover({ x, y, title: t.title, rows: t.rows });
    }).catch(() => {});
  }

  function handleClick(info: PickingInfo) {
    const hit = idAt(info);
    if (!hit) return;
    if (hit.count > 1 && info.coordinate) {
      const map = mapRef.current!;
      map.easeTo({ center: info.coordinate as [number, number], zoom: Math.min(map.getZoom() + 2.5, 18), duration: 450 });
      return;
    }
    propsRef.current.onPick(hit.id);
  }

  useImperativeHandle(ref, () => ({
    fitBounds: (b) => {
      const map = mapRef.current;
      if (!map) return;
      if (Math.abs(b[2] - b[0]) < 1e-6 && Math.abs(b[3] - b[1]) < 1e-6) {
        map.flyTo({ center: [b[0], b[1]], zoom: Math.max(map.getZoom(), 16), duration: 600 });
      } else {
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 16, duration: 600 });
      }
    },
    flyTo: (lon, lat, zoom) => {
      const map = mapRef.current;
      if (map) map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 16), duration: 600 });
    },
    bounds: () => {
      const m = mapRef.current;
      if (!m) return null;
      const b = m.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    },
  }), []);

  // ---------- rectangle selection
  const rectStart = useRef<{ x: number; y: number } | null>(null);
  const local = (e: React.PointerEvent) => {
    const r = container.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className="map-wrap">
      <div ref={container} style={{ position: 'absolute', inset: 0 }} />
      {rectMode && (
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 4, cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); const p = local(e); rectStart.current = p; setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
          onPointerMove={(e) => { if (!rectStart.current) return; const p = local(e); setRect({ x0: rectStart.current.x, y0: rectStart.current.y, x1: p.x, y1: p.y }); }}
          onPointerUp={(e) => {
            const s = rectStart.current;
            rectStart.current = null;
            setRect(null);
            const map = mapRef.current;
            if (!s || !map) return onRectDone(null);
            const p = local(e);
            if (Math.abs(p.x - s.x) < 4 || Math.abs(p.y - s.y) < 4) return onRectDone(null);
            const a = map.unproject([Math.min(s.x, p.x), Math.max(s.y, p.y)]);
            const c = map.unproject([Math.max(s.x, p.x), Math.min(s.y, p.y)]);
            onRectDone([a.lng, a.lat, c.lng, c.lat]);
          }}
        />
      )}
      {rect && (
        <div className="rect-sel" style={{ left: Math.min(rect.x0, rect.x1), top: Math.min(rect.y0, rect.y1), width: Math.abs(rect.x1 - rect.x0), height: Math.abs(rect.y1 - rect.y0) }} />
      )}
      {rectMode && <div className="map-hint floating">Drag a rectangle to select the points inside it · Esc to stop</div>}
      {hover && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 14, (container.current?.clientWidth || 9999) - 300), top: hover.y + 14 }}>
          <div className="t">{hover.title}</div>
          {hover.rows.length > 0 && (
            <table><tbody>{hover.rows.map(([k, v], i) => <tr key={i}><td>{k}</td><td>{v || '—'}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
    </div>
  );
});
