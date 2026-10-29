import { describe, expect, test } from 'vitest';
import { breadcrumbStepMs } from './routes';

describe('Deere breadcrumb spacing', () => {
  test('10 s of wall time at 1x (or paused, or slower)', () => {
    expect(breadcrumbStepMs(10_000, 1)).toBe(10_000);
    expect(breadcrumbStepMs(10_000, 0.5)).toBe(10_000);
  });
  test('about 10 s of sim time when sped up, whole wall seconds, at least one second', () => {
    expect(breadcrumbStepMs(10_000, 2)).toBe(5_000);
    expect(breadcrumbStepMs(10_000, 3)).toBe(3_000);
    expect(breadcrumbStepMs(10_000, 5)).toBe(2_000);
    expect(breadcrumbStepMs(10_000, 30)).toBe(1_000);
    expect(breadcrumbStepMs(10_000, 3600)).toBe(1_000);
  });
});
