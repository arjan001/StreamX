/**
 * Portal URL handling. Users paste anything from `http://host:8080` to
 * `http://host/stalker_portal/c/` or the API path itself; we reduce it to an
 * origin + prefix and probe the usual API paths with a handshake.
 */
import { StalkerError } from './errors.ts';

export interface PortalUrl {
  /** `http://host:port`, no trailing slash. */
  readonly origin: string;
  /** Path prefix in front of the portal's own paths, `''` or `/xyz`. */
  readonly prefix: string;
  /** True when the pasted URL pointed at `stalker_portal`. */
  readonly stalkerPortal: boolean;
  /** The pasted URL if it already named an API script, tried first. */
  readonly explicitEndpoint: string | null;
  /** The `Referer` a box sends: its own `/c/` page. */
  readonly referer: string;
}

const API_TAIL = /\/(?:stalker_portal\/)?(?:server\/load\.php|c\/portal\.php|portal\.php)$/i;
const PAGE_TAIL = /\/(?:stalker_portal\/)?c\/?$/i;

export function parsePortalUrl(input: string): PortalUrl {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new StalkerError('bad_url', 'Portal address is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new StalkerError('bad_url', 'Portal address must start with http:// or https://');
  }
  if (!u.hostname) throw new StalkerError('bad_url', 'Portal address has no host');
  const origin = u.origin;
  let path = u.pathname.replace(/\/+$/, '');
  let explicit: string | null = null;
  const stalkerPortal = /\/stalker_portal(\/|$)/i.test(path);
  if (API_TAIL.test(path)) {
    explicit = `${origin}${path}`;
    path = path.replace(API_TAIL, '');
  } else if (PAGE_TAIL.test(path)) {
    path = path.replace(PAGE_TAIL, '');
  } else if (/\/stalker_portal$/i.test(path)) {
    path = path.replace(/\/stalker_portal$/i, '');
  }
  const prefix = path === '/' ? '' : path;
  return {
    origin,
    prefix,
    stalkerPortal,
    explicitEndpoint: explicit,
    referer: `${origin}${prefix}${stalkerPortal ? '/stalker_portal' : ''}/c/`,
  };
}

/** API endpoints to probe, in order; the explicitly pasted one leads. */
export function endpointCandidates(p: PortalUrl): string[] {
  const base = `${p.origin}${p.prefix}`;
  const list = [
    p.explicitEndpoint,
    `${base}/portal.php`,
    `${base}/server/load.php`,
    `${base}/stalker_portal/server/load.php`,
    `${base}/c/portal.php`,
    `${base}/stalker_portal/c/portal.php`,
  ].filter((x): x is string => x !== null);
  return [...new Set(list)];
}

/** Directory the portal's static files (logos) live under, from a working endpoint. */
export function portalRootOf(endpoint: string): string {
  return endpoint.replace(/\/(?:server\/load\.php|c\/portal\.php|portal\.php)$/i, '');
}
