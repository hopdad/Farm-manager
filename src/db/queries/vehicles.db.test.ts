/**
 * The vehicle kind / route writer (1f.2): a vendor tag sets the kind until someone sets it on
 * /admin; via is written when the vendor says it; nothing changes when nothing differs.
 */
import { describe, expect, test } from 'vitest';
import { VEHICLE_KINDS } from '../../domain/vehicles';
import { setupTestDb } from '../../test/db';
import { machines } from '../schema';
import {
  applyVendorVehicle,
  listAdminVehicles,
  releaseMachineKind,
  setMachineKindByAdmin,
} from './vehicles';

const t = setupTestDb(import.meta.url);

async function semi(unitNo: string): Promise<string> {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'semi', unitNo })
    .returning({ id: machines.id });
  if (!m) throw new Error('insert failed');
  return m.id;
}

describe('applyVendorVehicle / setMachineKindByAdmin', () => {
  test('a vendor tag sets the kind and via; the same answer again changes nothing', async () => {
    const id = await semi('PU1');
    const first = await applyVendorVehicle(t().pool, id, {
      kindFromTags: 'pickup',
      via: 'ford_pro',
    });
    expect(first).toEqual({
      row: { kind: 'pickup', kindSetBy: 'vendor', telematicsVia: 'ford_pro' },
      changed: true,
    });
    const again = await applyVendorVehicle(t().pool, id, {
      kindFromTags: 'pickup',
      via: 'ford_pro',
    });
    expect(again?.changed).toBe(false);
    // No tag kind and no via: nothing changes (the vendor says nothing).
    const silent = await applyVendorVehicle(t().pool, id, { kindFromTags: null, via: null });
    expect(silent).toEqual({
      row: { kind: 'pickup', kindSetBy: 'vendor', telematicsVia: 'ford_pro' },
      changed: false,
    });
  });

  test('a kind set on /admin wins over every later vendor tag; via still follows the vendor', async () => {
    const id = await semi('ST1');
    expect(await setMachineKindByAdmin(t().pool, id, 'service_truck')).toEqual({
      kind: 'service_truck',
      kindSetBy: 'admin',
      telematicsVia: null,
    });
    const r = await applyVendorVehicle(t().pool, id, { kindFromTags: 'semi', via: 'obd_device' });
    expect(r).toEqual({
      row: { kind: 'service_truck', kindSetBy: 'admin', telematicsVia: 'obd_device' },
      changed: true,
    });
  });

  test('an unknown machine is null', async () => {
    expect(
      await applyVendorVehicle(t().pool, '00000000-0000-4000-8000-000000000000', {
        kindFromTags: 'pickup',
        via: null,
      }),
    ).toBeNull();
    expect(
      await setMachineKindByAdmin(t().pool, '00000000-0000-4000-8000-000000000000', 'pickup'),
    ).toBeNull();
  });

  test('releasing an admin-set kind lets the next vendor tag decide again', async () => {
    const id = await semi('PU9');
    await setMachineKindByAdmin(t().pool, id, 'service_truck');
    expect(await releaseMachineKind(t().pool, id)).toEqual({
      kind: 'service_truck',
      kindSetBy: 'default',
      telematicsVia: null,
    });
    const r = await applyVendorVehicle(t().pool, id, { kindFromTags: 'pickup', via: null });
    expect(r?.row).toMatchObject({ kind: 'pickup', kindSetBy: 'vendor' });
    // A vendor-set kind is not the admin's to release: nothing changes.
    expect((await releaseMachineKind(t().pool, id))?.kindSetBy).toBe('vendor');
    expect(await releaseMachineKind(t().pool, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('listAdminVehicles', () => {
  test('vehicle kinds and anything a vendor or a person set, by unit; never a retired one; with its refs', async () => {
    const pickup = await semi('ZZ-A');
    await applyVendorVehicle(t().pool, pickup, { kindFromTags: 'pickup', via: 'ford_pro' });
    const tractor = (
      await t()
        .db.insert(machines)
        .values({ kind: 'tractor', unitNo: 'ZZ-B' })
        .returning({ id: machines.id })
    )[0]?.id as string;
    const loader = (
      await t()
        .db.insert(machines)
        .values({ kind: 'loader', unitNo: 'ZZ-C', kindSetBy: 'admin' })
        .returning({ id: machines.id })
    )[0]?.id as string;
    await t().db.insert(machines).values({ kind: 'semi', unitNo: 'ZZ-D', status: 'retired' });
    await t().pool.query(
      `insert into ingest.external_refs (source, kind, external_id, source_org, entity_id)
       values ('samsara', 'machine', 'zz-a', '', $1), ('terminal', 'machine', 'vcl_zz', 'conn_zz', $1)`,
      [pickup],
    );
    const rows = (await listAdminVehicles(t().pool, VEHICLE_KINDS)).filter((r) =>
      r.unitNo.startsWith('ZZ-'),
    );
    expect(rows.map((r) => [r.unitNo, r.kind, r.kindSetBy, r.telematicsVia, r.sources])).toEqual([
      ['ZZ-A', 'pickup', 'vendor', 'ford_pro', ['samsara', 'terminal']],
      ['ZZ-C', 'loader', 'admin', null, []],
    ]);
    expect(rows.map((r) => r.id)).not.toContain(tractor);
    expect(rows.find((r) => r.id === loader)?.positionVendor).toBeNull();
  });
});
