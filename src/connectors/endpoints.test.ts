/**
 * The 1f.2 endpoint resolvers: sim = the stand-in with SIM_CREDENTIALS, replay = the replay
 * origin (no secrets), sandbox/live = the configured host (or the doc-derived default) and the
 * secrets each vendor needs, refused with a fix-it message when one is missing.
 */
import { describe, expect, test } from 'vitest';
import { SIM_CREDENTIALS } from '../sim/types';
import {
  aempEndpoints,
  CNH_DEFAULT_API_BASE,
  type ConnectorConfig,
  ConnectorModeError,
  cnhEndpoints,
  geotabEndpoint,
  MOTIVE_DEFAULT_BASE,
  motiveEndpoint,
  TERMINAL_SANDBOX_BASE,
  terminalEndpoint,
} from './endpoints';
import { REPLAY_ORIGIN } from './replay';

const cfg: ConnectorConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:4010/',
  PUBLIC_URL: 'http://localhost:3000',
};

describe('1f.2 endpoint resolvers', () => {
  test('sim: the stand-in under /<vendor> with the fixed sim credentials', () => {
    expect(motiveEndpoint('sim', cfg).baseUrl).toBe('http://127.0.0.1:4010/motive');
    expect(geotabEndpoint('sim', cfg)).toMatchObject({
      apiUrl: 'http://127.0.0.1:4010/geotab/apiv1',
      ...SIM_CREDENTIALS.geotab,
    });
    expect(aempEndpoints('sim', cfg).map((p) => [p.id, p.baseUrl])).toEqual([
      ['cnh', 'http://127.0.0.1:4010/aemp/cnh'],
      ['kubota', 'http://127.0.0.1:4010/aemp/kubota'],
      ['samsara', 'http://127.0.0.1:4010/aemp/samsara'],
    ]);
    expect(cnhEndpoints('sim', cfg)).toMatchObject({
      apiBase: 'http://127.0.0.1:4010/cnh/api',
      environment: 'sim',
      redirectUri: 'http://localhost:3000/api/oauth/cnh',
    });
    expect(terminalEndpoint('sim', cfg).baseUrl).toBe('http://127.0.0.1:4010/terminal/tsp/v1');
  });

  test('replay: the replay origin, never the network; CNH has no replay mode', () => {
    expect(motiveEndpoint('replay', cfg).baseUrl).toBe(`${REPLAY_ORIGIN}/motive`);
    expect(geotabEndpoint('replay', cfg).apiUrl).toBe(`${REPLAY_ORIGIN}/geotab/apiv1`);
    expect(aempEndpoints('replay', cfg)[0]?.baseUrl).toBe(`${REPLAY_ORIGIN}/aemp/cnh`);
    expect(terminalEndpoint('replay', cfg).baseUrl).toBe(`${REPLAY_ORIGIN}/terminal/tsp/v1`);
    expect(() => cnhEndpoints('replay', cfg)).toThrow(ConnectorModeError);
  });

  test('sandbox/live: configured hosts or the doc-derived defaults, secrets required', () => {
    expect(() => motiveEndpoint('live', cfg)).toThrow(/MOTIVE_API_KEY is required in live mode/);
    expect(motiveEndpoint('live', { ...cfg, MOTIVE_API_KEY: 'k' }).baseUrl).toBe(
      MOTIVE_DEFAULT_BASE,
    );
    expect(
      motiveEndpoint('live', {
        ...cfg,
        MOTIVE_API_KEY: 'k',
        MOTIVE_API_BASE: 'https://m.example.com/',
      }).baseUrl,
    ).toBe('https://m.example.com');
    expect(() => geotabEndpoint('sandbox', cfg)).toThrow(/GEOTAB_DATABASE/);
    expect(
      geotabEndpoint('sandbox', {
        ...cfg,
        GEOTAB_DATABASE: 'demo',
        GEOTAB_USERNAME: 'u',
        GEOTAB_PASSWORD: 'p',
      }).apiUrl,
    ).toBe('https://my.geotab.com/apiv1');
    expect(() => cnhEndpoints('sandbox', cfg)).toThrow(/CNH_CLIENT_ID/);
    expect(
      cnhEndpoints('sandbox', {
        ...cfg,
        CNH_CLIENT_ID: 'i',
        CNH_CLIENT_SECRET: 's',
        CNH_SUBSCRIPTION_KEY: 'k',
      }),
    ).toMatchObject({ apiBase: CNH_DEFAULT_API_BASE, environment: 'staging' });
    expect(() => terminalEndpoint('sandbox', { ...cfg, TERMINAL_SECRET_KEY: 's' })).toThrow(
      /TERMINAL_CONNECTION_TOKEN/,
    );
    expect(
      terminalEndpoint('sandbox', {
        ...cfg,
        TERMINAL_SECRET_KEY: 's',
        TERMINAL_CONNECTION_TOKEN: 'c',
      }).baseUrl,
    ).toBe(TERMINAL_SANDBOX_BASE);
  });

  test('AEMP sandbox/live: only the configured providers, each with what its auth style needs', () => {
    expect(aempEndpoints('live', cfg)).toEqual([]);
    const providers = [
      {
        id: 'kubota',
        baseUrl: 'https://k.example.com/iso/',
        auth: 'basic' as const,
        format: 'auto' as const,
      },
    ];
    expect(() => aempEndpoints('live', { ...cfg, AEMP_PROVIDERS: providers })).toThrow(
      /provider 'kubota' \(auth basic\) needs 'username'/,
    );
    expect(
      aempEndpoints('live', {
        ...cfg,
        AEMP_PROVIDERS: [
          { ...providers[0], username: 'u', password: 'p' } as (typeof providers)[number],
        ],
      })[0]?.baseUrl,
    ).toBe('https://k.example.com/iso');
    expect(() => aempEndpoints('off', cfg)).toThrow(ConnectorModeError);
  });
});
