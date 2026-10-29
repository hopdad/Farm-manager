'use client';
/** The wall clock in ms, re-read every `ms` (for "edited 5 min ago"). */
import { useEffect, useState } from 'react';

export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
