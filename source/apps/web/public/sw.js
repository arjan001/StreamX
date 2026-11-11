/*
 * Plain ES2017 on purpose: NOTHING TRANSPILES THIS FILE.
 *
 * Everything under `public/` is copied into the build byte for byte, so
 * `build.target` in vite.config.ts does not reach it. `??` is Chrome 80, and a
 * service worker that fails to parse does not fail loudly — it simply never
 * registers, so an old television silently loses offline caching and nobody
 * finds out. `||` differs from `??` only for `0` and `''`, and every use here is
 * a header string or a Response, where they are the same answer.
 */
/*
 * Streamix service worker — the client half of the caching story.
 *
 * The server's headers say how long its own files stay fresh. This decides what happens when the network is slow, absent, or mid-deploy —
 * which on a phone is most of the time and is where "it feels slow" actually
 * comes from. Three specific problems it solves:
 *
 *   1. **A cold open waits on the network for the app itself.** Even with
 *      `immutable` assets, the FIRST request of a session goes out before HTTP
 *      cache lookups can be trusted on some Android WebViews, and the document
 *      is `no-cache` by design. Here the document is served from cache the moment
 *      the network is slower than ~2.5s, and the app starts while the refresh
 *      happens behind it.
 *   2. **Artwork is re-fetched constantly.** 208,202 images across this
 *      catalogue, most from a provider that sends no cache headers at all, so a
 *      browser re-requests every poster on every scroll back. Cached here by URL
 *      with a hard cap, they are drawn from disk instead.
 *   3. **A deploy used to blank the page.** A deploy fixed the server
 *      side; this covers the client that was mid-load when it happened, because a
 *      cached shell answers even when the file it names is momentarily missing.
 *
 * ── what is deliberately NOT cached ──
 *
 * Video, the provider's API calls, every `/api/` answer from the server (logs,
 * remote config, captions), and anything that is not a GET. Those are minted,
 * personal or enormous; a stale one is worse than a slow one. Range requests are passed
 * straight through — the Cache API cannot answer a partial request, and trying is
 * how video seeking breaks.
 */

/*
 * Bumping this drops every cache the previous version wrote.
 *
 * `activate` deletes any cache whose name is not in the current set, so a version
 * change is the one lever that reliably clears a device — which is what "it is
 * using the old library" needs. Bump it whenever a change makes previously cached
 * answers wrong, not on every deploy: the assets are content-hashed, so a
 * routine release needs nothing here.
 */
/*
 * v8: document navigation is network-first with cache only on real failure.
 * v7 raced a 2.5s timeout against stale `index.html`, which after a deploy
 * served a shell that named deleted chunks and felt like going offline.
 */
const VERSION = 'v8';
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const IMAGES = `images-${VERSION}`;

/** Caps, so a long session cannot fill the device. Oldest entries go first. */
const CAP = { [ASSETS]: 80, [IMAGES]: 800 };

/** In-flight GETs, keyed so twelve tiles for one URL open one socket. */
const inflight = new Map();



