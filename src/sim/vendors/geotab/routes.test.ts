/**
 * The MyGeotab stand-in on its own (the demo world, a frozen wall clock): JSON-RPC over POST
 * /apiv1, errors as HTTP 200 with `error.data.type`, `userName` (not `username`) on the wire,
 * one version counter per entity type, "from now" without a fromVersion, the session cap, and
 * the control knobs. The client's view of it is src/connectors/geotab/geotab.contract.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  geotabFeedResultSchema,
  geotabLoginResultSchema,
  geotabStatusDataSchema,
} from '../../../connectors/geotab/schemas';
import { createSimWorld } from '../../index';
import { SIM_CREDENTIALS } from '../../types';
import { startVendorSim, type VendorSim } from '../server';
import {
  GEOTAB_SIM_FAULTS_PATH,
  GEOTAB_SIM_SERVER_PATH,
  GEOTAB_SIM_STATUS_PATH,
  type GeotabSimStatus,
} from './control-types';
import { GEOTAB_SIM_VERSION } from './routes';

let wall = Date.parse('2026-10-15T14:00:02.000Z');
let sim: VendorSim;
const creds = SIM_CREDENTIALS.geotab;

const rpc = async (body: unknown, path = '/apiv1', method = 'POST') => {
  const res = await fetch(`${sim.url}/geotab${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: (await res.json()) as {
      result?: unknown;
      error?: { data: { type: string }; message: string };
    },
  };
};
const login = async () => {
  const r = await rpc({
    method: 'Authenticate',
    params: { database: creds.database, userName: creds.username, password: creds.password },
  });
  const c = geotabLoginResultSchema.parse(r.body.result).credentials;
  return { database: c.database, userName: c.userName, sessionId: c.sessionId };
};
const knob = async (path: string, body?: unknown) => {
  const res = await fetch(`${sim.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as GeotabSimStatus };
};

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
});
afterAll(() => sim.close());
beforeEach(() => {
  wall += 3_600_000;
  sim.control.reset({ scenario: 'harvest-day' });
});

describe('MyGeotab stand-in', () => {
  test('GetVersion needs no credentials; the id is echoed; unknown methods and paths', async () => {
    expect((await rpc({ method: 'GetVersion', id: 7 })).body).toEqual({
      result: GEOTAB_SIM_VERSION,
      jsonrpc: '2.0',
      id: 7,
    });
    const missing = await rpc({ method: 'ExecuteMultiCall', params: {} });
    expect(missing.status).toBe(200);
    expect(missing.body.error?.data.type).toBe('MissingMethodException');
    expect((await rpc(null, '/apiv2')).body.error?.data.type).toBe('MissingMethodException');
  });

  test('Authenticate: `userName` on the wire, else InvalidUserException with HTTP 200', async () => {
    const wrong = await rpc({
      method: 'Authenticate',
      params: { database: creds.database, username: creds.username, password: creds.password },
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body.error).toMatchObject({
      message: 'Incorrect login credentials',
      data: { type: 'InvalidUserException' },
    });
    const ok = await rpc({
      method: 'Authenticate',
      params: { database: creds.database, userName: creds.username, password: creds.password },
    });
    expect(geotabLoginResultSchema.parse(ok.body.result).path).toBe('ThisServer');
    const noSession = await rpc({ method: 'GetFeed', params: { typeName: 'LogRecord' } });
    expect(noSession.body.error).toMatchObject({ data: { type: 'InvalidUserException' } });
    expect(noSession.body.error?.message).toBe(`Invalid session @ '${creds.database}'`);
  });

  test('Authenticate 10 a minute, then OverLimitException with Retry-After; 100 sessions at most', async () => {
    for (let i = 0; i < 10; i++) await login();
    const over = await rpc({
      method: 'Authenticate',
      params: { database: creds.database, userName: creds.username, password: creds.password },
    });
    expect(over.body.error?.data.type).toBe('OverLimitException');
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      wall += 61_000;
      for (let k = 0; k < 10; k++) await login();
    }
    expect((await knob(GEOTAB_SIM_STATUS_PATH)).body.sessions).toBe(100);
  });

  test('GetFeed: from now, then each entity on its own counter; every diagnostic in StatusData', async () => {
    const credentials = await login();
    const feed = async (typeName: string, fromVersion?: string) =>
      geotabFeedResultSchema.parse(
        (await rpc({ method: 'GetFeed', params: { typeName, fromVersion, credentials } })).body
          .result,
      );
    const log0 = await feed('LogRecord');
    const sd0 = await feed('StatusData');
    expect(log0.data).toEqual([]);
    expect(log0.toVersion).not.toBe(sd0.toVersion);
    wall += 60_000;
    const logs = await feed('LogRecord', log0.toVersion as string);
    expect(logs.data).toHaveLength(12); // 60 s of 5 s instants, one device
    const sds = await feed('StatusData', sd0.toVersion as string);
    const ids = sds.data.map((d) => geotabStatusDataSchema.parse(d).diagnostic.id).sort();
    expect(ids).toEqual(
      [
        'DiagnosticEngineCoolantTemperatureId',
        'DiagnosticEngineHoursId',
        'DiagnosticEngineSpeedId',
        'DiagnosticFuelLevelId',
        'DiagnosticIgnitionId',
        'DiagnosticOdometerId',
      ].sort(),
    );
    expect((await feed('FaultData')).data).toEqual([]);
  });

  test('knobs: faults raise → clear, the login path, the scope, session expiry; bad bodies', async () => {
    const raised = await knob(GEOTAB_SIM_FAULTS_PATH, { action: 'raise', kind: 'oem' });
    expect(raised.body.faults).toEqual([
      expect.objectContaining({ kind: 'oem', state: 'Active', seq: 1 }),
    ]);
    const cleared = await knob(GEOTAB_SIM_FAULTS_PATH, {
      action: 'clear',
      id: raised.body.faults[0]?.id,
    });
    expect(cleared.body.faults.map((f) => f.state)).toEqual(['Active', 'Inactive']);
    expect((await knob(GEOTAB_SIM_FAULTS_PATH, { action: 'clear', id: 'nope' })).status).toBe(404);
    const credentials = await login();
    await knob(GEOTAB_SIM_SERVER_PATH, { loginPath: null, limitedScope: true });
    const limited = await rpc({
      method: 'GetFeed',
      params: { typeName: 'StatusData', credentials },
    });
    expect(limited.body.error?.data.type).toBe('ArgumentException');
    const login2 = await rpc({
      method: 'Authenticate',
      params: { database: creds.database, userName: creds.username, password: creds.password },
    });
    expect(geotabLoginResultSchema.parse(login2.body.result).path).toBeUndefined();
    await knob(GEOTAB_SIM_SERVER_PATH, { expireSessions: true });
    const gone = await rpc({ method: 'Get', params: { typeName: 'Device', credentials } });
    expect(gone.body.error?.data.type).toBe('InvalidUserException');
    expect((await knob(GEOTAB_SIM_SERVER_PATH, { loginPath: 'not a host!' })).status).toBe(400);
    expect((await knob('/_control/vendor/geotab/nope', {})).status).toBe(404);
  });
});
