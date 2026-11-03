/**
 * GET /api/fields/<id>/operations against a real database, under chosen sessions: every role
 * from viewer up reads (signed out = 401), the crop year defaults to the field's growing year
 * (D23: the newest crop season of the synced window with operations on that field, else the
 * calendar year in Michigan), an explicit crop year wins, a bad one is 400, an unknown or
 * malformed field 404, and the answer is private, no-store and names the realtime adapter for
 * the History tab. Every call passes its own `now`: no real clock against a fixed one.
 */
import { describe, expect, test } from 'vitest';
import { externalRef } from '@/connectors/types';
import { upsertExternalRef } from '@/db/external-refs';
import { upsertOperation } from '@/db/queries/operations';
import { deterministicId } from '@/domain/ids';
import type { FieldOperationsResponse } from '@/domain/operations';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { ROLES, type Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { ADRIAN_QUARTER_SECTION, insertField } from '@/test/fixtures';
import { OPERATIONS_APP_ENV_HEADER, OPERATIONS_REALTIME_HEADER } from '@/ui/fields/operations';
import { handleFieldOperations, parseCropYear } from './handler';

const t = setupTestDb(import.meta.url);
const NOW = new Date('2026-10-31T13:00:00.000Z');

const as = <T>(role: Role | null, fn: () => Promise<T>) =>
  runWithSession(role === null ? null : makeSession({ role }), fn);

const get = (fieldId: string, query = '') =>
  new Request(`http://localhost:3112/api/fields/${fieldId}/operations${query}`);

type Op = [externalId: string, kind: 'seeding' | 'harvest', startedAt: string, cropYear: number];

/** A field with a Deere ref and these operations (ids made unique per field). */
async function fieldWith(ops: readonly Op[]) {
  const { fieldId } = await insertField(t().db, {
    name: `Ops route ${Math.random().toString(16).slice(2, 8)}`,
    geom: ADRIAN_QUARTER_SECTION,
  });
  const deereFieldId = `route-${fieldId}`;
  await upsertExternalRef(
    t().adminDb,
    externalRef('deere', 'field', deereFieldId, 'org-home'),
    fieldId,
  );
  const op = (
    externalId: string,
    kind: 'seeding' | 'harvest',
    startedAt: string,
    cropYear: number,
  ) =>
    upsertOperation(
      t().pool,
      {
        source: 'deere',
        sourceOrg: 'org-home',
        externalId,
        fieldExternalId: deereFieldId,
        kind,
        cropYear,
        crop: 'corn',
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + 5 * 3_600_000).toISOString(),
        areaAc: 158.9,
        products: [],
        measurements: { areaAc: 158.9 },
        machineExternalIds: [],
        operatorName: null,
        coverage: null,
        modifiedAt: null,
      },
      { now: NOW },
    );
  for (const [id, kind, startedAt, cropYear] of ops) {
    await op(`${fieldId}-${id}`, kind, startedAt, cropYear);
  }
  return fieldId;
}

/** Last season (2026) planted and harvested, and the one before. */
const LAST_SEASON: Op[] = [
  ['h', 'harvest', '2026-10-15T13:00:00.000Z', 2026],
  ['s', 'seeding', '2026-05-06T13:00:00.000Z', 2026],
  ['old', 'harvest', '2025-10-10T13:00:00.000Z', 2025],
];

const seeded = () => fieldWith(LAST_SEASON);

/** The default (no cropYear) answer at `now`: its year and its operations' kinds. */
async function byDefault(fieldId: string, now: Date) {
  const res = await as('viewer', () => handleFieldOperations(get(fieldId), fieldId, t().pool, now));
  expect(res.status).toBe(200);
  const body = (await res.json()) as FieldOperationsResponse;
  return { cropYear: body.cropYear, kinds: body.operations.map((o) => o.kind) };
}

