/**
 * Provider artwork URLs that a browser cannot load as-is.
 *
 * A slice of VOD posters are TMDB files copied onto a dead HTTP mirror
 * (`/images/movies/{hash}.jpg`). The same file is still on image.tmdb.org.
 * Hashes are 26 or 27 characters on this catalogue — not a fixed 27.
 *
 * Recovering a poster to `https://image.tmdb.org` is the difference between a
 * tile that loads on a secure page and a letter, because the mirror it came from
 * is plaintext as well as dead.
 */

/** Trailing junk the panel appends, e.g. `.pngf`. */
const JUNK_EXT = /\.(png|jpe?g|webp|gif)[a-z]$/i;
const TMDB_MOVIE = /\/images\/movies\/+([a-zA-Z0-9]{26,32})\.(jpe?g|png)$/i;

/**
 * TMDB's WEBSITE, standing in for its image CDN.
 *
 * `www.themoviedb.org/t/p/original/…` is what the panel writes for a great many
 * series covers, and it is a 301 to `image.tmdb.org` — so it works, and it costs
 * a redirect on every tile. Worse, it costs the resize: `artworkAt` swaps the
 * rendition segment only on the CDN host, so every one of these arrived as the
 * MASTER. Measured on the series rail's own covers, walking it with the D-pad
 * fetched 1,159,971 bytes for a picture drawn 28 CSS pixels wide; the same file
 * as `image.tmdb.org/t/p/w92` is 6,342 bytes. That is the largest single
 * over-fetch this app has measured, and it was invisible because an image nine
 * hundred times too big looks exactly like one that fits.
 *
 * The path space is identical on both hosts, so this is a host swap and nothing
 * else — the rendition, if the URL names one, is left exactly as it was.
 */
const TMDB_SITE = /^(?:www\.)?themoviedb\.org$/i;
const TMDB_RENDITION_PATH = /^\/t\/p\//;

export function rewriteArtwork(raw: string): string {
  const trimmed = raw.replace(JUNK_EXT, '.$1');
  let href: URL;
  try {
    href = new URL(trimmed);
  } catch {
    return '';
  }
  if (TMDB_SITE.test(href.hostname) && TMDB_RENDITION_PATH.test(href.pathname)) {
    return `https://image.tmdb.org${href.pathname}${href.search}`;
  }
  const m = TMDB_MOVIE.exec(href.pathname);
  if (!m) return href.href;
  const ext = m[2]!.toLowerCase() === 'jpeg' ? 'jpg' : m[2]!.toLowerCase();
  return `https://image.tmdb.org/t/p/original/${m[1]}.${ext}`;
}

/* ── asking for the size that will actually be drawn ───────────────────────── */

/**
 * TMDB's published poster renditions, smallest first.
 *
 * These are real paths on `image.tmdb.org`, not a resize service — swapping the
 * segment costs nothing and needs nobody's API key.
 */
const TMDB_TIERS = [92, 154, 185, 342, 500, 780] as const;

/**
 * The widths a resized picture is asked for at, smallest first.
 *
 * A URL is the cache key everywhere: the service worker's `IMAGES` cache, the
 * browser's HTTP cache, and the WebView's native poster cache all key on the
 * exact string. Asked for with the raw number, the same picon behind a 39px
 * guide logo, a 48px channel row and a 68px rail tile was three URLs, three
 * cache entries and three downloads of identical bytes.
 *
 * Rounding here makes those one entry. It cannot make a picture blurry: the
 * tier is always >= what was asked for.
 */
export const WIDTH_TIERS = [64, 96, 128, 192, 256, 384, 512, 768] as const;

/** The tier a drawn width belongs in: the first one at least as wide. */
export function tierWidth(want: number): number {
  return WIDTH_TIERS.find((t) => t >= want) ?? WIDTH_TIERS[WIDTH_TIERS.length - 1]!;
}

/** `image.tmdb.org/t/p/<rendition>/<file>` — the rendition is what we replace. */
const TMDB_PATH = /^\/t\/p\/([^/]+)\/(.+)$/;

/** How much bigger than the box we are willing to fetch before rounding up. */
const DPR_CAP = 2;

