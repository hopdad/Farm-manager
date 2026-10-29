/**
 * /board: the war room on the wall display (4K, touch, kiosk). The server reads basemap.json
 * through the storage adapter and the fields' tile version and extent from the database, and
 * passes origin-relative URLs to the client map (contracts §10).
 */
import type { Metadata, Viewport } from 'next';
import { requirePageSession } from '@/platform/auth/page';
import { BoardScreen } from '@/ui/board/BoardScreen';
import { loadMapPageData } from '@/ui/map/server/map-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Farm Ops · War room' };

// Kiosk: the browser never zooms the page; the map handles pinch and rotate.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0b1210',
};

export default async function BoardPage() {
  // A revoked or signed-out screen goes to /login (the proxy only checks the cookie's signature).
  await requirePageSession('/board');
  const data = await loadMapPageData();
  return <BoardScreen data={data} variant="wall" />;
}
