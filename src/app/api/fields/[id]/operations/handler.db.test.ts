/**
 * GET /api/fields/<id>/operations against a real database, under chosen sessions: every role
 * from viewer up reads (signed out = 401), the crop year defaults to the current one in
 * Michigan, a bad crop year is 400, an unknown or malformed field 404, and the answer is
 * private, no-store and names the realtime adapter for the History tab.
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

async function seeded() {
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
  await op(`${fieldId}-h`, 'harvest', '2026-10-15T13:00:00.000Z', 2026);
  await op(`${fieldId}-s`, 'seeding', '2026-05-06T13:00:00.000Z', 2026);
  await op(`${fieldId}-old`, 'harvest', '2025-10-10T13:00:00.000Z', 2025);
  return fieldId;
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

  test('the default crop year follows Michigan, not UTC', async () => {
    const fieldId = await seeded();
    const newYearsEve = new Date('2027-01-01T03:00:00.000Z'); // 22:00 on Dec 31 in Adrian
    const res = await as('viewer', () =>
      handleFieldOperations(get(fieldId), fieldId, t().pool, newYearsEve),
    );
    expect(((await res.json()) as FieldOperationsResponse).cropYear).toBe(2026);
    expect(parseCropYear(new URL('http://x/?cropYear='))).toBeNull();
  });
});