/**
 * The same picture, asked for at the size it will be drawn.
 *
 * This is the largest single cost in the app and it was invisible, because a
 * poster that is nine times too big looks exactly like one that fits. Measured
 * against this catalogue's own fixture: 15% of items point at TMDB's
 * `t/p/original` — a 2000×3000 master, 1.3MB — and another 38% at
 * `w600_and_h900_bestv2`, 122KB. The tile they land in is 109 CSS pixels wide,
 * which on a 1080p box at DPR 2 is 217 device pixels. That is a 7.6× area
 * over-fetch on the good slice and 85× on the bad one, and one mid-scroll window
 * of the grid mounts 66 of them.
 *
 * Two rewrites, none of which costs anything or adds a dependency:
 *
 *   TMDB — swap the rendition for the smallest published one that still covers
 *   the box. `w342` for a poster tile, against `original`: measured 35KB against
 *   1.3MB for the same image.
 *
 *   wsrv — the proxy 42% of plaintext artwork already goes through, used until
 *   now purely as a mixed-content shim. It resizes; it was simply never asked.
 *   `&w=` with `&we` (never enlarge), so a 60px picon is not blown up to 342.
 *
 * Anything else is returned untouched. Widening this to wrap every origin in
 * wsrv would resize the remaining 5% and make a third party load-bearing for all
 * artwork instead of some, which is a bad trade.
 */
/**
 * The rewritten URLs, kept — one `new URL()` per poster per render is a tax.
 *
 * This runs on every render of every tile, and it parses a URL and walks four
 * regexes to arrive at an answer that depends on nothing but its two arguments.
 * Measured on a 4x-throttled CPU walking /series with the wheel, `artworkAt` was
 * 65ms of a 7.9s scroll and the `URL` constructor it calls another 92ms — 2% of
 * the scroll spent re-deriving strings the app already had.
 *
 * Keyed on the url and the QUANTISED width, so the cache has at most one entry
 * per url per tier rather than one per pixel — the same reason `tierWidth`
 * exists. Bounded and cleared wholesale for the same reason as `displayName`'s.
 */
const REWRITTEN = new Map<string, string>();
const REWRITTEN_MAX = 4000;

export function artworkAt(url: string, cssWidth: number): string {
  if (url === '' || cssWidth <= 0) return url;
  const want = Math.round(cssWidth * Math.min(DPR_CAP, dpr()));
  const key = `${tierWidth(want)} ${want} ${url}`;
  const held = REWRITTEN.get(key);
  if (held !== undefined) return held;
  const made = rewriteAt(url, want);
  if (REWRITTEN.size >= REWRITTEN_MAX) REWRITTEN.clear();
  REWRITTEN.set(key, made);
  return made;
}

function rewriteAt(url: string, want: number): string {
  let href: URL;
  try {
    href = new URL(url);
  } catch {
    /* A relative path — an app asset, and already exactly the size it was
       built at. */
    return url;
  }

  if (href.hostname === 'wsrv.nl') {
    if (href.searchParams.has('w')) return url;
    /* Appended to the raw string rather than rebuilt through `searchParams`:
       the `url=` value is already percent-encoded, and round-tripping it
       through URLSearchParams re-encodes it into a different string for the
       same picture — which is a cache miss on every tile. */
    const join = url.includes('?') ? '&' : '?';
    /* `we` is wsrv's "without enlargement": a logo smaller than the box stays
       its own size rather than being upscaled into a blur. */
    /* Rounded to a tier: wsrv keys its cache on the URL too, and a width
       nobody else will ask for is a fetch nobody else can share. */
    return `${url}${join}w=${tierWidth(want)}&we`;
  }

  /* The website as well as the CDN — see `TMDB_SITE`. Artwork that reaches here
     without passing through `safeImage` (a detail response's own `cover`, which
     comes from the panel rather than from the catalogue) is otherwise fetched at
     full size AND through a redirect. The answer is always the CDN's origin,
     because that is where the 301 was pointing anyway. */
  if (href.hostname === 'image.tmdb.org' || TMDB_SITE.test(href.hostname)) {
    const m = TMDB_PATH.exec(href.pathname);
    if (m === null) return url;
    const tier = TMDB_TIERS.find((t) => t >= want);
    const rendition = tier === undefined ? 'original' : `w${tier}`;
    if (rendition === m[1] && href.hostname === 'image.tmdb.org') return url;
    return `https://image.tmdb.org/t/p/${rendition}/${m[2]}${href.search}`;
  }

  return url;
}

function dpr(): number {
  return typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1);
}
