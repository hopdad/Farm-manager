/**
 * The layer rail remembers its choices per device (plan 1d; contracts-m1 §7.2: "the rail may
 * persist them"): which layers are on or off and whether the rail is open, in localStorage,
 * one entry per variant. The wall kiosk keeps its own browser profile, so "the wall remembers".
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
  /** Rail open; null = never chosen (the variant's default). */
  open: boolean | null;
}

export const EMPTY_PREFS: RailPrefs = { overrides: {}, open: null };

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function railStorageKey(variant: 'wall' | 'phone'): string {
  return `${RAIL_STORAGE_PREFIX}${variant}`;
}

/** Tolerant parse: unknown keys and non-boolean values are dropped. */
export function parseRailPrefs(text: string | null): RailPrefs {
  if (!text) return { ...EMPTY_PREFS, overrides: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...EMPTY_PREFS, overrides: {} };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...EMPTY_PREFS, overrides: {} };
  const r = raw as { overrides?: unknown; open?: unknown };
  const overrides: Record<string, boolean> = {};
  if (r.overrides && typeof r.overrides === 'object' && !Array.isArray(r.overrides)) {
    for (const [k, v] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (LAYER_KEY_RE.test(k) && typeof v === 'boolean') overrides[k] = v;
    }
  }
  return { overrides, open: typeof r.open === 'boolean' ? r.open : null };
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
  if (!storage) return { ...EMPTY_PREFS, overrides: {} };
  try {
    return parseRailPrefs(storage.getItem(railStorageKey(variant)));
  } catch {
    return { ...EMPTY_PREFS, overrides: {} };
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
