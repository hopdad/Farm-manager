import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CONFIG_KEYS,
  ConfigError,
  childEnv,
  parseConfig,
  parseE2eSettings,
  publicConfig,
} from './config';
import { runNode, tsxBin } from './lib/proc';

const secret = 'a'.repeat(64);
const base = {
  DATABASE_URL: 'postgres://farm_app:pw@127.0.0.1:15432/postgres',
  JOBS_SECRET: secret,
  SESSION_SECRET: secret,
};
const prod = {
  ...base,
  APP_ENV: 'production',
  PUBLIC_URL: 'https://farm.example.com',
  TOKEN_ENC_KEY: 'b'.repeat(64),
  NEXT_PUBLIC_REALTIME: 'supabase',
  CONNECTOR_DEERE: 'live',
  CONNECTOR_ELD: 'live',
  CONNECTOR_WEATHER: 'live',
};

function issues(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
}

describe('parseConfig', () => {
  test('defaults', () => {
    const c = parseConfig(base, '/proj');
    expect(c).toMatchObject({
      APP_ENV: 'development',
      DB_PORT: 15432,
      DB_POOL_MAX: 10,
      PUBLIC_URL: 'http://localhost:3000',
      DEV_ORIGINS: [],
      VENDOR_SIM_URL: 'http://127.0.0.1:4010',
      CONNECTOR_DEERE: 'sim',
      CONNECTOR_ELD: 'sim',
      CONNECTOR_WEATHER: 'sim',
      ELD_VENDOR: 'samsara',
      WRITEBACK_DEERE: false,
      NEXT_PUBLIC_REALTIME: 'sse',
      BASEMAP_STYLE: 'protomaps-local',
      SIM_SCENARIO: 'harvest-day',
      SIM_SPEED: 1,
      SIM_FROZEN_AT: null,
      CLOCK_HOSTS: ['app', 'pc'],
      projectDir: '/proj',
      isProduction: false,
      cookieSecure: false,
    });
  });

  test('parses lists, numbers, switches and dates', () => {
    const c = parseConfig({
      ...base,
      DEV_ORIGINS: '192.168.1.20, farm-pc.local,,',
      DB_POOL_MAX: '3',
      SIM_SPEED: '30',
      WRITEBACK_DEERE: 'on',
      SIM_FROZEN_AT: '2026-10-15T11:00:00Z',
      PUBLIC_URL: 'https://192.168.1.20:3443',
    });
    expect(c.DEV_ORIGINS).toEqual(['192.168.1.20', 'farm-pc.local']);
    expect(c.DB_POOL_MAX).toBe(3);
    expect(c.SIM_SPEED).toBe(30);
    expect(c.WRITEBACK_DEERE).toBe(true);
    expect(c.SIM_FROZEN_AT?.toISOString()).toBe('2026-10-15T11:00:00.000Z');
    expect(c.cookieSecure).toBe(true);
  });

  test('empty strings count as unset', () => {
    expect(parseConfig({ ...base, DB_PORT: '', CONNECTOR_ELD: '' }).DB_PORT).toBe(15432);
  });

  test('missing secrets and bad values give readable issues', () => {
    const list = issues({
      DATABASE_URL: 'mysql://x',
      CONNECTOR_DEERE: 'maybe',
      CLOCK_HOSTS: 'app,moon',
    });
    expect(list.join('\n')).toMatch(/DATABASE_URL: must be a postgres:\/\/ URL/);
    expect(list.join('\n')).toMatch(/JOBS_SECRET/);
    expect(list.join('\n')).toMatch(/SESSION_SECRET/);
    expect(list.join('\n')).toMatch(/CONNECTOR_DEERE/);
    expect(list.join('\n')).toMatch(/unknown host 'moon'/);
    expect(() => parseConfig({})).toThrow(/pnpm env:init/);
  });

  test('BASEMAP_STYLE=openfreemap is refused until that style exists', () => {
    expect(parseConfig(base).BASEMAP_STYLE).toBe('protomaps-local');
    expect(issues({ ...base, BASEMAP_STYLE: 'openfreemap' }).join('\n')).toMatch(
      /BASEMAP_STYLE: 'openfreemap': the online style is not built yet/,
    );
  });

  test('VENDOR_SIM_URL must be a loopback address', () => {
    for (const ok of ['http://127.0.0.1:4011', 'http://localhost:4010', 'http://[::1]:4010']) {
      expect(parseConfig({ ...base, VENDOR_SIM_URL: ok }).VENDOR_SIM_URL).toBe(ok);
    }
    for (const bad of ['http://192.168.1.20:4010', 'http://0.0.0.0:4010', 'https://sim.example']) {
      expect(issues({ ...base, VENDOR_SIM_URL: bad }).join('\n')).toMatch(
        /VENDOR_SIM_URL: the vendor stand-in is loopback-only/,
      );
    }
  });

  test('a valid production config passes', () => {
    const c = parseConfig(prod);
    expect(c.isProduction).toBe(true);
  });

  test.each([
    ['CONNECTOR_DEERE', 'sim'],
    ['CONNECTOR_ELD', 'replay'],
    ['CONNECTOR_WEATHER', 'sim'],
  ])('APP_ENV=production refuses %s=%s', (key, mode) => {
    expect(issues({ ...prod, [key]: mode }).join('\n')).toMatch(
      new RegExp(`${key}: '${mode}' is not allowed when APP_ENV=production`),
    );
  });

  test('production refuses defaulted sim modes, SSE, http and a frozen sim clock', () => {
    const list = issues({
      ...base,
      APP_ENV: 'production',
      TOKEN_ENC_KEY: 'b'.repeat(64),
      SIM_FROZEN_AT: '2026-10-15T11:00:00Z',
    }).join('\n');
    expect(list).toMatch(/CONNECTOR_DEERE: 'sim' is not allowed/);
    expect(list).toMatch(/NEXT_PUBLIC_REALTIME/);
    expect(list).toMatch(/PUBLIC_URL: must be https/);
    expect(list).toMatch(/SIM_FROZEN_AT/);
  });

  test('JOBS_DEMO_CADENCE: off by default, never in production; live connectors are allowed (the clock skips their jobs)', () => {
    expect(parseConfig(base).JOBS_DEMO_CADENCE).toBe(false);
    expect(parseConfig({ ...base, JOBS_DEMO_CADENCE: 'on' }).JOBS_DEMO_CADENCE).toBe(true);
    expect(
      parseConfig({
        ...base,
        JOBS_DEMO_CADENCE: 'on',
        CONNECTOR_DEERE: 'replay',
        CONNECTOR_ELD: 'off',
      }).JOBS_DEMO_CADENCE,
    ).toBe(true);
    // A live weather connector keeps weather.nws on its real schedule (src/jobs/schedule.ts);
    // the config no longer refuses the combination.
    expect(
      parseConfig({ ...base, JOBS_DEMO_CADENCE: 'on', CONNECTOR_WEATHER: 'live' })
        .JOBS_DEMO_CADENCE,
    ).toBe(true);
    expect(issues({ ...prod, JOBS_DEMO_CADENCE: 'on' }).join('\n')).toMatch(
      /JOBS_DEMO_CADENCE: not allowed in production/,
    );
    expect(issues({ ...base, JOBS_DEMO_CADENCE: 'yes' })).toHaveLength(1);
  });

  test('stale thresholds: one for continuous sources, one for Deere working-only fixes', () => {
    const c = parseConfig({ ...base, FLEET_STALE_SECONDS: '60', FLEET_STALE_SECONDS_DEERE: '900' });
    expect([c.FLEET_STALE_SECONDS, c.FLEET_STALE_SECONDS_DEERE]).toEqual([60, 900]);
    expect(publicConfig(c)).toMatchObject({ staleAfterSeconds: 60, deereStaleAfterSeconds: 900 });
    expect(parseConfig(base).FLEET_STALE_SECONDS_DEERE).toBe(600);
  });

  test('Deere redirect override and daily call budget (1f): optional, validated', () => {
    const c = parseConfig(base);
    expect(c.DEERE_REDIRECT_URI).toBeUndefined();
    expect(c.DEERE_DAILY_CALL_BUDGET).toBeUndefined();
    const set = parseConfig({
      ...base,
      DEERE_REDIRECT_URI: 'https://farm.example.com/deere-callback.html',
      DEERE_DAILY_CALL_BUDGET: '50000',
    });
    expect(set.DEERE_REDIRECT_URI).toBe('https://farm.example.com/deere-callback.html');
    expect(set.DEERE_DAILY_CALL_BUDGET).toBe(50_000);
    // Empty counts as unset, like every key.
    expect(parseConfig({ ...base, DEERE_DAILY_CALL_BUDGET: '' }).DEERE_DAILY_CALL_BUDGET).toBe(
      undefined,
    );
    expect(issues({ ...base, DEERE_REDIRECT_URI: 'ftp://x.example.com/cb' }).join('\n')).toMatch(
      /DEERE_REDIRECT_URI/,
    );
    expect(issues({ ...base, DEERE_DAILY_CALL_BUDGET: '0' }).join('\n')).toMatch(
      /DEERE_DAILY_CALL_BUDGET/,
    );
    expect(issues({ ...base, DEERE_DAILY_CALL_BUDGET: '12.5' }).join('\n')).toMatch(
      /DEERE_DAILY_CALL_BUDGET/,
    );
    // Production: the public callback must be https, like PUBLIC_URL.
    expect(
      issues({ ...prod, DEERE_REDIRECT_URI: 'http://farm.example.com/cb' }).join('\n'),
    ).toMatch(/DEERE_REDIRECT_URI: must be https:\/\/ in production/);
    expect(issues({ ...prod, DEERE_REDIRECT_URI: 'https://farm.example.com/cb' })).toEqual([]);
  });

  test('Deere home org (1f): optional, any non-blank org id', () => {
    expect(parseConfig(base).DEERE_HOME_ORG_ID).toBeUndefined();
    expect(parseConfig({ ...base, DEERE_HOME_ORG_ID: '4117350' }).DEERE_HOME_ORG_ID).toBe(
      '4117350',
    );
    expect(parseConfig({ ...base, DEERE_HOME_ORG_ID: '  4117350 ' }).DEERE_HOME_ORG_ID).toBe(
      '4117350',
    );
    // Empty counts as unset, like every key; blanks alone are refused.
    expect(parseConfig({ ...base, DEERE_HOME_ORG_ID: '' }).DEERE_HOME_ORG_ID).toBeUndefined();
    expect(issues({ ...base, DEERE_HOME_ORG_ID: '   ' }).join('\n')).toMatch(/DEERE_HOME_ORG_ID/);
    expect(issues({ ...prod, DEERE_HOME_ORG_ID: '4117350' })).toEqual([]);
  });

  test('production allows off and sandbox', () => {
    expect(issues({ ...prod, CONNECTOR_DEERE: 'off', CONNECTOR_ELD: 'sandbox' })).toEqual([]);
  });

  test('publicConfig exposes only client-safe values', () => {
    const p = publicConfig(parseConfig(base));
    expect(Object.keys(p).sort()).toEqual([
      'appEnv',
      'basemapStyle',
      'deereStaleAfterSeconds',
      'realtime',
      'staleAfterSeconds',
    ]);
    expect(JSON.stringify(p)).not.toContain(secret);
  });

  test('every key is documented in docs/contracts.md', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(path.join(process.cwd(), 'docs', 'contracts.md'), 'utf8');
    const missing = CONFIG_KEYS.filter((k) => !doc.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });
});

