/**
 * Deere flags → farm.pins against a real database (docs/contracts-1f.md §5.2, §6): read-only
 * pins with deterministic ids, the field through the org's ref, kind from the category, a
 * re-run that changes nothing (and publishes nothing), archived = resolved (and back), a flag
 * Deere no longer lists = resolved, ONE pins/updated per call with the touched fields, and
 * listPins (open by default, all with `resolved`, per field, with the field's name).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listenAppEvents, seedSimFarm } from '../../connectors/testkit';
import type { NormalizedFlag } from '../../connectors/types';
import { pinsResponseSchema } from '../../domain/pins';
import { buildDemoFarm } from '../../sim/farm/build';
import { SIM_DEERE_HOME_ORG } from '../../sim/types';
import { setupTestDb } from '../../test/db';
import { applyDeereFlags, deereFlagPinId, listPins, type OrgFlags } from './pins';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const HOME = SIM_DEERE_HOME_ORG;
const f0 = farm.fields[0] as (typeof farm.fields)[number];
const f1 = farm.fields[1] as (typeof farm.fields)[number];
const corner = (f: typeof f0): [number, number] => {
  const p = f.boundary.coordinates[0]?.[0]?.[0] as [number, number];
  return [p[0] + 0.001, p[1] + 0.001];
};

function flag(id: string, over: Partial<NormalizedFlag> = {}): NormalizedFlag {
  return {
    source: 'deere',
    sourceOrg: HOME,
    externalId: id,
    fieldExternalId: f0.deereFieldId,
    geometry: { type: 'Point', coordinates: corner(f0) },
    note: `note ${id}`,
    category: 'Rocks',
    archived: false,
    createdAt: '2026-05-01T12:00:00.000Z',
    modifiedAt: '2026-05-01T12:10:00.000Z',
    ...over,
  };
}

const apply = (orgs: OrgFlags[]) => t().db.transaction((tx) => applyDeereFlags(tx, orgs));
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
});

describe('Deere flags as pins', () => {
  const flags = [
    flag('a'),
    flag('b', {
      category: 'Wet Spot',
      fieldExternalId: f1.deereFieldId,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            corner(f1),
            [corner(f1)[0] + 0.001, corner(f1)[1]],
            [corner(f1)[0], corner(f1)[1] + 0.001],
            corner(f1),
          ],
        ],
      },
    }),
    flag('c', {
      category: null,
      fieldExternalId: null,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-84, 41.9],
          [-84.001, 41.901],
        ],
      },
    }),
    flag('d', { category: 'Tile Blowout', archived: true, modifiedAt: '2026-06-01T08:00:00.000Z' }),
  ];

  test('insert: read-only, deterministic ids, field through the ref, kind from the category; one pins/updated', async () => {
    const before = listener.of('pins', 'updated').length;
    const r = await apply([{ orgId: HOME, flags }]);
    expect(r).toMatchObject({ changed: 4, removed: 0 });
    expect(r.published).toEqual({ fieldIds: [f0.id, f1.id].sort(), hasUnfielded: true });
    await listener.settle();
    expect(listener.of('pins', 'updated').length - before).toBe(1);
    const rows = await t().pool.query(
      `select id::text, kind, field_id::text as field_id, read_only, source, source_id, source_org,
              resolved_at, category, created_at
         from farm.pins order by source_id`,
    );
    expect(rows.rows.map((x) => [x.source_id, x.kind, x.field_id, x.read_only, x.source])).toEqual([
      ['a', 'rock', f0.id, true, 'deere_flag'],
      ['b', 'wet_hole', f1.id, true, 'deere_flag'],
      ['c', 'note', null, true, 'deere_flag'],
      ['d', 'tile_blowout', f0.id, true, 'deere_flag'],
    ]);
    expect(rows.rows[0]?.id).toBe(deereFlagPinId('a'));
    expect(rows.rows[3]?.resolved_at?.toISOString()).toBe('2026-06-01T08:00:00.000Z');
    expect(rows.rows[0]?.created_at.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  test('the same flags again: nothing written, nothing published', async () => {
    const stamp = await t().pool.query(`select max(updated_at) as u from farm.pins`);
    const before = listener.of('pins', 'updated').length;
    const r = await apply([{ orgId: HOME, flags }]);
    expect(r).toEqual({ changed: 0, removed: 0, published: null });
    await listener.settle();
    expect(listener.of('pins', 'updated').length).toBe(before);
    const after = await t().pool.query(`select max(updated_at) as u from farm.pins`);
    expect(after.rows[0]?.u).toEqual(stamp.rows[0]?.u);
  });

  test('archive resolves (keeping the first time), un-archive reopens, a moved flag touches both fields', async () => {
    const r1 = await apply([
      {
        orgId: HOME,
        flags: [
          flag('a', { archived: true, modifiedAt: '2026-07-01T00:00:00.000Z' }),
          flag('b', { ...flags[1], fieldExternalId: f0.deereFieldId }),
          flags[2] as NormalizedFlag,
          flag('d', {
            category: 'Tile Blowout',
            archived: true,
            modifiedAt: '2026-08-01T00:00:00.000Z',
          }),
        ],
      },
    ]);
    expect(r1.changed).toBe(3);
    expect(r1.published?.fieldIds).toEqual([f0.id, f1.id].sort());
    const d = await t().pool.query(`select resolved_at from farm.pins where source_id = 'd'`);
    expect(d.rows[0]?.resolved_at.toISOString()).toBe('2026-06-01T08:00:00.000Z');
    const r2 = await apply([{ orgId: HOME, flags: [flag('a'), ...flags.slice(1)] }]);
    expect(r2.changed).toBeGreaterThanOrEqual(2);
    const a = await t().pool.query(`select resolved_at from farm.pins where source_id = 'a'`);
    expect(a.rows[0]?.resolved_at).toBeNull();
  });

  test("a flag Deere no longer lists resolves its pin; another org's pins are left alone", async () => {
    await apply([
      {
        orgId: 'org-customer-1',
        flags: [flag('x', { sourceOrg: 'org-customer-1', fieldExternalId: null })],
      },
    ]);
    const r = await apply([{ orgId: HOME, flags: [flag('a'), flags[1] as NormalizedFlag] }]);
    expect(r.removed).toBe(1); // c (d was already resolved)
    const open = await t().pool.query(
      `select source_id from farm.pins where resolved_at is null order by source_id`,
    );
    expect(open.rows.map((x) => x.source_id)).toEqual(['a', 'b', 'x']);
  });

  test('listPins: open ones by default, every pin with resolved, per field, valid PinViews', async () => {
    const open = await listPins(t().pool);
    expect(open.map((p) => p.id).sort()).toEqual(['a', 'b', 'x'].map(deereFlagPinId).sort());
    const a = open.find((p) => p.id === deereFlagPinId('a'));
    expect(a).toMatchObject({
      kind: 'rock',
      fieldId: f0.id,
      fieldName: f0.name,
      category: 'Rocks',
      note: 'note a',
      source: 'deere_flag',
      readOnly: true,
      resolvedAt: null,
      geometry: { type: 'Point' },
    });
    const all = await listPins(t().pool, { resolved: true });
    expect(all).toHaveLength(4 + 1);
    expect(
      all
        .filter((p) => p.resolvedAt !== null)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['c', 'd'].map(deereFlagPinId).sort());
    const ofField = await listPins(t().pool, { fieldId: f1.id });
    expect(ofField.map((p) => p.id)).toEqual([deereFlagPinId('b')]);
    expect(ofField[0]?.fieldName).toBe(f1.name);
    expect(
      pinsResponseSchema.safeParse({ builtAt: new Date().toISOString(), pins: all }).success,
    ).toBe(true);
  });
});
