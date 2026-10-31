/**
 * What the vehicle-list streams share (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.4):
 * which vendor vehicles the farm maps (so the clients ask for and land only those: a hired
 * hauler's whole fleet never lands in ingest.raw_events, and vehicles are never created from a
 * vendor list), and the upsert of a `vehicles` stream (kind from tags, via) with ONE
 * `fleet`/`invalidate` per run when a machine changed. Used by fleet.vehicles (Samsara) and
 * fleet.terminal; vendor-neutral.
 */

import { type Executor, exec } from '../../db/exec';
import { applyVendorVehicle } from '../../db/queries/vehicles';
import { publish } from '../../platform/realtime/publish';
import type { ConnectorSource, NormalizedVehicle, SyncContext, SyncStepResult } from '../types';

/** The vendor's mapped vehicle ids, per external_refs source_org ('' for vendors with no org). */
export async function mappedVehicleRefs(
  ex: Executor,
  source: ConnectorSource,
): Promise<Map<string, Set<string>>> {
  const r = await exec<{ source_org: string; external_id: string }>(
    ex,
    `select source_org, external_id from ingest.external_refs
      where source = $1 and kind = 'machine'
      order by source_org, external_id`,
    [source],
  );
  const out = new Map<string, Set<string>>();
  for (const row of r.rows) {
    const set = out.get(row.source_org) ?? new Set<string>();
    set.add(row.external_id);
    out.set(row.source_org, set);
  }
  return out;
}

/** Every mapped vehicle id of a vendor, whatever its source_org. */
export function allMappedIds(refs: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  return new Set([...refs.values()].flatMap((s) => [...s]));
}

type Resolve = (
  ex: Executor,
  sctx: SyncContext,
  source: ConnectorSource,
  sourceOrg: string,
  externalId: string,
) => Promise<string | null>;

/**
 * A vehicle-list stream's `upsert` (applyVendorVehicle: an admin-set kind never changes) and
 * `afterRun` (ONE `fleet`/`invalidate` { event: 'machine', reason: 'changed' } when a machine
 * changed this run, then `then`, the stream's sync status).
 */
export function vehicleListUpsert(
  resolve: Resolve,
  then: (result: SyncStepResult, sctx: SyncContext) => Promise<void>,
) {
  let changed = 0;
  return {
    upsert: async (tx: Executor, v: NormalizedVehicle, sctx: SyncContext): Promise<void> => {
      const id = await resolve(tx, sctx, v.source, v.sourceOrg, v.externalId);
      if (!id) return;
      const r = await applyVendorVehicle(tx, id, { kindFromTags: v.kindFromTags, via: v.via });
      if (r?.changed) changed++;
    },
    afterRun: async (result: SyncStepResult, sctx: SyncContext): Promise<void> => {
      if (changed > 0) {
        changed = 0;
        await publish(
          'fleet',
          'invalidate',
          { event: 'machine', reason: 'changed' },
          sctx.job.pool,
        );
      }
      await then(result, sctx);
    },
  };
}
