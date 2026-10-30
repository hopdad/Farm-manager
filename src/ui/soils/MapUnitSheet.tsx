'use client';
/**
 * The soil map unit sheet (soil map Phase A): with soils on, a tap on the map outside any field
 * opens the map unit under the finger (a field tap still opens the field panel). Owner: soils.
 *
 *   <MapUnitSheet variant="wall" map={map} />   (BoardScreen; opened through ./sheet-store.ts)
 *
 *  - Opens at once from the tapped tile feature (symbol, name, drainage, hydrologic group,
 *    farmland class, NCCPI), then GET /api/soils/mapunits/<mukey> adds the components with their
 *    percentages and the survey.
 *  - Links each major series to its official description, online only (offline it says so).
 *  - Outlines the map unit's polygons on the map while open (`layer:soils:selected`).
 *  - Wall: a side panel where the field panel goes (72 px targets); phone: a bottom sheet.
 *    Closes with the X, Escape, a tap elsewhere on the map, or a field or machine tap.
 */
import type { FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useId, useState } from 'react';
import { SOILS_IDS, selectedFilter } from '../map/layers/soils';
import type { MapVariant } from '../map/types';
import {
  MAP_UNIT_PATH,
  type MapUnitDetail,
  type MapUnitPreview,
  type MapUnitView,
  mapUnitView,
} from './map-unit';
import css from './map-unit-sheet.module.css';
import { useMapUnitSheet } from './sheet-store';

export interface MapUnitSheetProps {
  variant: MapVariant;
  /** The board's map, for the outline of the open map unit (optional). */
  map?: MapLibreMap | null;
}

type DetailState =
  | { status: 'loading'; detail: null }
  | { status: 'ready'; detail: MapUnitDetail }
  | { status: 'not_found'; detail: null }
  | { status: 'error'; detail: null; error: string };

/** Details already loaded in this tab (map units don't change while a page is open). */
const cache = new Map<string, MapUnitDetail>();

