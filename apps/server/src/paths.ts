/**
 * The places this server reads that it does not own.
 *
 * The API serves two things it does not produce: the built web app and the
 * brand file that names it. Until the repository
 * was split those were `../../../apps/web/dist` and friends — correct in a
 * monorepo and meaningless the moment the server lives on its own.
 *
 * So each is an environment variable, and the defaults describe THIS
 * repository: `apps/web/dist` for the built front end and the root
 * `brand.config.json`, which the web build reads too. Point the variables
 * somewhere else when the server is deployed apart from the checkout.
 *
 * Nothing here creates a directory or fails when one is missing. An absent
 * `WEB_DIST` is a perfectly good state — an API running with no front end in
 * front of it — and `server.ts` already checks `existsSync` before registering
 * each static root.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `src/` — where this file is, whatever the process was started from. */
const here = dirname(fileURLToPath(import.meta.url));

/** An env path if one is set, otherwise the monorepo-relative fallback. */
function fromEnv(name: string, fallback: string): string {
  const given = (process.env[name] ?? '').trim();
  return given === '' ? resolve(here, fallback) : resolve(given);
}

/** The built web app, served as the site. `WEB_DIST`. */
export const webDist = (): string => fromEnv('WEB_DIST', '../../web/dist');

/** `brand.config.json` — the name, the colours, the package id. `BRAND_CONFIG`. */
export const brandConfig = (): string => fromEnv('BRAND_CONFIG', '../../../brand.config.json');

/** Where `.env` is read from, when `ENV_FILE` does not name one. `ENV_DIR`. */
export const envDir = (): string => fromEnv('ENV_DIR', '..');

/** The shared legal texts (`legal/*.md`), which the app bundles too. `LEGAL_DIR`. */
export const legalDir = (): string => fromEnv('LEGAL_DIR', '../../../legal');

/**
 * Packages offered on the website's download page. `DOWNLOAD_DIR`.
 *
 * Plain files dropped in by `scripts/collect-downloads.mjs` (or by hand): the
 * Android APKs, the Samsung `.wgt`, the LG `.ipk`. May be missing or empty.
 */
export const downloadDir = (): string => fromEnv('DOWNLOAD_DIR', '../downloads');
