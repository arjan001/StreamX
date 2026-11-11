/**
 * How long the browser may keep each kind of file we serve.
 *
 * Its own module rather than a function inside `server.ts`, because
 * `server.ts` LISTENS at the top level: importing it to test one pure function
 * tries to bind port 7500, and the rule below went untested for exactly that
 * reason until it got something wrong.
 */
/** Vite writes /assets/<name>-<hash>.<ext>; the hash makes the URL the version. */
const YEAR_S = 31_536_000;
export function staticCacheControl(path: string): string {
  if (path.endsWith('index.html')) return 'no-cache';
  if (/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path)) {
    return `public, max-age=${YEAR_S}, immutable`;
  }
  /*
    The service worker is the one file that must never be held: a stale sw.js can
    keep serving a stale app long after a deploy, and it is the one thing a
    reload cannot fix from the outside.
  */
  if (path.endsWith('/sw.js')) return 'no-cache';
  /*
   * The remuxer's files, for the same reason and a measured one.
   *
   *     worker.js:1761 Uncaught TypeError: globalThis.crypto.randomUUID is not
   *     a function
   *
   * — reported after the fix for exactly that had shipped. `/libav/worker.js`
   * is a FIXED address: the library's files are copied in under their own
   * names rather than content-hashed like `/assets/`, so a day's cache meant a
   * browser went on running the previous copy and the fix could not reach it
   * for twenty-four hours. These are not "stable names" in the sense the line
   * below means; they are stable names with changing contents, which is the
   * one combination a long cache cannot survive.
   *
   * `no-cache` is revalidate-before-use, not "do not store": the eleven-
   * megabyte wasm answers 304 and costs one round trip while it is unchanged,
   * and re-downloads exactly when it should.
   */
  if (path.includes('/libav/')) return 'no-cache';
  // Icons, the manifest, the worklet: stable names, so a day, revalidated after.
  return 'public, max-age=86400';
}