function useMapUnitDetail(mukey: string): { state: DetailState; retry(): void } {
  const [state, setState] = useState<DetailState>(() => {
    const hit = cache.get(mukey);
    return hit ? { status: 'ready', detail: hit } : { status: 'loading', detail: null };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    void attempt;
    const hit = cache.get(mukey);
    if (hit) {
      setState({ status: 'ready', detail: hit });
      return;
    }
    const ctrl = new AbortController();
    setState({ status: 'loading', detail: null });
    fetch(`${MAP_UNIT_PATH}/${encodeURIComponent(mukey)}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 404) {
          setState({ status: 'not_found', detail: null });
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const detail = (await r.json()) as MapUnitDetail;
        cache.set(mukey, detail);
        setState({ status: 'ready', detail });
      })
      .catch((e: Error) => {
        if (!ctrl.signal.aborted) setState({ status: 'error', detail: null, error: e.message });
      });
    return () => ctrl.abort();
  }, [mukey, attempt]);
  return { state, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Outline the open map unit's polygons (and nothing once closed); survives a layer re-add. */
function useSelectedOutline(map: MapLibreMap | null | undefined, mukey: string | null) {
  useEffect(() => {
    if (!map) return;
    const want = selectedFilter(mukey);
    const set = (filter: FilterSpecification) => {
      try {
        if (!map.getLayer(SOILS_IDS.selected)) return;
        if (JSON.stringify(map.getFilter(SOILS_IDS.selected)) === JSON.stringify(filter)) return;
        map.setFilter(SOILS_IDS.selected, filter);
      } catch {
        // The map is gone or its style is reloading: the next styledata puts it back.
      }
    };
    const apply = () => set(want);
    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
      set(selectedFilter(null));
    };
  }, [map, mukey]);
}

export function MapUnitSheet({ variant, map = null }: MapUnitSheetProps) {
  const current = useMapUnitSheet((s) => s.current);
  const close = useMapUnitSheet((s) => s.close);
  useSelectedOutline(map, current?.mukey ?? null);
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [current, close]);
  if (!current) return null;
  return <SheetBody key={current.mukey} preview={current} variant={variant} onClose={close} />;
}

function SheetBody({
  preview,
  variant,
  onClose,
}: {
  preview: MapUnitPreview;
  variant: MapVariant;
  onClose(): void;
}) {
  const titleId = useId();
  const { state, retry } = useMapUnitDetail(preview.mukey);
  const online = useOnline();
  const v = mapUnitView(preview, state.detail);
  return (
    <aside
      className={`${css.sheet} ${variant === 'wall' ? css.wall : css.phone}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="map-unit-sheet"
      data-mukey={preview.mukey}
      data-state={state.status}
      data-dock={variant === 'wall' ? 'right' : undefined}
    >
      <header className={css.header}>
        <div>
          <div className={css.kicker}>Soil map unit</div>
          <h2 id={titleId} className={css.title} data-testid="map-unit-title">
            <span className={css.symbol}>{v.symbol}</span> {v.name}
          </h2>
          {v.area && (
            <div className={css.meta} data-testid="map-unit-area">
              {v.area}
            </div>
          )}
        </div>
        <button
          type="button"
          className={css.close}
          aria-label="Close"
          onClick={onClose}
          data-testid="map-unit-close"
        >
          ×
        </button>
      </header>
      <div className={css.body}>
        {v.synthetic && (
          <p className={css.warn} data-testid="map-unit-synthetic">
            Synthetic test fixture, not survey data: run <code>pnpm gis:soils</code> on the PC.
          </p>
        )}
        <Facts v={v} />
        <section className={css.section}>
          <h3 className={css.sectionTitle}>Components</h3>
          <Components v={v} state={state} variant={variant} onRetry={retry} />
        </section>
        <Series v={v} online={online} loading={state.status === 'loading'} />
        <p className={css.foot}>
          Drainage class and hydrologic group are the dominant component&apos;s
          {state.detail?.components[0]
            ? ` (${state.detail.components[0].name}, ${state.detail.components[0].pct} %)`
            : ''}
          ; NCCPI is weighted by component percent. Soils: USDA NRCS SSURGO.
        </p>
      </div>
    </aside>
  );
}

function Facts({ v }: { v: MapUnitView }) {
  return (
    <dl className={css.facts}>
      {v.facts.map((f) => (
        <div key={f.key} className={css.fact} data-testid={`map-unit-fact-${f.key}`}>
          <dt className={css.factLabel}>{f.label}</dt>
          <dd className={css.factValue}>
            <span className={css.swatch} style={{ background: f.color }} aria-hidden="true" />
            {f.value}
          </dd>
          {f.detail && <dd className={css.factDetail}>{f.detail}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Components({
  v,
  state,
  variant,
  onRetry,
}: {
  v: MapUnitView;
  state: DetailState;
  variant: MapVariant;
  onRetry(): void;
}) {
  if (state.status === 'loading') {
    return (
      <div role="status" aria-busy="true" aria-label="Loading components">
        {[70, 55, 40].map((w) => (
          <div key={w} className={css.skeleton} style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  if (state.status === 'not_found') {
    return <p className={css.muted}>This map unit is no longer in the soils database.</p>;
  }
  if (state.status === 'error') {
    return (
      <div className={css.muted} role="alert">
        Couldn’t load the components ({state.error}).{' '}
        <button type="button" className={css.button} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  const rows = v.components ?? [];
  if (rows.length === 0) return <p className={css.muted}>No components recorded.</p>;
  if (variant === 'phone') {
    return (
      <div>
        {rows.map((c) => (
          <div key={c.name} className={css.item} data-testid="map-unit-component">
            <div>
              <strong>{c.name}</strong>
              {c.major && <span className={css.badge}>major</span>}
              <span className={css.num}>{c.pct}</span>
            </div>
            <div className={css.muted}>
              {c.drainage} · group {c.hydgrp} · NCCPI {c.nccpi}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <table className={css.table}>
      <thead>
        <tr>
          <th>Component</th>
          <th className={css.num}>Share</th>
          <th>Drainage</th>
          <th>Hyd. group</th>
          <th className={css.num}>NCCPI</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.name} data-testid="map-unit-component">
            <td>
              {c.name}
              {c.major && <span className={css.badge}>major</span>}
            </td>
            <td className={css.num}>{c.pct}</td>
            <td>{c.drainage}</td>
            <td>{c.hydgrp}</td>
            <td className={css.num}>{c.nccpi}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Series({ v, online, loading }: { v: MapUnitView; online: boolean; loading: boolean }) {
  if (loading || v.series.length === 0) return null;
  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>Official series description</h3>
      {online ? (
        <div className={css.links}>
          {v.series.map((s) => (
            <a
              key={s.name}
              className={css.link}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="map-unit-osd-link"
            >
              {s.name} series (USDA, opens online)
            </a>
          ))}
        </div>
      ) : (
        <p className={css.muted} data-testid="map-unit-osd-offline">
          Offline: the official series descriptions need the internet.
        </p>
      )}
    </section>
  );
}
