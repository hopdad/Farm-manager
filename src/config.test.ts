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
  CONNECTOR_SAMSARA: 'live',
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
      CONNECTOR_SAMSARA: 'sim',
      CONNECTOR_MOTIVE: 'sim',
      CONNECTOR_GEOTAB: 'sim',
      CONNECTOR_AEMP: 'sim',
      CONNECTOR_CNH: 'sim',
      CONNECTOR_TERMINAL: 'sim',
      CONNECTOR_WEATHER: 'sim',
      connectorAliasNotes: [],
      AEMP_PROVIDERS: [],
      FLEET_STALE_SECONDS_LAST_KNOWN: 10_800,
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
    ['CONNECTOR_SAMSARA', 'replay'],
    ['CONNECTOR_MOTIVE', 'sim'],
    ['CONNECTOR_GEOTAB', 'replay'],
    ['CONNECTOR_AEMP', 'sim'],
    ['CONNECTOR_CNH', 'sim'],
    ['CONNECTOR_TERMINAL', 'replay'],
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
        CONNECTOR_SAMSARA: 'off',
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

  test('stale thresholds: continuous sources, Deere working-only fixes, last-known snapshots', () => {
    const c = parseConfig({ ...base, FLEET_STALE_SECONDS: '60', FLEET_STALE_SECONDS_DEERE: '900' });
    expect([c.FLEET_STALE_SECONDS, c.FLEET_STALE_SECONDS_DEERE]).toEqual([60, 900]);
    expect(publicConfig(c)).toMatchObject({ staleAfterSeconds: 60, deereStaleAfterSeconds: 900 });
    expect(parseConfig(base).FLEET_STALE_SECONDS_DEERE).toBe(600);
    expect(
      publicConfig(parseConfig({ ...base, FLEET_STALE_SECONDS_LAST_KNOWN: '7200' })),
    ).toMatchObject({
      lastKnownStaleAfterSeconds: 7200,
    });
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

  test('1f.2: unset vendor keys are sim locally and off in production (production names only what it uses)', () => {
    const local = parseConfig(base);
    const production = parseConfig(prod);
    for (const k of [
      'CONNECTOR_MOTIVE',
      'CONNECTOR_GEOTAB',
      'CONNECTOR_AEMP',
      'CONNECTOR_CNH',
      'CONNECTOR_TERMINAL',
    ] as const) {
      expect(local[k]).toBe('sim');
      expect(production[k]).toBe('off');
    }
    expect(production.CONNECTOR_SAMSARA).toBe('live');
  });

  test('1f.2: the deprecated CONNECTOR_ELD / ELD_VENDOR set the named vendor key, with a warning', () => {
    const plain = parseConfig({ ...base, CONNECTOR_ELD: 'replay' });
    expect(plain.CONNECTOR_SAMSARA).toBe('replay');
    expect(plain.CONNECTOR_MOTIVE).toBe('sim');
    expect(plain.connectorAliasNotes).toEqual([
      {
        keys: ['CONNECTOR_ELD'],
        sets: 'CONNECTOR_SAMSARA',
        message: expect.stringMatching(
          /CONNECTOR_ELD=replay is deprecated: it set CONNECTOR_SAMSARA=replay\. Write CONNECTOR_SAMSARA=replay/,
        ),
      },
    ]);
    // Derrick's old .env.local: Motive as the ELD.
    const motive = parseConfig({ ...base, CONNECTOR_ELD: 'live', ELD_VENDOR: 'motive' });
    expect([motive.CONNECTOR_MOTIVE, motive.CONNECTOR_SAMSARA]).toEqual(['live', 'sim']);
    expect(motive.connectorAliasNotes[0]?.keys).toEqual(['CONNECTOR_ELD', 'ELD_VENDOR']);
    // The vendor's own key wins; the alias is then only a warning.
    const both = parseConfig({ ...base, CONNECTOR_ELD: 'replay', CONNECTOR_SAMSARA: 'off' });
    expect(both.CONNECTOR_SAMSARA).toBe('off');
    expect(both.connectorAliasNotes[0]).toMatchObject({ sets: null });
    expect(both.connectorAliasNotes[0]?.message).toMatch(
      /ignored: CONNECTOR_SAMSARA is set \(off\)/,
    );
    // ELD_VENDOR alone does nothing but warn.
    const vendorOnly = parseConfig({ ...base, ELD_VENDOR: 'geotab' });
    expect(vendorOnly.CONNECTOR_GEOTAB).toBe('sim');
    expect(vendorOnly.connectorAliasNotes[0]?.message).toMatch(/does nothing on its own/);
    // The raw keys never reach the Config the rest of the app reads.
    expect('CONNECTOR_ELD' in plain).toBe(false);
    expect('ELD_VENDOR' in plain).toBe(false);
    expect(issues({ ...base, ELD_VENDOR: 'omnitracs' }).join('\n')).toMatch(/ELD_VENDOR/);
    expect(CONFIG_KEYS).toEqual(expect.arrayContaining(['CONNECTOR_ELD', 'ELD_VENDOR']));
  });

  test('1f.2: production rules apply per key, the alias included', () => {
    expect(issues({ ...prod, CONNECTOR_SAMSARA: undefined, CONNECTOR_ELD: 'live' })).toEqual([]);
    expect(
      issues({ ...prod, CONNECTOR_SAMSARA: undefined, CONNECTOR_ELD: 'replay' }).join('\n'),
    ).toMatch(
      /CONNECTOR_SAMSARA: 'replay' is not allowed when APP_ENV=production .*\(set by the deprecated CONNECTOR_ELD\)/,
    );
    expect(issues({ ...prod, CNH_REDIRECT_URI: 'http://farm.example.com/cnh' }).join('\n')).toMatch(
      /CNH_REDIRECT_URI: must be https:\/\/ in production/,
    );
  });

  test('1f.2: vendor credentials are optional (sim and replay need none) and validated', () => {
    const c = parseConfig({
      ...base,
      MOTIVE_API_BASE: 'https://api.gomotive.com',
      GEOTAB_SERVER: 'my.geotab.com',
      GEOTAB_DATABASE: 'demo_farm',
      GEOTAB_USERNAME: 'svc@example.com',
      GEOTAB_PASSWORD: 'pw',
      CNH_CLIENT_ID: 'id',
      CNH_CLIENT_SECRET: 'secret',
      CNH_SUBSCRIPTION_KEY: 'sub',
      TERMINAL_SECRET_KEY: 'sk_test',
      TERMINAL_CONNECTION_TOKEN: 'con_tkn',
    });
    expect(c.GEOTAB_DATABASE).toBe('demo_farm');
    expect(c.TERMINAL_CONNECTION_TOKEN).toBe('con_tkn');
    expect(parseConfig(base).GEOTAB_SERVER).toBeUndefined();
    expect(issues({ ...base, GEOTAB_SERVER: 'https://my.geotab.com/' }).join('\n')).toMatch(
      /GEOTAB_SERVER/,
    );
    expect(issues({ ...base, TERMINAL_API_BASE: 'not a url' }).join('\n')).toMatch(
      /TERMINAL_API_BASE/,
    );
  });

  test('1f.2: AEMP_PROVIDERS is a JSON list of providers (id, base URL, auth style, credentials)', () => {
    const c = parseConfig({
      ...base,
      AEMP_PROVIDERS: JSON.stringify([
        {
          id: 'kubota',
          baseUrl: 'https://aemp.example.com/iso',
          auth: 'basic',
          username: 'u',
          password: 'p',
        },
        {
          id: 'samsara',
          label: 'Samsara AEMP',
          baseUrl: 'https://api.samsara.com/beta/aemp',
          auth: 'bearer',
        },
      ]),
    });
    expect(c.AEMP_PROVIDERS.map((p) => [p.id, p.auth, p.format])).toEqual([
      ['kubota', 'basic', 'auto'],
      ['samsara', 'bearer', 'auto'],
    ]);
    expect(issues({ ...base, AEMP_PROVIDERS: '{not json' }).join('\n')).toMatch(
      /AEMP_PROVIDERS: must be a JSON array/,
    );
    expect(
      issues({
        ...base,
        AEMP_PROVIDERS: JSON.stringify([
          { id: 'Kubota', baseUrl: 'https://x.example.com', auth: 'none' },
        ]),
      }).join('\n'),
    ).toMatch(/AEMP_PROVIDERS: 0\.id/);
    expect(
      issues({
        ...base,
        AEMP_PROVIDERS: JSON.stringify([
          { id: 'cnh', baseUrl: 'https://x.example.com', auth: 'none' },
          { id: 'cnh', baseUrl: 'https://y.example.com', auth: 'none' },
        ]),
      }).join('\n'),
    ).toMatch(/'cnh' is listed twice/);
    expect(
      issues({
        ...base,
        AEMP_PROVIDERS: JSON.stringify([
          { id: 'x1', baseUrl: 'https://x.example.com', auth: 'kerberos' },
        ]),
      }).join('\n'),
    ).toMatch(/AEMP_PROVIDERS/);
  });

  test('1f.2: VEHICLE_KIND_TAGS maps vendor tags to kinds (default semi/pickup/service truck)', () => {
    expect(parseConfig(base).VEHICLE_KIND_TAGS).toEqual([
      { tag: 'semi', kind: 'semi' },
      { tag: 'pickup', kind: 'pickup' },
      { tag: 'service truck', kind: 'service_truck' },
    ]);
    expect(
      parseConfig({ ...base, VEHICLE_KIND_TAGS: 'pickup:Pickups, service_truck:Shop Truck' })
        .VEHICLE_KIND_TAGS,
    ).toEqual([
      { tag: 'pickups', kind: 'pickup' },
      { tag: 'shop truck', kind: 'service_truck' },
    ]);
    expect(issues({ ...base, VEHICLE_KIND_TAGS: 'combine:Combines' }).join('\n')).toMatch(
      /VEHICLE_KIND_TAGS: 'combine:Combines': the kind must be one of semi, pickup, service_truck/,
    );
    expect(issues({ ...base, VEHICLE_KIND_TAGS: 'pickup:' }).join('\n')).toMatch(
      /a tag name is required/,
    );
  });

  test('production allows off and sandbox', () => {
    expect(issues({ ...prod, CONNECTOR_DEERE: 'off', CONNECTOR_SAMSARA: 'sandbox' })).toEqual([]);
  });

  test('publicConfig exposes only client-safe values', () => {
    const p = publicConfig(parseConfig(base));
    expect(Object.keys(p).sort()).toEqual([
      'appEnv',
      'basemapStyle',
      'deereStaleAfterSeconds',
      'lastKnownStaleAfterSeconds',
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
