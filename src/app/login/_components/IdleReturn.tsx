'use client';
/**
 * On a shared screen (the wall, a cab iPad) the sign-in page must not stay up when someone opens
 * it and walks away: after `ms` without a touch, a key or a click it goes back to the device's
 * own screen (the board or /m).
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** How long the PIN pad waits for input on a shared screen. */
export const SHARED_LOGIN_IDLE_MS = 60_000;

export function IdleReturn({ href, ms = SHARED_LOGIN_IDLE_MS }: { href: string; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    let timer = setTimeout(() => router.replace(href), ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.replace(href), ms);
    };
    const events = ['pointerdown', 'keydown', 'input', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
  }, [href, ms, router]);
  return null;
}