describe('GET /api/fields/<id>/operations', () => {
  test('every role reads this crop year, oldest first; private, no-store, names the adapter', async () => {
    const fieldId = await seeded();
    for (const role of ROLES) {
      const res = await as(role, () => handleFieldOperations(get(fieldId), fieldId, t().pool, NOW));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get(OPERATIONS_REALTIME_HEADER)).toBe('sse');
      expect(res.headers.get(OPERATIONS_APP_ENV_HEADER)).toBe('test');
      const body = (await res.json()) as FieldOperationsResponse;
      expect(body.fieldId).toBe(fieldId);
      expect(body.cropYear).toBe(2026);
      expect(body.operations.map((o) => o.kind)).toEqual(['seeding', 'harvest']);
      expect(body.operations[0]).toMatchObject({
        id: deterministicId('deere', `${fieldId}-s`),
        areaReportedAc: 158.9,
        source: 'deere',
        hasCoverage: false,
      });
    }
  });

  test('?cropYear picks another year; a bad one is 400', async () => {
    const fieldId = await seeded();
    const res = await as('viewer', () =>
      handleFieldOperations(get(fieldId, '?cropYear=2025'), fieldId, t().pool, NOW),
    );
    const body = (await res.json()) as FieldOperationsResponse;
    expect(body.cropYear).toBe(2025);
    expect(body.operations).toHaveLength(1);
    for (const q of ['?cropYear=25', '?cropYear=1700', '?cropYear=abcd']) {
      const bad = await as('viewer', () =>
        handleFieldOperations(get(fieldId, q), fieldId, t().pool, NOW),
      );
      expect(bad.status).toBe(400);
      expect(bad.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('signed out is 401; an unknown or malformed field is 404', async () => {
    const fieldId = await seeded();
    const out = await as(null, () => handleFieldOperations(get(fieldId), fieldId, t().pool, NOW));
    expect(out.status).toBe(401);
    const missing = deterministicId('x', 'missing');
    const r404 = await as('viewer', () =>
      handleFieldOperations(get(missing), missing, t().pool, NOW),
    );
    expect(r404.status).toBe(404);
    const bad = await as('viewer', () => handleFieldOperations(get('nope'), 'nope', t().pool, NOW));
    expect(bad.status).toBe(404);
  });

  test('a field with no operations in the window: the calendar year in Michigan, not UTC', async () => {
    const fieldId = await fieldWith([]);
    const newYearsEve = new Date('2027-01-01T03:00:00.000Z'); // 22:00 on Dec 31 in Adrian
    expect(await byDefault(fieldId, newYearsEve)).toEqual({ cropYear: 2026, kinds: [] });
    expect(await byDefault(fieldId, new Date('2027-01-01T06:00:00.000Z'))).toEqual({
      cropYear: 2027,
      kinds: [],
    });
    expect(parseCropYear(new URL('http://x/?cropYear='))).toBeNull();
  });
});

describe("the default is the field's growing year (D23)", () => {
  const JANUARY = new Date('2027-01-15T15:00:00.000Z');

  test("in January a field with only last season's operations shows last season", async () => {
    const fieldId = await seeded();
    expect(await byDefault(fieldId, JANUARY)).toEqual({
      cropYear: 2026,
      kinds: ['seeding', 'harvest'],
    });
    // Until Aug 1 (the window is [2026, 2027] through Jul 31); then 2026 still has the field.
    expect((await byDefault(fieldId, new Date('2027-07-31T12:00:00.000Z'))).cropYear).toBe(2026);
    // From Aug 1 the window is [2027, 2028]: no operations there, so the calendar year, empty.
    expect(await byDefault(fieldId, new Date('2027-08-01T12:00:00.000Z'))).toEqual({
      cropYear: 2027,
      kinds: [],
    });
  });

  test('a field moves on with its own first operation of the new season', async () => {
    const fieldId = await fieldWith([
      ...LAST_SEASON,
      ['s27', 'seeding', '2027-05-04T13:00:00.000Z', 2027],
    ]);
    expect(await byDefault(fieldId, new Date('2027-05-10T15:00:00.000Z'))).toEqual({
      cropYear: 2027,
      kinds: ['seeding'],
    });
  });

  test('wheat seeded in October, filed under next year, shows next year; its neighbour this year', async () => {
    const wheat = await fieldWith([
      ...LAST_SEASON,
      ['w', 'seeding', '2026-10-12T13:00:00.000Z', 2027],
    ]);
    const neighbour = await seeded();
    expect(await byDefault(wheat, NOW)).toEqual({ cropYear: 2027, kinds: ['seeding'] });
    expect(await byDefault(neighbour, NOW)).toEqual({
      cropYear: 2026,
      kinds: ['seeding', 'harvest'],
    });
  });

  test('an explicit cropYear still wins; a year past the window never becomes the default', async () => {
    const fieldId = await fieldWith([
      ...LAST_SEASON,
      ['w', 'seeding', '2026-10-12T13:00:00.000Z', 2027],
      ['typo', 'seeding', '2026-10-20T13:00:00.000Z', 2030],
    ]);
    const res = await as('viewer', () =>
      handleFieldOperations(get(fieldId, '?cropYear=2026'), fieldId, t().pool, NOW),
    );
    const body = (await res.json()) as FieldOperationsResponse;
    expect(body.cropYear).toBe(2026);
    expect(body.operations.map((o) => o.kind)).toEqual(['seeding', 'harvest']);
    expect((await byDefault(fieldId, NOW)).cropYear).toBe(2027);
  });
});
