/**
 * Deere engine hours → farm.machine_hours + machines.engine_hours (docs/contracts-1f.md §5.0,
 * §5.3): appended once per (machine, source, ts), the meter only ever moves up (greatest()),
 * rounding to the column's 0.1 h, and a bad value refused.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { appendEngineHours } from './machine-hours';

const t = setupTestDb(import.meta.url);
let machineId = '';

const meter = async () =>
  Number(
    (await t().pool.query(`select engine_hours from farm.machines where id = $1`, [machineId]))
      .rows[0]?.engine_hours,
  );
const rows = async () =>
  (
    await t().pool.query(
      `select ts, engine_hours::float8 as h, source from farm.machine_hours where machine_id = $1 order by ts`,
      [machineId],
    )
  ).rows;

beforeAll(async () => {
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.machines (kind, unit_no) values ('combine', 'C9') returning id::text`,
  );
  machineId = r.rows[0]?.id as string;
});

describe('appendEngineHours', () => {
  test('a first reading sets the meter; the same reading again is one row', async () => {
    expect(
      await appendEngineHours(t().pool, machineId, {
        ts: '2026-10-15T13:00:00Z',
        engineHours: 1234.4,
      }),
    ).toEqual({
      appended: true,
      raised: true,
    });
    expect(
      await appendEngineHours(t().pool, machineId, {
        ts: '2026-10-15T13:00:00Z',
        engineHours: 1234.4,
      }),
    ).toEqual({
      appended: false,
      raised: false,
    });
    expect(await meter()).toBe(1234.4);
    expect(await rows()).toHaveLength(1);
  });

  test('a later reading raises it; an older or lower one is history only', async () => {
    await appendEngineHours(t().pool, machineId, {
      ts: '2026-10-15T13:15:00Z',
      engineHours: 1235.2,
    });
    expect(await meter()).toBe(1235.2);
    expect(
      await appendEngineHours(t().pool, machineId, {
        ts: '2026-10-15T12:45:00Z',
        engineHours: 1233.9,
      }),
    ).toEqual({ appended: true, raised: false });
    expect(await meter()).toBe(1235.2);
    expect((await rows()).map((r) => [r.h, r.source])).toEqual([
      [1233.9, 'deere'],
      [1234.4, 'deere'],
      [1235.2, 'deere'],
    ]);
  });

  test("a reading equal after rounding doesn't touch the machine row", async () => {
    const before = await t().pool.query(`select updated_at from farm.machines where id = $1`, [
      machineId,
    ]);
    const r = await appendEngineHours(t().pool, machineId, {
      ts: '2026-10-15T13:30:00Z',
      engineHours: 1235.21,
    });
    expect(r).toEqual({ appended: true, raised: false });
    const after = await t().pool.query(`select updated_at from farm.machines where id = $1`, [
      machineId,
    ]);
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
  });

  test('another source has its own rows; a negative value is refused', async () => {
    await appendEngineHours(
      t().pool,
      machineId,
      { ts: '2026-10-15T13:00:00Z', engineHours: 1234.4 },
      'samsara',
    );
    expect((await rows()).filter((r) => r.source === 'samsara')).toHaveLength(1);
    await expect(
      appendEngineHours(t().pool, machineId, { ts: '2026-10-15T14:00:00Z', engineHours: -1 }),
    ).rejects.toThrow(RangeError);
  });
});
