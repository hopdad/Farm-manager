/**
 * What a faults stream's mode change does to its source's codes (1f review round 2): only a
 * different account closes them for good; off suspends them, and the same mode coming back
 * resumes them. The DB side is in src/db/queries/machine-faults.db.test.ts and the job side in
 * src/connectors/geotab/fleet-geotab.db.test.ts.
 */
import { describe, expect, test } from 'vitest';
import { faultsModeAction } from './fleet-shared';

describe('faultsModeAction', () => {
  test('turning a stream off suspends its codes, whatever mode it ran in', () => {
    for (const from of ['sim', 'replay', 'sandbox', 'live'] as const) {
      expect(faultsModeAction({ from, to: 'off' }, null)).toBe('suspend');
      expect(faultsModeAction({ from, to: 'off' }, from)).toBe('suspend');
    }
  });

  test('back on in the mode it was turned off from resumes them', () => {
    for (const to of ['sim', 'replay', 'sandbox', 'live'] as const) {
      expect(faultsModeAction({ from: 'off', to }, to)).toBe('resume');
    }
  });

  test('another account closes them for good (and an unknown one counts as another)', () => {
    expect(faultsModeAction({ from: 'off', to: 'live' }, 'sim')).toBe('switch');
    expect(faultsModeAction({ from: 'off', to: 'live' }, null)).toBe('switch');
    expect(faultsModeAction({ from: 'sim', to: 'live' }, 'sim')).toBe('switch');
    expect(faultsModeAction({ from: 'replay', to: 'sim' }, null)).toBe('switch');
    expect(faultsModeAction({ from: 'sandbox', to: 'live' }, 'sandbox')).toBe('switch');
  });
});
