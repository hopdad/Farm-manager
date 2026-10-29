/**
 * The stand-in control client against a fake stand-in speaking the contract types
 * (src/sim/types.ts): paths, bodies, error mapping, and the fault presets.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FaultRule, SimStatus } from '../../../sim/types';
import {
  faultPresets,
  getSimStatus,
  SimControlError,
  simClock,
  simFaults,
  simReset,
  simScenario,
} from './sim-control';

const status: SimStatus = {
  clock: {
    anchorWall: '2026-10-29T12:00:00.000Z',
    anchorSim: '2026-10-15T11:00:00.000Z',
    speed: 1,
    paused: false,
    simNow: '2026-10-15T11:00:00.000Z',
    wallNow: '2026-10-29T12:00:00.000Z',
  },
  scenario: { scenario: 'harvest-day', seed: 1, startsAt: '2026-10-15T11:00:00.000Z' },
  faults: { rules: [], scenarioRules: [] },
};

const requests: { method: string; url: string; body: unknown }[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      const send = (code: number, value: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/_control/status') return send(200, status);
      if (req.url === '/_control/clock') {
        if (body.action === 'speed' && body.speed > 3600)
          return send(400, { error: 'speed too high' });
        return send(200, {
          ...status.clock,
          paused: body.action === 'pause',
          speed: body.speed ?? 1,
        });
      }
      if (req.url === '/_control/scenario')
        return send(200, { ...status.scenario, scenario: body.scenario });
      if (req.url === '/_control/faults') {
        const rules: FaultRule[] = body.action === 'add' ? [{ ...body.rule }] : [];
        return send(200, { rules, scenarioRules: [] });
      }
      if (req.url === '/_control/reset') return send(200, status);
      if (req.url === '/_control/text') {
        res.writeHead(200);
        return res.end('not json');
      }
      send(404, { error: 'no such path' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('control API client', () => {
  test('GET status and POST clock/scenario/faults/reset with the contract bodies', async () => {
    requests.length = 0;
    expect(await getSimStatus(base)).toEqual(status);
    expect((await simClock(base, { action: 'pause' })).paused).toBe(true);
    expect((await simClock(base, { action: 'speed', speed: 30 })).speed).toBe(30);
    expect((await simScenario(base, { scenario: 'spray-windy' })).scenario).toBe('spray-windy');
    const preset = faultPresets('samsara')[0];
    if (!preset) throw new Error('no presets');
    const f = await simFaults(base, { action: 'add', rule: { id: preset.id, ...preset.rule } });
    expect(f.rules[0]).toMatchObject({
      id: 'admin-trucks-down',
      vendor: 'samsara',
      kind: 'outage',
    });
    await simReset(`${base}/`, { clearFaults: true });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /_control/status',
      'POST /_control/clock',
      'POST /_control/clock',
      'POST /_control/scenario',
      'POST /_control/faults',
      'POST /_control/reset',
    ]);
    expect(requests[2]?.body).toEqual({ action: 'speed', speed: 30 });
    expect(requests[4]?.body).toEqual({
      action: 'add',
      rule: {
        id: 'admin-trucks-down',
        vendor: 'samsara',
        kind: 'outage',
        label: 'trucks API down',
      },
    });
    expect(requests[5]?.body).toEqual({ clearFaults: true });
  });

  test('HTTP errors carry the status and the stand-in message', async () => {
    const err = await simClock(base, { action: 'speed', speed: 9999 }).catch((e) => e);
    expect(err).toBeInstanceOf(SimControlError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/HTTP 400 speed too high/);
  });

  test('an unreachable stand-in says so', async () => {
    const err = await getSimStatus('http://127.0.0.1:9', { timeoutMs: 1_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(SimControlError);
    expect(err.message).toMatch(/not reachable at http:\/\/127\.0\.0\.1:9/);
    expect(err.status).toBeNull();
  });
});

describe('fault presets', () => {
  test("'trucks API down' is the contract's rule, for the configured ELD vendor", () => {
    const down = faultPresets('samsara').find((p) => p.key === 'trucks-down');
    expect(down?.rule).toEqual({ vendor: 'samsara', kind: 'outage', label: 'trucks API down' });
    expect(faultPresets('motive').find((p) => p.key === 'trucks-down')?.rule.vendor).toBe('motive');
  });

  test('ids are unique and stable', () => {
    const ids = faultPresets('samsara').map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('admin-'))).toBe(true);
  });
});
