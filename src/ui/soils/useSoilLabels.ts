'use client';
/**
 * Keeps the soils layer's label points (`layer:soils:labels`, ../map/layers/soils.ts) filled
 * from GET /api/soils/labels while the soils layer is drawn (soil map Phase A). Owner: soils;
 * the layer rail runs it, next to applyLayers.
 *
 *  - After the map settles (moveend, debounced) at zoom 13 and in: one request for the view
 *    snapped outward to whole tiles plus a margin (../map/layers/soils-labels.ts), so pans
 *    inside the last answer ask nothing; a newer request aborts the one in flight.
 *  - The answer goes into the GeoJSON source with setData; if the rail re-adds the source (a new
 *    soils version, a style reload), the last answer is put back.
 *  - A failed request keeps the labels drawn and tries again on the next move.
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { useEffect } from 'react';
import { SOILS_IDS } from '../map/layers/soils';
import {
  type LabelCoverage,
  planLabelFetch,
  type SoilLabelsResponse,
  soilLabelsUrl,
} from '../map/layers/soils-labels';

/** Wait this long after the map stops moving. */
export const LABELS_DEBOUNCE_MS = 200;

export interface SoilLabelsOptions {
  /** The soils layer is on and ready (labels are fetched only then). */
  enabled: boolean;
  /** The soils layer's version (row.version): the URL carries it, so a reload refetches. */
  version: string | null;
}

export function useSoilLabels(map: MapLibreMap | null, { enabled, version }: SoilLabelsOptions) {
  useEffect(() => {
    if (!map || !enabled) return;
    let last: LabelCoverage | null = null;
    let data: SoilLabelsResponse | null = null;
    let filled: object | null = null;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const source = () => map.getSource(SOILS_IDS.labelsSource) as GeoJSONSource | undefined;
    // The source the rail added, holding the last answer (re-filled after a re-add).
    const ensure = () => {
      const s = source();
      if (!s || !data || s === filled) return;
      s.setData(data);
      filled = s;
    };
    const refresh = () => {
      timer = null;
      const b = map.getBounds();
      const view = {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      };
      const plan = planLabelFetch(view, map.getZoom(), version, last);
      if (!plan) {
        ensure();
        return;
      }
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      fetch(soilLabelsUrl(plan.bbox, plan.z, plan.version), { signal: mine.signal })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<SoilLabelsResponse>;
        })
        .then((fc) => {
          if (mine.signal.aborted) return;
          last = plan;
          data = fc;
          filled = null;
          ensure();
        })
        .catch((e: Error) => {
          if (!mine.signal.aborted) console.warn('[soil labels]', e.message);
        });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, LABELS_DEBOUNCE_MS);
    };
    map.on('moveend', schedule);
    map.on('styledata', ensure);
    map.on('sourcedata', ensure);
    schedule();
    return () => {
      map.off('moveend', schedule);
      map.off('styledata', ensure);
      map.off('sourcedata', ensure);
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }, [map, enabled, version]);
}
