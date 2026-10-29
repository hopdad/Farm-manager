/**
 * HTTP Range parsing (RFC 9110 §14) for single byte ranges, which is all PMTiles and MapLibre
 * send. Pure.
 *
 *   parseRange('bytes=0-99', 1000)   → { kind: 'range', start: 0, end: 99 }
 *   parseRange('bytes=900-', 1000)   → { kind: 'range', start: 900, end: 999 }
 *   parseRange('bytes=-100', 1000)   → { kind: 'range', start: 900, end: 999 }
 *   parseRange('bytes=1000-', 1000)  → { kind: 'unsatisfiable' }      (→ 416)
 *   parseRange('items=0-1', 1000)    → { kind: 'none' }               (ignored → 200)
 *
 * Multi-range requests (`bytes=0-1,5-6`) are ignored (served whole, as RFC 9110 allows), so a
 * client never gets a multipart/byteranges body it didn't expect.
 */

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number };

const SINGLE = /^bytes=(\d*)-(\d*)$/i;

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (header == null) return { kind: 'none' };
  const m = SINGLE.exec(header.trim().replace(/\s+/g, ''));
  if (!m) return { kind: 'none' };
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return { kind: 'none' };
  if (a === '') {
    // Suffix range: the last n bytes.
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return { kind: 'none' };
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return { kind: 'none' };
  const last = b === '' ? Number.POSITIVE_INFINITY : Number(b);
  if (b !== '' && !Number.isSafeInteger(last)) return { kind: 'none' };
  if (last < start) return { kind: 'none' }; // invalid range-spec: ignore the header
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end: Math.min(last, size - 1) };
}

/** `Content-Range` value for a satisfied range. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** `Content-Range` value for a 416 response. */
export function unsatisfiedRange(size: number): string {
  return `bytes */${size}`;
}