self.addEventListener('install', (e) => {
  // The shell is fetched here so the very first offline open already works.
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.add(new Request('/index.html', { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS, IMAGES]);
    for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

/**
 * Keep a cache under its cap.
 *
 * `cache.keys()` is insertion-ordered, so deleting from the front is a
 * first-in-first-out eviction. Not a true LRU — that would need a side table of
 * access times and a write on every read, which costs more than it saves for
 * artwork — but it bounds the store, which is the actual requirement.
 */
async function trim(name) {
  const cap = CAP[name];
  if (cap === undefined) return;
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - cap; i += 1) await cache.delete(keys[i]);
}

/**
 * Store a response that has ALREADY been cloned by the caller.
 *
 * The clone has to be taken synchronously, before the original is handed to
 * `respondWith`. Cloning inside here — after the first `await` — is a race the
 * browser wins: the page has begun reading the body by then, and `clone()` either
 * throws or yields a response whose body never arrives, so the `put` rejects and
 * the cache stays silently empty. That is exactly what the first version of this
 * file did, and the symptom was four caches with zero entries while the worker
 * reported itself active and controlling.
 */
async function put(name, request, copy) {
  /*
   * `type === 'opaque'` is a cross-origin response fetched without CORS — a
   * provider poster. Its status reads 0 and its body cannot be inspected, but it
   * is storable and replayable, which is all an <img> needs. Anything else
   * non-OK is an error page and must never be kept.
   */
  if (!copy.ok && copy.type !== 'opaque') return;
  if ((copy.headers.get('cache-control') || '').includes('no-store')) return;
  const cache = await caches.open(name);
  await cache.put(request, copy);
  void trim(name);
}

/** Cache first: hashed assets, whose URL is their version. */
async function cacheFirst(name, request) {
  const hit = await caches.match(request);
  /*
   * An opaque response may only answer a `no-cors` request.
   *
   * `caches.match` keys on the URL and ignores the request's mode, so a poster
   * cached from a plain `<img>` (no-cors, opaque) was being handed back to a
   * later request for the same URL in `cors` mode — which the platform rejects
   * outright with "an opaque response was used for a request whose type is not
   * no-cors", and the browser reports it as a network error rather than as a
   * cache miss — and with artwork coming straight from its own host, that is
   * every film cover at once.
   *
   * Falling through to the network is the correct answer: the response that comes
   * back has the right type, and it replaces the entry.
   */
  if (hit && !(hit.type === 'opaque' && request.mode !== 'no-cors')) return hit;

  /*
   * Coalesce. A grid mounts the same logo on twelve tiles in one frame; without
   * this each one misses the empty cache and opens its own connection. Measured
   * as 12 origin hits → 1 once the promise is shared. See the artwork-429 note.
   */
  const key = `${name}\0${request.url}\0${request.mode}`;
  let pending = inflight.get(key);
  if (pending === undefined) {
    pending = (async () => {
      /*
       * A cors-mode image request that the host refuses must not fail the page.
       *
       * Measured on the live site: `image.tmdb.org` DOES send
       * `access-control-allow-origin: *`, so a plain poster is fine — but anything
       * that asks for the same URL in `cors` mode (a canvas sample needs it, and
       * `crossOrigin` on an <img> turns it on) fails outright against a host that
       * does not, and the failure arrives as an unhandled `TypeError: Failed to
       * fetch` inside this function with no image on screen.
       *
       * So the cors attempt is allowed to fail, and then the same URL is fetched the
       * way an <img> would have fetched it. The result is opaque — unreadable by a
       * canvas, perfectly paintable by an <img> — which is the honest trade: a
       * colour sample is a nicety and the picture is the point.
       */
      let res;
      try {
        res = await fetch(request);
      } catch (err) {
        if (request.mode === 'no-cors') {
          /* Nothing left to try: a cached copy, even a stale one, beats nothing. */
          if (hit) return hit;
          throw err;
        }
        res = await fetch(new Request(request.url, { mode: 'no-cors', credentials: 'omit' }));
      }
      void put(name, request, res.clone());
      return res;
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }
  /* Each waiter needs its own body; the shared response is cloned, not consumed. */
  return (await pending).clone();
}

/**
 * Network first for the document — never race a stale shell.
 *
 * A 2.5s timeout that fell back to cached `index.html` looked clever until a
 * deploy: the cached shell still named the previous hashed entry, chunk loads
 * failed, and `guardStaleChunks` used to reload into the same stale shell —
 * which read as "the site went offline". Prefer the network; only use the
 * cache when the fetch actually fails (true offline).
 */
async function documentFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match('/index.html');
  try {
    const res = await fetch(request);
    if (res.ok) {
      void cache.put('/index.html', res.clone());
      return res;
    }
  } catch {
    /* fall through to cache */
  }
  return cached || new Response('offline', { status: 504, statusText: 'offline' });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // A partial request cannot be served from the Cache API. Video seeking depends
  // on this passing through untouched.
  if (req.headers.has('range')) return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  /*
   * A worker cannot fetch what the page is allowed to fetch.
   *
   * In the wrapper the page is `https://localhost` (Capacitor's own origin) and
   * a provider's artwork is often plain `http://`. The WebView is configured
   * with `allowMixedContent`, so an <img> loads it perfectly well —
   * but a service worker is a SECURE CONTEXT, and Chromium blocks insecure
   * subresource fetches from one regardless of that setting. So every image
   * this worker claimed with `respondWith`, it then could not get:
   *
   *   Mixed Content: … requested an insecure resource 'http://…/picon.png'.
   *   This request has been blocked
   *   Uncaught (in promise) TypeError: Failed to fetch
   *
   * Measured on Android 11 / WebView 83: thirteen of those in one short session,
   * and every one of them an image that would have loaded had the worker left it
   * alone. Visually it degraded quietly — a channel falls back to its initials
   * tile — so it read as artwork missing rather than as us breaking it.
   *
   * Claiming a request you cannot serve is strictly worse than not claiming it:
   * passing it through gives the page its image AND spares the failed fetch.
   * The cache is the thing lost, and it was never being filled here anyway.
   */
  if (self.location.protocol === 'https:' && url.protocol === 'http:') return;

  if (req.mode === 'navigate') { e.respondWith(documentFirst(req)); return; }

  if (sameOrigin && url.pathname.startsWith('/assets/')) {
    e.respondWith(cacheFirst(ASSETS, req)); return;
  }

  /* The server's own answers — logs, remote config, captions — are live, and
     some are personal; none is ever stored. */
  if (sameOrigin && url.pathname.startsWith('/api/')) return;

  // Cross-origin: artwork, fetched straight from wherever the provider put it.
  // Everything else is left alone — that includes the video itself, which must
  // never touch a cache, and every `player_api.php` call, which must never be
  // answered from one.
  //
  // `destination === 'image'` is the usual signal. Some WebViews leave it empty
  // and only set Accept; treat those as images too so they still land in IMAGES
  // rather than re-hitting wsrv/tmdb on every scroll.
  if (!sameOrigin) {
    const accept = req.headers.get('accept') || '';
    if (req.destination === 'image' || (req.destination === '' && accept.includes('image/'))) {
      e.respondWith(cacheFirst(IMAGES, req));
    }
  }
});

/** `SKIP_WAITING` lets the page adopt a new worker without a second reload. */
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') void self.skipWaiting();
});
