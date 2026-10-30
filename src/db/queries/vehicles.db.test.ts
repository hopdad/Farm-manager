/**
 * The vehicle kind / route writer (1f.2): a vendor tag sets the kind until someone sets it on
 * /admin; via is written when the vendor says it; nothing changes when nothing differs.
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { machines } from '../schema';
import { applyVendorVehicle, setMachineKindByAdmin } from './vehicles';

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
});
