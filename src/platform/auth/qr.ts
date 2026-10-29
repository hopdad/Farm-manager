/**
 * A small QR code encoder for enrollment links (pure TS, no dependency): byte mode, error
 * correction level M (15 % of the symbol may be damaged), versions 1-20 (up to 666 bytes; an
 * enrollment link is about 60), automatic mask choice. A cab iPad's camera opens the link
 * without anyone typing.
 *
 * The algorithm follows ISO/IEC 18004 as laid out in Project Nayuki's reference
 * implementation (https://www.nayuki.io/page/qr-code-generator-library, MIT): data and
 * Reed-Solomon codewords interleaved per block, function patterns, the zigzag placement, the
 * eight masks scored by the standard penalty rules, BCH-coded format and version information.
 */

/** Error correction codewords per block, level M, by version (index 0 unused). */
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
/** Number of error correction blocks, level M, by version. */
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
export const QR_MAX_VERSION = 20;
/** Level M's 2-bit format indicator (L=1, M=0, Q=3, H=2). */
const ECL_M_FORMAT_BITS = 0;

export interface QrCode {
  version: number;
  /** Modules per side (without the quiet zone). */
  size: number;
  mask: number;
  /** modules[y][x]: true = dark. */
  modules: boolean[][];
}

// ---------------------------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------------------------

/** Data + EC modules of a version (everything but function patterns and format/version info). */
export function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords at level M. */
export function dataCodewordsM(ver: number): number {
  return (
    Math.floor(rawDataModules(ver) / 8) -
    (ECC_PER_BLOCK_M[ver] as number) * (BLOCKS_M[ver] as number)
  );
}

// ---------------------------------------------------------------------------------------------
// Reed-Solomon over GF(2^8), polynomial 0x11D
// ---------------------------------------------------------------------------------------------

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial of `degree` (coefficients, highest first, leading 1 dropped). */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error correction codewords of `data` for `divisor`. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Codewords
// ---------------------------------------------------------------------------------------------

/** Byte-mode data codewords (mode, count, data, terminator, padding) for a version. */
export function dataCodewords(bytes: Uint8Array, ver: number): number[] {
  const capacityBits = dataCodewordsM(ver) * 8;
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  if (bits.length > capacityBits) throw new RangeError('data too long for this version');
  put(0, Math.min(4, capacityBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] as number);
    out.push(v);
  }
  return out;
}

/** Split into blocks, add each block's EC codewords, interleave. */
export function interleave(data: readonly number[], ver: number): number[] {
  const numBlocks = BLOCKS_M[ver] as number;
  const eccLen = ECC_PER_BLOCK_M[ver] as number;
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(block[i] as number);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------------------------

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** 15-bit format information (level M) for a mask. */
export function formatBits(mask: number): number {
  const data = (ECL_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions 7 and up). */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

class QrSymbol {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  private setFn(x: number, y: number, dark: boolean): void {
    (this.modules[y] as boolean[])[x] = dark;
    (this.isFunction[y] as boolean[])[x] = true;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    pos.forEach((a, i) => {
      pos.forEach((b, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        this.alignment(a, b);
      });
    });
    this.drawFormat(0); // reserves the area; redrawn with the chosen mask
    if (this.version >= 7) {
      const v = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFn(a, b, bit(v, i));
        this.setFn(b, a, bit(v, i));
      }
    }
  }

  private finder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private alignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFn(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormat(mask: number): void {
    const bits = formatBits(mask);
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(bits, i));
    this.setFn(8, 7, bit(bits, 6));
    this.setFn(8, 8, bit(bits, 7));
    this.setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFn(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFn(8, n - 15 + i, bit(bits, i));
    this.setFn(8, n - 8, true); // the dark module
  }

  drawCodewords(codewords: readonly number[]): void {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!(this.isFunction[y] as boolean[])[x] && i < codewords.length * 8) {
            (this.modules[y] as boolean[])[x] = bit(codewords[i >>> 3] as number, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if ((this.isFunction[y] as boolean[])[x]) continue;
        if (maskHit(mask, x, y)) {
          (this.modules[y] as boolean[])[x] = !(this.modules[y] as boolean[])[x];
        }
      }
    }
  }
}

export function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError('mask 0-7');
  }
}

/** The standard penalty score (lower reads more reliably). */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const n = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) {
    lines.push([...(modules[i] as boolean[])]);
    lines.push(modules.map((row) => row[i] as boolean));
  }
  const finderLike = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  for (const line of lines) {
    // N1: runs of five or more of one color.
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // N3: 1:1:3:1:1 finder look-alikes with four light modules on one side (outside is light).
    const padded = [false, false, false, false, ...line, false, false, false, false];
    for (let i = 0; i + 11 <= padded.length; i++) {
      for (const pat of finderLike) {
        if (pat.every((v, k) => padded[i + k] === v)) score += 40;
      }
    }
  }
  // N2: 2x2 blocks of one color.
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = (modules[y] as boolean[])[x];
      if (
        c === (modules[y] as boolean[])[x + 1] &&
        c === (modules[y + 1] as boolean[])[x] &&
        c === (modules[y + 1] as boolean[])[x + 1]
      ) {
        score += 3;
      }
    }
  }
  // N4: balance of dark and light.
  const dark = modules.reduce((s, row) => s + row.filter(Boolean).length, 0);
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode `text` (UTF-8 bytes) in the smallest version that holds it. */
export function encodeQr(text: string, opts: { mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (needBits <= dataCodewordsM(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new RangeError(`text too long for a QR code here (${bytes.length} bytes)`);
  const sym = new QrSymbol(version);
  sym.drawFunctionPatterns();
  sym.drawCodewords(interleave(dataCodewords(bytes, version), version));
  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 8; m++) {
      sym.applyMask(m);
      sym.drawFormat(m);
      const p = penalty(sym.modules);
      if (p < best) {
        best = p;
        mask = m;
      }
      sym.applyMask(m); // XOR again: undo
    }
  }
  sym.applyMask(mask);
  sym.drawFormat(mask);
  return { version, size: sym.size, mask, modules: sym.modules };
}

/**
 * An SVG path (one `M x y h1 v1 h-1 z` square per dark module, merged per row run) with a
 * four-module quiet zone, plus the viewBox size: `<svg viewBox="0 0 {size} {size}"><path d=…/>`.
 */
export function qrSvgPath(text: string): { size: number; path: string } {
  const qr = encodeQr(text);
  const border = 4;
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && row[x]) x++;
      parts.push(`M${start + border} ${y + border}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size: qr.size + border * 2, path: parts.join('') };
}
