/**
 * The 1f migration (db/migrations/0007_m1f_live_connectors.sql) as the app sees it, running as
 * farm_app: the new tables round-trip through Drizzle, and the constraints the four builders rely
 * on hold (docs/contracts-1f.md §3).
 */
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { deterministicId } from '../domain/ids';
import { setupTestDb } from '../test/db';
import { ADRIAN_QUARTER_SECTION, insertField } from '../test/fixtures';
import {
  apiCallsDaily,
  connectorOrgs,
  fields,
  machineFaults,
  machineHours,
  machineState,
  machines,
  operations,
  pins,
} from './schema';

const t = setupTestDb(import.meta.url);

/** The Postgres error code of a rejected statement (23505 unique, 23514 check). */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code;
  }
}

async function machine(unitNo = 'S1'): Promise<string> {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'semi', unitNo })
    .returning({ id: machines.id });
  if (!m) throw new Error('insert failed');
  return m.id;
}

describe('farm.fields tenure', () => {
  test("'unknown' is allowed (a field the Deere sync created); anything else still is not", async () => {
    const { fieldId } = await insertField(t().db);
    await t().pool.query(`update farm.fields set tenure = 'unknown' where id = $1`, [fieldId]);
    const [row] = await t().db.select().from(fields).where(eq(fields.id, fieldId));
    expect(row?.tenure).toBe('unknown');
    expect(
      await pgCode(
        t().pool.query(`update farm.fields set tenure = 'leased' where id = $1`, [fieldId]),
      ),
    ).toBe('23514');
  });
});

