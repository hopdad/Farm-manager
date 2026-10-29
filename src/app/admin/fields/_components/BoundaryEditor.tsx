'use client';
/**
 * The boundary editor on /admin/fields/<id> and /admin/fields/new (plan 1c): the offline
 * basemap and every field (the same style as the board), with the field's boundary on top.
 *
 *  - Edit points: drag a corner; drag the small dot in the middle of an edge to add a corner;
 *    tap a corner, then "Delete point". Save writes a new boundary version (source 'drawn').
 *  - Redraw: tap the corners of a new outline, then "Finish".
 *  - Split: tap a line across the field, preview the pieces, name them, split (lineage).
 *  - Merge: pick a touching field, preview, name the result, merge (lineage).
 *  - Deere field (D6): no edits; "Propose a change" draws a shape that is saved as a
 *    "change this in Ops Center" request instead.
 *
 * Touch-first (the wall and an iPad): handles are big, one finger drags a corner, two fingers
 * still pan and zoom. Load it with next/dynamic and ssr: false (MapLibre needs WebGL2).
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString, MultiPolygon, Position } from 'geojson';
import type {
  GeoJSONSource,
  MapLayerMouseEvent,
  MapLayerTouchEvent,
  Marker,
  Map as MlMap,
  VectorTileSource,
} from 'maplibre-gl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Piece } from '@/db/queries/lineage';
import { TENURES } from '@/domain/farm';
import { setupMapLibre } from '@/ui/map/maplibre';
import { buildMapStyle, FIELDS_SOURCE } from '@/ui/map/style';
import type { MapPageData } from '@/ui/map/types';
import adminCss from '../../admin.module.css';
import type { DataResult } from '../_lib/access';
import {
  deletePoint,
  fromMultiPolygon,
  insertPoint,
  midpointFeatures,
  movePoint,
  type Shape,
  shapeBounds,
  toMultiPolygon,
  type VertexRef,
  vertexFeatures,
  vertexRefOf,
} from '../_lib/geometry-edit';
import {
  createFieldAction,
  mergeAction,
  previewMergeAction,
  previewSplitAction,
  saveBoundaryAction,
  splitAction,
} from '../actions';
import css from '../field-data.module.css';

export interface EditorField {
  id: string;
  name: string;
  active: boolean;
  editable: boolean;
  readOnlyReason: string | null;
  boundaryId: string | null;
  geometry: MultiPolygon | null;
}

export interface EditorProps {
  data: MapPageData;
  /** null: drawing a new field. */
  field: EditorField | null;
  adjacent: { fieldId: string; name: string; sameFarm: boolean; editable: boolean; gapM: number }[];
  /** Today in America/Detroit (YYYY-MM-DD), for the split/merge dates. */
  today: string;
  /** Choices for a new field. */
  farms: { id: string; name: string }[];
  landlords: { id: string; displayName: string }[];
}

type Mode = 'view' | 'edit' | 'draw' | 'split' | 'merge';

const SRC = {
  shape: 'fd-shape',
  draft: 'fd-draft',
  mid: 'fd-mid',
  vertices: 'fd-vertices',
  pieces: 'fd-pieces',
};
const LAYER = {
  fill: 'fd-shape-fill',
  line: 'fd-shape-line',
  draft: 'fd-draft-line',
  draftPts: 'fd-draft-pts',
  mid: 'fd-mid-pts',
  vertices: 'fd-vertex-pts',
  piecesFill: 'fd-pieces-fill',
  piecesLine: 'fd-pieces-line',
};
const PIECE_COLORS = ['#38bdf8', '#f97316', '#a78bfa', '#facc15', '#f472b6', '#22d3ee'];
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

declare global {
  interface Window {
    /** Test-only handle (not in production builds' runtime: appEnv check). */
    __fieldEditor?: {
      map: MlMap;
      geometry(): MultiPolygon;
      mode(): Mode;
    };
  }
}

function shapeData(shape: Shape): FeatureCollection {
  const g = toMultiPolygon(shape);
  return g.coordinates.length
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: g, properties: {} }] }
    : EMPTY;
}

function lineData(points: Position[], closed: boolean): FeatureCollection {
  const features: Feature[] = points.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: p },
    properties: {},
  }));
  if (points.length >= 2) {
    const coords = closed && points.length >= 3 ? [...points, points[0] as Position] : points;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {},
    });
  }
  return { type: 'FeatureCollection', features };
}

