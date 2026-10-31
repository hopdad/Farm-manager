/** The pure parts of the connectors read model: the stream notes (1f merge). */
import { describe, expect, test } from 'vitest';
import { streamNotes } from './data';

describe('streamNotes', () => {
  test("CNH's EULA list, AEMP provider errors and notes, Geotab's limited scope", () => {
    expect(
      streamNotes({
        needsEula: [{ vin: 'YJG12345678', reason: 'EULA not accepted for the VIN', at: 'x' }],
        needsEulaCount: 1,
      }),
    ).toEqual([
      "VIN YJG12345678 skipped: EULA not accepted for the VIN (accept CNH's EULA for it in FieldOps)",
    ]);
    expect(
      streamNotes({
        providers: {
          kubota: { polledAt: 'x', error: null, note: null },
          deere: { polledAt: null, error: null, note: 'approve the org at https://x' },
          trackunit: { polledAt: null, error: 'HTTP 401', note: null },
        },
        providerErrors: 1,
      }),
    ).toEqual(['deere: approve the org at https://x', 'trackunit: HTTP 401']);
    expect(streamNotes({ scopeFallback: 1 })[0]).toMatch(/limited-scope user/);
    expect(streamNotes({ scopeFallback: 0 })).toEqual([]);
  });

  test('anything else is ignored, and a long list is cut', () => {
    expect(streamNotes(null)).toEqual([]);
    expect(streamNotes({ needsEula: 'x', providers: [1], calls: 3 })).toEqual([]);
    const many = streamNotes({
      needsEula: Array.from({ length: 9 }, (_, i) => ({ vin: `V${i}`, reason: 'r' })),
    });
    expect(many).toHaveLength(7);
    expect(many[6]).toBe('and 3 more');
  });
});
