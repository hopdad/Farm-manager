/**
 * The 1f.2 endpoint resolvers: sim = the stand-in with SIM_CREDENTIALS, replay = the replay
 * origin (no secrets), sandbox/live = the configured host (or the doc-derived default) and the
 * secrets each vendor needs, refused with a fix-it message when one is missing.
 */
import { describe, expect, test } from 'vitest';
import { SIM_CREDENTIALS } from '../sim/types';
import { deereAuthorizeUrl, exchangeDeereCode } from './deere/oauth';
import {
  aempEndpoints,
  CNH_ENVIRONMENTS,
  type ConnectorConfig,
  ConnectorModeError,
  cnhEndpoints,
  DEERE_EQUIPMENT_API_DEFAULT_BASE,
  DEERE_LIVE_API_BASE,
  DEERE_SANDBOX_API_BASE,
  deereEndpoints,
  deereRedirectUri,
  geotabEndpoint,
  MOTIVE_DEFAULT_BASE,
  motiveEndpoint,
  TERMINAL_LIVE_BASE,
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
    // CNH has its own connection: the AEMP stand-in serves Kubota and Samsara only.
    expect(aempEndpoints('sim', cfg).map((p) => [p.id, p.baseUrl, p.accept])).toEqual([
      ['kubota', 'http://127.0.0.1:4010/aemp/kubota', 'application/xml, application/json;q=0.9'],
      ['samsara', 'http://127.0.0.1:4010/aemp/samsara', 'application/json'],
    ]);
    expect(cnhEndpoints('sim', cfg)).toMatchObject({
      apiBase: 'http://127.0.0.1:4010/cnh/v1',
      authorizeUrl: 'http://127.0.0.1:4010/cnh/identity/authorize',
      tokenUrl: 'http://127.0.0.1:4010/cnh/identity/oauth/token',
      audience: CNH_ENVIRONMENTS.staging.audience,
      connection: 'STG-ADFS-CONN',
      environment: 'sim',
      redirectUri: 'http://localhost:3000/api/oauth/cnh',
    });
    expect(terminalEndpoint('sim', cfg)).toEqual({
      baseUrl: 'http://127.0.0.1:4010/terminal/tsp/v1',
      secretKey: SIM_CREDENTIALS.terminal.secretKey,
      connectionToken: null,
    });
    expect(deereEndpoints('sim', cfg)).toMatchObject({
      apiBase: 'http://127.0.0.1:4010/deere/platform',
      equipmentBase: 'http://127.0.0.1:4010/deere/isg',
    });
  });

  test("Deere: the portal's production host, one Equipment API host for sandbox and live", () => {
    const deere = { ...cfg, DEERE_CLIENT_ID: 'i', DEERE_CLIENT_SECRET: 's' };
    expect(deereEndpoints('sandbox', deere)).toMatchObject({
      apiBase: DEERE_SANDBOX_API_BASE,
      equipmentBase: DEERE_EQUIPMENT_API_DEFAULT_BASE,
    });
    expect(deereEndpoints('live', deere)).toMatchObject({
      apiBase: 'https://api.deere.com/platform',
      equipmentBase: 'https://equipmentapi.deere.com/isg',
      authBase: 'https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7',
    });
    expect(DEERE_LIVE_API_BASE).toBe('https://api.deere.com/platform');
    expect(
      deereEndpoints('live', {
        ...deere,
        DEERE_API_BASE: 'https://partnerapi.deere.com/platform/',
        DEERE_EQUIPMENT_API_BASE: 'https://eq.example.com/isg/',
      }),
    ).toMatchObject({
      apiBase: 'https://partnerapi.deere.com/platform',
      equipmentBase: 'https://eq.example.com/isg',
    });
    expect(deereEndpoints('replay', cfg).equipmentBase).toBe(`${REPLAY_ORIGIN}/deere/isg`);
  });

  test('replay: the replay origin, never the network; CNH has no replay mode', () => {
    expect(motiveEndpoint('replay', cfg).baseUrl).toBe(`${REPLAY_ORIGIN}/motive`);
    expect(geotabEndpoint('replay', cfg).apiUrl).toBe(`${REPLAY_ORIGIN}/geotab/apiv1`);
    expect(aempEndpoints('replay', cfg)[0]?.baseUrl).toBe(`${REPLAY_ORIGIN}/aemp/kubota`);
    expect(terminalEndpoint('replay', cfg).baseUrl).toBe(`${REPLAY_ORIGIN}/terminal/tsp/v1`);
    expect(() => cnhEndpoints('replay', cfg)).toThrow(/cnh: no replay mode/);
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
    const cnh = { ...cfg, CNH_CLIENT_ID: 'i', CNH_CLIENT_SECRET: 's', CNH_SUBSCRIPTION_KEY: 'k' };
    // Staging and production each have their own hosts, audience and connection.
    expect(cnhEndpoints('sandbox', cnh)).toMatchObject({
      apiBase: 'https://stg.api-data.cnh.com/v1',
      authorizeUrl: 'https://stg.identity.cnhind.com/authorize',
      tokenUrl: 'https://stg.identity.cnhind.com/oauth/token',
      audience: 'https://sandbox.api-data.cnh.com/',
      connection: 'STG-ADFS-CONN',
      environment: 'staging',
    });
    expect(cnhEndpoints('live', cnh)).toMatchObject({
      apiBase: 'https://api-data.cnh.com/v1',
      revokeUrl: 'https://identity.cnhind.com/oauth/revoke',
      audience: 'https://api-data.cnh.com/',
      connection: 'PROD-ADFS-CONN',
      environment: 'production',
    });
    expect(
      cnhEndpoints('live', { ...cnh, CNH_CONNECTION: 'CNHI-OPENID-CON-PROD' }).connection,
    ).toBe('CNHI-OPENID-CON-PROD');
    expect(() => terminalEndpoint('sandbox', cfg)).toThrow(/TERMINAL_SECRET_KEY/);
    // One secret key lists every hauler's connection: the token is an optional pin.
    expect(terminalEndpoint('sandbox', { ...cfg, TERMINAL_SECRET_KEY: 's' })).toEqual({
      baseUrl: TERMINAL_SANDBOX_BASE,
      secretKey: 's',
      connectionToken: null,
    });
    expect(
      terminalEndpoint('live', {
        ...cfg,
        TERMINAL_SECRET_KEY: 's',
        TERMINAL_CONNECTION_TOKEN: 'c',
      }),
    ).toMatchObject({ baseUrl: TERMINAL_LIVE_BASE, connectionToken: 'c' });
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

  test("AEMP: Deere's user grant, a subscription key next to a bearer token, Accept from format", () => {
    const live = aempEndpoints('live', {
      ...cfg,
      DEERE_CLIENT_ID: 'i',
      DEERE_CLIENT_SECRET: 's',
      AEMP_PROVIDERS: [
        {
          id: 'deere',
          baseUrl: 'https://partneraemp.deere.com',
          auth: 'deere_oauth',
          format: 'xml',
          minIntervalSeconds: 3600,
        },
        {
          id: 'cnhiso',
          baseUrl: 'https://api-data.cnh.com/v1',
          auth: 'bearer',
          token: 't',
          subscriptionKey: 'k',
          format: 'auto',
        },
        {
          id: 'samsara',
          baseUrl: 'https://api.samsara.com/beta/aemp',
          auth: 'bearer',
          token: 't',
          format: 'json',
        },
      ],
    });
    expect(live.map((p) => [p.id, p.accept, p.minIntervalSeconds, p.subscriptionKey])).toEqual([
      ['deere', 'application/xml, application/json;q=0.9', 3600, undefined],
      ['cnhiso', 'application/xml, application/json;q=0.9', 900, 'k'],
      ['samsara', 'application/json', 900, undefined],
    ]);
    // deere_oauth rides on the Deere app's grant: no app, no Deere AEMP.
    expect(() =>
      aempEndpoints('live', {
        ...cfg,
        AEMP_PROVIDERS: [
          {
            id: 'deere',
            baseUrl: 'https://partneraemp.deere.com',
            auth: 'deere_oauth',
            format: 'xml',
          },
        ],
      }),
    ).toThrow(/DEERE_CLIENT_ID is required/);
    // oauth2 with the password grant needs the user's credentials too (Trackunit v1).
    expect(() =>
      aempEndpoints('live', {
        ...cfg,
        AEMP_PROVIDERS: [
          {
            id: 'trackunit',
            baseUrl: 'https://iris.trackunit.com/public/api/aemp/v2/15143/-3',
            auth: 'oauth2',
            grantType: 'password',
            clientId: 'c',
            clientSecret: 's',
            tokenUrl: 'https://auth.example.com/token',
            format: 'auto',
          },
        ],
      }),
    ).toThrow(/needs 'username'/);
  });
});

