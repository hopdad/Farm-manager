/** The test builders produce what the contract's schemas accept (so mocks never drift). */
import { describe, expect, test } from 'vitest';
import { boardSnapshotSchema, jobOptionsResponseSchema, jobViewSchema } from '../contract';
import { makeJobOptions, makeJobView, makeSnapshot } from './fixtures';

describe('fixtures', () => {
  test('match the contract', () => {
    expect(jobViewSchema.safeParse(makeJobView()).success).toBe(true);
    expect(jobOptionsResponseSchema.safeParse(makeJobOptions()).success).toBe(true);
    const snap = makeSnapshot([
      makeJobView(),
      makeJobView({ kind: 'haul', id: crypto.randomUUID() }),
    ]);
    expect(boardSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.lanes.map((l) => [l.businessLine, l.jobs.length])).toEqual([
      ['spraying', 1],
      ['grain', 0],
      ['trucking', 1],
      ['store', 0],
    ]);
  });
});
