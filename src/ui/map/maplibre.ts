/**
 * One-time MapLibre setup in the browser (plan §3): MapLibre 6 is ESM-only and runs its worker
 * as a module worker, which a bundler must emit as an asset (setWorkerUrl), and the local
 * basemap is a PMTiles archive read with HTTP range requests through the `pmtiles://` protocol.
 * Client-only module.
 */
import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let ready = false;

export function setupMapLibre(): typeof maplibregl {
  if (ready) return maplibregl;
  ready = true;
  maplibregl.setWorkerUrl(
    new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString(),
  );
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  return maplibregl;
}
