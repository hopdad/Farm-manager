/**
 * GET /api/pins against a real database (docs/contracts-1f.md §2, §5.2): viewers may read
 * (signed out is refused), `no-store`, open pins unless `resolved=1`, per field, bad queries 400,
 * and the body is a valid PinsResponse.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { seedSimFarm } from '../../../connectors/testkit';
import type { NormalizedFlag } from '../../../connectors/types';
import { applyDeereFlags, deereFlagPinId } from '../../../db/queries/pins';
import { type PinsResponse, pinsResponseSchema } from '../../../domain/pins';
import { makeSession, runWithSession } from '../../../platform/auth/testing';
import type { Role } from '../../../platform/auth/types';
import { buildDemoFarm } from '../../../sim/farm/build';
import { setupTestDb } from '../../../test/db';
import { handleListPins } from './handler';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const f0 = farm.fields[0] as (typeof farm.fields)[number];
const f1 = farm.fields[1] as (typeof farm.fields)[number];
const at = (f: typeof f0): [number, number] => {
  const p = f.boundary.coordinates[0]?.[0]?.[0] as [number, number];
  return [p[0] + 0.001, p[1] + 0.001];
};
const flag = (id: string, f: typeof f0, archived = false): NormalizedFlag => ({
  source: 'deere',
  sourceOrg: 'org-home',
  externalId: id,
  fieldExternalId: f.deereFieldId,
  geometry: { type: 'Point', coordinates: at(f) },
  note: `note ${id}`,
  category: 'Rocks',
  archived,
  createdAt: '2026-05-01T12:00:00.000Z',
  modifiedAt: '2026-05-01T12:00:00.000Z',
});

const as = <T>(role: Role | null, fn: () => Promise<T>) =>
  runWithSession(role ? makeSession({ role }) : null, fn);
const get = (query = '') =>
  handleListPins(new Request(`http://localhost/api/pins${query}`), t().pool);

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
  await t().db.transaction((tx) =>
    applyDeereFlags(tx, [
      { orgId: 'org-home', flags: [flag('p1', f0), flag('p2', f1), flag('p3', f0, true)] },
    ]),
  );
});

describe('GET /api/pins', () => {
  test('signed out: refused; a viewer reads the open pins, no-store, a valid PinsResponse', async () => {
    expect((await as(null, () => get())).status).toBe(401);
    const res = await as('viewer', () => get());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as PinsResponse;
    expect(pinsResponseSchema.safeParse(body).success).toBe(true);
    expect(body.pins.map((p) => p.id).sort()).toEqual(
      [deereFlagPinId('p1'), deereFlagPinId('p2')].sort(),
    );
    expect(body.pins.find((p) => p.id === deereFlagPinId('p1'))).toMatchObject({
      fieldId: f0.id,
      fieldName: f0.name,
      readOnly: true,
      source: 'deere_flag',
      kind: 'rock',
    });
  });

  test('resolved=1 adds the resolved ones; fieldId narrows; bad queries are 400', async () => {
    const all = (await (await as('viewer', () => get('?resolved=1'))).json()) as PinsResponse;
    expect(all.pins).toHaveLength(3);
    const one = (await (await as('driver', () => get(`?fieldId=${f1.id}`))).json()) as PinsResponse;
    expect(one.pins.map((p) => p.id)).toEqual([deereFlagPinId('p2')]);
    const both = (await (
      await as('viewer', () => get(`?fieldId=${f0.id}&resolved=1`))
    ).json()) as PinsResponse;
    expect(both.pins.map((p) => p.id).sort()).toEqual(
      [deereFlagPinId('p1'), deereFlagPinId('p3')].sort(),
    );
    expect((await as('viewer', () => get('?fieldId=nope'))).status).toBe(400);
    expect((await as('viewer', () => get('?resolved=yes'))).status).toBe(400);
  });
});
