/**
 * usage.prune's cutoff (decision 2a-11; docs/contracts-2a.md §7.7): the first farm day kept is
 * today's farm date minus USAGE_RETENTION_DAYS (400), by calendar date, so neither the evening
 * (a UTC date ahead) nor the DST change moves it. The batched delete is in
 * src/db/queries/usage.db.test.ts.
 */
import { describe, expect, test } from 'vitest';
import { USAGE_RETENTION_DAYS } from '../domain/work-jobs';
import { usageRetentionCutoff } from './usage-prune';

describe('usageRetentionCutoff', () => {
  test(`${USAGE_RETENTION_DAYS} farm days before today`, () => {
    expect(USAGE_RETENTION_DAYS).toBe(400);
    expect(usageRetentionCutoff(new Date('2026-11-06T15:00:00Z'))).toBe('2025-10-02');
  });

  test("the farm's date, not UTC's: 03:00 UTC is still the evening before in Michigan", () => {
    expect(usageRetentionCutoff(new Date('2026-11-07T03:00:00Z'))).toBe('2025-10-02');
    expect(usageRetentionCutoff(new Date('2026-11-07T07:23:00Z'))).toBe('2025-10-03');
  });

  test('over a leap day', () => {
    expect(usageRetentionCutoff(new Date('2028-04-05T16:00:00Z'))).toBe('2027-03-02');
  });
});
