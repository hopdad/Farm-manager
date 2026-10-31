/**
 * The fault writer against the real database (slice 1f, docs/contracts-1f.md §5.3): snapshot
 * reports (stored with every system's columns, cleared, out of order for both tables, reopened
 * as a new row), the first fix seeding the summary, the invalidate published only on a change,
 * delta reports (open, refresh, close, an older item that changes nothing, the age-out), and
 * Samsara's per-module OBD-II clearing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listenAppEvents } from '../../connectors/testkit';
import type { NormalizedPosition, NormalizedVehicleStat } from '../../connectors/types';
import {
  DELTA_FAULT_AGE_OUT_SECONDS,
  type NormalizedFault,
  normalizedFault,
} from '../../domain/fault-codes';
import { setupTestDb } from '../../test/db';
import { machines } from '../schema';
import { upsertPosition, upsertVehicleStat } from './fleet';
import {
  activeFaultSummary,
  applyFaultReport,
  faultSetChanged,
  type ModuleFault,
  parseStoredFaults,
  type ScopedVehicleStat,
} from './machine-faults';

const t = setupTestDb(import.meta.url);
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

beforeAll(async () => {
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
});

async function machine(unitNo: string): Promise<string> {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'semi', unitNo })
    .returning({ id: machines.id });
  if (!m) throw new Error('insert failed');
  return m.id;
}

const at = (min: number) => new Date(Date.parse('2026-10-15T14:00:00.000Z') + min * 60_000);
const iso = (min: number) => at(min).toISOString();

const fix = (min: number): NormalizedPosition => ({
  source: 'samsara',
  externalMachineId: 'v',
  sourceOrg: '',
  ts: iso(min),
  lng: -84.04,
  lat: 41.9,
  heading: 0,
  speedMph: 0,
  engineOn: true,
  positionSource: 'eld',
});

const RED = { redStop: true, amberWarning: true, protect: false, malfunction: false };
const AMBER = { redStop: false, amberWarning: true, protect: false, malfunction: false };

const j1939 = (spn: number, fmi: number, lamps = AMBER, extra: Partial<NormalizedFault> = {}) =>
  normalizedFault({
    system: 'j1939',
    spn,
    fmi,
    lamps,
    sourceAddress: 0,
    occurrenceCount: 2,
    ...extra,
  });

const snapshot = (min: number, faultCodes: ModuleFault[], extra: Partial<ScopedVehicleStat> = {}) =>
  ({
    source: 'samsara',
    externalMachineId: 'v',
    sourceOrg: '',
    ts: iso(min),
    faultCodes,
    faultReport: 'snapshot',
    ...extra,
  }) as ScopedVehicleStat;

const delta = (
  min: number,
  faultCodes: NormalizedFault[],
  extra: Partial<NormalizedVehicleStat> = {},
): NormalizedVehicleStat => ({
  source: 'motive',
  externalMachineId: 'm',
  sourceOrg: 'co-1',
  ts: iso(min),
  faultCodes,
  faultReport: 'delta',
  ...extra,
});

interface FaultRow {
  code: string;
  source: string;
  system: string;
  spn: number | null;
  fmi: number | null;
  source_address: number | null;
  occurrence_count: number | null;
  dtc_state: string | null;
  oem_class: string | null;
  module: string | null;
  lamps: unknown;
  severity: string;
  vendor_severity: string | null;
  description: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  cleared_at: Date | null;
}

async function rows(id: string): Promise<FaultRow[]> {
  return (
    await t().pool.query<FaultRow>(
      `select code, source, system, spn, fmi, source_address, occurrence_count, dtc_state,
              oem_class, module, lamps, severity, vendor_severity, description, first_seen_at,
              last_seen_at, cleared_at
         from farm.machine_faults where machine_id = $1 order by first_seen_at, code`,
      [id],
    )
  ).rows;
}
const open = async (id: string) => (await rows(id)).filter((r) => r.cleared_at === null);

async function state(id: string) {
  const r = await t().pool.query<{ fault_codes: unknown; faults_at: Date | null }>(
    'select fault_codes, faults_at from farm.machine_state where machine_id = $1',
    [id],
  );
  return r.rows[0];
}

async function invalidatesDuring(run: () => Promise<unknown>): Promise<number> {
  await listener.settle();
  const before = listener
    .of('fleet', 'invalidate')
    .filter((m) => m.payload.reason === 'faults').length;
  await run();
  await listener.settle();
  return (
    listener.of('fleet', 'invalidate').filter((m) => m.payload.reason === 'faults').length - before
  );
}

describe('snapshot reports (Samsara)', () => {
  test('a code is stored with its system columns; the summary and faults_at follow; invalidate once', async () => {
    const id = await machine('S1');
    await upsertPosition(t().pool, id, fix(0));
    const n = await invalidatesDuring(() =>
      upsertVehicleStat(
        t().pool,
        id,
        snapshot(1, [j1939(110, 0, RED, { description: 'Coolant hot' })]),
      ),
    );
    expect(n).toBe(1);
    const [row] = await rows(id);
    expect(row).toMatchObject({
      code: 'J1939 SPN 110 FMI 0',
      source: 'samsara',
      system: 'j1939',
      spn: 110,
      fmi: 0,
      source_address: 0,
      occurrence_count: 2,
      dtc_state: null,
      oem_class: null,
      lamps: RED,
      severity: 'critical',
      description: 'Coolant hot',
      cleared_at: null,
    });
    expect(row?.first_seen_at.toISOString()).toBe(iso(1));
    const st = await state(id);
    expect(st?.faults_at?.toISOString()).toBe(iso(1));
    expect(parseStoredFaults(st?.fault_codes)).toEqual([
      {
        code: 'J1939 SPN 110 FMI 0',
        severity: 'critical',
        description: 'Coolant hot',
        system: 'j1939',
        spn: 110,
        fmi: 0,
        lamps: RED,
        since: iso(1),
      },
    ]);
    // The same set again (a newer reading): last seen moves, nothing published.
    expect(
      await invalidatesDuring(() =>
        upsertVehicleStat(t().pool, id, snapshot(2, [j1939(110, 0, RED, { occurrenceCount: 5 })])),
      ),
    ).toBe(0);
    expect(await open(id)).toMatchObject([{ occurrence_count: 5 }]);
    expect((await open(id))[0]?.last_seen_at.toISOString()).toBe(iso(2));
    expect((await state(id))?.faults_at?.toISOString()).toBe(iso(2));
  });

  test('cleared by [] (stays as history); an older page never brings it back', async () => {
    const id = await machine('S2');
    await upsertPosition(t().pool, id, fix(0));
    await upsertVehicleStat(t().pool, id, snapshot(1, [j1939(110, 0, RED)]));
    expect(await invalidatesDuring(() => upsertVehicleStat(t().pool, id, snapshot(3, [])))).toBe(1);
    expect(await open(id)).toEqual([]);
    const [hist] = await rows(id);
    expect(hist?.cleared_at?.toISOString()).toBe(iso(3));
    expect(parseStoredFaults((await state(id))?.fault_codes)).toEqual([]);
    // A page from before the clear (out of order, a duplicate): changes nothing anywhere.
    expect(
      await invalidatesDuring(() =>
        upsertVehicleStat(t().pool, id, snapshot(2, [j1939(110, 0, RED)])),
      ),
    ).toBe(0);
    expect(await open(id)).toEqual([]);
    expect(await rows(id)).toHaveLength(1);
    expect((await state(id))?.faults_at?.toISOString()).toBe(iso(3));
    // Seen again later: a NEW row (the old one stays cleared).
    await upsertVehicleStat(t().pool, id, snapshot(5, [j1939(110, 0, RED)]));
    const all = await rows(id);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.cleared_at === null)).toEqual([false, true]);
  });

  test('an older reading only extends last_seen_at of the open codes it names', async () => {
    const id = await machine('S3');
    await upsertPosition(t().pool, id, fix(0));
    await upsertVehicleStat(t().pool, id, snapshot(1, [j1939(110, 0, RED)]));
    await upsertVehicleStat(t().pool, id, snapshot(10, [j1939(110, 0, RED), j1939(100, 1)]));
    // A late page from minute 5 that lists only one code: it clears nothing, opens nothing.
    await upsertVehicleStat(t().pool, id, snapshot(5, [j1939(100, 1), j1939(3216, 2)]));
    const codes = (await open(id)).map((r) => r.code).sort();
    expect(codes).toEqual(['J1939 SPN 100 FMI 1', 'J1939 SPN 110 FMI 0']);
    // And a late page from minute 12 (no state change at 10 → 12 is newer): it is applied.
    await upsertVehicleStat(t().pool, id, snapshot(12, [j1939(100, 1)]));
    expect((await open(id)).map((r) => r.code)).toEqual(['J1939 SPN 100 FMI 1']);
    // Extending: a reading older than the guard but newer than a row's last_seen_at.
    await t().pool.query(
      `update farm.machine_faults set last_seen_at = $2 where machine_id = $1 and cleared_at is null`,
      [id, iso(11)],
    );
    await upsertVehicleStat(t().pool, id, snapshot(11.5, [j1939(100, 1)]));
    expect((await open(id))[0]?.last_seen_at.toISOString()).toBe(iso(11.5));
  });

  test('a worse severity of the same code publishes; the summary is worst first', async () => {
    const id = await machine('S4');
    await upsertPosition(t().pool, id, fix(0));
    await upsertVehicleStat(t().pool, id, snapshot(1, [j1939(110, 0), j1939(100, 1)]));
    expect(
      await invalidatesDuring(() =>
        upsertVehicleStat(t().pool, id, snapshot(2, [j1939(110, 0, RED), j1939(100, 1, RED)])),
      ),
    ).toBe(1);
    // Two codes in one reading share its lamps: both critical now.
    const summary = await activeFaultSummary(t().pool, id);
    expect(summary.map((f) => [f.code, f.severity])).toEqual([
      ['J1939 SPN 100 FMI 1', 'critical'],
      ['J1939 SPN 110 FMI 0', 'critical'],
    ]);
    expect(faultSetChanged(summary, summary)).toBe(false);
    expect(faultSetChanged(summary, summary.slice(1))).toBe(true);
  });

  test('a fault before the first fix: rows only; the first fix seeds the summary', async () => {
    const id = await machine('S5');
    expect(
      await invalidatesDuring(() =>
        upsertVehicleStat(t().pool, id, snapshot(1, [j1939(110, 0, RED)])),
      ),
    ).toBe(0);
    expect(await open(id)).toHaveLength(1);
    expect(await state(id)).toBeUndefined();
    // A second, older report while there is no state: guarded by the rows' newest time.
    await upsertVehicleStat(t().pool, id, snapshot(0.5, []));
    expect(await open(id)).toHaveLength(1);
    await upsertPosition(t().pool, id, fix(2));
    const st = await state(id);
    expect(st?.faults_at?.toISOString()).toBe(iso(1));
    expect(parseStoredFaults(st?.fault_codes)).toMatchObject([
      { code: 'J1939 SPN 110 FMI 0', severity: 'critical', since: iso(1) },
    ]);
    // A later fix doesn't re-seed (and doesn't clear) anything.
    await t().pool.query(`update farm.machine_state set fault_codes = '[]' where machine_id = $1`, [
      id,
    ]);
    await upsertPosition(t().pool, id, fix(3));
    expect(parseStoredFaults((await state(id))?.fault_codes)).toEqual([]);
    // A machine with no fault history keeps the defaults on its first fix.
    const clean = await machine('S6');
    await upsertPosition(t().pool, clean, fix(1));
    expect(await state(clean)).toMatchObject({ fault_codes: [], faults_at: null });
  });

  test('every system stored: OBD-II state and lamps, OEM vendor severity and class', async () => {
    const id = await machine('PU9');
    await upsertPosition(t().pool, id, fix(0));
    await upsertVehicleStat(
      t().pool,
      id,
      snapshot(
        1,
        [
          {
            ...normalizedFault({
              system: 'obd2',
              dtc: 'P0087',
              dtcState: 'confirmed',
              lamps: { malfunction: true },
              description: 'Fuel rail pressure low',
            }),
            module: '2024',
          },
          normalizedFault({ system: 'oem', oemCode: 'CA2387', vendorSeverity: 'L03' }),
          normalizedFault({ system: 'oem', oemCode: '77', oemClass: 'caution' }),
        ],
        { faultScope: { obdModules: ['2024'] } },
      ),
    );
    const by = new Map((await rows(id)).map((r) => [r.code, r]));
    expect(by.get('P0087')).toMatchObject({
      system: 'obd2',
      spn: null,
      dtc_state: 'confirmed',
      lamps: { malfunction: true },
      severity: 'warning',
    });
    expect(by.get('OEM CA2387')).toMatchObject({
      system: 'oem',
      vendor_severity: 'L03',
      oem_class: null,
      severity: 'warning',
    });
    expect(by.get('OEM caution 77')).toMatchObject({ oem_class: 'caution', severity: 'info' });
    const module = await t().pool.query(
      `select module from farm.machine_faults where code = 'P0087' and cleared_at is null`,
    );
    expect(module.rows).toEqual([{ module: '2024' }]);
    // The module is OBD-II's only.
    expect(by.get('OEM CA2387')).toMatchObject({ module: null });
  });

  test('OBD-II per module: a module the reading leaves out keeps its codes', async () => {
    const id = await machine('PU8');
    await upsertPosition(t().pool, id, fix(0));
    const obd = (dtc: string, module: string): ModuleFault => ({
      ...normalizedFault({ system: 'obd2', dtc, dtcState: 'confirmed' }),
      module,
    });
    const scoped = (min: number, codes: ModuleFault[], modules: string[]) =>
      snapshot(min, codes, { faultScope: { obdModules: modules } });
    await upsertVehicleStat(
      t().pool,
      id,
      scoped(1, [obd('P0087', '2024'), obd('U0100', '2025')], ['2024', '2025']),
    );
    // Module 2025 alone, U0100 gone: P0087 (module 2024, not named) stays open.
    await upsertVehicleStat(t().pool, id, scoped(2, [], ['2025']));
    expect((await open(id)).map((r) => r.code)).toEqual(['P0087']);
    // No module named (a J1939-only reading): OBD-II codes untouched.
    await upsertVehicleStat(t().pool, id, scoped(3, [], []));
    expect((await open(id)).map((r) => r.code)).toEqual(['P0087']);
    // Module 2024 with empty lists: cleared.
    await upsertVehicleStat(t().pool, id, scoped(4, [], ['2024']));
    expect(await open(id)).toEqual([]);
    // The cleared rows keep the module that last named them (history).
    expect(
      (
        await t().pool.query(
          `select module from farm.machine_faults
            where machine_id = $1::uuid and code = 'P0087' and cleared_at is not null`,
          [id],
        )
      ).rows,
    ).toEqual([{ module: '2024' }]);
    // Without a scope (another vendor's plain snapshot) the clear is machine-wide.
    await upsertVehicleStat(t().pool, id, scoped(5, [obd('P0087', '2024')], ['2024']));
    await upsertVehicleStat(t().pool, id, snapshot(6, []));
    expect(await open(id)).toEqual([]);
  });

  test('a bad fault fails the event with a readable reason (it is retried, then dead-lettered)', async () => {
    const id = await machine('S7');
    await expect(
      applyFaultReport(t().pool, id, snapshot(1, [{ ...j1939(1, 1), code: 'wrong key' }])),
    ).rejects.toThrow(/invalid fault "wrong key" from samsara: .*faultCodeKey/);
    // A stat without faultCodes says nothing about faults.
    expect(
      await applyFaultReport(t().pool, id, { ...snapshot(1, []), faultCodes: undefined }),
    ).toBeNull();
  });
});

describe('delta reports (Motive, Geotab, AEMP, CNH, Terminal)', () => {
  const motive = (spn: number, fmi: number, over: Partial<NormalizedFault>) =>
    normalizedFault({ system: 'j1939', spn, fmi, lamps: AMBER, ...over });

  test('open, refresh, close; an older item changes nothing; codes not named are unchanged', async () => {
    const id = await machine('H1');
    await upsertPosition(t().pool, id, { ...fix(0), source: 'motive', sourceOrg: 'co-1' });
    // Opened with the vendor's first-seen time.
    expect(
      await invalidatesDuring(() =>
        upsertVehicleStat(
          t().pool,
          id,
          delta(5, [
            motive(110, 0, { state: 'open', firstSeenAt: iso(1), lastSeenAt: iso(4) }),
            motive(100, 1, { state: 'open', lastSeenAt: iso(5) }),
          ]),
        ),
      ),
    ).toBe(1);
    let r = await open(id);
    expect(
      r.map((x) => [x.code, x.first_seen_at.toISOString(), x.last_seen_at.toISOString()]),
    ).toEqual([
      ['J1939 SPN 110 FMI 0', iso(1), iso(4)],
      ['J1939 SPN 100 FMI 1', iso(5), iso(5)],
    ]);
    // Refreshed (newer); an older sighting doesn't move it back.
    await upsertVehicleStat(t().pool, id, delta(8, [motive(110, 0, { lastSeenAt: iso(8) })]));
    await upsertVehicleStat(t().pool, id, delta(9, [motive(110, 0, { lastSeenAt: iso(6) })]));
    r = await open(id);
    expect(r.find((x) => x.spn === 110)?.last_seen_at.toISOString()).toBe(iso(8));
    // A closed item older than the last sighting changes nothing...
    await upsertVehicleStat(
      t().pool,
      id,
      delta(10, [motive(110, 0, { state: 'closed', closedAt: iso(7) })]),
    );
    expect((await open(id)).map((x) => x.spn).sort()).toEqual([100, 110]);
    // ...a newer one clears it at its closedAt; SPN 100 (not named) stays open.
    expect(
      await invalidatesDuring(() =>
        upsertVehicleStat(
          t().pool,
          id,
          delta(12, [motive(110, 0, { state: 'closed', closedAt: iso(11) })]),
        ),
      ),
    ).toBe(1);
    expect((await open(id)).map((x) => x.spn)).toEqual([100]);
    const cleared = (await rows(id)).find((x) => x.spn === 110);
    expect(cleared?.cleared_at?.toISOString()).toBe(iso(11));
    // An open sighting from before that close (out of order) doesn't reopen it.
    await upsertVehicleStat(t().pool, id, delta(13, [motive(110, 0, { lastSeenAt: iso(10) })]));
    expect((await open(id)).map((x) => x.spn)).toEqual([100]);
    // A closed item for a code that isn't open: nothing.
    await upsertVehicleStat(t().pool, id, delta(14, [motive(999, 3, { state: 'closed' })]));
    expect(await rows(id)).toHaveLength(2);
    // faults_at = the newest event time.
    expect((await state(id))?.faults_at?.toISOString()).toBe(iso(14));
    expect(parseStoredFaults((await state(id))?.fault_codes).map((f) => f.code)).toEqual([
      'J1939 SPN 100 FMI 1',
    ]);
  });

  test('the age-out (decision 1f-12): open rows not seen for 24 h close at the report time', async () => {
    const id = await machine('L1');
    await upsertPosition(t().pool, id, { ...fix(0), source: 'aemp', sourceOrg: 'kubota' });
    const aemp = (min: number, faults: NormalizedFault[]) => ({
      ...delta(min, faults),
      source: 'aemp' as const,
      sourceOrg: 'kubota',
      faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
    });
    const occ = (code: string, min: number) =>
      normalizedFault({ system: 'oem', oemCode: code, state: 'open', lastSeenAt: iso(min) });
    await upsertVehicleStat(t().pool, id, aemp(0, [occ('A1', 0), occ('B2', 0)]));
    // 23 h later only A1 is seen again: nothing ages out yet.
    await upsertVehicleStat(t().pool, id, aemp(23 * 60, [occ('A1', 23 * 60)]));
    expect((await open(id)).map((r) => r.code).sort()).toEqual(['OEM A1', 'OEM B2']);
    // 25 h after B2 was last seen: it closes at the report's time; A1 stays.
    await upsertVehicleStat(t().pool, id, aemp(25 * 60, []));
    expect((await open(id)).map((r) => r.code)).toEqual(['OEM A1']);
    expect((await rows(id)).find((r) => r.code === 'OEM B2')?.cleared_at?.toISOString()).toBe(
      iso(25 * 60),
    );
    // Without faultAgeOutSeconds (a vendor that sends `closed`), nothing ages out.
    await upsertVehicleStat(t().pool, id, { ...aemp(60 * 60, []), faultAgeOutSeconds: undefined });
    expect((await open(id)).map((r) => r.code)).toEqual(['OEM A1']);
  });
});
