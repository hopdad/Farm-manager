/**
 * Demo people: sign-ins for the demo farm's crew (tools/seed demo), so the PIN pad, the people
 * admin and the role checks can be tried on day one. One manager, three operators, four
 * drivers. Rows: farm.app_users with source 'demo', source_id `user:<crew key>`, deterministic
 * ids (plan §4). data:export carries only what was changed in the app (switched off, role,
 * epoch, a new PIN) as an overlay, so a `db:reset` wrapped in data:export / data:import keeps
 * them switched off (tools/import/data-transfer.ts).
 *
 * Their PINs are NOT in the repo: each is derived from this install's SESSION_SECRET (like the
 * M0 admin key), so only the person at the PC sees them (bootstrap / `pnpm dev` print them, and
 * `pnpm auth:demo-people`). A demo manager can enroll devices and manage crew, so switch the
 * demo people off before real use: /admin/people or `pnpm auth:demo-people --off`.
 */
import { createHmac } from 'node:crypto';
import { type Executor, exec } from '../../db/exec';
import { demoId, deterministicId } from '../../domain/ids';
import { CREW } from '../../sim/farm/names';
import { hashPin, isGuessablePin, verifyPin } from './pin';
import type { Role } from './types';

export const DEMO_SOURCE = 'demo';

/** Demo crew key -> role (D8 defaults). */
export const DEMO_PEOPLE: readonly { key: string; role: Role }[] = [
  { key: 'crew-amy', role: 'manager' },
  { key: 'crew-dale', role: 'operator' },
  { key: 'crew-luis', role: 'operator' },
  { key: 'crew-jake', role: 'operator' },
  { key: 'crew-tom', role: 'driver' },
  { key: 'crew-ben', role: 'driver' },
  { key: 'crew-sam', role: 'driver' },
  { key: 'crew-kyle', role: 'driver' },
];

const sourceIdOf = (key: string) => `user:${key}`;

/** The app_users id of a demo person. */
export function demoUserId(key: string): string {
  return deterministicId(DEMO_SOURCE, sourceIdOf(key));
}

/** This install's 4-digit demo PIN for a crew key (never a guessable one). */
export function demoPin(secret: string, key: string): string {
  for (let n = 0; ; n++) {
    const h = createHmac('sha256', secret).update(`farm-ops demo pin\n${key}\n${n}`).digest();
    const pin = String(h.readUInt32BE(0) % 10_000).padStart(4, '0');
    if (!isGuessablePin(pin)) return pin;
  }
}

export interface DemoPerson {
  key: string;
  appUserId: string;
  displayName: string;
  role: Role;
  active: boolean;
  /** The derived PIN while it is still their PIN (null once someone changed it). */
  pin: string | null;
}

/**
 * Create the demo people's sign-ins (idempotent: existing rows are left as they are, so role or
 * PIN changes made in the app stick). Skips crew the database doesn't have (no demo seed).
 */
export async function seedDemoPeople(
  ex: Executor,
  secret: string,
): Promise<{ inserted: number; existing: number; skipped: number }> {
  const known = new Set(CREW.map((c) => c.key));
  const have = await exec<{ source_id: string }>(
    ex,
    `select source_id from farm.app_users where source = $1`,
    [DEMO_SOURCE],
  );
  const existing = new Set(have.rows.map((r) => r.source_id));
  let inserted = 0;
  // No such crew party (no demo seed), or that person already has a sign-in of another source.
  let skipped = 0;
  for (const p of DEMO_PEOPLE) {
    if (!known.has(p.key)) continue;
    if (existing.has(sourceIdOf(p.key))) continue;
    const r = await exec(
      ex,
      `insert into farm.app_users (id, party_id, role, pin_hash, pin_set_at, source, source_id)
       select $1::uuid, $2::uuid, $3, $4, now(), $5, $6
        where exists (select 1 from farm.parties where id = $2::uuid)
       on conflict do nothing`,
      [
        demoUserId(p.key),
        demoId(p.key),
        p.role,
        await hashPin(demoPin(secret, p.key)),
        DEMO_SOURCE,
        sourceIdOf(p.key),
      ],
    );
    if (r.rowCount) inserted++;
    else skipped++;
  }
  return { inserted, existing: existing.size, skipped };
}

/** The demo people as they are now, with their derived PIN when it still works. */
export async function listDemoPeople(ex: Executor, secret: string): Promise<DemoPerson[]> {
  const r = await exec<{
    id: string;
    source_id: string;
    display_name: string;
    role: Role;
    active: boolean;
    pin_hash: string | null;
  }>(
    ex,
    `select u.id::text as id, u.source_id, p.display_name, u.role, u.active, u.pin_hash
       from farm.app_users u join farm.parties p on p.id = u.party_id
      where u.source = $1
      order by array_position(array['owner','manager','operator','driver','viewer']::text[], u.role),
               lower(p.display_name)`,
    [DEMO_SOURCE],
  );
  const out: DemoPerson[] = [];
  for (const row of r.rows) {
    const key = row.source_id.replace(/^user:/, '');
    const pin = demoPin(secret, key);
    out.push({
      key,
      appUserId: row.id,
      displayName: row.display_name,
      role: row.role,
      active: row.active,
      pin: (await verifyPin(pin, row.pin_hash)) ? pin : null,
    });
  }
  return out;
}

/** Switch every demo person off (and end their sessions). Returns how many. */
export async function deactivateDemoPeople(ex: Executor): Promise<number> {
  const r = await exec(
    ex,
    `update farm.app_users set active = false, session_epoch = session_epoch + 1, updated_at = now()
      where source = $1 and active`,
    [DEMO_SOURCE],
  );
  return r.rowCount;
}

/** "Amy Kovach (manager) 4821 · Dale Mercer (operator) 1739 · …" for the launch banners. */
export function formatDemoPins(people: DemoPerson[]): string[] {
  return people
    .filter((p) => p.active && p.pin)
    .map((p) => `${p.displayName} (${p.role}) ${p.pin}`);
}
