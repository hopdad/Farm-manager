/** The pure parts of the sync-health read model. */
import { describe, expect, test } from 'vitest';
import type { JobRegistry } from '../../../jobs/types';
import { scheduleSeconds, terminalProvidersOf, unmappedKindsOf } from './health';

const run = async () => ({ items: 0 });

describe('scheduleSeconds', () => {
  const at = new Date('2026-10-31T12:00:30Z');
  test('every and cron schedules; unknown or bad = null', () => {
    const r: JobRegistry = {
      a: { every: '30 seconds', run },
      b: { cron: '*/2 * * * *', run },
      c: { cron: '17 * * * *', run },
      d: { cron: 'not a cron', run },
    };
    expect(scheduleSeconds(r.a, at)).toBe(30);
    expect(scheduleSeconds(r.b, at)).toBe(120);
    expect(scheduleSeconds(r.c, at)).toBe(3600);
    expect(scheduleSeconds(r.d, at)).toBeNull();
    expect(scheduleSeconds(undefined, at)).toBeNull();
  });
});

describe('extra readers', () => {
  test('unmappedKinds keeps numeric counts only', () => {
    expect(unmappedKindsOf({ unmappedKinds: { Gator: 2, Loader: 1, Bad: 'x' } })).toEqual({
      Gator: 2,
      Loader: 1,
    });
    expect(unmappedKindsOf({ unmappedKinds: [1] })).toEqual({});
    expect(unmappedKindsOf(null)).toEqual({});
  });

  test("Terminal's provider rows: rows with a code and capabilities", () => {
    const row = {
      code: 'omnitracs-xrs',
      label: 'Omnitracs XRS',
      vendorId: 'terminal_omnitracs_xrs',
      capabilities: { positions: { live: 'yes', lastKnown: 'yes' } },
    };
    expect(terminalProvidersOf({ providers: [row, { code: 1 }, null] })).toEqual([row]);
    expect(terminalProvidersOf({})).toEqual([]);
  });
});
