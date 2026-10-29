/**
 * Deterministic randomness for the simulated world. Every random draw comes from an `Rng` seeded
 * by `hash32(worldSeed, ...labels)`, so each purpose (field placement, landlord names, the queue
 * at one elevator, ...) has its own stream: adding a draw in one place never shifts another.
 *
 * Pure TS, no dependencies, identical on every platform (integer math + Math.imul).
 */

/** 32-bit FNV-1a over the labels (joined with NUL), finished with murmur3's fmix32 avalanche. */
export function hash32(...parts: readonly (string | number)[]): number {
  let h = 0x811c9dc5;
  const text = parts.map(String).join('\u0000');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for a simulation (not for anything secret). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('Rng.pick: empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Fisher-Yates shuffle of a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** An independent stream for one purpose: `rngFor(seed, 'fields', 'adrian')`. */
export function rngFor(seed: number, ...labels: readonly (string | number)[]): Rng {
  return new Rng(hash32(seed, ...labels));
}