describe('farm.operations', () => {
  test('a synced operation round-trips with its coverage, products and measurements', async () => {
    const { fieldId } = await insertField(t().db);
    const id = deterministicId('deere', 'op-1');
    await t()
      .db.insert(operations)
      .values({
        id,
        kind: 'harvest',
        fieldId,
        cropYear: 2026,
        crop: 'corn',
        startedAt: new Date('2026-10-15T13:00:00Z'),
        endedAt: new Date('2026-10-15T19:00:00Z'),
        areaReportedAc: 79.6,
        products: [
          {
            name: 'P1185AM',
            kind: 'seed',
            rate: null,
            rateUnit: null,
            total: null,
            totalUnit: null,
          },
        ],
        measurements: { areaAc: 79.6, yieldBuAc: 212.4, moisturePct: 18.2 },
        geom: ADRIAN_QUARTER_SECTION,
        source: 'deere',
        sourceId: 'op-1',
        sourceOrg: 'org-home',
      });
    const [row] = await t().db.select().from(operations).where(eq(operations.id, id));
    expect(row).toMatchObject({ kind: 'harvest', status: 'provisional', crop: 'corn' });
    expect(row?.measurements.yieldBuAc).toBe(212.4);
    expect(row?.machineIds).toEqual([]);
    expect(row?.geom?.type).toBe('MultiPolygon');
    // source + source_id is the sync's idempotency key.
    expect(
      await pgCode(
        t().db.insert(operations).values({
          kind: 'harvest',
          cropYear: 2026,
          startedAt: new Date(),
          source: 'deere',
          sourceId: 'op-1',
        }),
      ),
    ).toBe('23505');
  });

  test('kind, crop year and time order are checked', async () => {
    const base = { cropYear: 2026, startedAt: new Date('2026-05-01T12:00:00Z'), source: 'deere' };
    expect(
      await pgCode(
        t().pool.query(
          `insert into farm.operations (kind, crop_year, started_at, source) values ('scouting', 2026, now(), 'deere')`,
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        t()
          .db.insert(operations)
          .values({ ...base, kind: 'seeding', endedAt: new Date('2026-04-30T12:00:00Z') }),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        t()
          .db.insert(operations)
          .values({ ...base, kind: 'seeding', cropYear: 1900 }),
      ),
    ).toBe('23514');
  });
});

describe('farm.pins', () => {
  test('a read-only Deere flag (Point, LineString, Polygon) round-trips; other types are refused', async () => {
    const id = deterministicId('deere_flag', 'flag-1');
    await t()
      .db.insert(pins)
      .values({
        id,
        kind: 'rock',
        geom: { type: 'Point', coordinates: [-84.05, 41.9] },
        note: 'big rock',
        category: 'Rock',
        readOnly: true,
        source: 'deere_flag',
        sourceId: 'flag-1',
        sourceOrg: 'org-home',
      });
    await t()
      .db.insert(pins)
      .values({
        geom: {
          type: 'LineString',
          coordinates: [
            [-84.05, 41.9],
            [-84.04, 41.91],
          ],
        },
        source: 'deere_flag',
        sourceId: 'flag-2',
      });
    const [row] = await t().db.select().from(pins).where(eq(pins.id, id));
    expect(row).toMatchObject({ kind: 'rock', readOnly: true, photoKeys: [], resolvedAt: null });
    expect(row?.geom).toEqual({ type: 'Point', coordinates: [-84.05, 41.9] });
    expect(
      await pgCode(
        t().pool.query(
          `insert into farm.pins (geom, source) values (extensions.ST_SetSRID(extensions.ST_GeomFromText('MULTIPOINT((-84 41.9))'), 4326), 'app')`,
        ),
      ),
    ).toBe('23514');
    expect(
      await pgCode(
        t()
          .db.insert(pins)
          .values({
            kind: 'pothole' as 'rock',
            geom: { type: 'Point', coordinates: [-84, 41.9] },
          }),
      ),
    ).toBe('23514');
  });

  test('client_id (offline dedupe) is unique when set', async () => {
    const clientId = '0d6c3e2a-1b4f-4c5d-8e9f-0a1b2c3d4e5f';
    const pin = { geom: { type: 'Point' as const, coordinates: [-84, 41.9] }, clientId };
    await t().db.insert(pins).values(pin);
    expect(await pgCode(t().db.insert(pins).values(pin))).toBe('23505');
    // Many pins without one are fine.
    await t()
      .db.insert(pins)
      .values({ geom: { type: 'Point', coordinates: [-84, 41.9] } });
    await t()
      .db.insert(pins)
      .values({ geom: { type: 'Point', coordinates: [-84, 41.9] } });
  });
});

describe('farm.machine_hours and farm.machine_faults', () => {
  test('one reading per machine, source and time; a reading needs a value', async () => {
    const id = await machine();
    const ts = new Date('2026-10-15T14:00:00Z');
    await t()
      .db.insert(machineHours)
      .values({ machineId: id, ts, engineHours: 1234.5, source: 'deere' });
    expect(
      await pgCode(
        t()
          .db.insert(machineHours)
          .values({ machineId: id, ts, engineHours: 1235, source: 'deere' }),
      ),
    ).toBe('23505');
    await t()
      .db.insert(machineHours)
      .values({ machineId: id, ts, odometerMi: 10, source: 'samsara' });
    expect(
      await pgCode(t().db.insert(machineHours).values({ machineId: id, ts, source: 'deere' })),
    ).toBe('23514');
  });

  test('one OPEN row per machine, source and code; it may reopen after clearing', async () => {
    const id = await machine('S2');
    const at = new Date('2026-10-15T14:00:00Z');
    const fault = {
      machineId: id,
      source: 'samsara',
      code: 'J1939 SPN 110 FMI 0',
      severity: 'critical' as const,
      firstSeenAt: at,
      lastSeenAt: at,
    };
    const [first] = await t()
      .db.insert(machineFaults)
      .values(fault)
      .returning({ id: machineFaults.id });
    expect(await pgCode(t().db.insert(machineFaults).values(fault))).toBe('23505');
    await t()
      .db.update(machineFaults)
      .set({ clearedAt: new Date('2026-10-15T15:00:00Z') })
      .where(eq(machineFaults.id, first?.id as string));
    await t()
      .db.insert(machineFaults)
      .values({
        ...fault,
        firstSeenAt: new Date('2026-10-15T16:00:00Z'),
        lastSeenAt: new Date('2026-10-15T16:00:00Z'),
      });
    expect(
      await pgCode(
        t()
          .db.insert(machineFaults)
          .values({ ...fault, code: 'x', severity: 'fatal' as 'info' }),
      ),
    ).toBe('23514');
  });

  test('machine_state gains the fault summary (default none), its time guard and the vendor', async () => {
    const id = await machine('S3');
    await t()
      .db.insert(machineState)
      .values({
        machineId: id,
        ts: new Date('2026-10-15T14:00:00Z'),
        geom: { type: 'Point', coordinates: [-84.04, 41.9] },
        positionSource: 'eld',
      });
    const [row] = await t().db.select().from(machineState).where(eq(machineState.machineId, id));
    expect(row).toMatchObject({
      faultCodes: [],
      faultsAt: null,
      statsAt: null,
      positionVendor: null,
    });
  });
});

describe('ingest.api_calls_daily and ingest.connector_orgs', () => {
  test('call counts add up per source, stream and day', async () => {
    const add = (calls: number, errors = 0) =>
      t().pool.query(
        `insert into ingest.api_calls_daily (source, stream, day, calls, errors)
         values ('deere', 'locations', '2026-10-30', $1, $2)
         on conflict (source, stream, day) do update
           set calls = api_calls_daily.calls + excluded.calls,
               errors = api_calls_daily.errors + excluded.errors, updated_at = now()`,
        [calls, errors],
      );
    await add(11);
    await add(12, 1);
    const rows = await t().db.select().from(apiCallsDaily);
    expect(rows.map((r) => [r.source, r.stream, r.day, r.calls, r.errors, r.rateLimited])).toEqual([
      ['deere', 'locations', '2026-10-30', 23, 1, 0],
    ]);
    expect(
      await pgCode(
        t().pool.query(
          `insert into ingest.api_calls_daily (source, day, calls) values ('deere', '2026-10-30', -1)`,
        ),
      ),
    ).toBe('23514');
  });

  test('an org is connected or needs approval', async () => {
    await t().db.insert(connectorOrgs).values({
      source: 'deere',
      orgExternalId: 'org-customer-1',
      status: 'needs_approval',
      approvalUrl: 'https://connections.deere.com/x',
    });
    const [row] = await t().db.select().from(connectorOrgs);
    expect(row).toMatchObject({ status: 'needs_approval', name: null, detail: null });
    expect(
      await pgCode(
        t().pool.query(
          `insert into ingest.connector_orgs (source, org_external_id, status) values ('deere', 'o', 'pending')`,
        ),
      ),
    ).toBe('23514');
  });
});
