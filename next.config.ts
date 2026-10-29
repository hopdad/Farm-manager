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
  reactStrictMode: true,
  // pg's optional native binding must never be bundled.
  serverExternalPackages: ['pg', 'pg-native'],
};

export default nextConfig;
