/**
 * The QR encoder against published reference values (ISO/IEC 18004 tables and worked examples)
 * and structural invariants. During development every symbol here was also decoded by an
 * independent reader (zxing-cpp) for versions 1-20 and all eight masks.
 */
import { describe, expect, test } from 'vitest';
import {
  alignmentPositions,
  dataCodewords,
  dataCodewordsM,
  encodeQr,
  formatBits,
  gfMultiply,
  penalty,
  QR_MAX_VERSION,
  qrSvgPath,
  rawDataModules,
  rsDivisor,
  rsRemainder,
  versionBits,
} from './qr';

describe('reference values', () => {
  test('Reed-Solomon: the "HELLO WORLD" 1-Q example codewords', () => {
    // thonky.com QR tutorial, error correction coding: 13 data codewords, 13 EC codewords.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
    expect(rsRemainder(data, rsDivisor(13))).toEqual([
      168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16,
    ]);
  });

  test('GF(256) arithmetic', () => {
    expect(gfMultiply(0, 7)).toBe(0);
    expect(gfMultiply(1, 0x53)).toBe(0x53);
    expect(gfMultiply(2, 0x80)).toBe(0x1d);
  });

  test('format information (level M) and version information (BCH)', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits(5).toString(2).padStart(15, '0')).toBe('100000011001110');
    expect(formatBits(7).toString(2).padStart(15, '0')).toBe('100101010100000');
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
    expect(versionBits(20).toString(2).padStart(18, '0')).toBe('010100100110100110');
  });

  test('capacities at level M (codewords) and alignment pattern centres', () => {
    const want: Record<number, number> = {
      1: 16,
      2: 28,
      3: 44,
      4: 64,
      5: 86,
      7: 124,
      10: 216,
      14: 365,
      20: 669,
    };
    for (const [v, n] of Object.entries(want)) expect(dataCodewordsM(Number(v))).toBe(n);
    expect(Math.floor(rawDataModules(1) / 8)).toBe(26);
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66]);
  });

  test('byte-mode data codewords: mode, count, data, terminator, 0xEC/0x11 padding', () => {
    expect(dataCodewords(new TextEncoder().encode('A'), 1)).toEqual([
      0x40, 0x14, 0x10, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
      0xec,
    ]);
  });
});

describe('symbols', () => {
  test('an enrollment link: the smallest version, finder patterns, timing, dark module', () => {
    const qr = encodeQr('http://192.168.1.50:3000/enroll?code=K7QD2M9XPA');
    expect(qr.version).toBe(4);
    expect(qr.size).toBe(33);
    const m = qr.modules;
    for (const [x0, y0] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ] as const) {
      for (let d = 0; d < 7; d++) {
        expect(m[y0]?.[x0 + d]).toBe(true); // finder's top edge
        expect(m[y0 + d]?.[x0]).toBe(true); // and left edge
      }
      expect(m[y0 + 3]?.[x0 + 3]).toBe(true); // centre
      expect(m[y0 + 1]?.[x0 + 1]).toBe(false); // light ring
    }
    for (let i = 8; i < qr.size - 8; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0);
      expect(m[i]?.[6]).toBe(i % 2 === 0);
    }
    expect(m[qr.size - 8]?.[8]).toBe(true);
  });

  test('the chosen mask has the lowest penalty of all eight', () => {
    const text = 'http://localhost:3000/enroll?code=ABCDE12345';
    const best = encodeQr(text);
    for (let mask = 0; mask < 8; mask++) {
      expect(penalty(best.modules)).toBeLessThanOrEqual(penalty(encodeQr(text, { mask }).modules));
    }
  });

  test('grows with the data, up to version 20', () => {
    // Byte capacity at level M: version 6 holds 106 bytes, version 7 122 (ISO/IEC 18004 table 7).
    expect(encodeQr('x'.repeat(106)).version).toBe(6);
    expect(encodeQr('x'.repeat(107)).version).toBe(7);
    expect(encodeQr('x'.repeat(666)).version).toBe(QR_MAX_VERSION);
    expect(() => encodeQr('x'.repeat(667))).toThrow(RangeError);
  });

  test('SVG path: a quiet zone of 4 and one run per dark stretch', () => {
    const { size, path } = qrSvgPath('HELLO');
    expect(size).toBe(21 + 8);
    expect(path.startsWith('M4 4h7v1h-7z')).toBe(true); // the top-left finder's first row
    expect(path).not.toMatch(/[^-Mhvz0-9 ]/);
  });
});
