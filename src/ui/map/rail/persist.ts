/**
 * The layer rail remembers its choices per device (plan 1d; contracts-m1 §7.2: "the rail may
 * persist them"): which layers are on or off, how a layer with modes is drawn (the soils layer's
 * colour-by mode, ./modes.ts) and whether the rail is open, in localStorage, one entry per
 * variant. The wall kiosk keeps its own browser profile, so "the wall remembers".
 *
 * localStorage can be missing or throw (private mode, a locked-down kiosk profile, storage full,
 * SecurityError on access): every access is wrapped, a bad or foreign value reads as "nothing
 * saved", and a failed save is reported, never thrown.
 */
import { LAYER_KEY_RE } from '../../../domain/map-layers';

export const RAIL_STORAGE_PREFIX = 'farm-ops:layer-rail:v1:';

export interface RailPrefs {
  /** Layer key → chosen visibility (absent: the layer's default). */
  overrides: Record<string, boolean>;
  /**
   * Layer key → chosen mode (absent: the layer's default). Kept as saved here (any well-formed
   * id); ./modes.ts checks each against its layer's modes when the rail restores them.
   */
  modes: Record<string, string>;
  /** Rail open; null = never chosen (the variant's default). */
  open: boolean | null;
}

export const EMPTY_PREFS: RailPrefs = { overrides: {}, modes: {}, open: null };

/** A mode id: lower-case identifier (e.g. 'drainage', 'hydgrp'). */
export const MODE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

const empty = (): RailPrefs => ({ overrides: {}, modes: {}, open: null });

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function railStorageKey(variant: 'wall' | 'phone'): string {
  return `${RAIL_STORAGE_PREFIX}${variant}`;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Tolerant parse: unknown keys, non-boolean visibilities and malformed modes are dropped (a value
 * saved before modes existed reads as "default modes").
 */
export function parseRailPrefs(text: string | null): RailPrefs {
  if (!text) return empty();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty();
  }
  if (!isRecord(raw)) return empty();
  const overrides: Record<string, boolean> = {};
  if (isRecord(raw.overrides)) {
    for (const [k, v] of Object.entries(raw.overrides)) {
      if (LAYER_KEY_RE.test(k) && typeof v === 'boolean') overrides[k] = v;
    }
  }
  const modes: Record<string, string> = {};
  if (isRecord(raw.modes)) {
    for (const [k, v] of Object.entries(raw.modes)) {
      if (LAYER_KEY_RE.test(k) && typeof v === 'string' && MODE_ID_RE.test(v)) modes[k] = v;
    }
  }
  return { overrides, modes, open: typeof raw.open === 'boolean' ? raw.open : null };
}

/** The browser's localStorage, or null when it can't be used. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadRailPrefs(storage: StorageLike | null, variant: 'wall' | 'phone'): RailPrefs {
  if (!storage) return empty();
  try {
    return parseRailPrefs(storage.getItem(railStorageKey(variant)));
  } catch {
    return empty();
  }
}

/** Save; false when the browser refused (the choice still applies to this page). */
export function saveRailPrefs(
  storage: StorageLike | null,
  variant: 'wall' | 'phone',
  prefs: RailPrefs,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(railStorageKey(variant), JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
