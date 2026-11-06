'use client';
/**
 * One minute-resolution clock for every card on the page (the windows say "Today" and
 * "Tomorrow"; they change at midnight, not every second). One interval however many cards.
 */
import { useSyncExternalStore } from 'react';

const TICK_MS = 60_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const snapshot = () => now;

/** Milliseconds since the epoch, updated once a minute. */
export function useClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
