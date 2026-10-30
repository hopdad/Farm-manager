/**
 * Telematics vehicles' kind and route (slice 1f.2, docs/contracts-1f.md part B): the one writer
 * of farm.machines.kind / kind_set_by / telematics_via for the vendor vehicle lists and the
 * /admin control. Rules (src/domain/vehicles.ts `nextVehicleKind`): a kind set on /admin
 * (`kind_set_by = 'admin'`) never changes by a vendor tag; a vendor tag's kind replaces a default
 * or an earlier vendor kind; a vendor that names no kind changes nothing; `via` is written when the
 * vendor says it (null leaves it as it is).
 *
 * Owned by the foundation now; the terminal-pickups builder owns it in 1f.2 and may only add
 * (frozen exports: `applyVendorVehicle`, `setMachineKindByAdmin`). Every vendor's vehicle-list
 * stream (Samsara: terminal-pickups; Motive, Geotab: trucks) calls `applyVendorVehicle` in its
 * per-event transaction after resolving the machine through ingest.external_refs.
 */
import type { MachineKind } from '../../domain/fleet';
import type { KindSetBy, VehicleKind } from '../../domain/vehicles';
import { type Executor, exec } from '../exec';

export interface VehicleRow {
  kind: MachineKind;
  kindSetBy: KindSetBy;
  telematicsVia: string | null;
}

/**
 * Apply what a vendor says about a vehicle. Returns the row after the update, and whether it
 * changed (so the caller can publish `fleet`/`invalidate` once per run). Null = no such machine.
 */
export async function applyVendorVehicle(
  ex: Executor,
  machineId: string,
  v: { kindFromTags: VehicleKind | null; via: string | null },
): Promise<{ row: VehicleRow; changed: boolean } | null> {
  const r = await exec<{
    kind: MachineKind;
    kind_set_by: KindSetBy;
    telematics_via: string | null;
    changed: boolean;
  }>(
    ex,
    `with cur as (
       select id, kind, kind_set_by, telematics_via from farm.machines where id = $1::uuid
     ), nxt as (
       select id,
              case when kind_set_by = 'admin' or $2::text is null then kind else $2::text end as kind,
              case when kind_set_by = 'admin' or $2::text is null then kind_set_by else 'vendor' end
                as kind_set_by,
              coalesce($3::text, telematics_via) as telematics_via
         from cur
     ), upd as (
       update farm.machines m
          set kind = nxt.kind, kind_set_by = nxt.kind_set_by, telematics_via = nxt.telematics_via,
              updated_at = now()
         from nxt, cur
        where m.id = nxt.id
          and (cur.kind, cur.kind_set_by, cur.telematics_via)
              is distinct from (nxt.kind, nxt.kind_set_by, nxt.telematics_via)
       returning m.id
     )
     select nxt.kind, nxt.kind_set_by, nxt.telematics_via,
            exists (select 1 from upd) as changed
       from nxt`,
    [machineId, v.kindFromTags, v.via],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    row: { kind: row.kind, kindSetBy: row.kind_set_by, telematicsVia: row.telematics_via },
    changed: row.changed,
  };
}

/** The /admin control: set a machine's kind by hand (vendor tags never change it again). */
export async function setMachineKindByAdmin(
  ex: Executor,
  machineId: string,
  kind: MachineKind,
): Promise<VehicleRow | null> {
  const r = await exec<{
    kind: MachineKind;
    kind_set_by: KindSetBy;
    telematics_via: string | null;
  }>(
    ex,
    `update farm.machines set kind = $2, kind_set_by = 'admin', updated_at = now()
      where id = $1::uuid
      returning kind, kind_set_by, telematics_via`,
    [machineId, kind],
  );
  const row = r.rows[0];
  return row
    ? { kind: row.kind, kindSetBy: row.kind_set_by, telematicsVia: row.telematics_via }
    : null;
}
