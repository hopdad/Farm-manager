import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, test } from 'vitest';
import { devOriginCandidates, initEnvFiles, isPrivateIPv4, planEnvFiles } from './env';

let counter = 0;
const fakeHex = (bytes: number) => (counter++).toString(16).padStart(bytes * 2, '0');
const opts = { randomHex: fakeHex, devOrigins: ['192.168.1.20', 'farm-pc.local'] };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'farm-env-'));
const read = (f: string) => parseEnv(readFileSync(f, 'utf8'));

describe('env:init', () => {
  test('creates both files with consistent URLs and secret lengths', () => {
    const dir = tmp();
    const r = initEnvFiles(dir, { devOrigins: opts.devOrigins });
    const env = read(path.join(dir, '.env'));
    const local = read(path.join(dir, '.env.local'));
    expect(env.DB_PASSWORD).toMatch(/^[0-9a-f]{32}$/);
    expect(env.DB_PORT).toBe('15432');
    expect(local.DATABASE_URL).toBe(
      `postgres://farm_app:${local.FARM_APP_PASSWORD}@127.0.0.1:15432/postgres`,
    );
    expect(local.DATABASE_URL_MIGRATE).toBe(
      `postgres://postgres:${env.DB_PASSWORD}@127.0.0.1:15432/postgres`,
    );
    expect(local.JOBS_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(local.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(local.TOKEN_ENC_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(local.PUBLIC_URL).toBe('http://localhost:3000');
    expect(local.VENDOR_SIM_URL).toBe('http://127.0.0.1:4010');
    expect(local.DEV_ORIGINS).toBe('192.168.1.20,farm-pc.local');
    expect(r.added.env).toEqual(['DB_PASSWORD', 'DB_PORT']);
    // M0 demo tuning.
    expect(local.JOBS_DEMO_CADENCE).toBe('on');
    expect(local.FLEET_STALE_SECONDS).toBe('60');
    expect(local.FLEET_STALE_SECONDS_DEERE).toBe('900');
  });

  test('demo cadence is not added once a connector talks to a real vendor', () => {
    const p = planEnvFiles({}, { CONNECTOR_DEERE: 'sandbox' }, opts);
    expect(p.envLocal.JOBS_DEMO_CADENCE).toBeUndefined();
    expect(p.envLocal.FLEET_STALE_SECONDS).toBe('60');
    const kept = planEnvFiles({}, { JOBS_DEMO_CADENCE: 'off' }, opts);
    expect(kept.envLocal.JOBS_DEMO_CADENCE).toBe('off');
    expect(kept.addedLocal).not.toContain('JOBS_DEMO_CADENCE');
  });

  test('is idempotent: a second run changes nothing and never regenerates secrets', () => {
    const dir = tmp();
    initEnvFiles(dir, { devOrigins: opts.devOrigins });
    const before = [
      readFileSync(path.join(dir, '.env'), 'utf8'),
      readFileSync(path.join(dir, '.env.local'), 'utf8'),
    ];
    const r = initEnvFiles(dir, { devOrigins: opts.devOrigins });
    expect(r.added).toEqual({ env: [], envLocal: [] });
    expect(r.updated).toEqual([]);
    expect([
      readFileSync(path.join(dir, '.env'), 'utf8'),
      readFileSync(path.join(dir, '.env.local'), 'utf8'),
    ]).toEqual(before);
  });

  test('keeps user lines, appends only missing keys, fills empty ones in place', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.env'), '# mine\nDB_PASSWORD=keepme\n');
    writeFileSync(path.join(dir, '.env.local'), 'CONNECTOR_ELD=replay\nJOBS_SECRET=\n');
    initEnvFiles(dir, { devOrigins: [] });
    const envText = readFileSync(path.join(dir, '.env'), 'utf8');
    expect(envText.startsWith('# mine\nDB_PASSWORD=keepme\n')).toBe(true);
    const local = read(path.join(dir, '.env.local'));
    expect(local.CONNECTOR_ELD).toBe('replay');
    expect(local.JOBS_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(dir, '.env.local'), 'utf8').match(/JOBS_SECRET=/g)).toHaveLength(
      1,
    );
    expect(local.DATABASE_URL_MIGRATE).toBe('postgres://postgres:keepme@127.0.0.1:15432/postgres');
  });

  test('recovers passwords from existing URLs when .env is gone', () => {
    const p = planEnvFiles(
      {},
      {
        DATABASE_URL: 'postgres://farm_app:apppw@127.0.0.1:15432/postgres',
        DATABASE_URL_MIGRATE: 'postgres://postgres:dbpw@127.0.0.1:15432/postgres',
      },
      opts,
    );
    expect(p.env.DB_PASSWORD).toBe('dbpw');
    expect(p.envLocal.FARM_APP_PASSWORD).toBe('apppw');
    expect(p.warnings).toEqual([]);
  });

  test('DEV_ORIGINS is kept unless --refresh-origins, with a warning when stale', () => {
    const stale = planEnvFiles(
      { DB_PASSWORD: 'x', DB_PORT: '15432' },
      { DEV_ORIGINS: '10.0.0.5' },
      opts,
    );
    expect(stale.envLocal.DEV_ORIGINS).toBe('10.0.0.5');
    expect(stale.warnings.join()).toMatch(/refresh-origins/);
    const fresh = planEnvFiles(
      { DB_PASSWORD: 'x', DB_PORT: '15432' },
      { DEV_ORIGINS: '10.0.0.5' },
      { ...opts, refreshOrigins: true },
    );
    expect(fresh.envLocal.DEV_ORIGINS).toBe('192.168.1.20,farm-pc.local');
    expect(fresh.updated).toEqual(['DEV_ORIGINS']);
  });

  test('private IPv4 detection and origin candidates', () => {
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10'])
      expect(isPrivateIPv4(a)).toBe(true);
    for (const a of ['172.15.0.1', '172.32.0.1', '8.8.8.8', '127.0.0.1', '169.254.1.1', 'x'])
      expect(isPrivateIPv4(a)).toBe(false);
    expect(devOriginCandidates().at(-1)).toMatch(/\.local$/);
  });
});
