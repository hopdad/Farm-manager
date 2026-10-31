/**
 * Setting a vehicle's kind by hand (slice 1f.2, terminal-pickups; docs/contracts-1f.md §B.4.5),
 * shared by /admin/vehicles' server actions and its JSON route: `setMachineKindByAdmin` (a kind set
 * here always wins over vendor tags) or `releaseMachineKind` (vendor tags decide again), then
 * `fleet`/`invalidate` { event: 'machine', reason: 'changed' } so the panel and the map refetch.
 * The callers check the session (requireRole(ROLE_FOR.admin)) FIRST.
 */
import { z } from 'zod';
import type { Executor } from '@/db/exec';
import { releaseMachineKind, setMachineKindByAdmin, type VehicleRow } from '@/db/queries/vehicles';
import { VEHICLE_KINDS, vehicleKindSchema } from '@/domain/vehicles';
import { publish } from '@/platform/realtime/publish';

/** `{ machineId, kind }` sets it; `{ machineId, release: true }` hands it back to the vendor tags. */
export const setVehicleKindRequestSchema = z.union([
  z.strictObject({ machineId: z.uuid(), kind: vehicleKindSchema }),
  z.strictObject({ machineId: z.uuid(), release: z.literal(true) }),
]);
export type SetVehicleKindRequest = z.infer<typeof setVehicleKindRequestSchema>;

export const KIND_CHOICES = VEHICLE_KINDS;

/** Apply one request; null = no such machine (nothing published). */
export async function setVehicleKind(
  ex: Executor,
  rq: SetVehicleKindRequest,
): Promise<VehicleRow | null> {
  const row =
    'release' in rq
      ? await releaseMachineKind(ex, rq.machineId)
      : await setMachineKindByAdmin(ex, rq.machineId, rq.kind);
  if (row) await publish('fleet', 'invalidate', { event: 'machine', reason: 'changed' }, ex);
  return row;
}
