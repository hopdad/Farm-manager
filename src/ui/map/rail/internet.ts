/**
 * Can this page reach the internet, not only the farm's LAN? Owner: soils (the layer rail feeds
 * it; the soil map unit sheet's official series links read it).
 *
 * navigator.onLine only knows the network adapter. The farm's usual outage is the WAN down
 * behind a working LAN (the PC and the shop Wi-Fi up), and then it stays true. The rail already
 * sees that case: an online-only layer's tiles fail (the NAIP aerial photos), and it says
 * "offline" on that layer (./model.ts wanDownOf). It publishes the same fact here (`wanDown`),
 * and `useInternet()` is false when either signal says the internet is gone. Neither proves the
 * internet is up (with no online layer on there is nothing to watch), so a link that needs it
 * says so in its text.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';

export interface InternetState {
  /** An online-only layer's tiles are failing right now (cleared when one loads again). */
  wanDown: boolean;
  setWanDown(down: boolean): void;
}

export const useInternetStore = create<InternetState>()((set) => ({
  wanDown: false,
  setWanDown: (wanDown) => set((s) => (s.wanDown === wanDown ? s : { wanDown })),
}));

/** navigator.onLine, kept current (true before mount and where the browser can't tell). */
export function useNavigatorOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () =>
      setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** False when the browser is offline or the rail sees the WAN down; true otherwise. */
export function useInternet(): boolean {
  const online = useNavigatorOnline();
  const wanDown = useInternetStore((s) => s.wanDown);
  return online && !wanDown;
}
