import { describe, expect, test } from 'vitest';
import { contentRange, parseRange, unsatisfiedRange } from './range';

describe('parseRange', () => {
  const size = 1000;
  test.each([
    ['bytes=0-99', { kind: 'range', start: 0, end: 99 }],
    ['bytes=0-0', { kind: 'range', start: 0, end: 0 }],
    ['bytes=900-', { kind: 'range', start: 900, end: 999 }],
    ['bytes=900-5000', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-100', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-5000', { kind: 'range', start: 0, end: 999 }],
    ['BYTES=1-2', { kind: 'range', start: 1, end: 2 }],
    [' bytes = 1 - 2 ', { kind: 'range', start: 1, end: 2 }],
    ['bytes=999-999', { kind: 'range', start: 999, end: 999 }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  test.each([['bytes=1000-'], ['bytes=1000-1001'], ['bytes=-0']])(
    '%s is unsatisfiable',
    (header) => {
      expect(parseRange(header, size)).toEqual({ kind: 'unsatisfiable' });
    },
  );

  test.each([
    [null],
    [undefined],
    [''],
    ['bytes='],
    ['bytes=-'],
    ['items=0-1'],
    ['bytes=5-1'],
    ['bytes=0-1,5-6'],
    ['bytes=abc-def'],
    ['bytes=99999999999999999999-'],
  ])('%s is ignored', (header) => {
    expect(parseRange(header, size)).toEqual({ kind: 'none' });
  });

  test('any range of an empty object is unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  test('Content-Range values', () => {
    expect(contentRange(0, 99, 1000)).toBe('bytes 0-99/1000');
    expect(unsatisfiedRange(1000)).toBe('bytes */1000');
  });
});
