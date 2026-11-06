/**
 * The job board's API contract (src/ui/work/contract.ts; docs/contracts-2a.md §5): the URLs and
 * the body schemas' edges the routes and the clients rely on.
 */
import { describe, expect, test } from 'vitest';
import {
  assignJobBodySchema,
  boardSnapshotSchema,
  cancelJobBodySchema,
  createJobBodySchema,
  jobAssignmentUrl,
  jobsUrl,
  jobUrl,
  jobWindowSchema,
  reorderJobsBodySchema,
  setJobFieldBodySchema,
  setJobStatusBodySchema,
  updateJobBodySchema,
  usageHeartbeatBodySchema,
} from './contract';

const ID = '3f2b8c1e-9d4a-5b6c-8e7f-0a1b2c3d4e5f';

describe('URLs', () => {
  test('every route is under /api/v1', () => {
    expect(jobsUrl()).toBe('/api/v1/jobs');
    expect(jobsUrl({ fieldId: ID })).toBe(`/api/v1/jobs?fieldId=${ID}`);
    expect(jobUrl(ID)).toBe(`/api/v1/jobs/${ID}`);
    expect(jobAssignmentUrl(ID, ID, 3)).toBe(`/api/v1/jobs/${ID}/assignments/${ID}?version=3`);
    expect(jobAssignmentUrl(ID, ID, 3, 'machine')).toMatch(/version=3&part=machine$/);
  });
});

describe('bodies', () => {
  test('a job needs a kind; everything else is optional; unknown keys are refused', () => {
    expect(createJobBodySchema.safeParse({ kind: 'spray' }).success).toBe(true);
    expect(createJobBodySchema.safeParse({}).success).toBe(false);
    expect(createJobBodySchema.safeParse({ kind: 'mow' }).success).toBe(false);
    expect(createJobBodySchema.safeParse({ kind: 'spray', status: 'done' }).success).toBe(false);
    expect(createJobBodySchema.safeParse({ kind: 'spray', colour: 'red' }).success).toBe(false);
    const full = createJobBodySchema.parse({
      kind: 'spray',
      fieldId: ID,
      window: { from: '2026-11-06T13:00:00Z', to: '2026-11-06T22:00:00Z' },
      products: [{ productId: ID, rate: 32, unit: 'floz_ac' }],
      request: { channel: 'phone', name: '  Gail  ' },
    });
    expect(full.products?.[0]?.suppliedBy).toBe('us');
    expect(full.request?.name).toBe('Gail');
  });

  test('every write after create carries the version it saw', () => {
    expect(updateJobBodySchema.safeParse({ title: 'x' }).success).toBe(false);
    expect(updateJobBodySchema.safeParse({ version: 2, title: 'x' }).success).toBe(true);
    expect(setJobStatusBodySchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(cancelJobBodySchema.safeParse({ version: 1 }).success).toBe(true);
    expect(updateJobBodySchema.safeParse({ version: 0 }).success).toBe(false);
  });

  test('a window ends after it starts', () => {
    expect(jobWindowSchema.safeParse({ from: '2026-11-06T13:00:00Z', to: null }).success).toBe(
      true,
    );
    expect(
      jobWindowSchema.safeParse({ from: '2026-11-06T13:00:00Z', to: '2026-11-06T13:00:00Z' })
        .success,
    ).toBe(false);
  });

  test('a field by id, by the drop point, or cleared', () => {
    expect(setJobFieldBodySchema.safeParse({ version: 1, fieldId: ID }).success).toBe(true);
    expect(setJobFieldBodySchema.safeParse({ version: 1, fieldId: null }).success).toBe(true);
    expect(
      setJobFieldBodySchema.safeParse({ version: 1, at: { lng: -84.06, lat: 41.9 } }).success,
    ).toBe(true);
    expect(setJobFieldBodySchema.safeParse({ version: 1, at: { lng: -200, lat: 0 } }).success).toBe(
      false,
    );
    expect(setJobFieldBodySchema.safeParse({ version: 1 }).success).toBe(false);
  });

  test('an assignment names a machine or a person (or both)', () => {
    expect(assignJobBodySchema.safeParse({ version: 1 }).success).toBe(false);
    expect(assignJobBodySchema.safeParse({ version: 1, machineId: ID }).success).toBe(true);
    expect(assignJobBodySchema.safeParse({ version: 1, partyId: ID, machineId: ID }).success).toBe(
      true,
    );
  });

  test('reorder names one lane and at least one job; the heartbeat names its page', () => {
    expect(
      reorderJobsBodySchema.safeParse({ businessLine: 'grain', jobs: [{ id: ID, version: 1 }] })
        .success,
    ).toBe(true);
    expect(reorderJobsBodySchema.safeParse({ businessLine: 'grain', jobs: [] }).success).toBe(
      false,
    );
    expect(usageHeartbeatBodySchema.safeParse({ route: '/board' }).success).toBe(true);
    expect(usageHeartbeatBodySchema.safeParse({ route: '/admin' }).success).toBe(false);
  });
});

describe('the snapshot', () => {
  test('an empty board parses', () => {
    const empty = {
      asOf: '2026-11-06T14:30:00.000Z',
      viewer: { role: 'viewer', partyId: null, canPlan: false },
      lanes: ['spraying', 'grain', 'trucking', 'store'].map((businessLine) => ({
        businessLine,
        label: businessLine,
        jobs: [],
      })),
    };
    expect(boardSnapshotSchema.parse(empty).lanes).toHaveLength(4);
  });
});
