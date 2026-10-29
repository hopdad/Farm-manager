/**
 * The PC's own addresses on the shop network, for enrollment links a cab iPad can open when the
 * manager is using the PC itself (http://localhost:3000 is useless on an iPad). Private IPv4
 * only (RFC 1918), non-internal; Docker/WSL adapters show up too, so the page lists them all
 * (the `pnpm dev` banner names each adapter).
 */
import { networkInterfaces } from 'node:os';

/** The host the wall kiosk on the PC opens (README, docs/kiosk.md): http://localhost:3000/board. */
export const KIOSK_HOST = 'localhost';

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/** Private IPv4 addresses of this machine (pure filter over `os.networkInterfaces()` output). */
export function privateAddresses(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && PRIVATE.some((re) => re.test(a.address))) {
        out.push(a.address);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Shop-network addresses, most likely first: home and shop routers hand out 192.168.x.x, then
 * 10.x.x.x; 172.16-31.x.x is where Docker Desktop and WSL put their virtual adapters.
 */
export function rankLanAddresses(addresses: readonly string[]): string[] {
  const rank = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2);
  return addresses
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a);
}

export interface EnrollLinks {
  /** The link the QR code and the main link carry: one the device can open. */
  url: string;
  /** The same link on localhost, when the manager is on the PC itself ("on this PC"). */
  localUrl: string | null;
  /** Every shop-network link (the first is `url`), when the manager is on the PC itself. */
  lanUrls: string[];
  /**
   * The link for the wall kiosk on the PC itself, whatever address this browser used: always
   * http://localhost on the app's port. The kiosk opens http://localhost:3000/board and cookies
   * belong to one host, so a wall enrolled on the LAN address would land on /login.
   */
  kioskUrl: string;
}

/**
 * The enrollment links for a code, from the origin the manager's browser used. On the PC itself
 * (localhost) the QR code must carry a LAN address: an iPad or phone that scans
 * http://localhost:3000 opens itself.
 */
export function enrollLinks(
  origin: string,
  path: string,
  addresses: readonly string[],
): EnrollLinks {
  const u = new URL(origin);
  const own = `${u.origin}${path}`;
  const port = u.port ? `:${u.port}` : '';
  const kioskUrl = `${u.protocol}//${KIOSK_HOST}${port}${path}`;
  if (!isLoopbackHost(u.hostname) || addresses.length === 0) {
    return { url: own, localUrl: null, lanUrls: [], kioskUrl };
  }
  const lanUrls = rankLanAddresses(addresses).map((ip) => `${u.protocol}//${ip}${port}${path}`);
  return { url: lanUrls[0] as string, localUrl: own, lanUrls, kioskUrl };
}
