/**
 * Every layer the rail offers (contract: ./types.ts). INTEGRATOR-OWNED list: each builder adds
 * only its own import line and its own entries (merge conflicts stay one-liners), e.g.
 *
 *   import { soilsLayer } from './soils';
 *   export const LAYER_DEFS: readonly LayerDef[] = [fieldsLayer, soilsLayer, …];
 *
 * The rail shows `resolveLayers(LAYER_DEFS, rows)`.
 */
import { customersLayer, fieldsLayer, fleetLayer } from './builtin';
import { naipAoiLayer, naipLayer } from './naip';
import { parcelsLayer } from './parcels';
import { tileLayer } from './tile';
import type { LayerDef } from './types';

export const LAYER_DEFS: readonly LayerDef[] = [
  fieldsLayer,
  fleetLayer,
  customersLayer,
  parcelsLayer,
  tileLayer,
  naipLayer,
  naipAoiLayer,
];
