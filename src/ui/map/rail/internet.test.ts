/**
 * The internet signal the soil map unit sheet reads (./internet.ts, fed from ./model.ts
 * wanDownOf): the WAN counts as down when an online-only layer's tiles fail, whatever
 * navigator.onLine says (the LAN is still up).
 */
import { describe, expect, test } from 'vitest';
import { useInternetStore } from './internet';
import { isOnlineOnly, wanDownOf } from './model';

const naip = { key: 'naip', kind: 'online' as const, offline: false };
const soils = { key: 'soils', kind: 'vector' as const, offline: true };
const aoi = { key: 'naip_aoi', kind: 'raster' as const, offline: true };

describe('internet', () => {
  test('online-only: kind online, or a layer that does not work offline', () => {
    expect(isOnlineOnly(naip)).toBe(true);
    expect(isOnlineOnly({ ...soils, offline: false })).toBe(true);
    expect(isOnlineOnly(soils)).toBe(false);
    expect(isOnlineOnly(aoi)).toBe(false);
  });

  test('the WAN is down when an online-only layer’s tiles fail, not a local layer’s', () => {
    const resolved = [{ def: soils }, { def: naip }, { def: aoi }];
    expect(wanDownOf(resolved, new Set())).toBe(false);
    expect(wanDownOf(resolved, new Set(['naip']))).toBe(true);
    // Local tiles failing is the app (or the PC), not the internet.
    expect(wanDownOf(resolved, new Set(['soils', 'naip_aoi']))).toBe(false);
    // A failing key with no def (a layer nobody draws) says nothing.
    expect(wanDownOf([{ def: soils }], new Set(['naip']))).toBe(false);
  });

  test('the store only changes on a real change', () => {
    const s = useInternetStore;
    s.getState().setWanDown(false);
    const before = s.getState();
    s.getState().setWanDown(false);
    expect(s.getState()).toBe(before);
    s.getState().setWanDown(true);
    expect(s.getState().wanDown).toBe(true);
    s.getState().setWanDown(false);
    expect(s.getState().wanDown).toBe(false);
  });
});
