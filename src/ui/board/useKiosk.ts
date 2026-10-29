'use client';
/**
 * Kiosk behaviour for the wall and phones: the browser itself never zooms, scrolls, selects text
 * or opens a context menu; only the map handles gestures. (The page also sets
 * `user-scalable=no` / `maximum-scale=1` and CSS `touch-action: none`.)
 */
import { useEffect } from 'react';

export function useKiosk(): void {
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    // Ctrl+wheel (trackpad pinch) zooms the page in Chrome; the map handles its own wheel events.
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey && !(e.target as Element | null)?.closest?.('.maplibregl-map'))
        e.preventDefault();
    };
    // Two-finger page zoom outside the map (iOS fires gesture* events, others multi-touch moves).
    const touchmove = (e: TouchEvent) => {
      if (e.touches.length > 1 && !(e.target as Element | null)?.closest?.('.maplibregl-map')) {
        e.preventDefault();
      }
    };
    const opts: AddEventListenerOptions = { passive: false };
    document.addEventListener('gesturestart', prevent, opts);
    document.addEventListener('gesturechange', prevent, opts);
    document.addEventListener('contextmenu', prevent, opts);
    document.addEventListener('wheel', wheel, opts);
    document.addEventListener('touchmove', touchmove, opts);
    return () => {
      document.removeEventListener('gesturestart', prevent);
      document.removeEventListener('gesturechange', prevent);
      document.removeEventListener('contextmenu', prevent);
      document.removeEventListener('wheel', wheel);
      document.removeEventListener('touchmove', touchmove);
    };
  }, []);
}
