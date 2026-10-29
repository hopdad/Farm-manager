/**
 * The PC's own addresses on the shop network, for enrollment links a cab iPad can open when the
 * manager is using the PC itself (http://localhost:3000 is useless on an iPad). Private IPv4
 * only (RFC 1918), non-internal; Docker/WSL adapters show up too, so the page lists them all
 * (the `pnpm dev` banner names each adapter).
 */
import { networkInterfaces } from 'node:os';

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