describe('parseE2eSettings (playwright.config.ts)', () => {
  test('defaults to localhost:3000 and not-CI, with no other config needed', () => {
    expect(parseE2eSettings({})).toEqual({
      baseURL: 'http://localhost:3000',
      ci: false,
      external: false,
    });
    expect(parseE2eSettings({ E2E_BASE_URL: 'http://10.0.0.5:3000' }).external).toBe(true);
  });

  test('E2E_BASE_URL wins over PUBLIC_URL; PUBLIC_URL wins over the default', () => {
    expect(
      parseE2eSettings({ E2E_BASE_URL: 'http://127.0.0.1:3100', PUBLIC_URL: 'http://x:3101' }),
    ).toMatchObject({ baseURL: 'http://127.0.0.1:3100' });
    expect(parseE2eSettings({ PUBLIC_URL: 'http://localhost:3101' })).toMatchObject({
      baseURL: 'http://localhost:3101',
    });
    expect(parseE2eSettings({ PUBLIC_URL: 'not a url' })).toMatchObject({
      baseURL: 'http://localhost:3000',
    });
  });

  test('CI is true for any value except empty, 0 and false', () => {
    expect(parseE2eSettings({ CI: 'true' }).ci).toBe(true);
    expect(parseE2eSettings({ CI: '1' }).ci).toBe(true);
    expect(parseE2eSettings({ CI: 'false' }).ci).toBe(false);
    expect(parseE2eSettings({ CI: 'FALSE' }).ci).toBe(false);
    expect(parseE2eSettings({ CI: '0' }).ci).toBe(false);
    expect(parseE2eSettings({ CI: '' }).ci).toBe(false);
  });

  test('a malformed E2E_BASE_URL is a readable ConfigError', () => {
    expect(() => parseE2eSettings({ E2E_BASE_URL: 'localhost:3000' })).toThrow(ConfigError);
    expect(() => parseE2eSettings({ E2E_BASE_URL: 'ftp://x' })).toThrow(/E2E_BASE_URL/);
  });

  test('E2E keys are documented in docs/contracts.md', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(path.join(process.cwd(), 'docs', 'contracts.md'), 'utf8');
    expect(doc).toContain('`E2E_BASE_URL`');
    expect(doc).toContain('`CI`');
  });
});

