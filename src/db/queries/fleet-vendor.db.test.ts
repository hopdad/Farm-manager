/**
 * 1f.2: a fix stores its vendor id (position_vendor: `positionVendorId(source, provider)`) and its
 * kind; a `last_known` snapshot moves machine_state only (never farm.positions, never back in
 * time) and goes stale on its own, longer threshold.
 */
import { describe, expect, test } from 'vitest';
import type { NormalizedPosition } from '../../connectors/types';
import { setupTestDb } from '../../test/db';
import { machines } from '../schema';
import { fleetMachines, upsertPosition } from './fleet';

const t = setupTestDb(import.meta.url);

async function machine(unitNo: string, kind: 'semi' | 'loader' = 'semi'): Promise<string> {
  const [m] = await t().db.insert(machines).values({ kind, unitNo }).returning({ id: machines.id });
  if (!m) throw new Error('insert failed');
  return m.id;
}

const fix = (over: Partial<NormalizedPosition>): NormalizedPosition => ({
  source: 'samsara',
  externalMachineId: 'v1',
  sourceOrg: '',
  ts: '2026-10-15T14:00:00.000Z',
  lng: -84.04,
  lat: 41.9,
  heading: 90,
  speedMph: 0,
  engineOn: false,
  positionSource: 'eld',
  ...over,
});

const state = async (id: string) =>
  (
    await t().pool.query(
      `select position_vendor, position_kind, ts from farm.machine_state where machine_id = $1`,
      [id],
    )
  ).rows[0];
const trail = async (id: string) =>
  Number(
    (await t().pool.query(`select count(*) from farm.positions where machine_id = $1`, [id]))
      .rows[0].count,
  );

describe('upsertPosition: vendor id and position kind (1f.2)', () => {
  test('a live fix: trail point + state, the connector as the vendor', async () => {
    const id = await machine('S1');
    expect(await upsertPosition(t().pool, id, fix({}))).toEqual({
      inserted: true,
      stateUpdated: true,
    });
    expect(await state(id)).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
    expect(await trail(id)).toBe(1);
  });

  test('a last-known snapshot: state only, `<route>_<provider>` as the vendor, never backwards', async () => {
    const id = await machine('L1', 'loader');
    const snap = fix({
      source: 'aemp',
      sourceOrg: 'kubota',
      provider: 'kubota',
      positionKind: 'last_known',
      ts: '2026-10-15T13:00:00.000Z',
    });
    expect(await upsertPosition(t().pool, id, snap)).toEqual({
      inserted: false,
      stateUpdated: true,
    });
    expect(await state(id)).toMatchObject({
      position_vendor: 'aemp_kubota',
      position_kind: 'last_known',
    });
    expect(await trail(id)).toBe(0);
    // A newer live fix (a gateway on the same machine) wins; an older snapshot never moves it back.
    await upsertPosition(t().pool, id, fix({ ts: '2026-10-15T14:00:00.000Z' }));
    const older = await upsertPosition(t().pool, id, { ...snap, ts: '2026-10-15T13:30:00.000Z' });
    expect(older.stateUpdated).toBe(false);
    expect(await state(id)).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
  });

  test('the tick: a two-hour-old snapshot is fresh, a two-hour-old live fix is stale', async () => {
    const live = await machine('S9');
    const snap = await machine('L9', 'loader');
    const ts = '2026-10-15T12:00:00.000Z';
    await upsertPosition(t().pool, live, fix({ ts }));
    await upsertPosition(
      t().pool,
      snap,
      fix({ source: 'aemp', provider: 'cnh', positionKind: 'last_known', ts }),
    );
    const now = new Date('2026-10-15T14:00:00.000Z');
    const views = await fleetMachines(t().pool, now, {
      staleAfterSeconds: 600,
      deereStaleAfterSeconds: 900,
    });
    const byUnit = new Map(views.map((v) => [v.unitNo, v]));
    expect(byUnit.get('S9')).toMatchObject({ stale: true });
    expect(byUnit.get('S9')).not.toHaveProperty('positionKind');
    expect(byUnit.get('L9')).toMatchObject({ stale: false, positionKind: 'last_known' });
  });
});