export default function BoundaryEditor(props: EditorProps) {
  const { data, field, adjacent, today } = props;
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const initialShape = useMemo(() => fromMultiPolygon(field?.geometry ?? null), [field?.geometry]);
  const [shape, setShape] = useState<Shape>(initialShape);
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const [mode, setMode] = useState<Mode>(field ? 'view' : 'draw');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [selected, setSelected] = useState<VertexRef | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [draft, setDraft] = useState<Position[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [effectiveOn, setEffectiveOn] = useState(today);
  const [otherId, setOtherId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const dragRef = useRef<VertexRef | null>(null);
  const markers = useRef<Marker[]>([]);
  const drawRef = useRef<() => void>(() => {});
  const proposing = !!field && !field.editable;

  // A new version from the server (after a save, or someone else's) resets the editor.
  useEffect(() => {
    setShape(initialShape);
    setMode(field ? 'view' : 'draw');
    setSelected(null);
    setDraft([]);
    setPieces([]);
  }, [initialShape, field]);

  // --- the map ------------------------------------------------------------------------------
  // Built once per page; later changes reach it through the redraw effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the map is built once
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const maplib = setupMapLibre();
    const style = buildMapStyle({
      origin: window.location.origin,
      basemap: data.basemap,
      glyphsPath: data.glyphsPath,
      fields: data.fields,
      flavor: 'dark',
    });
    const bounds = shapeBounds(shapeRef.current) ?? data.initialBounds;
    const map = new maplib.Map({
      container: el,
      style,
      bounds: [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      fitBoundsOptions: { padding: 60, maxZoom: 16 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    map.on('load', () => {
      for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY });
      map.addLayer({
        id: LAYER.piecesFill,
        type: 'fill',
        source: SRC.pieces,
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: LAYER.piecesLine,
        type: 'line',
        source: SRC.pieces,
        paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
      });
      map.addLayer({
        id: LAYER.fill,
        type: 'fill',
        source: SRC.shape,
        paint: { 'fill-color': '#4ade80', 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: LAYER.line,
        type: 'line',
        source: SRC.shape,
        paint: { 'line-color': '#4ade80', 'line-width': 3 },
      });
      map.addLayer({
        id: LAYER.draft,
        type: 'line',
        source: SRC.draft,
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#fbbf24', 'line-width': 3, 'line-dasharray': [2, 1] },
      });
      map.addLayer({
        id: LAYER.draftPts,
        type: 'circle',
        source: SRC.draft,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#fbbf24',
          'circle-stroke-color': '#0b1210',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: LAYER.mid,
        type: 'circle',
        source: SRC.mid,
        paint: {
          'circle-radius': 7,
          'circle-color': '#e7efe9',
          'circle-opacity': 0.55,
          'circle-stroke-color': '#0b1210',
          'circle-stroke-width': 1,
        },
      });
      map.addLayer({
        id: LAYER.vertices,
        type: 'circle',
        source: SRC.vertices,
        paint: {
          'circle-radius': 11,
          'circle-color': ['case', ['get', 'selected'], '#f87171', '#4ade80'],
          'circle-stroke-color': '#0b1210',
          'circle-stroke-width': 2,
        },
      });

      const begin = (e: MapLayerMouseEvent | MapLayerTouchEvent, onEdge: boolean) => {
        if (modeRef.current !== 'edit') return;
        const oe = e.originalEvent as TouchEvent | MouseEvent;
        if ('touches' in oe && oe.touches.length > 1) return; // two fingers: pan and zoom
        const ref = vertexRefOf(e.features?.[0]?.properties as Record<string, unknown> | undefined);
        if (!ref) return;
        e.preventDefault();
        if (onEdge) {
          shapeRef.current = insertPoint(shapeRef.current, ref, [e.lngLat.lng, e.lngLat.lat]);
        }
        dragRef.current = ref;
        selectedRef.current = ref;
        map.dragPan.disable();
        draw();
      };
      const move = (lng: number, lat: number) => {
        const d = dragRef.current;
        if (!d) return;
        shapeRef.current = movePoint(shapeRef.current, d, [lng, lat]);
        draw();
      };
      const end = () => {
        if (!dragRef.current) return;
        const sel = dragRef.current;
        dragRef.current = null;
        map.dragPan.enable();
        setShape(shapeRef.current);
        setSelected(sel);
      };
      map.on('mousedown', LAYER.vertices, (e) => begin(e, false));
      map.on('touchstart', LAYER.vertices, (e) => begin(e, false));
      map.on('mousedown', LAYER.mid, (e) => begin(e, true));
      map.on('touchstart', LAYER.mid, (e) => begin(e, true));
      map.on('mousemove', (e) => move(e.lngLat.lng, e.lngLat.lat));
      map.on('touchmove', (e) => {
        if (dragRef.current) e.preventDefault();
        move(e.lngLat.lng, e.lngLat.lat);
      });
      map.on('mouseup', end);
      map.on('touchend', end);
      map.on('touchcancel', end);
      map.on('click', (e) => {
        const m = modeRef.current;
        if (m === 'draw' || m === 'split') {
          setDraft((d) => [...d, [e.lngLat.lng, e.lngLat.lat]]);
        } else if (m === 'edit') {
          const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER.vertices] });
          if (!hit.length) setSelected(null);
        }
      });
      setReady(true);
      if (data.config.appEnv !== 'production') {
        window.__fieldEditor = {
          map,
          geometry: () => toMultiPolygon(shapeRef.current),
          mode: () => modeRef.current,
        };
      }
    });

    function draw() {
      const m = mapRef.current;
      if (!m?.getSource(SRC.shape)) return;
      const editing = modeRef.current === 'edit';
      (m.getSource(SRC.shape) as GeoJSONSource).setData(shapeData(shapeRef.current));
      (m.getSource(SRC.vertices) as GeoJSONSource).setData(
        editing ? vertexFeatures(shapeRef.current, selectedRef.current) : EMPTY,
      );
      (m.getSource(SRC.mid) as GeoJSONSource).setData(
        editing && !dragRef.current ? midpointFeatures(shapeRef.current) : EMPTY,
      );
    }
    drawRef.current = draw;

    return () => {
      for (const mk of markers.current) mk.remove();
      markers.current = [];
      mapRef.current = null;
      window.__fieldEditor = undefined;
      map.remove();
    };
  }, []);

  // A save re-renders the page with a new fields-tile version: show the new shapes underneath.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const url = new URL(data.fields.tilesPath, window.location.origin)
      .toString()
      .replace(/%7B/gi, '{')
      .replace(/%7D/gi, '}');
    (map.getSource(FIELDS_SOURCE) as VectorTileSource | undefined)?.setTiles([url]);
  }, [ready, data.fields.tilesPath]);

  // Redraw on every state change (draw() reads the refs; the state values are the triggers).
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape and selected trigger draw()
  useEffect(() => {
    if (!ready) return;
    drawRef.current();
    const map = mapRef.current;
    if (!map) return;
    (map.getSource(SRC.draft) as GeoJSONSource | undefined)?.setData(
      mode === 'draw' || mode === 'split' ? lineData(draft, mode === 'draw') : EMPTY,
    );
    (map.getSource(SRC.pieces) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: pieces.map((p, i) => ({
        type: 'Feature',
        geometry: p.geometry,
        properties: { color: PIECE_COLORS[i % PIECE_COLORS.length] },
      })),
    });
    for (const mk of markers.current) mk.remove();
    markers.current = [];
    if (pieces.length > 1) {
      const maplib = setupMapLibre();
      pieces.forEach((p, i) => {
        const el = document.createElement('div');
        el.textContent = String.fromCharCode(65 + i);
        el.style.cssText =
          'font:700 20px system-ui;color:#0b1210;background:#e7efe9;border-radius:999px;width:34px;height:34px;display:grid;place-items:center;box-shadow:0 2px 8px rgb(0 0 0 / 50%)';
        markers.current.push(new maplib.Marker({ element: el }).setLngLat(p.label).addTo(map));
      });
    }
  }, [ready, shape, mode, selected, draft, pieces]);

  // --- actions --------------------------------------------------------------------------------
  const report = useCallback(<T,>(r: DataResult<T>) => {
    setResult({ ok: r.ok, message: r.message });
    return r;
  }, []);

  /** A server action that never answered (network, the 1 MB body limit, a restart). */
  const failed = (e: unknown) =>
    setResult({
      ok: false,
      message: `The server could not be reached (${(e as Error).message}). Try again.`,
    });

  const reset = () => {
    setShape(initialShape);
    setSelected(null);
    setDraft([]);
    setPieces([]);
    setMode(field ? 'view' : 'draw');
  };

  const finishDraw = () => {
    if (draft.length < 3) {
      setResult({ ok: false, message: 'Tap at least three corners' });
      return;
    }
    setShape([[draft.map((p) => [p[0], p[1]] as [number, number])]]);
    setDraft([]);
    setMode('edit');
  };

  const save = async () => {
    if (!field) return;
    setBusy(true);
    try {
      const r = report(
        await saveBoundaryAction({
          fieldId: field.id,
          geometry: toMultiPolygon(shape),
          expectedBoundaryId: field.boundaryId,
          note: proposing ? note : undefined,
        }),
      );
      if (r.ok) {
        setMode('view');
        setNote('');
        router.refresh();
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const previewSplit = async () => {
    if (!field) return;
    setBusy(true);
    try {
      const line: LineString = { type: 'LineString', coordinates: draft };
      const r = report(await previewSplitAction({ fieldId: field.id, line }));
      if (r.ok && r.data) {
        setPieces(r.data);
        setNames(r.data.map((_, i) => `${field.name} ${String.fromCharCode(65 + i)}`));
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const doSplit = async () => {
    if (!field) return;
    setBusy(true);
    try {
      const r = report(
        await splitAction({
          fieldId: field.id,
          line: { type: 'LineString', coordinates: draft },
          names,
          effectiveOn,
        }),
      );
      if (r.ok && r.data?.childIds[0]) router.push(`/admin/fields/${r.data.childIds[0]}`);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const previewMerge = async (id: string) => {
    if (!field || !id) return;
    setOtherId(id);
    setBusy(true);
    try {
      const r = report(await previewMergeAction({ fieldId: field.id, otherId: id }));
      if (r.ok && r.data) {
        setPieces([r.data]);
        const other = adjacent.find((a) => a.fieldId === id);
        setNames([`${field.name} + ${other?.name ?? ''}`.trim()]);
      } else {
        setPieces([]);
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const doMerge = async () => {
    if (!field || !otherId) return;
    setBusy(true);
    try {
      const r = report(
        await mergeAction({ fieldId: field.id, otherId, name: names[0] ?? '', effectiveOn }),
      );
      if (r.ok && r.data) router.push(`/admin/fields/${r.data.childId}`);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  // --- new field form ---------------------------------------------------------------------------
  const [identity, setIdentity] = useState({
    name: '',
    farmId: props.farms[0]?.id ?? 'new',
    newFarmName: '',
    tenure: 'owned',
    landlordPartyId: '',
    countyFips: '',
  });
  const create = async () => {
    setBusy(true);
    try {
      const r = report(
        await createFieldAction({
          geometry: toMultiPolygon(shape),
          name: identity.name,
          farmId: identity.farmId === 'new' ? null : identity.farmId,
          newFarmName: identity.farmId === 'new' ? identity.newFarmName : null,
          tenure: identity.tenure,
          landlordPartyId: identity.landlordPartyId || null,
          countyFips: identity.countyFips || null,
        }),
      );
      if (r.ok && r.data) router.push(`/admin/fields/${r.data.fieldId}`);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  // --- render ---------------------------------------------------------------------------------
  const B = adminCss.button;
  const primary = `${adminCss.button} ${adminCss.primary}`;
  const hint: Record<Mode, string> = {
    view: proposing
      ? 'Read-only: this boundary is edited in Operations Center.'
      : field?.active === false
        ? 'This field is no longer active.'
        : 'Choose a tool above.',
    edit: 'Drag a corner to move it; drag a middle dot to add a corner; tap a corner to select it.',
    draw: 'Tap each corner of the field, then Finish.',
    split: pieces.length
      ? 'Name the pieces, then Split.'
      : 'Tap a line across the field (start and end outside it), then Preview.',
    merge: 'Pick the touching field to merge with.',
  };
  const canTools = !!field && field.active && !!field.boundaryId;
  const hasSide =
    !field ||
    !!result ||
    (mode === 'edit' && proposing) ||
    (mode === 'split' && pieces.length > 1) ||
    mode === 'merge';

  return (
    <div
      className={`${css.split} ${hasSide ? '' : css.splitWide}`}
      data-testid="boundary-editor"
      data-mode={mode}
    >
      <div className={css.mapWrap}>
        <div ref={container} className={css.map} data-testid="editor-map" />
        <div className={css.toolbar}>
          {mode === 'view' && field && (
            <>
              {field.editable && canTools && (
                <>
                  <button
                    type="button"
                    className={B}
                    onClick={() => setMode('edit')}
                    data-testid="tool-edit"
                  >
                    Edit points
                  </button>
                  <button
                    type="button"
                    className={B}
                    onClick={() => {
                      setDraft([]);
                      setMode('draw');
                    }}
                  >
                    Redraw
                  </button>
                  <button
                    type="button"
                    className={B}
                    onClick={() => {
                      setDraft([]);
                      setPieces([]);
                      setMode('split');
                    }}
                    data-testid="tool-split"
                  >
                    Split
                  </button>
                  <button
                    type="button"
                    className={B}
                    disabled={!adjacent.some((a) => a.editable && a.sameFarm)}
                    title={adjacent.length ? undefined : 'No touching field'}
                    onClick={() => {
                      setPieces([]);
                      setOtherId('');
                      setMode('merge');
                    }}
                    data-testid="tool-merge"
                  >
                    Merge
                  </button>
                </>
              )}
              {field.editable && field.active && !field.boundaryId && (
                <button type="button" className={B} onClick={() => setMode('draw')}>
                  Draw the boundary
                </button>
              )}
              {proposing && (
                <button
                  type="button"
                  className={B}
                  onClick={() => setMode('edit')}
                  data-testid="tool-propose"
                >
                  Propose a change
                </button>
              )}
            </>
          )}
          {mode === 'edit' && (
            <>
              {field && (
                <button
                  type="button"
                  className={primary}
                  disabled={busy}
                  onClick={save}
                  data-testid="editor-save"
                >
                  {proposing ? 'Save as Ops Center request' : 'Save boundary'}
                </button>
              )}
              <button
                type="button"
                className={B}
                disabled={!selected}
                onClick={() => {
                  if (!selected) return;
                  const next = deletePoint(shape, selected);
                  if (next) {
                    setShape(next);
                    setSelected(null);
                  } else {
                    setResult({ ok: false, message: 'A ring needs at least three corners' });
                  }
                }}
              >
                Delete point
              </button>
              {field && (
                <button type="button" className={B} onClick={reset}>
                  Cancel
                </button>
              )}
              {!field && (
                <button
                  type="button"
                  className={B}
                  onClick={() => {
                    setShape([]);
                    setDraft([]);
                    setMode('draw');
                  }}
                >
                  Start over
                </button>
              )}
            </>
          )}
          {mode === 'draw' && (
            <>
              <button
                type="button"
                className={primary}
                onClick={finishDraw}
                data-testid="draw-finish"
              >
                Finish
              </button>
              <button
                type="button"
                className={B}
                disabled={!draft.length}
                onClick={() => setDraft((d) => d.slice(0, -1))}
              >
                Undo
              </button>
              {field && (
                <button type="button" className={B} onClick={reset}>
                  Cancel
                </button>
              )}
            </>
          )}
          {mode === 'split' && (
            <>
              {!pieces.length ? (
                <button
                  type="button"
                  className={primary}
                  disabled={busy || draft.length < 2}
                  onClick={previewSplit}
                  data-testid="split-preview"
                >
                  Preview
                </button>
              ) : null}
              <button
                type="button"
                className={B}
                disabled={!draft.length}
                onClick={() => {
                  setPieces([]);
                  setDraft((d) => d.slice(0, -1));
                }}
              >
                Undo
              </button>
              <button type="button" className={B} onClick={reset}>
                Cancel
              </button>
            </>
          )}
          {mode === 'merge' && (
            <button type="button" className={B} onClick={reset}>
              Cancel
            </button>
          )}
        </div>
        <div className={css.hint} data-testid="editor-hint">
          {hint[mode]}
        </div>
      </div>

      <div className={adminCss.stack}>
        {result && (
          <p
            role="status"
            data-testid="editor-message"
            data-ok={result.ok}
            className={result.ok ? undefined : adminCss.error}
          >
            {result.message}
          </p>
        )}
        {mode === 'edit' && proposing && (
          <label className={css.label}>
            What should change in Operations Center?
            <textarea
              className={css.textarea}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        )}
        {mode === 'split' && pieces.length > 1 && (
          <section className={adminCss.card}>
            <h2>Split into {pieces.length} fields</h2>
            <div className={css.pieces}>
              {pieces.map((p, i) => (
                <label key={p.label.join(',')} className={css.label}>
                  {String.fromCharCode(65 + i)}: {p.acres.toFixed(1)} ac
                  <input
                    className={css.input}
                    value={names[i] ?? ''}
                    onChange={(e) =>
                      setNames((n) => n.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    data-testid={`split-name-${i}`}
                  />
                </label>
              ))}
              <label className={css.label}>
                From (the old field ends that day)
                <input
                  type="date"
                  className={css.input}
                  value={effectiveOn}
                  max={today}
                  onChange={(e) => setEffectiveOn(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={primary}
                disabled={busy}
                onClick={doSplit}
                data-testid="split-apply"
              >
                Split
              </button>
            </div>
          </section>
        )}
        {mode === 'merge' && (
          <section className={adminCss.card}>
            <h2>Merge with</h2>
            <div className={css.pieces}>
              <select
                className={adminCss.select}
                value={otherId}
                onChange={(e) => previewMerge(e.target.value)}
                data-testid="merge-other"
              >
                <option value="">Pick a touching field…</option>
                {adjacent
                  .filter((a) => a.editable && a.sameFarm)
                  .map((a) => (
                    <option key={a.fieldId} value={a.fieldId}>
                      {a.name}
                      {a.gapM > 0.5 ? ` (${a.gapM.toFixed(1)} m gap)` : ''}
                    </option>
                  ))}
              </select>
              {pieces.length === 1 && (
                <>
                  <p className={css.muted}>Together: {pieces[0]?.acres.toFixed(1)} ac</p>
                  <label className={css.label}>
                    Name of the merged field
                    <input
                      className={css.input}
                      value={names[0] ?? ''}
                      onChange={(e) => setNames([e.target.value])}
                      data-testid="merge-name"
                    />
                  </label>
                  <label className={css.label}>
                    From (both fields end that day)
                    <input
                      type="date"
                      className={css.input}
                      value={effectiveOn}
                      max={today}
                      onChange={(e) => setEffectiveOn(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={primary}
                    disabled={busy}
                    onClick={doMerge}
                    data-testid="merge-apply"
                  >
                    Merge
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        {!field && (
          <section className={adminCss.card} data-testid="new-field-form">
            <h2>New field</h2>
            <div className={css.form}>
              <label className={css.label}>
                Name
                <input
                  className={css.input}
                  value={identity.name}
                  onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
                  data-testid="new-field-name"
                />
              </label>
              <label className={css.label}>
                Farm
                <select
                  className={adminCss.select}
                  value={identity.farmId}
                  onChange={(e) => setIdentity({ ...identity, farmId: e.target.value })}
                >
                  {props.farms.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                  <option value="new">New farm…</option>
                </select>
              </label>
              {identity.farmId === 'new' && (
                <label className={css.label}>
                  New farm name
                  <input
                    className={css.input}
                    value={identity.newFarmName}
                    onChange={(e) => setIdentity({ ...identity, newFarmName: e.target.value })}
                  />
                </label>
              )}
              <label className={css.label}>
                Tenure
                <select
                  className={adminCss.select}
                  value={identity.tenure}
                  onChange={(e) => setIdentity({ ...identity, tenure: e.target.value })}
                >
                  {TENURES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className={css.label}>
                Landlord
                <select
                  className={adminCss.select}
                  value={identity.landlordPartyId}
                  onChange={(e) => setIdentity({ ...identity, landlordPartyId: e.target.value })}
                >
                  <option value="">None</option>
                  {props.landlords.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className={css.label}>
                County (26091 Lenawee, 26115 Monroe)
                <input
                  className={css.input}
                  value={identity.countyFips}
                  inputMode="numeric"
                  onChange={(e) => setIdentity({ ...identity, countyFips: e.target.value })}
                />
              </label>
              <button
                type="button"
                className={primary}
                disabled={busy || mode !== 'edit' || !identity.name.trim()}
                onClick={create}
                data-testid="new-field-create"
              >
                Create field
              </button>
              {mode !== 'edit' && <p className={css.muted}>Draw the outline on the map first.</p>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
