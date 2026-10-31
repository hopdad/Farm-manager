'use client';
/**
 * The soil map units drawn on screen, kept current while `enabled` (the soils layer on and the
 * rail showing its legend): re-read after the map stops moving and as soils tiles arrive,
 * coalesced, and only from zoom 12 in (./in-view.ts does the reading and the counting). null
 * while disabled. Owner: soils.
 */
import type { Map as MapLibreMap, MapSourceDataEvent } from 'maplibre-gl';
import { useEffect, useState } from 'react';
import { SOILS_IDS } from '../map/layers/soils';
import { type InView, readUnitsInView, sameInView } from './in-view';

const SETTLE_MS = 300;

export function useSoilsInView(map: MapLibreMap | null, enabled: boolean): InView | null {
  const [units, setUnits] = useState<InView | null>(null);
  useEffect(() => {
    if (!map || !enabled) {
      setUnits(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      const next = readUnitsInView(map);
      setUnits((prev) => (sameInView(prev, next) ? prev : next));
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
