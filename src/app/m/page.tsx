/**
 * /m: the same map for phones and cab iPads (open http://<pc-ip>:3000/m on shop Wi-Fi), with a
 * bottom sheet listing the fleet.
 */
import type { Metadata, Viewport } from 'next';
import { requirePageSession } from '@/platform/auth/page';
import { BoardScreen } from '@/ui/board/BoardScreen';
import { loadMapPageData } from '@/ui/map/server/map-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Farm Ops' };

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#101a16',
};

export default async function PhonePage() {
  // A revoked or signed-out screen goes to /login (the proxy only checks the cookie's signature).
  await requirePageSession('/m');
  const data = await loadMapPageData();
  return <BoardScreen data={data} variant="phone" />;
}
