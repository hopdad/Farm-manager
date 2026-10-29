/** `pnpm auth:*` argument parsing. */
import { describe, expect, test } from 'vitest';
import { parseAuthArgs, UsageError } from './cli';

describe('parseAuthArgs', () => {
  test('the three commands', () => {
    expect(parseAuthArgs(['reset-owner'])).toEqual({
      command: 'reset-owner',
      base: null,
      off: false,
    });
    expect(parseAuthArgs(['links', '--base=http://192.168.1.50:3000'])).toEqual({
      command: 'links',
      base: 'http://192.168.1.50:3000',
      off: false,
    });
    expect(parseAuthArgs(['demo-people', '--off'])).toEqual({
      command: 'demo-people',
      base: null,
      off: true,
    });
  });

  test('usage errors', () => {
    for (const argv of [
      [],
      ['nope'],
      ['links', 'extra'],
      ['links', '--off'],
      ['links', '--base=nope'],
      ['--help'],
      ['links', '--pin=1234'],
    ]) {
      expect(() => parseAuthArgs(argv), argv.join(' ')).toThrow(UsageError);
    }
  });
});
