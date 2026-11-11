#!/usr/bin/env node
/**
 * Build the staging directory that goes INTO an LG webOS `.ipk`.
 *
 * ── why this is a sibling of apps/tizen and not a flag on it ──
 *
 * The web bundle the two need is identical — a packaged, file-local build of
 * `@iptv/web` with `VITE_PLATFORM` left unset, so the Android-only paths
 * (libVLC, the native bridge, Capacitor storage) fall through to their plain
 * web behaviour. Everything AFTER the bundle differs: Tizen wants a W3C
 * `config.xml` and a DUID-bound signature, webOS wants an `appinfo.json` and
 * no signature at all. Sharing the manifest step would mean one script with
 * two of everything in it; sharing nothing means one `pnpm --filter` build per
 * platform, which is nine seconds. Nine seconds is the cheaper of the two.
 *
 * ── the one real difference in the bundle ──
 *
 * `disableBackHistoryAPI` in `appinfo.json` is why the remote's Back button
 * does not close the app the moment a viewer presses it: webOS's default is to
 * treat Back as "leave", and this app has screens worth going back through. It
 * is a manifest setting rather than a build one, so the bundle stays the same —
 * but it is only half of a pair. It hands Back to the page, and the page has to
 * answer: `lib/webosKeys.ts` listens for LG's keyCode 461 and maps it to the
 * same `exit` intent Tizen's 10009 gets. Without that listener this setting
 * makes Back do NOTHING, which is worse than the default it replaces.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const OUT_NAME = 'dist-webos';
const webOut = join(ROOT, 'apps/web', OUT_NAME);
const staging = join(HERE, 'staging');

/**
 * The origin a packaged shell talks to, from `STREAMIX_API_ORIGIN` or else the
 * public site origin in `.env`. The page is loaded from a local package root,
 * so there is no meaningful relative origin and every API call has to name the
 * server absolutely. The origin never enters the repository; it lands only in
 * the built package, which is not checked in. With neither set it is empty.
 */
function siteOrigin() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^PUBLIC_SITE_ORIGIN=(.*)$/.exec(line.trim());
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, '').trim().replace(/\/$/, '');
        if (v !== '') return v;
      }
    }
  } catch { /* no .env on this machine */ }
  return '';
}

const DEFAULT_ORIGIN = siteOrigin();
const apiOrigin = (process.env.STREAMIX_API_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, '');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function version() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'));
  /* webOS wants three numbers and nothing else — no `+build` suffix, which is
     what `version.json` carries separately anyway. */
  const parts = String(raw.version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { version: parts.slice(0, 3).join('.'), build: Number(raw.build) || 0 };
}

function main() {
  const v = version();

  const buildEnv = {
    ...process.env,
    VITE_BASE: './',
    VITE_ROUTER: 'hash',
    VITE_DATA: 'local',
    /* "This page is loaded from a package root, and its API is elsewhere" — the
       one thing `VITE_PLATFORM=capacitor` would also have said, without the
       Android machinery it drags in. Without it the presence socket points at
       the package origin and every handshake fails. See `lib/api.ts`. */
    VITE_PACKAGED: '1',
    VITE_OUT: OUT_NAME,
    VITE_API_ORIGIN: apiOrigin,
  };
  /* Guard against a stray export from an apps/mobile build in the same shell:
     an inherited 'capacitor' would gate the Android-only code paths back on. */
  delete buildEnv.VITE_PLATFORM;
  run('pnpm', ['--filter', '@iptv/web', 'build'], { env: buildEnv });

  if (!existsSync(join(webOut, 'index.html'))) {
    console.error(`webos build: FAIL — ${webOut}/index.html missing after vite build`);
    process.exit(1);
  }

  /* The same two post-build passes the widget and the APK get: the version
     stamp, so "which build is this" is answerable from the shipped files, and
     the @layer-flattening CSS pass — a 2020 webOS 5 set is Chromium 68, which
     is as pre-@layer as the Tizen and old-Android cases that pass was written
     for. */
  run('node', [join(ROOT, 'scripts/stamp-build.mjs'), webOut]);
  run('node', [join(ROOT, 'scripts/css-compat.mjs'), webOut]);
  /* The compatibility gate: syntax above the Chromium 68 floor fails the build. */
  run('node', [join(ROOT, 'scripts/bundle-floor.mjs'), join(webOut, 'assets')]);

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  /* Source maps never go into a store package. */
  cpSync(webOut, staging, { recursive: true, filter: (src) => !src.endsWith('.map') });

  /*
   * `appinfo.json` — webOS's whole manifest. No signature, no certificate, no
   * device list: the difference from Tizen that decides how this is delivered.
   */
  const appinfo = {
    id: 'com.easyred.streamix',
    version: v.version,
    vendor: 'EasyRed',
    type: 'web',
    main: 'index.html',
    title: 'Streamix',
    icon: 'icon.png',
    largeIcon: 'icon-large.png',
    bgColor: '#0b0b0d',
    iconColor: '#0b0b0d',
    /* The app draws its own screens at TV size and has no portrait layout. */
    supportPortraitMode: false,
    resolution: '1920x1080',
    /* Back is handled in the app (`remoteKeys.ts`), so webOS must not treat it
       as "close the app" before the page has seen it. */
    disableBackHistoryAPI: true,
    /* Returning to an already-running app must not restart it — a viewer who
       presses Home mid-film and comes back expects the film. */
    handlesRelaunch: true,
  };
  writeFileSync(join(staging, 'appinfo.json'), `${JSON.stringify(appinfo, null, 2)}\n`);
  cpSync(join(HERE, 'icon.png'), join(staging, 'icon.png'));
  cpSync(join(HERE, 'icon-large.png'), join(staging, 'icon-large.png'));

  const size = dirSize(staging);
  console.log(`webos build: staged ${staging.replace(ROOT, '.')} — ${(size / 1024 / 1024).toFixed(2)} MB`
    + ` (${v.version}+${v.build})`);
  console.log('webos build: next step is apps/webos/package.mjs to produce the .ipk');
}

function dirSize(dir) {
  let total = 0;
  for (const name of readDirRecursive(dir)) total += statSync(name).size;
  return total;
}

function readDirRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readDirRecursive(full));
    else out.push(full);
  }
  return out;
}

main();
