/**
 * GET and HEAD /api/v1/job-options against a real database, under every role (runWithSession):
 * 401 signed out, 200 for viewer and up with the contract's shape, no-store and the realtime
 * headers (the field panel's Jobs tab reads them); HEAD has no body; a database failure is 503.
 */
import { describe, expect, test } from 'vitest';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { ROLES, type Role } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import { jobOptionsResponseSchema } from '@/ui/work/contract';
import { JOB_FORMS_APP_ENV_HEADER, JOB_FORMS_REALTIME_HEADER } from '@/ui/work/forms/protocol';
import { handleJobOptions, handleJobOptionsHead } from './handler';

const t = setupTestDb(import.meta.url);
const cfg = () => ({ NEXT_PUBLIC_REALTIME: 'sse' as const, APP_ENV: 'test' as const });
const NOW = new Date('2026-11-06T15:00:00Z');
const as = <T>(role: Role | null, fn: () => Promise<T>) =>
  runWithSession(role === null ? null : makeSession({ role }), fn);

describe('GET /api/v1/job-options', () => {
  test('signed out: 401 JSON, no-store', async () => {
    const res = await as(null, () => handleJobOptions(t().pool, NOW, cfg));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 401 });
  });

  test('every role may read it, with the realtime headers', async () => {
    await t().pool.query(
      `insert into farm.products (kind, name, unit) values ('fuel', 'Off-road diesel', 'gal')`,
    );
    for (const role of ROLES) {
      const res = await as(role, () => handleJobOptions(t().pool, NOW, cfg));
      expect(res.status, role).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get(JOB_FORMS_REALTIME_HEADER)).toBe('sse');
      expect(res.headers.get(JOB_FORMS_APP_ENV_HEADER)).toBe('test');
      const body = jobOptionsResponseSchema.parse(await res.json());
      expect(body.products.map((p) => p.name)).toContain('Off-road diesel');
      expect(body.cropYears).toEqual([2026, 2027]);
    }
  });

  test('a database failure is a logged 503', async () => {
    const broken = {
      query: async () => {
        throw new Error('connection refused');
      },
    };
    const res = await as('viewer', () =>
      handleJobOptions(broken as unknown as Parameters<typeof handleJobOptions>[0], NOW, cfg),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'job options unavailable' });
  });
});

describe('HEAD /api/v1/job-options', () => {
  test('the headers only; signed out is refused', async () => {
    const ok = await as('viewer', () => handleJobOptionsHead(cfg));
    expect(ok.status).toBe(200);
    expect(ok.headers.get(JOB_FORMS_REALTIME_HEADER)).toBe('sse');
    expect(await ok.text()).toBe('');
    const no = await as(null, () => handleJobOptionsHead(cfg));
    expect(no.status).toBe(401);
    expect(no.headers.get(JOB_FORMS_REALTIME_HEADER)).toBeNull();
  });
});
