/**
 * Hardcoded provider URLs for simplified login mode.
 *
 * When the app is configured for simplified login, the server URL field is
 * hidden and these URLs are tried in order until one succeeds. The failover
 * engine in `hosts.ts` handles probing, sticky caching, and busy retry.
 */

export const PROVIDER_URLS = [
  'http://line.istreamix.com',    // Primary
  'http://vpn.istreamix.com',
  'http://vpn.new4k-tx.site',
  'http://line.trexottvendor.store',
  'http://vpn.trexottvendor.store',
] as const;

export const PRIMARY_PROVIDER = PROVIDER_URLS[0];
export const FALLBACK_PROVIDERS = PROVIDER_URLS.slice(1);
