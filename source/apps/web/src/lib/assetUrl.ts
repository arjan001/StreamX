/**
 * An absolute URL for a file in `public/`, and it has to be absolute.
 *
 * ── the bug this exists to stop ──
 *
 * The room behind the launcher and the browse screens arrives as a CSS custom
 * property: the component writes `--shot: url(<file>)` inline and `index.css`
 * spends it inside a `background-image`. That is the only way to do it — the
 * stylesheet cannot name the file, because the wrapper build is served from a
 * relative base and Vite will not rewrite an absolute `url()` in CSS for one.
 *
 * But a relative `url()` inside a custom property is NOT resolved where it is
 * written. It is resolved where it is USED — against the base URL of the
 * stylesheet that substitutes it. On the website `import.meta.env.BASE_URL` is
 * `/`, so the URL is absolute and the question never arises. In the Android
 * build it is `./`, the stylesheet lives at `/assets/index-XXXX.css`, and the
 * television asked for:
 *
 *     /assets/modern-bg-dark.jpg        404
 *
 * for a file that is at the root. Reported as "on television I don't see the
 * background image", and reproducible outside the device by serving the app's
 * own bundle: the logo loads (it is an `<img src>`, resolved against the
 * document) and the room does not.
 *
 * So the URL is resolved here, against `document.baseURI`, before it ever
 * reaches CSS. An absolute URL cannot be re-resolved against anything.
 */
/**
 * The resolution itself, separated so it can be tested without a document.
 *
 * `base` is the page, NOT the stylesheet — that is the whole point.
 */
export function resolveAsset(rel: string, base: string): string {
  try {
    return new URL(rel, base).href;
  } catch {
    /* An unparseable base is not worth throwing over: the relative form is what
       the app used before this existed, and it is right on the website. */
    return rel;
  }
}

/** Vite's base, without assuming a bundler is present (the tests run in node). */
function viteBase(): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? '/';
}

/** `modern-bg-dark.jpg` → `https://localhost/modern-bg-dark.jpg?v=…` */
export function assetUrl(file: string): string {
  const base = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI;
  return resolveAsset(`${viteBase()}${file}`, base);
}

/* No import of `BRAND` here on purpose: this module is imported by a test that
   runs under `node --experimental-strip-types`, where a bare relative import
   with no extension does not resolve. Callers append the revision. */
