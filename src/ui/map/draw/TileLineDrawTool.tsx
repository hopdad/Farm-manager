'use client';
/**
 * The tile-line draw tool on /board and /m (plan 1d "tile_lines import and draw tool"). For
 * managers and owners (ROLE_FOR.editTileLines; the server re-checks every write): a "Tile" button
 * opens it; the lines around the view are shown and a tap selects one; "Draw a line" turns taps
 * into points (drag a point to move it, Undo removes the last), "Done" asks for kind, size, depth,
 * install date and notes, and "Save" POSTs /api/tile-lines. A selected line can be edited,
 * reshaped (its points become the sketch) or deleted. The field is found by the server (the one
 * holding most of the line).
 *
 * Every save publishes `layers`/`updated { key: 'tile_lines' }`: other boards reload the tile
 * layer (the rail), and an open tool reloads its lines, within the realtime budget.
 *
 * The tool draws on the map with its own sources and layers, prefixed `draw:tile:` (never
 * `layer:`, so the rail's applyLayers leaves them alone), and re-adds them after a style reload.
 * While it is drawing, `useTileDrawStore().drawing` is true: the board should not open the field
 * panel for those taps (BoardScreen passes no onFieldTap to WarRoomMap while drawing).
 */
import type {
  GeoJSONSource,
  LayerSpecification,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  Map as MapLibreMap,
  MapMouseEvent,
  MapTouchEvent,
} from 'maplibre-gl';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { PublicConfig } from '../../../config';
import {
  TILE_KIND_LABELS,
  TILE_KINDS,
  type TileKind,
  type TileLinesResponse,
  type TileLineView,
} from '../../../db/queries/tile-lines-schema';
import { resolveRealtimeClient } from '../fleet/realtime';
import { TILE_KIND_COLORS } from '../layers/tile';
import type { MapVariant } from '../types';
import {
  addPoint,
  canFinish,
  createPayload,
  type DrawMode,
  describeLine,
  EMPTY_FORM,
  formOf,
  type LngLatPair,
  lengthFt,
  linesCollection,
  movePoint,
  paddedBbox,
  pointsOf,
  sketchCollection,
  type TileForm,
  undoPoint,
  updatePayload,
} from './model';

export const DRAW_SOURCE_LINES = 'draw:tile:lines';
export const DRAW_SOURCE_SKETCH = 'draw:tile:sketch';
export const DRAW_LAYER = {
  hit: 'draw:tile:lines-hit',
  lines: 'draw:tile:lines',
  sketchLine: 'draw:tile:sketch-line',
  vertex: 'draw:tile:sketch-vertex',
} as const;

/** Is the tool drawing (taps add points)? The board reads it to keep taps off the field panel. */
export const useTileDrawStore = create<{ drawing: boolean; set(drawing: boolean): void }>()(
  (set) => ({ drawing: false, set: (drawing) => set({ drawing }) }),
);

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

function drawLayers(variant: MapVariant): LayerSpecification[] {
  const wide = variant === 'wall' ? 1.5 : 1;
  return [
    {
      id: DRAW_LAYER.hit,
      type: 'line',
      source: DRAW_SOURCE_LINES,
      paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 24 * wide },
    },
    {
      id: DRAW_LAYER.lines,
      type: 'line',
      source: DRAW_SOURCE_LINES,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'case',
          ['get', 'selected'],
          '#facc15',
          [
            'match',
            ['get', 'kind'],
            ...TILE_KINDS.flatMap((k) => [k, TILE_KIND_COLORS[k]]),
            '#a5b4fc',
          ],
        ] as never,
        'line-width': ['case', ['get', 'selected'], 6 * wide, 3.5 * wide] as never,
      },
    },
    {
      id: DRAW_LAYER.sketchLine,
      type: 'line',
      source: DRAW_SOURCE_SKETCH,
      filter: ['==', ['get', 'role'], 'line'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#facc15', 'line-width': 4 * wide, 'line-dasharray': [2, 1] },
    },
    {
      id: DRAW_LAYER.vertex,
      type: 'circle',
      source: DRAW_SOURCE_SKETCH,
      filter: ['==', ['get', 'role'], 'vertex'],
      paint: {
        'circle-radius': 9 * wide,
        'circle-color': '#facc15',
        'circle-stroke-color': '#0b1210',
        'circle-stroke-width': 2,
      },
    },
  ];
}