describe('env files', () => {
  test('CLI scripts pick up .env and .env.local like Next (.env.local wins, real env wins over both)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'farm-config-'));
    writeFileSync(
      path.join(dir, '.env'),
      `DB_PORT=15999\nDATABASE_URL=postgres://farm_app:fromdotenv@127.0.0.1:15999/postgres\nSIM_SPEED=5\n`,
    );
    writeFileSync(
      path.join(dir, '.env.local'),
      `DATABASE_URL=postgres://farm_app:fromlocal@127.0.0.1:15999/postgres\nJOBS_SECRET=${secret}\nSESSION_SECRET=${secret}\nSIM_SPEED=10\n`,
    );
    const probe = path.join(process.cwd(), 'src', 'test', 'fixtures', 'print-config.ts');
    const r = await runNode(tsxBin(), [probe], {
      cwd: dir,
      // A CLI run: no NODE_ENV (Next would skip .env.local under NODE_ENV=test).
      env: childEnv({
        NODE_ENV: undefined,
        APP_ENV: undefined,
        DATABASE_URL: undefined,
        JOBS_SECRET: undefined,
        SESSION_SECRET: undefined,
        SIM_SPEED: '42',
        DB_PORT: undefined,
      }),
      timeoutMs: 60_000,
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out.DATABASE_URL).toBe('postgres://farm_app:fromlocal@127.0.0.1:15999/postgres');
    expect(out.DB_PORT).toBe(15999);
    expect(out.SIM_SPEED).toBe(42);
    expect(out.projectDir).toBe(dir);
  }, 60_000);
});
