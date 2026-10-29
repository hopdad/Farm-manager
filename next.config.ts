import type { NextConfig } from 'next';
import { getDevOrigins } from './src/config';

/**
 * Next 16 config. Env comes from src/config.ts (never process.env here).
 * allowedDevOrigins: LAN addresses + <hostname>.local written to DEV_ORIGINS by `pnpm env:init`,
 * so phones on shop Wi-Fi can load `next dev` pages and HMR.
 */
const nextConfig: NextConfig = {
  allowedDevOrigins: getDevOrigins(),
  poweredByHeader: false,
  // /api/jobs, /api/realtime, /api/tiles, /api/webhooks and /api/oauth must never answer 3xx
  // (contracts §5): pg_net and the clock don't follow redirects. Next would 308 a trailing slash.
  skipTrailingSlashRedirect: true,
  reactStrictMode: true,
  // pg's optional native binding must never be bundled.
  serverExternalPackages: ['pg', 'pg-native'],
};

export default nextConfig;
