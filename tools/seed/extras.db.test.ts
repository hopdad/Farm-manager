/**
 * The demo seed's M1 extras (./extras.ts) on a fresh database: demo people with working PINs,
 * the synthetic soils fixture (every demo field gets soils), the synthetic parcels, the online
 * NAIP row; a second run changes nothing; a real parcel import is never replaced.
 */
import { describe, expect, test } from 'vitest';
import { demoPin } from '../../src/platform/auth/demo';
import { verifyPin } from '../../src/platform/auth/pin';
import { setupTestDb } from '../../src/test/db';
import { seedDemo } from './demo';
import { formatExtrasReport, seedDemoExtras } from './extras';

const t = setupTestDb(import.meta.url);
const SECRET = 'extras-test-secret-0123456789abcdef';
const opts = () => ({ secret: SECRET, projectDir: process.cwd(), soilsCache: false });

describe('seedDemoExtras', () => {
  test('first run: people, synthetic soils and parcels, the NAIP row', async () => {
    const { pool } = t();
    await seedDemo(pool, { seed: 1, eldVendor: 'samsara' });
    const r = await seedDemoExtras(pool, opts());
    expect(r.people.inserted).toBe(8);
    expect(r.soils.action).toBe('fixture');
    expect(r.parcels.action).toBe('synthetic');
    expect(r.naip.action).toBe('online-row');

    // Amy Kovach (the demo manager) signs in with her derived PIN.
    const amy = await pool.query<{ role: string; pin_hash: string }>(
      `select u.role, u.pin_hash from farm.app_users u join farm.parties p on p.id = u.party_id
        where p.display_name = 'Amy Kovach'`,
    );
    expect(amy.rows[0]?.role).toBe('manager');
    expect(await verifyPin(demoPin(SECRET, 'crew-amy'), amy.rows[0]?.pin_hash ?? null)).toBe(true);

    // Every demo field has soils summing to 100 % and at least one parcel.
    const soils = await pool.query<{ n: number }>(
      `select count(*)::int as n from (
         select b.field_id, sum(s.pct) as pct
           from farm.current_boundaries b join gis.field_soils s on s.boundary_id = b.id
          group by b.field_id having abs(sum(s.pct) - 100) < 0.5) x`,
    );
    expect(soils.rows[0]?.n).toBe(40);
    const parcels = await pool.query<{ n: number }>(
      `select count(distinct b.field_id)::int as n
         from farm.current_boundaries b join gis.parcels p
           on extensions.ST_Intersects(p.geom, b.geom)`,
    );
    expect(parcels.rows[0]?.n).toBe(40);
    const naip = await pool.query(
      `select kind, cache_policy from gis.map_layers where key = 'naip'`,
    );
    expect(naip.rows[0]).toEqual({ kind: 'xyz', cache_policy: 'public' });

    const lines = await formatExtrasReport(pool, r, SECRET);
    expect(lines.join('\n')).toMatch(/Amy Kovach \(manager\) \d{4}/);
  });

  test('a second run writes nothing', async () => {
    const r = await seedDemoExtras(t().pool, opts());
    expect(r.people.inserted).toBe(0);
    expect(r.soils.action).toBe('kept');
    expect(r.parcels.action).toBe('kept');
    expect(r.naip.action).toBe('kept');
  });

  test('a real county parcel file is never replaced by the synthetic one', async () => {
    const { pool, admin } = t();
    await admin.query(
      `insert into gis.parcel_imports (source, county_fips) values ('lenawee-county', '26091')`,
    );
    const before = await pool.query<{ n: number }>('select count(*)::int as n from gis.parcels');
    const r = await seedDemoExtras(pool, opts());
    expect(r.parcels.action).toBe('real-import');
    const after = await pool.query<{ n: number }>('select count(*)::int as n from gis.parcels');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
