/**
 * Which product this build is.
 *
 * The app is white-label: the same code ships under different names, colours and
 * package ids, driven by `brand.config.json` at the repo root. The server had no
 * idea about any of that — every log line and every stored row was
 * brand-agnostic — so the question "which brand is this user on" had no answer
 * anywhere.
 *
 * Read once at startup. It is a build-time fact, not a request-time one, and
 * re-reading a file per request to learn something that cannot change would be
 * silly. A brand change means a redeploy anyway.
 *
 * The client reports its OWN brand on every heartbeat, and that is the value the
 * roster keeps. This one is the fallback for a client that says nothing, and the
 * value stamped on the server's own log lines.
 */
import { brandConfig } from './paths.ts';
import './env.ts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Brand {
  /** Display name — "Streamix". */
  name: string;
  /** The uppercase wordmark, when it differs. */
  wordmark: string;
  /** Android application id, which is the most durable identifier a build has. */
  applicationId: string | null;
  site: string | null;
  /** Who publishes the app, for the legal pages. Empty strings until filled in. */
  publisher: Record<'name' | 'email' | 'address' | 'website' | 'governingLaw' | 'termsEffectiveDate' | 'privacyEffectiveDate', string>;
  captions: { provider: string; privacyUrl: string };
  /** Store listings, when the app has been published. Empty hides the badge. */
  playStoreUrl: string;
  appStoreUrl: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const PUBLISHER_KEYS = ['name', 'email', 'address', 'website', 'governingLaw', 'termsEffectiveDate', 'privacyEffectiveDate'] as const;

function publisherOf(raw: Record<string, unknown>): Brand['publisher'] {
  const p = (raw['publisher'] ?? {}) as Record<string, unknown>;
  return Object.fromEntries(PUBLISHER_KEYS.map((k) => [k, str(p[k])])) as Brand['publisher'];
}
function captionsOf(raw: Record<string, unknown>): Brand['captions'] {
  const c = (raw['captions'] ?? {}) as Record<string, unknown>;
  return { provider: str(c['provider']), privacyUrl: str(c['privacyUrl']) };
}

/**
 * The public address people type into a television, which is NOT a build fact.
 *
 * It does not belong in `brand.config.json`: the
 * address can change the day a DNS record does, and a signed APK cannot be
 * rebuilt for that. So the domain is an operator setting in `.env`, the brand
 * file keeps the address that is true of any deployment, and the server hands
 * whichever one it has.
 */
const ENV_SITE = (() => {
  const raw = (process.env['PUBLIC_SITE_ORIGIN'] ?? '').trim();
  return raw === '' ? null : raw.replace(/\/+$/, '');
})();

function load(): Brand {
  const path = brandConfig();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const android = (raw['android'] ?? {}) as Record<string, unknown>;
    return {
      name: typeof raw['name'] === 'string' ? raw['name'] : 'unknown',
      wordmark: typeof raw['wordmark'] === 'string' ? raw['wordmark'] : '',
      applicationId: typeof android['applicationId'] === 'string' ? android['applicationId'] : null,
      site: ENV_SITE ?? (str(raw['publisher'] && (raw['publisher'] as Record<string, unknown>)['website']) || (typeof raw['site'] === 'string' && raw['site'] !== '' ? raw['site'] : null)),
      publisher: publisherOf(raw),
      captions: captionsOf(raw),
      playStoreUrl: str(android['playStoreUrl']),
      appStoreUrl: str(((raw['ios'] ?? {}) as Record<string, unknown>)['appStoreUrl']),
    };
  } catch {
    /* A missing or malformed brand file is not a reason to refuse to start: an
       unbranded server serves the same catalogue. It is a reason to say so, which
       "unknown" does every time it appears in a log line. */
    return { name: 'unknown', wordmark: '', applicationId: null, site: ENV_SITE, publisher: publisherOf({}), captions: captionsOf({}), playStoreUrl: '', appStoreUrl: '' };
  }
}

export const BRAND: Brand = load();
