import { describe, expect, test } from 'vitest';
import { fieldKey, fieldsToCheck, parseOpsCursor, REFUSED_TTL_MS } from './poll';

describe('parseOpsCursor', () => {
  test('a fresh cursor for nothing, garbage or another version', () => {
    const fresh = { v: 1, checked: {}, refused: {} };
    expect(parseOpsCursor(null)).toEqual(fresh);
    expect(parseOpsCursor('not json')).toEqual(fresh);
    expect(parseOpsCursor('"2026-10-31T00:00:00Z"')).toEqual(fresh); // a locations-style cursor
    expect(parseOpsCursor(JSON.stringify({ v: 2, checked: { a: 'x' } }))).toEqual(fresh);
  });

  test('keeps string entries only', () => {
    const c = parseOpsCursor(
      JSON.stringify({
        v: 1,
        checked: { 'o|f': '2026-10-31T00:00:00.000Z', bad: 3 },
        refused: null,
      }),
    );
    expect(c).toEqual({ v: 1, checked: { 'o|f': '2026-10-31T00:00:00.000Z' }, refused: {} });
  });
});

describe('fieldsToCheck', () => {
  const f = (orgId: string, fieldId: string) => ({ orgId, fieldId });
  const all = [f('org-b', 'f1'), f('org-a', 'f2'), f('org-a', 'f1'), f('org-a', 'f3')];

  test('never-checked first (org, field order), then the ones checked longest ago', () => {
    const checked = {
      [fieldKey('org-a', 'f1')]: '2026-10-31T10:00:00.000Z',
      [fieldKey('org-a', 'f3')]: '2026-10-31T09:00:00.000Z',
    };
    expect(fieldsToCheck(all, checked, null)).toEqual([
      f('org-a', 'f2'),
      f('org-b', 'f1'),
      f('org-a', 'f3'),
      f('org-a', 'f1'),
    ]);
    expect(fieldsToCheck(all, checked, 2)).toEqual([f('org-a', 'f2'), f('org-b', 'f1')]);
    expect(fieldsToCheck(all, checked, 0)).toEqual([]);
  });

  test('a refusal is trusted for a week', () => {
    expect(REFUSED_TTL_MS).toBe(7 * 86_400_000);
  });
});