describe('DEERE_REDIRECT_URI (decision 6)', () => {
  const live: ConnectorConfig = {
    ...cfg,
    DEERE_CLIENT_ID: 'app',
    DEERE_CLIENT_SECRET: 'secret',
  };

  test('unset: PUBLIC_URL + /api/oauth/deere in every mode', () => {
    for (const mode of ['sim', 'replay', 'sandbox', 'live'] as const) {
      expect(deereEndpoints(mode, live).redirectUri).toBe('http://localhost:3000/api/oauth/deere');
    }
    expect(deereRedirectUri({ PUBLIC_URL: 'https://farm.example/' })).toBe(
      'https://farm.example/api/oauth/deere',
    );
  });

  test('set: the authorize URL and the code exchange both send it', async () => {
    const forwarder = 'https://pages.example/deere-callback.html';
    const ep = deereEndpoints('sandbox', { ...live, DEERE_REDIRECT_URI: forwarder });
    expect(ep.redirectUri).toBe(forwarder);
    expect(new URL(deereAuthorizeUrl(ep, 'st4te')).searchParams.get('redirect_uri')).toBe(
      forwarder,
    );
    const bodies: string[] = [];
    await exchangeDeereCode(ep, 'c0de', {
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return Response.json({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });
      },
    });
    expect(new URLSearchParams(bodies[0]).get('redirect_uri')).toBe(forwarder);
    expect(new URLSearchParams(bodies[0]).get('grant_type')).toBe('authorization_code');
  });
});
