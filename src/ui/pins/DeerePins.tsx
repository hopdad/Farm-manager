'use client';
/**
 * Deere flags on the war-room map (slice 1f, docs/contracts-1f.md §5.2; owner: deere-data), one
 * element on /board and /m:
 *
 *  - keeps the `pins` layer's GeoJSON source (`layer:pins`, src/ui/map/layers/pins.ts) filled
 *    from GET /api/pins: on mount, on `pins`/`updated`, on every resync, every few minutes as a
 *    fallback, and again whenever applyLayers re-adds the source (`styledata`: a basemap switch
 *    or the layer toggled back on rebuilds it empty);
 *  - shows the pin popup (category, note, field, "From Operations Center (read-only)") when
 *    WarRoomMap's tap seam hands it a pin (`openPinFromTap`, BoardScreen's `onFeatureTap`); the
 *    popup calls `onOpen` so an open field panel closes, closes on its X, Escape or a tap on the
 *    map that hits no pin, and follows refetches (a pin resolved in Operations Center closes it).
 *
 * The SprayFieldState pattern: it gets the shared map and needs no change to the layer plumbing.
 * Test hook (outside production only, like the map's `window.__map`): `window.__pins`.
 */
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { PublicConfig } from '../../config';
import { PINS_URL, type PinsResponse, type PinView } from '../../domain/pins';
import { getRealtimeClient } from '../../platform/realtime/client';
import { PINS_SOURCE_ID } from '../map/layers/pins';
import type { FeatureTap } from '../map/tap';
import { tapLayerIds } from '../map/tap';
import type { MapVariant } from '../map/types';
import { PIN_TAP_LAYERS, pinPopupView, pinsFeatureCollection } from './model';
import css from './pins.module.css';

export interface PinsTestApi {
  /** Pin ids as last set on the map's source. */
  ids(): string[];
  /** How many times the source's data was set. */
  applied(): number;
  /** The pin whose popup is open, or null. */
  open(): string | null;
}

declare global {
  interface Window {
    __pins?: PinsTestApi;
  }
}

/** Which pin's popup is open (set from the map's tap seam). */
export const usePinPopupStore = create<{
  pinId: string | null;
  open(id: string): void;
  close(): void;
}>()((set) => ({
  pinId: null,
  open: (pinId) => set({ pinId }),
  close: () => set({ pinId: null }),
}));

/** WarRoomMap `onFeatureTap`: a tap on a pin opens its popup. */
export function openPinFromTap(hit: FeatureTap): void {
  if (hit.id) usePinPopupStore.getState().open(hit.id);
}

const DEBOUNCE_MS = 300;
const POLL_MS = 5 * 60_000;
/** A resync right after subscribing repeats the load that just happened: skip it. */
const FIRST_RESYNC_GRACE_MS = 2_000;

/** GET /api/pins, kept current by the `pins` topic. */
function usePins(realtime: PublicConfig['realtime']): PinView[] | null {
  const [pins, setPins] = useState<PinView[] | null>(null);
  useEffect(() => {
    let stopped = false;
    let ctrl: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      try {
        const res = await fetch(PINS_URL, { cache: 'no-store', signal: mine.signal });
        if (!res.ok) return;
        const body = (await res.json()) as PinsResponse;
        if (!stopped && !mine.signal.aborted) setPins(body.pins);
      } catch {
        // Offline: keep what is drawn; the next event, resync or poll tries again.
      }
    };
    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void load();
      }, DEBOUNCE_MS);
    };
    void load();
    const subscribedAt = Date.now();
    const off = getRealtimeClient(realtime).subscribe('pins', () => refetch(), {
      onResync: () => {
        if (Date.now() - subscribedAt > FIRST_RESYNC_GRACE_MS) refetch();
      },
    });
    const poll = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      ctrl?.abort();
      off();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
    };
  }, [realtime]);
  return pins;
}

export interface DeerePinsProps {
  map: MapLibreMap | null;
  variant: MapVariant;
  config: PublicConfig;
  /** Called when a popup opens (the board closes an open field panel). */
  onOpen?(): void;
}

export function DeerePins({ map, variant, config, onOpen }: DeerePinsProps) {
  const pins = usePins(config.realtime);
  const pinId = usePinPopupStore((s) => s.pinId);
  const close = usePinPopupStore((s) => s.close);
  const applied = useRef({ count: 0, ids: [] as string[] });
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // Keep the layer's source filled (and refill it whenever applyLayers re-adds it empty).
  useEffect(() => {
    if (!map || !pins) return;
    const data = pinsFeatureCollection(pins);
    let filled: unknown = null;
    const apply = () => {
      const src = map.getSource(PINS_SOURCE_ID) as GeoJSONSource | undefined;
      if (!src || src === filled || typeof src.setData !== 'function') return;
      src.setData(data);
      filled = src;
      applied.current = {
        count: applied.current.count + 1,
        ids: data.features.map((f) => f.properties.id),
      };
    };
    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [map, pins]);

  // A tap on the map that hits no pin closes the popup (a pin tap opens it through the seam).
  useEffect(() => {
    if (!map) return;
    const r = variant === 'wall' ? 14 : 10;
    const onClick = (e: MapMouseEvent) => {
      if (!usePinPopupStore.getState().pinId) return;
      const ids = tapLayerIds(
        PIN_TAP_LAYERS,
        (map.getStyle()?.layers ?? []).map((l) => l.id),
      );
      const hits = ids.length
        ? map.queryRenderedFeatures(
            [
              [e.point.x - r, e.point.y - r],
              [e.point.x + r, e.point.y + r],
            ],
            { layers: ids },
          )
        : [];
      if (hits.length === 0) usePinPopupStore.getState().close();
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, variant]);

  const pin = pinId && pins ? (pins.find((p) => p.id === pinId && !p.resolvedAt) ?? null) : null;

  // A popup that opened closes an open field panel; one whose pin went away closes itself.
  useEffect(() => {
    if (pinId && pin) onOpenRef.current?.();
  }, [pinId, pin]);
  useEffect(() => {
    if (pinId && pins && !pin) close();
  }, [pinId, pins, pin, close]);

  useEffect(() => {
    if (!pin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pin, close]);

  // Close the popup when the board unmounts it (route change).
  useEffect(() => () => usePinPopupStore.getState().close(), []);

  const testHook = config.appEnv !== 'production';
  useEffect(() => {
    if (!testHook || typeof window === 'undefined') return;
    const api: PinsTestApi = {
      ids: () => [...applied.current.ids],
      applied: () => applied.current.count,
      open: () => usePinPopupStore.getState().pinId,
    };
    window.__pins = api;
    return () => {
      if (window.__pins === api) delete window.__pins;
    };
  }, [testHook]);

  const onClose = useCallback(() => close(), [close]);
  if (!pin) return null;
  const v = pinPopupView(pin);
  return (
    <section
      className={variant === 'phone' ? css.phone : css.card}
      data-testid="pin-popup"
      aria-label={`Flag: ${v.title}`}
    >
      <div className={css.title}>
        <span className={css.dot} style={{ background: v.color }} />
        <span data-testid="pin-popup-title">{v.title}</span>
        <button type="button" className={css.close} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {v.kindLabel !== v.title && <div className={css.muted}>{v.kindLabel}</div>}
      {v.note && (
        <div className={css.note} data-testid="pin-popup-note">
          {v.note}
        </div>
      )}
      <div data-testid="pin-popup-field">
        <span className={css.muted}>Field: </span>
        {v.field}
      </div>
      <div className={css.origin} data-testid="pin-popup-origin">
        {v.origin}
      </div>
    </section>
  );
}

export default DeerePins;
