/**
 * /admin/vehicles' server actions against the real database, as the sessions that press them:
 * a viewer or driver is refused on the server (nothing changes), a manager sets a kind by hand
 * and hands it back; a bad form says what to pick. (Next's revalidatePath and the app pool are
 * swapped for the test's.)
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { machines } from '@/db/schema';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';

const t = setupTestDb(import.meta.url);
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db/client', async (orig) => ({
  ...(await orig<typeof import('@/db/client')>()),
  getPool: () => t().pool,
}));
const { releaseVehicleKindAction, setVehicleKindAction } = await import('./actions');

let id: string;
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const as = (role: Role) => makeSession({ role, displayName: `Test ${role}` });
const kind = async () =>
  (await t().pool.query('select kind, kind_set_by from farm.machines where id = $1', [id])).rows[0];

beforeAll(async () => {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'pickup', unitNo: 'PU2', kindSetBy: 'vendor' })
    .returning({ id: machines.id });
  id = m?.id as string;
});
afterAll(() => vi.restoreAllMocks());

describe('/admin/vehicles actions', () => {
  test('a viewer or a driver is refused on the server; nothing changes', async () => {
    for (const role of ['viewer', 'driver'] as const) {
      const r = await runWithSession(as(role), () =>
        setVehicleKindAction(null, form({ machineId: id, kind: 'service_truck', unitNo: 'PU2' })),
      );
      expect(r, role).toMatchObject({
        ok: false,
        message: 'Setting a vehicle kind needs a manager or the owner.',
      });
    }
    expect(
      await runWithSession(null, () => releaseVehicleKindAction(null, form({ machineId: id }))),
    ).toMatchObject({ ok: false, message: 'Sign in first.' });
    expect(await kind()).toEqual({ kind: 'pickup', kind_set_by: 'vendor' });
  });

  test('a manager sets a service truck by hand, then lets the tags decide again', async () => {
    const m = as('manager');
    expect(
      await runWithSession(m, () =>
        setVehicleKindAction(null, form({ machineId: id, kind: 'loader' })),
      ),
    ).toMatchObject({ ok: false, message: 'Pick a machine and one of the vehicle kinds.' });
    const set = await runWithSession(m, () =>
      setVehicleKindAction(null, form({ machineId: id, kind: 'service_truck', unitNo: 'PU2' })),
    );
    expect(set).toMatchObject({ ok: true, message: 'PU2 is now a service truck (set by hand)' });
    expect(await kind()).toEqual({ kind: 'service_truck', kind_set_by: 'admin' });
    const released = await runWithSession(m, () =>
      releaseVehicleKindAction(null, form({ machineId: id, unitNo: 'PU2' })),
    );
    expect(released).toMatchObject({
      ok: true,
      message: "PU2: its kind follows the vendor's tags again",
    });
    expect(await kind()).toEqual({ kind: 'service_truck', kind_set_by: 'default' });
  });
});
