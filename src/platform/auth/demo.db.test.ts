/**
 * Demo people on the demo farm: idempotent seeding, per-install PINs that really sign in, the
 * launch banner lines, and switching them off.
 */
import { describe, expect, test } from 'vitest';
import { seedDemo } from '../../../tools/seed/demo';
import { setupTestDb } from '../../test/db';
import { authBannerLines, ownerSetupUrl } from './banner';
import { ownerSetupCode } from './codes';
import {
  DEMO_PEOPLE,
  deactivateDemoPeople,
  demoPin,
  demoUserId,
  formatDemoPins,
  listDemoPeople,
  seedDemoPeople,
} from './demo';
import { isGuessablePin } from './pin';
import { attemptPin, setupOwner } from './store';

const t = setupTestDb(import.meta.url);
const SECRET = 'demo-db-test-secret-0123456789abcdef';
const NOW = new Date('2026-11-16T13:00:00Z');

describe('demo people', () => {
  test('PINs are per install, 4 digits, never guessable', () => {
    for (const p of DEMO_PEOPLE) {
      const pin = demoPin(SECRET, p.key);
      expect(pin).toMatch(/^\d{4}$/);
      expect(isGuessablePin(pin)).toBe(false);
      expect(demoPin(SECRET, p.key)).toBe(pin);
    }
    const other = DEMO_PEOPLE.map((p) => demoPin('another-secret-0123456789abcdef-xyz', p.key));
    expect(other).not.toEqual(DEMO_PEOPLE.map((p) => demoPin(SECRET, p.key)));
  });

  test('without the demo farm nothing is created', async () => {
    expect(await seedDemoPeople(t().pool, SECRET)).toEqual({
      inserted: 0,
      existing: 0,
      skipped: DEMO_PEOPLE.length,
    });
  });

  test('on the demo farm: created once, deterministic ids, and the PINs sign in', async () => {
    await seedDemo(t().pool, { seed: 1 });
    expect(await seedDemoPeople(t().pool, SECRET)).toEqual({
      inserted: DEMO_PEOPLE.length,
      existing: 0,
      skipped: 0,
    });
    expect(await seedDemoPeople(t().pool, SECRET)).toEqual({
      inserted: 0,
      existing: DEMO_PEOPLE.length,
      skipped: 0,
    });
    const people = await listDemoPeople(t().pool, SECRET);
    expect(people.map((p) => p.role)).toEqual([
      'manager',
      'operator',
      'operator',
      'operator',
      'driver',
      'driver',
      'driver',
      'driver',
    ]);
    const amy = people.find((p) => p.key === 'crew-amy');
    expect(amy).toMatchObject({
      displayName: 'Amy Kovach',
      role: 'manager',
      appUserId: demoUserId('crew-amy'),
    });
    expect(amy?.pin).toBe(demoPin(SECRET, 'crew-amy'));
    expect(
      await attemptPin(t().pool, demoUserId('crew-dale'), demoPin(SECRET, 'crew-dale'), NOW),
    ).toMatchObject({
      ok: true,
      user: { role: 'operator' },
    });
    const src = await t().pool.query(
      `select distinct source from farm.app_users where id = any($1::uuid[])`,
      [people.map((p) => p.appUserId)],
    );
    expect(src.rows).toEqual([{ source: 'demo' }]);
  });

  test('a PIN changed in the app is no longer printed', async () => {
    await t().pool.query(`update farm.app_users set pin_hash = null where id = $1`, [
      demoUserId('crew-kyle'),
    ]);
    const kyle = (await listDemoPeople(t().pool, SECRET)).find((p) => p.key === 'crew-kyle');
    expect(kyle?.pin).toBeNull();
    expect(formatDemoPins(await listDemoPeople(t().pool, SECRET)).join(' ')).not.toContain('Kyle');
  });

  test('banner: owner setup link first, demo PINs, then sign-in once the owner exists', async () => {
    const base = 'http://localhost:3000';
    const before = (await authBannerLines(t().pool, SECRET, base)).join('\n');
    expect(before).toContain(ownerSetupUrl(base, SECRET));
    expect(ownerSetupUrl(base, SECRET)).toBe(`${base}/login/setup?code=${ownerSetupCode(SECRET)}`);
    expect(before).toContain(`Amy Kovach (manager) ${demoPin(SECRET, 'crew-amy')}`);
    expect(before).toContain('/admin/devices');

    await setupOwner(t().db, { name: 'Derrick Hopson', pin: '4071' }, NOW);
    const after = (await authBannerLines(t().pool, SECRET, base)).join('\n');
    expect(after).not.toContain(ownerSetupCode(SECRET));
    expect(after).toContain(`${base}/login`);
    expect(after).toContain('pnpm auth:reset-owner');
  });

  test('switching them off ends their sessions and their banner line', async () => {
    expect(await deactivateDemoPeople(t().pool)).toBe(DEMO_PEOPLE.length);
    expect(await deactivateDemoPeople(t().pool)).toBe(0);
    expect(formatDemoPins(await listDemoPeople(t().pool, SECRET))).toEqual([]);
    expect(
      await attemptPin(t().pool, demoUserId('crew-dale'), demoPin(SECRET, 'crew-dale'), NOW),
    ).toMatchObject({ ok: false });
  });
});
