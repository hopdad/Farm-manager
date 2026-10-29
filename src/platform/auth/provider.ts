/**
 * Picks the AuthProvider for AUTH_PROVIDER. `local` (LocalAuth) now; `supabase` arrives at MD
 * (`src/platform/auth/supabase.ts`, @supabase/ssr in proxy.ts) and is refused until then
 * instead of silently falling back.
 */
import type { Config } from '../../config';
import { createLocalAuth } from './local';
import type { AuthProvider } from './types';

type ProviderConfig = Pick<Config, 'AUTH_PROVIDER' | 'SESSION_SECRET' | 'cookieSecure'>;

let cached: { key: string; provider: AuthProvider } | null = null;

export function getAuthProvider(cfg: ProviderConfig): AuthProvider {
  if (cfg.AUTH_PROVIDER !== 'local') {
    throw new Error(
      `AUTH_PROVIDER=${cfg.AUTH_PROVIDER} is not built yet (it arrives at MD); use AUTH_PROVIDER=local`,
    );
  }
  const key = `${cfg.AUTH_PROVIDER}|${cfg.cookieSecure}|${cfg.SESSION_SECRET}`;
  if (cached?.key !== key) {
    cached = {
      key,
      provider: createLocalAuth({ secret: cfg.SESSION_SECRET, secure: cfg.cookieSecure }),
    };
  }
  return cached.provider;
}
