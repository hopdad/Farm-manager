/**
 * src/db/external-refs.ts as farm_app: idempotent upsert, re-pointing, single and batch lookup,
 * on a pg pool and inside a Drizzle transaction (how the seed and the sync steps call it).
 */
import { describe, expect, test } from 'vitest';
import { externalRef } from '../connectors/types';
import { demoId } from '../domain/ids';
import { setupTestDb } from '../test/db';
import { resolveExternalRef, resolveExternalRefs, upsertExternalRef } from './external-refs';

const t = setupTestDb(import.meta.url);

describe('external refs', () => {
  test('upsert is idempotent and the same field maps from two orgs', async () => {
    const { pool, db } = t();
    const field = demoId('field-a');
    await db.transaction(async (tx) => {
      await upsertExternalRef(tx, externalRef('deere', 'field', 'fld-a', 'org-home'), field);
      await upsertExternalRef(
        tx,
        externalRef('deere', 'field', 'fld-a-cust', 'org-customer-1'),
        field,
      );
    });
    await upsertExternalRef(pool, externalRef('deere', 'field', 'fld-a', 'org-home'), field);
    const n = await pool.query(`select count(*)::int as n from ingest.external_refs`);
    expect(n.rows[0].n).toBe(2);
    expect(await resolveExternalRef(pool, externalRef('deere', 'field', 'fld-a', 'org-home'))).toBe(
      field,
    );
    expect(
      await resolveExternalRef(db, externalRef('deere', 'field', 'fld-a-cust', 'org-customer-1')),
    ).toBe(field);
    // Same vendor id, wrong org: no match.
    expect(
      await resolveExternalRef(pool, externalRef('deere', 'field', 'fld-a', 'org-customer-1')),
    ).toBeNull();
  });

  test('re-pointing replaces the entity; batch lookup skips unknown ids', async () => {
    const { pool, db } = t();
    const a = demoId('semi-1');
    const b = demoId('semi-1-replaced');
    await upsertExternalRef(pool, externalRef('samsara', 'machine', 'veh-1'), a);
    await upsertExternalRef(pool, externalRef('samsara', 'machine', 'veh-2'), demoId('semi-2'));
    await upsertExternalRef(pool, externalRef('samsara', 'machine', 'veh-1'), b);
    const map = await db.transaction((tx) =>
      resolveExternalRefs(tx, 'samsara', 'machine', '', ['veh-1', 'veh-2', 'veh-9', 'veh-1']),
    );
    expect(Object.fromEntries(map)).toEqual({ 'veh-1': b, 'veh-2': demoId('semi-2') });
    expect((await resolveExternalRefs(pool, 'samsara', 'machine', '', [])).size).toBe(0);
  });
});