/** Add the tool's sources and layers if missing (after a style reload too). */
function ensureOnMap(map: MapLibreMap, variant: MapVariant): void {
  if (!map.getSource(DRAW_SOURCE_LINES))
    map.addSource(DRAW_SOURCE_LINES, { type: 'geojson', data: EMPTY_FC });
  if (!map.getSource(DRAW_SOURCE_SKETCH))
    map.addSource(DRAW_SOURCE_SKETCH, { type: 'geojson', data: EMPTY_FC });
  for (const l of drawLayers(variant)) if (!map.getLayer(l.id)) map.addLayer(l);
}

function removeFromMap(map: MapLibreMap): void {
  for (const id of Object.values(DRAW_LAYER)) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of [DRAW_SOURCE_LINES, DRAW_SOURCE_SKETCH])
    if (map.getSource(id)) map.removeSource(id);
}

async function api<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, body };
}

export interface TileLineDrawToolProps {
  map: MapLibreMap | null;
  variant: MapVariant;
  config: Pick<PublicConfig, 'appEnv' | 'realtime'>;
}

export function TileLineDrawTool({ map, variant, config }: TileLineDrawToolProps) {
  const [canEdit, setCanEdit] = useState(false);
  const [lines, setLines] = useState<TileLineView[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [mode, setMode] = useState<DrawMode>({ kind: 'closed' });
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const [busy, setBusy] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const setDrawing = useTileDrawStore((s) => s.set);
  const open = mode.kind !== 'closed';

  // ---- data ------------------------------------------------------------------------------
  const load = useCallback(async () => {
    if (!map) return;
    try {
      const r = await api<TileLinesResponse & { error?: string }>(
        `/api/tile-lines?bbox=${paddedBbox(boundsOf(map))}`,
      );
      if (r.status !== 200 || !r.body) {
        setCanEdit(false);
        return;
      }
      setCanEdit(r.body.canEdit);
      setLines(r.body.lines);
      setTruncated(r.body.truncated);
    } catch {
      // Offline or the server restarting: keep what is shown; the next move or event retries.
    }
  }, [map]);

  // Learn canEdit (and the lines around) once the map is there.
  useEffect(() => {
    void load();
  }, [load]);

  // While open: reload when the view moves.
  useEffect(() => {
    if (!map || !open) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onMove = () => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 250);
    };
    map.on('moveend', onMove);
    return () => {
      clearTimeout(t);
      map.off('moveend', onMove);
    };
  }, [map, open, load]);

  // Realtime: another board saved a line (or we missed events): reload.
  useEffect(() => {
    if (!open) return;
    const { client } = resolveRealtimeClient(config);
    return client.subscribe(
      'layers',
      (evt) => {
        if (evt.event === 'updated' && evt.payload.key === 'tile_lines') void load();
      },
      { onResync: () => void load() },
    );
  }, [open, config, load]);

  useEffect(() => {
    setDrawing(mode.kind === 'draw');
    return () => setDrawing(false);
  }, [mode.kind, setDrawing]);

  // ---- map drawing -----------------------------------------------------------------------
  const selectedId = mode.kind === 'browse' ? mode.selectedId : null;
  const sketch: LngLatPair[] =
    mode.kind === 'draw' ? mode.points : mode.kind === 'form' && mode.points ? mode.points : [];
  const hiddenId = mode.kind === 'draw' || mode.kind === 'form' ? (mode.editing?.id ?? null) : null;
  const linesData = useMemo(
    () => linesCollection(lines, selectedId, hiddenId),
    [lines, selectedId, hiddenId],
  );
  const sketchData = useMemo(() => sketchCollection(sketch), [sketch]);

  useEffect(() => {
    if (!map) return;
    if (!open) {
      removeFromMap(map);
      return;
    }
    const apply = () => {
      if (!map.isStyleLoaded()) return;
      ensureOnMap(map, variant);
      (map.getSource(DRAW_SOURCE_LINES) as GeoJSONSource | undefined)?.setData(linesData);
      (map.getSource(DRAW_SOURCE_SKETCH) as GeoJSONSource | undefined)?.setData(sketchData);
    };
    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [map, open, variant, linesData, sketchData]);

  useEffect(
    () => () => {
      try {
        if (map) removeFromMap(map);
      } catch {
        // The map was already removed with its style.
      }
    },
    [map],
  );

  // Taps: add a point while drawing; select a line while browsing.
  const dragRef = useRef<{ index: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    if (!map || !open) return;
    const onClick = (e: MapMouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      const m = modeRef.current;
      if (m.kind === 'draw') {
        const p: LngLatPair = [e.lngLat.lng, e.lngLat.lat];
        // Functional update: two quick taps must not both start from the same render's points.
        setMode((cur) => (cur.kind === 'draw' ? { ...cur, points: addPoint(cur.points, p) } : cur));
        return;
      }
      if (m.kind === 'browse') {
        const r = variant === 'wall' ? 14 : 10;
        const hits = map.getLayer(DRAW_LAYER.hit)
          ? map.queryRenderedFeatures(
              [
                [e.point.x - r, e.point.y - r],
                [e.point.x + r, e.point.y + r],
              ],
              { layers: [DRAW_LAYER.hit] },
            )
          : [];
        const id = hits[0]?.properties?.id;
        setMode({ kind: 'browse', selectedId: typeof id === 'string' ? id : null });
        setMessage(null);
      }
    };
    // Dragging a point: stop the map from panning for that gesture, follow the pointer.
    const start = (e: MapLayerMouseEvent | MapLayerTouchEvent) => {
      if (modeRef.current.kind !== 'draw') return;
      const idx = e.features?.[0]?.properties?.index;
      if (typeof idx !== 'number') return;
      e.preventDefault();
      dragRef.current = { index: idx, moved: false };
      map.getCanvas().style.cursor = 'grabbing';
    };
    const move = (e: MapMouseEvent | MapTouchEvent) => {
      const d = dragRef.current;
      const m = modeRef.current;
      if (!d || m.kind !== 'draw') return;
      d.moved = true;
      const p: LngLatPair = [e.lngLat.lng, e.lngLat.lat];
      setMode((cur) =>
        cur.kind === 'draw' ? { ...cur, points: movePoint(cur.points, d.index, p) } : cur,
      );
    };
    const end = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      map.getCanvas().style.cursor = '';
      // The tap that ends a drag must not also add a point.
      if (d.moved) suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 400);
    };
    map.on('click', onClick);
    map.on('mousedown', DRAW_LAYER.vertex, start);
    map.on('touchstart', DRAW_LAYER.vertex, start);
    map.on('mousemove', move);
    map.on('touchmove', move);
    map.on('mouseup', end);
    map.on('touchend', end);
    return () => {
      map.off('click', onClick);
      map.off('mousedown', DRAW_LAYER.vertex, start);
      map.off('touchstart', DRAW_LAYER.vertex, start);
      map.off('mousemove', move);
      map.off('touchmove', move);
      map.off('mouseup', end);
      map.off('touchend', end);
    };
  }, [map, open, variant]);

  // ---- actions ---------------------------------------------------------------------------
  const selected = selectedId ? (lines.find((l) => l.id === selectedId) ?? null) : null;

  const save = async () => {
    if (mode.kind !== 'form') return;
    const payload = mode.editing
      ? updatePayload(mode.editing.version, mode.form, mode.points)
      : createPayload(mode.points ?? [], mode.form);
    if (typeof payload === 'string') {
      setMessage({ text: payload, tone: 'bad' });
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ line?: TileLineView; error?: string }>(
        mode.editing ? `/api/tile-lines/${mode.editing.id}` : '/api/tile-lines',
        {
          method: mode.editing ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const line = r.body?.line;
      if ((r.status === 200 || r.status === 201) && line) {
        setLines((ls) => [line, ...ls.filter((l) => l.id !== line.id)]);
        setMode({ kind: 'browse', selectedId: line.id });
        setMessage({
          text: `Saved${line.fieldName ? ` on ${line.fieldName}` : ''}: ${describeLine(line)}`,
          tone: 'ok',
        });
      } else {
        setMessage({ text: r.body?.error ?? `Not saved (HTTP ${r.status})`, tone: 'bad' });
      }
    } catch {
      setMessage({ text: 'Not saved: no connection. Try again.', tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (line: TileLineView) => {
    setBusy(true);
    try {
      const r = await api<{ error?: string }>(
        `/api/tile-lines/${line.id}?version=${encodeURIComponent(line.version)}`,
        { method: 'DELETE' },
      );
      if (r.status === 200) {
        setLines((ls) => ls.filter((l) => l.id !== line.id));
        setMode({ kind: 'browse', selectedId: null });
        setMessage({ text: 'Line deleted', tone: 'ok' });
      } else {
        setMessage({ text: r.body?.error ?? `Not deleted (HTTP ${r.status})`, tone: 'bad' });
      }
    } catch {
      setMessage({ text: 'Not deleted: no connection. Try again.', tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit) return null;

  const S = styles(variant);
  const setForm = (patch: Partial<TileForm>) =>
    setMode((m) => (m.kind === 'form' ? { ...m, form: { ...m.form, ...patch } } : m));

  return (
    <div style={S.root} data-testid="tile-tool">
      {open && (
        <section style={S.panel} aria-label="Drainage tile tool" data-testid="tile-tool-panel">
          <div style={S.title}>Drainage tile</div>

          {mode.kind === 'browse' && (
            <>
              {selected ? (
                <div data-testid="tile-selected" data-line-id={selected.id}>
                  <div style={S.strong}>
                    {TILE_KIND_LABELS[selected.kind]}
                    {selected.fieldName ? ` · ${selected.fieldName}` : ''}
                  </div>
                  <div style={S.muted}>{describeLine(selected)}</div>
                  {selected.installedOn && (
                    <div style={S.muted}>Installed {selected.installedOn}</div>
                  )}
                  {selected.notes && <div style={S.muted}>{selected.notes}</div>}
                  {selected.editable ? (
                    <div style={S.row}>
                      <button
                        type="button"
                        style={S.button}
                        data-testid="tile-edit"
                        onClick={() =>
                          setMode({
                            kind: 'form',
                            points: null,
                            editing: { id: selected.id, version: selected.version },
                            form: formOf(selected),
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        style={S.button}
                        data-testid="tile-reshape"
                        onClick={() =>
                          setMode({
                            kind: 'draw',
                            points: pointsOf(selected),
                            editing: { id: selected.id, version: selected.version },
                          })
                        }
                      >
                        Reshape
                      </button>
                      <button
                        type="button"
                        style={{ ...S.button, ...S.danger }}
                        data-testid="tile-delete"
                        disabled={busy}
                        onClick={() => void remove(selected)}
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <div style={S.muted}>From Operations Center: change it there.</div>
                  )}
                </div>
              ) : (
                <div style={S.muted}>
                  {lines.length === 0
                    ? 'No tile lines here yet.'
                    : `${lines.length} line${lines.length === 1 ? '' : 's'} in view. Tap one to edit it.`}
                  {truncated && ' Zoom in to see them all.'}
                </div>
              )}
              <div style={S.row}>
                <button
                  type="button"
                  style={{ ...S.button, ...S.primary }}
                  data-testid="tile-draw-start"
                  onClick={() => {
                    setMessage(null);
                    setMode({ kind: 'draw', points: [], editing: null });
                  }}
                >
                  Draw a line
                </button>
              </div>
            </>
          )}

          {mode.kind === 'draw' && (
            <>
              <div style={S.muted} data-testid="tile-draw-hint">
                {mode.points.length === 0
                  ? 'Tap the map where the line starts.'
                  : `${mode.points.length} point${mode.points.length === 1 ? '' : 's'} · ${Math.round(lengthFt(mode.points)).toLocaleString('en-US')} ft. Tap to add, drag a point to move it.`}
              </div>
              <div style={S.row}>
                <button
                  type="button"
                  style={S.button}
                  data-testid="tile-undo"
                  disabled={mode.points.length === 0}
                  onClick={() => setMode({ ...mode, points: undoPoint(mode.points) })}
                >
                  Undo point
                </button>
                <button
                  type="button"
                  style={S.button}
                  data-testid="tile-cancel"
                  onClick={() => setMode({ kind: 'browse', selectedId: mode.editing?.id ?? null })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={{ ...S.button, ...S.primary }}
                  data-testid="tile-finish"
                  disabled={!canFinish(mode.points)}
                  onClick={() => {
                    const line = mode.editing ? lines.find((l) => l.id === mode.editing?.id) : null;
                    setMode({
                      kind: 'form',
                      points: mode.points,
                      editing: mode.editing,
                      form: line ? formOf(line) : EMPTY_FORM,
                    });
                  }}
                >
                  Done
                </button>
              </div>
            </>
          )}

          {mode.kind === 'form' && (
            <form
              style={S.form}
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset style={S.kinds}>
                <legend style={S.legend}>Kind</legend>
                {TILE_KINDS.map((k: TileKind) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={mode.form.kind === k}
                    data-testid={`tile-kind-${k}`}
                    style={{ ...S.button, ...(mode.form.kind === k ? S.chosen : {}) }}
                    onClick={() => setForm({ kind: k })}
                  >
                    {TILE_KIND_LABELS[k]}
                  </button>
                ))}
              </fieldset>
              <label style={S.label}>
                Size (in)
                <input
                  style={S.input}
                  inputMode="decimal"
                  data-testid="tile-size"
                  value={mode.form.sizeIn}
                  onChange={(e) => setForm({ sizeIn: e.target.value })}
                />
              </label>
              <label style={S.label}>
                Depth (ft)
                <input
                  style={S.input}
                  inputMode="decimal"
                  data-testid="tile-depth"
                  value={mode.form.depthFt}
                  onChange={(e) => setForm({ depthFt: e.target.value })}
                />
              </label>
              <label style={S.label}>
                Installed
                <input
                  style={S.input}
                  type="date"
                  data-testid="tile-installed"
                  value={mode.form.installedOn}
                  onChange={(e) => setForm({ installedOn: e.target.value })}
                />
              </label>
              <label style={S.label}>
                Notes
                <input
                  style={S.input}
                  data-testid="tile-notes"
                  value={mode.form.notes}
                  onChange={(e) => setForm({ notes: e.target.value })}
                />
              </label>
              <div style={S.row}>
                <button
                  type="button"
                  style={S.button}
                  onClick={() =>
                    mode.points && !mode.editing
                      ? setMode({ kind: 'draw', points: mode.points, editing: null })
                      : setMode({ kind: 'browse', selectedId: mode.editing?.id ?? null })
                  }
                >
                  Back
                </button>
                <button
                  type="submit"
                  style={{ ...S.button, ...S.primary }}
                  data-testid="tile-save"
                  disabled={busy}
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}

          {message && (
            <div
              role="status"
              data-testid="tile-message"
              style={{ ...S.message, ...(message.tone === 'bad' ? S.messageBad : {}) }}
            >
              {message.text}
            </div>
          )}
        </section>
      )}
      <button
        type="button"
        style={{ ...S.toggle, ...(open ? S.toggleOn : {}) }}
        aria-pressed={open}
        aria-label={open ? 'Close the tile tool' : 'Draw drainage tile'}
        data-testid="tile-tool-toggle"
        onClick={() => {
          setMessage(null);
          if (open) setMode({ kind: 'closed' });
          else {
            setMode({ kind: 'browse', selectedId: null });
            void load();
          }
        }}
      >
        Tile
      </button>
    </div>
  );
}

function boundsOf(map: MapLibreMap) {
  const b = map.getBounds();
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
}

function styles(variant: MapVariant) {
  const wall = variant === 'wall';
  const target = wall ? 72 : 48;
  const font = wall ? 20 : 15;
  const button: CSSProperties = {
    minHeight: target,
    minWidth: target,
    padding: '0 14px',
    borderRadius: 12,
    border: '1px solid rgb(255 255 255 / 20%)',
    background: 'rgb(255 255 255 / 8%)',
    color: '#f4f7f2',
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
  };
  return {
    root: {
      position: 'absolute',
      right: 12,
      bottom: wall ? 40 : 28,
      // Over the weather strip and the fleet panel while drawing; under the field panel.
      zIndex: 4,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 10,
      fontSize: font,
      color: '#f4f7f2',
      pointerEvents: 'none',
    },
    panel: {
      pointerEvents: 'auto',
      width: wall ? 460 : 'min(92vw, 360px)',
      maxHeight: wall ? '70vh' : '55vh',
      overflowY: 'auto',
      background: 'rgb(11 18 16 / 94%)',
      border: '1px solid rgb(255 255 255 / 16%)',
      borderRadius: 14,
      padding: 14,
      display: 'grid',
      gap: 10,
    },
    title: { fontWeight: 800, letterSpacing: '0.02em' },
    strong: { fontWeight: 700 },
    muted: { opacity: 0.75, fontSize: font * 0.85 },
    row: { display: 'flex', flexWrap: 'wrap', gap: 8 },
    form: { display: 'grid', gap: 8 },
    kinds: { display: 'flex', flexWrap: 'wrap', gap: 6, border: 0, margin: 0, padding: 0 },
    legend: { fontSize: font * 0.85, padding: 0, marginBottom: 4 },
    label: { display: 'grid', gap: 4, fontSize: font * 0.85 },
    input: {
      minHeight: target * 0.8,
      borderRadius: 10,
      border: '1px solid rgb(255 255 255 / 25%)',
      background: 'rgb(0 0 0 / 35%)',
      color: '#f4f7f2',
      font: 'inherit',
      padding: '0 10px',
    },
    button,
    primary: { background: '#0e7490', borderColor: '#22d3ee' },
    danger: { background: 'rgb(185 28 28 / 70%)', borderColor: '#f87171' },
    chosen: { background: '#facc15', color: '#0b1210', borderColor: '#facc15' },
    message: {
      padding: '8px 10px',
      borderRadius: 10,
      background: 'rgb(34 197 94 / 20%)',
      fontSize: font * 0.85,
    },
    messageBad: { background: 'rgb(239 68 68 / 25%)' },
    toggle: {
      ...button,
      pointerEvents: 'auto',
      background: 'rgb(11 18 16 / 86%)',
      width: target,
      height: target,
      padding: 0,
    },
    toggleOn: { background: '#0e7490', borderColor: '#22d3ee' },
  } satisfies Record<string, CSSProperties>;
}
