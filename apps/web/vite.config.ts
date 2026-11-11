import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
// @ts-expect-error — plain JS, and the plugin shape is checked by vite itself
import { libavAssets } from './scripts/libav-assets.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** One line from the repo `.env`, unquoted. */
function dotenvValue(key: string): string {
  const envPath = resolve(rootDir, '.env');
  if (!existsSync(envPath)) return '';
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`).exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return '';
}

/**
 * The server origin the app talks to (logs, app config, caption keys).
 * Packaged builds set `VITE_API_ORIGIN` in the build command and win over the
 * .env default.
 */
function apiOrigin(): string {
  const fromEnv = (process.env.VITE_API_ORIGIN ?? '').replace(/\/+$/, '');
  if (fromEnv !== '') return fromEnv;
  return dotenvValue('PUBLIC_API_ORIGIN').replace(/\/+$/, '');
}

/**
 * The version this build reports.
 *
 * One source of truth: the Android `versionName`, which is the number a viewer
 * actually sees on their phone and the number an operator types into the admin
 * area's minimum-version field. Reading it here means the web build and the APK
 * can never disagree about which release they are — and they did, silently, until
 * this existed.
 *
 * A build that cannot read it reports nothing, and a client reporting nothing is
 * never force-updated. That is the safe direction to fail in.
 */
/**
 * The one version, read from the one file.
 *
 * It used to be scraped out of `build.gradle`, which made the Android project the
 * source of truth for the WEB build's version — so a web-only deploy shipped
 * whatever version the last APK happened to carry. `version.json` is the source
 * now and `scripts/version.mjs` is what writes gradle from it.
 */
function appVersion(): string {
  try {
    const raw = readFileSync(new URL('../../version.json', import.meta.url), 'utf8');
    const { version, build } = JSON.parse(raw) as { version?: string; build?: number };
    return typeof version === 'string' ? version : '';
  } catch {
    return '';
  }
}

/** The build number, which is what Android compares and what a bug report needs. */
function appBuild(): string {
  try {
    const raw = readFileSync(new URL('../../version.json', import.meta.url), 'utf8');
    return String((JSON.parse(raw) as { build?: number }).build ?? '');
  } catch {
    return '';
  }
}

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION ?? appVersion()),
    'import.meta.env.VITE_APP_BUILD': JSON.stringify(process.env.VITE_APP_BUILD ?? appBuild()),
    'import.meta.env.VITE_BRAND': JSON.stringify(process.env.VITE_BRAND ?? ''),
    /* Exact keys — optional-chaining on import.meta.env left these empty in the bundle. */
    'import.meta.env.VITE_API_ORIGIN': JSON.stringify(apiOrigin()),
  },
  /**
   * Absolute asset paths on the web, relative ones in a packaged shell.
   *
   * `/assets/index-abc.js` is correct when a server serves the app at the domain
   * root, and wrong under `file://`, where it resolves to the filesystem root. The
   * inverse is also true: `./assets/...` breaks web deep links, because /movie/123
   * would look for /movie/assets/... So this is a build-time switch, not a default
   *   pnpm build                       # web / pm2, served by the API process
   *   VITE_BASE=./ VITE_ROUTER=hash \
   *     VITE_API_ORIGIN=https://iptv.example.com pnpm build   # Electron/Capacitor
   */
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwind(), libavAssets()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5183),
    host: '127.0.0.1',
    // Proxy in dev so the browser talks to one origin. The provider itself is
    // CORS-permissive (measured), so stream requests go direct — only the API
    // is proxied.
    proxy: { '/api': { target: process.env.VITE_API_BASE ?? 'http://127.0.0.1:7500', changeOrigin: true } },
  },
  build: {
    /**
     * The wrapper build must not overwrite the web build.
     *
     * `dist/` is what the Fastify process serves (server.ts resolves it directly),
     * so a wrapper build writing there would replace the live site with a bundle
     * whose asset paths are relative and whose router is the hash router.
     */
    outDir: process.env.VITE_OUT ?? 'dist',
    /**
     * The browser floor, stated rather than inherited.
     *
     * There was no `target` here, so the floor was whatever Vite's default
     * happened to be that month — measured at Chrome 92+ in the shipped bundle,
     * against an APK whose `minSdkVersion` is 23 (Android 6). That gap is not
     * theoretical: a Capacitor app renders in the SYSTEM WebView, and on TV boxes
     * that WebView is frequently frozen at whatever shipped with the device.
     * `docs/06-platform-engines.md` §119 records the same floor for Tizen — 2019
     * sets are Chromium M63 — and `08-gotchas.md` #57 records the symptom: one
     * modern API from a transitive dependency is a white screen on a whole model
     * year, with no console to ask.
     *
     * Chrome 68 is the current choice, moved down from 70 on 2026-09-17 because
     * 70 missed the 2020 TV sets by one or two versions — the most annoying
     * possible way to miss. Samsung's own developer docs give Tizen 5.5 (2020)
     * as Chromium 69 and Tizen 6.0 (2021) as 76; LG gives webOS 5 (2020) as
     * roughly Chromium 68 and webOS 6 (2021) as roughly 79. Floor 68 is the
     * lowest of those two 2020 numbers, so it covers both the 2020 Samsung and
     * the 2020 LG set with one number instead of missing one of them by one.
     *
     * MEASURED cost, built from this exact source tree (JS+CSS bytes under
     * `apps/web/dist/assets`, maps excluded):
     *   chrome70 (previous floor): 2,175,766 bytes
     *   chrome69 (Tizen 5.5 only): 2,175,766 bytes — byte-identical, esbuild
     *     has nothing to transpile differently between 69 and 70 for the
     *     syntax this codebase uses
     *   chrome68 (this floor)    : 2,175,766 bytes — also byte-identical
     *   chrome63 (adds 2019 Samsung, Tizen 5.0): 2,176,512 bytes (+746 B,
     *     +0.03%) — rejected for now: the extra 2019 coverage is real but
     *     small, and going that low ALSO puts `String.trimStart`/`trimEnd`
     *     (Chrome 66) below the floor on top of the flat/flatMap gap below,
     *     which is one more shipped call site than 68 needs fixed first
     *
     * NOT a free lunch, though: this pins SYNTAX only, and `bundle-floor.mjs`
     * found the codebase already calling `Array.prototype.flat`/`flatMap`
     * (needs Chrome 69) unguarded in seven built chunks. On a REAL Chrome 68
     * engine — the LG 2020 set this floor is nominally for — that throws and
     * white-screens, exactly like the gap this change is meant to close. The
     * gate reports it as a WARNING rather than failing the build, because no
     * `target` fixes a library call; see `scripts/bundle-floor.mjs` for the
     * full list and file names. Raising this back to 70 silently drops the
     * 2020 Samsung and LG sets again with no error anywhere.
     *
     * Chrome 87 was ES2020-complete, so the syntax this codebase actually uses
     * (optional chaining, nullish, logical assignment, private fields)
     * survives untranspiled at either floor — the bundle barely moves between
     * 87 and 68 for the same reason it doesn't move between 70 and 68 above.
     * `scripts/bundle-floor.mjs` asserts the built output against whichever
     * floor is declared here, which is the CI-grep the gotcha asked for and
     * nobody had written.
     *
     * NOTE this pins SYNTAX, not runtime APIs. `structuredClone`, `Array.at` and
     * friends are library calls no transpiler can invent; the floor check reports
     * those separately so they are a decision rather than a surprise.
     */
    target: ['chrome68', 'safari14', 'firefox78'],
    /*
     * The same floor for CSS, which had none at all.
     *
     * The JS target has been here for a while and the CSS target was simply
     * missing, so stylesheets were emitted at esbuild's default — modern. That
     * is half of why an older television showed unstyled HTML; the other half is
     * `@layer`, which nothing can downlevel and which
     * `scripts/css-compat.mjs` flattens after the build.
     *
     * This does not overlap with that pass. What it buys is everything esbuild
     * CAN lower at this floor — nested selectors, some colour syntax — in this
     * app's own `index.css`, which Tailwind's own pipeline never sees.
     */
    cssTarget: ['chrome68', 'safari14', 'firefox78'],
    /*
     * Maps for operators (upload to a crash tool), not for viewers.
     * `true` embeds `//# sourceMappingURL` and browsers will fetch multi‑MB maps
     * on open DevTools / some WebViews. `hidden` still emits `.map` files.
     *
     * Every packaged build (Capacitor, Tizen, webOS — all set VITE_PACKAGED=1)
     * skips maps entirely: they would ship the full source inside the store
     * package. Only the plain web build keeps hidden maps.
     */
    sourcemap: process.env.VITE_PACKAGED === '1' || process.env.VITE_PLATFORM === 'capacitor' ? false : 'hidden',
    rollupOptions: {
      output: {
        /*
         * Function form — the array form only matched the package root, so
         * `react-dom/client` (React 19's entry) stayed in the index chunk and
         * first paint paid ~react-dom twice conceptually (vendor thin, index fat).
         */
        manualChunks(id) {
          /*
           * The provider clients (Xtream, Stalker, vault) get their own chunk.
           *
           * `apps/mobile/scripts/harden.mjs` looks for a `providers-*` chunk by
           * name and fails the packaged Android build if there is none, so keep
           * this boundary or change that script with it. It is a chunk boundary,
           * not a security boundary.
           */
          if (id.includes('/src/lib/providers/')) return 'providers';
          if (!id.includes('node_modules')) return;
          if (id.includes('hls.js')) return 'hls';
          if (id.includes('mpegts.js')) return 'mpegts';
          if (
            id.includes('/react-dom/')
            || id.includes('/react/')
            || id.includes('/scheduler/')
            || id.includes('react-router')
            || id.includes('@tanstack/react-query')
            || id.includes('@tanstack/query-core')
          ) {
            return 'vendor';
          }
        },
      },
    },
  },
});
