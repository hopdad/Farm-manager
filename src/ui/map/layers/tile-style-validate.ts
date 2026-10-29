/**
 * Test helper for the imagery builder's layer defs (naip, parcels, tile): check a def's spec
 * against the MapLibre style specification, the same validator MapLibre runs on addLayer (so an
 * expression MapLibre would refuse at runtime fails a unit test instead). The style-spec package
 * is maplibre-gl's own dependency, resolved through maplibre-gl (no extra install). Tests only.
 */
import { createRequire } from 'node:module';
import type { StyleSpecification } from 'maplibre-gl';
import type { LayerSpec } from './types';

type ValidateStyleMin = (style: StyleSpecification) => { message: string }[];

let validator: ValidateStyleMin | null = null;

function load(): ValidateStyleMin {
  if (validator) return validator;
  const fromMaplibre = createRequire(
    createRequire(import.meta.url).resolve('maplibre-gl/package.json'),
  );
  const spec = fromMaplibre('@maplibre/maplibre-gl-style-spec') as {
    validateStyleMin: ValidateStyleMin;
  };
  validator = spec.validateStyleMin;
  return validator;
}

/** MapLibre's error messages for a spec placed in a minimal style ([] = valid). */
export function styleErrors(
  spec: LayerSpec,
  extraSources: StyleSpecification['sources'] = {},
): string[] {
  const style: StyleSpecification = {
    version: 8,
    glyphs: 'http://localhost/fonts/{fontstack}/{range}.pbf',
    sources: { ...extraSources, ...spec.sources },
    layers: spec.layers,
  };
  return load()(style).map((e) => e.message);
}
