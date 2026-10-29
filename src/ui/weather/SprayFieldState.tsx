'use client';
/**
 * Paints the current hour's spray verdicts on the map (docs/contracts-m1.md §7.3): renders
 * nothing; loads GET /api/weather/spray (field id -> verdict, stale forecasts shown as caution)
 * and sets each field's feature state `{ verdict }` on the fields source, which the `spray`
 * layer (src/ui/map/layers/spray.ts) colours. Fields no longer listed are cleared. Refetches on
 * spray/assessed and every resync, and re-applies after a style reload ('styledata' drops
 * feature state).
 *
 * Test hook (only where the map's own `window.__map` test API is installed, i.e. never in
 * production): `window.__spray` with the verdicts applied and each field's feature state.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import type { SprayVerdict } from '../../domain/weather';
import { FIELDS_SOURCE, FIELDS_SOURCE_LAYER } from '../map/style';
import type { SprayMapResponse } from './contract';
import { useLiveJson } from './useLiveJson';

export interface SprayTestApi {
  /** The hour the applied verdicts are for. */
  forHour(): string | null;
  /** field id -> verdict as last applied. */
  verdicts(): Record<string, SprayVerdict>;
  /** The map's feature state `verdict` of one field (null when unset). */
  featureState(fieldId: string): string | null;
  /** How many times verdicts were applied (changes after each refetch). */
  applied(): number;
}

declare global {
  interface Window {
    __spray?: SprayTestApi;
  }
}

const TOPICS = ['spray'] as const;

/** The part of maplibre's Map this uses (a fake implements it in tests). */
export type FeatureStateMap = Pick<
  MapLibreMap,
  'getSource' | 'setFeatureState' | 'removeFeatureState' | 'getFeatureState' | 'on' | 'off'
>;

/**
 * Bring the map's feature state in line with `next` (field id -> verdict); returns what is now
 * applied. Fields in `prev` but not in `next` lose their verdict. No-op while the fields source
 * isn't there (style loading): the caller re-applies on 'styledata'.
 */
export function applyVerdicts(
  map: FeatureStateMap,
  prev: ReadonlyMap<string, SprayVerdict>,
  next: ReadonlyMap<string, SprayVerdict>,
): Map<string, SprayVerdict> | null {
  if (!map.getSource(FIELDS_SOURCE)) return null;
  const target = (id: string) => ({ source: FIELDS_SOURCE, sourceLayer: FIELDS_SOURCE_LAYER, id });
  for (const id of prev.keys()) {
    if (!next.has(id)) map.removeFeatureState(target(id), 'verdict');
  }
  for (const [id, verdict] of next) map.setFeatureState(target(id), { verdict });
  return new Map(next);
}

export function SprayFieldState({ map }: { map: MapLibreMap | null }) {
  const { data } = useLiveJson<SprayMapResponse>('/api/weather/spray', TOPICS);
  const applied = useRef<Map<string, SprayVerdict>>(new Map());
  const count = useRef(0);

  useEffect(() => {
    if (!map || !data) return;
    const next = new Map(data.fields.map((f) => [f.fieldId, f.verdict] as const));
    const apply = () => {
      const done = applyVerdicts(map, applied.current, next);
      if (done) {
        applied.current = done;
        count.current++;
      }
    };
    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [map, data]);

  useEffect(() => {
    if (!map || typeof window === 'undefined' || !window.__map) return;
    const api: SprayTestApi = {
      forHour: () => data?.forHour ?? null,
      verdicts: () => Object.fromEntries(applied.current),
      featureState: (fieldId) => {
        const s = map.getFeatureState({
          source: FIELDS_SOURCE,
          sourceLayer: FIELDS_SOURCE_LAYER,
          id: fieldId,
        }) as { verdict?: unknown } | undefined;
        return typeof s?.verdict === 'string' ? s.verdict : null;
      },
      applied: () => count.current,
    };
    window.__spray = api;
    return () => {
      if (window.__spray === api) delete window.__spray;
    };
  }, [map, data]);

  return null;
}

export default SprayFieldState;
