/**
 * pnpm pilot: the production build on the LAN, for the wall display and phones on shop Wi-Fi
 * (plan §2 "Daily commands"): `next build`, then the vendor stand-in, `next start -H 0.0.0.0`
 * and, once /api/health answers, the job clock. Same flags as `pnpm dev`, plus --skip-build to
 * reuse the last build.
 *
 *   pnpm pilot
 *   pnpm pilot --scenario=harvest-day --speed=30
 *   pnpm pilot --skip-build --no-clock
 *
 * `next build` / `next start` read .env.production.local (not .env.development.local); the
 * stand-in and the clock are started with NODE_ENV=production too, so all of them read the same
 * env files, and PUBLIC_URL / VENDOR_SIM_URL are passed explicitly so they agree on the ports.
 * TLS for phones (`pilot:https`, tools/https) arrives with slice 2c.
 */
import { isMainModule } from '../src/lib/proc';
import { launch } from './dev';

if (isMainModule(import.meta.url)) {
  launch('pilot', process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`[pilot] error: ${e.message}`);
      process.exit(1);
    },
  );
}
