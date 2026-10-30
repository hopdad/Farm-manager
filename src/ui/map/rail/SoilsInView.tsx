'use client';
/**
 * "In this view" under the soils legend (soil map Phase A): the map units drawn on screen, by
 * symbol, each with its swatch in the chosen mode, like Web Soil Survey's Map Unit Legend.
 * Owner: soils. Data: ../../soils/useSoilsInView.ts (only while this is mounted: soils on and
 * the rail open).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { IN_VIEW_MAX_ROWS } from '../../soils/in-view';
import { useSoilsInView } from '../../soils/useSoilsInView';
import { soilClassOf, soilMapModeOf } from '../layers/soils';
import type { BasemapFlavor } from '../types';
import css from './rail.module.css';

export function SoilsInView({
  map,
  mode,
  flavor,
  zoom,
}: {
  map: MapLibreMap | null;
  mode: string;
  flavor: BasemapFlavor;
  zoom: number | null;
}) {
  const units = useSoilsInView(map, true);
  const m = soilMapModeOf(mode);
  if (units === null) return null;
  const rows = units.slice(0, IN_VIEW_MAX_ROWS);
  const more = units.length - rows.length;
  return (
    <div className={css.inView} data-testid="soils-in-view" data-count={units.length}>
      <div className={css.legendTitle}>
        In this view: {units.length} map unit{units.length === 1 ? '' : 's'}
      </div>
      {units.length === 0 && (
        <div className={css.legendNote}>
          {zoom !== null && zoom < 10 ? 'Zoom in to see the soils.' : 'No soil map units here.'}
        </div>
      )}
      {rows.map((u) => {
        const c = soilClassOf(m, u, flavor);
        return (
          <div
            key={u.mukey}
            className={css.inViewRow}
            data-testid="soils-in-view-row"
            data-mukey={u.mukey}
          >
            <span
              className={`${css.swatch} ${m === 'type' ? css.swatchLine : ''}`}
              style={m === 'type' ? { borderColor: c.color } : { background: c.color }}
              title={c.label}
            />
            <span className={css.symbol}>{u.musym ?? '—'}</span>
            <span className={css.unitName}>{u.muname ?? ''}</span>
          </div>
        );
      })}
      {more > 0 && <div className={css.legendNote}>and {more} more: zoom in to list them</div>}
      {units.length > 0 && (
        <div className={css.legendNote}>
          Drainage and hydrologic group are each map unit&apos;s dominant component; NCCPI is
          weighted by component percent. Tap the map for a map unit&apos;s components.
        </div>
      )}
    </div>
  );
}
