/**
 * Put the remuxer's own files where the page can fetch them.
 *
 * The device takes a film apart with libav.js (FFmpeg compiled to WebAssembly,
 * LGPL-2.1) built into the variant described in `apps/web/libav/`. Three files
 * have to be reachable by URL at runtime rather than bundled:
 *
 *   libav-streamix.mjs        the front end the page imports
 *   libav-streamix.wasm.mjs   the worker libav.js starts for itself
 *   libav-streamix.wasm.wasm  FFmpeg
 *
 * They are copied out of `apps/web/libav/dist/` into `public/libav/` rather than
 * committed twice: `public/libav/` is ignored, like `dist`.
 *
 * ── why `libav/dist/` is committed at all ──
 *
 * They are build output, but of a build that needs Docker (the Emscripten SDK),
 * a fetch of the libav.js and FFmpeg sources, and about fifteen minutes. Asking
 * every checkout and every CI run to repeat that for a binary that changes when
 * the recipe does would be the wrong trade; `apps/web/libav/build.sh` rebuilds
 * them byte-for-byte from the recipe whenever somebody wants to check.
 *
 * ── why these live on our own origin ──
 *
 * They are the app's own code, like its JavaScript, and they are fetched once
 * and cached. That is not the same thing as a film: the rule is that no film
 * and nothing about a film comes from our box (`lib/serverFilms.ts`), and this
 * is what makes that rule keepable rather than breaking it — it is the machine
 * that lets the DEVICE take a film apart, so the film itself never leaves the
 * panel's network at all.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the recipe's committed output lives. */
const DIST = join(HERE, '..', 'libav', 'dist');

export const WANTED = ['libav-streamix.mjs', 'libav-streamix.wasm.mjs', 'libav-streamix.wasm.wasm'];

export function copyLibavAssets(publicDir, from = DIST) {
  if (!existsSync(from)) {
    throw new Error('apps/web/libav/dist is missing — the device cannot take a film apart without it');
  }
  const to = join(publicDir, 'libav');
  mkdirSync(to, { recursive: true });
  const copied = [];
  for (const name of WANTED) {
    const src = join(from, name);
    if (!existsSync(src)) throw new Error(`libav.js build is missing ${name}`);
    const dst = join(to, name);
    /* Skipped when it is already the same size: the wasm is megabytes and a dev
       server restarts often. */
    if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
    cpSync(src, dst);
    copied.push(name);
  }
  /* Anything left from an older layout would be served for nothing. */
  for (const name of readdirSync(to)) {
    if (!WANTED.includes(name)) rmSync(join(to, name), { recursive: true, force: true });
  }
  return { dir: to, copied, present: readdirSync(to) };
}

/**
 * A Vite plugin, so `vite build` and `vite dev` both have them.
 *
 * ── and so the television does NOT ──
 *
 * Several megabytes of the dist are the wasm, and the packaged app never runs
 * it: on a television the URL goes to libVLC, which demuxes and decodes
 * everything on the device already, so `wantsDeviceFilm` is false there before
 * it looks at the file. Shipping it would put it onto every APK download and
 * every update, for code no television can reach.
 *
 * The removal is at the END of a packaged build rather than a refusal to copy
 * at the start, because `public/` is shared: a web build in another window may
 * have put them there minutes ago and will want them there afterwards. What
 * leaves the packaged build is the COPY in its own output.
 */
export function libavAssets({ packaged = process.env.VITE_PACKAGED === '1' } = {}) {
  return {
    name: 'streamix-libav-assets',
    buildStart() {
      if (packaged) return;
      const publicDir = join(HERE, '..', 'public');
      const { copied, present } = copyLibavAssets(publicDir);
      if (copied.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  libav         copied ${copied.join(', ')}`);
      }
      const missing = WANTED.filter((w) => !present.includes(w));
      if (missing.length > 0) throw new Error(`libav assets missing: ${missing.join(', ')}`);
    },
    closeBundle() {
      if (!packaged) return;
      const out = join(process.cwd(), process.env.VITE_OUT ?? 'dist', 'libav');
      if (!existsSync(out)) return;
      rmSync(out, { recursive: true, force: true });
      // eslint-disable-next-line no-console
      console.log('  libav         left out of the packaged app — the television uses libVLC');
    },
  };
}
