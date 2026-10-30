'use client';
/**
 * The soil map units drawn on screen, kept current while `enabled` (the soils layer on and the
 * rail showing its legend): re-read after the map stops moving and as soils tiles arrive,
 * coalesced (./in-view.ts does the counting). null while disabled. Owner: soils.
 */
import type { Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';
import { useEffect, useState } from 'react';
import { SOILS_IDS } from '../map/layers/soils';
import { sameUnits, unitsInView } from './in-view';
import type { MapUnitPreview } from './map-unit';

const SETTLE_MS = 300;

export function useSoilsInView(map: MapLibreMap | null, enabled: boolean): MapUnitPreview[] | null {
  const [units, setUnits] = useState<MapUnitPreview[] | null>(null);
  useEffect(() => {
    if (!map || !enabled) {
      setUnits(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      const next = map.getLayer(SOILS_IDS.fill)
        ? unitsInView(map.queryRenderedFeatures({ layers: [SOILS_IDS.fill] }))
        : [];
      setUnits((prev) => (sameUnits(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, SETTLE_MS);
    };
    const onSource = (e: MapSourceDataEvent) => {
      if (e.sourceId === SOILS_IDS.source && e.tile) schedule();
    };
    map.on('moveend', schedule);
    map.on('sourcedata', onSource);
    schedule();
    return () => {
      map.off('moveend', schedule);
      map.off('sourcedata', onSource);
      if (timer) clearTimeout(timer);
    };
  }, [map, enabled]);
  return units;
}
