/**
 * Which channel logos this television keeps on its own storage, and when.
 *
 * The native half is `LogoStore.java`: it downloads, shrinks, keeps and serves
 * the files, holds a host that says "too many" and carries on when it lets up,
 * and stops — or gives its space back — when the device is short of room. This
 * half only decides WHICH: every logo a row on this television can show, most
 * wanted first, as the exact address the row will ask for (`artworkAt` at the
 * row's own size), so a stored file answers the request the row really makes.
 *
 *   1. favourites, then the sport channels, then everything else in the
 *      profile's scope — the order the store fills in, and the order it stops
 *      in when it reaches its cap;
 *   2. nothing outside the viewer's countries (adult rows never reach a read).
 *
 * Then `logoRetain` with the whole list — "each time proper clean up so it
 * doesn't clog up space": a channel that has left the line, or a country the
 * profile turned off, takes its logo with it.
 *
 * Only in the television app. The website has no such store (a browser cannot
 * keep images from hosts that send no CORS header without counting each as
 * megabytes of quota), and nothing here ever asks our server for anything.
 * Everything fails soft: an older APK without the methods, a plugin that
 * refuses, a library still building — the logos load from their hosts exactly
 * as they always did.
 */
import { deviceInfo } from './deviceInfo.ts';
import { localCatalogue } from './localCatalogue.ts';
import { eachLocalItem } from './localRead.ts';
import { artworkAt } from './artwork.ts';
import { getPrefs, scopeParams } from './prefs.ts';
import { topicSet } from './topicIndex.ts';
import { kv } from './kv.ts';
import { dlog } from './debugLog.ts';
import type { ItemQuery } from './api.ts';

/** The row's logo size — `DEFAULT_WIDTH.logo` in components/Poster.tsx. */
const ROW_WIDTH = 56;
/** More than any viewer's scope needs, and under the store's own file cap. */
const MAX_LOGOS = 15_000;
const CHUNK = 1_000;
const SYNCED_KEY = 'iptv.logos.synced';
/** Once a day is plenty: logos change far more slowly than that. */
const EVERY_MS = 24 * 3600_000;

/**
 * Where a logo really lives, given the address a row asks for.
 *
 * Plain-http logos are drawn through a public resizer (wsrv.nl — see
 * lib/artwork.ts), and fifteen thousand requests to a free third-party service
 * in a row is how it stops answering: measured, it said "too many" after forty.
 * So the store downloads from the logo's own host and shrinks it itself, and
 * keeps it under the address the row asks for.
 */
export function logoSource(asked: string): string {
  try {
    const u = new URL(asked);
    /* The APK's own address for a plain-http picture: the picture's host. */
    if (u.pathname === '/_img') {
      const own = u.searchParams.get('u');
      return own !== null && /^https?:\/\//i.test(own) ? own : asked;
    }
    if (u.hostname !== 'wsrv.nl') return asked;
    const inner = u.searchParams.get('url');
    if (inner === null || inner === '') return asked;
    if (/^https?:\/\//i.test(inner)) return inner;
    return `http://${inner.replace(/^\/\//, '')}`;
  } catch {
    return asked;
  }
}

/**
 * The list, in the order it should be filled. Pure but for the catalogue read.
 *
 * Walked in slices (`eachLocalItem`), not built in one piece: it reads every
 * channel on the line, and on a 40,000-channel library that was 1.4 s of one
 * uninterrupted task on the TV emulator — a real box's slower processor makes
 * that seconds of a frozen remote, ninety seconds after every launch of the day.
 */
export async function wantedLogos(scope: ItemQuery, favs: readonly number[], sport: ReadonlySet<number> | null): Promise<string[]> {
  const fav = new Set(favs);
  const rank = (id: number | null): number => (id !== null && fav.has(id) ? 0 : id !== null && sport?.has(id) ? 1 : 2);
  const found: { url: string; k: number; i: number }[] = [];
  const seen = new Set<string>();
  await eachLocalItem('live', scope, (r, i) => {
    const own = r.logo;
    if (own === null || own === '') return;
    const url = artworkAt(own, ROW_WIDTH);
    if (!/^https?:\/\//.test(url) || seen.has(url)) return;
    seen.add(url);
    found.push({ url, k: rank(r.streamId), i });
  });
  return found.sort((a, b) => a.k - b.k || a.i - b.i).slice(0, MAX_LOGOS).map((f) => f.url);
}

let running = false;

/**
 * Bring the store up to date with this library, at most once a day per build of
 * it. Returns how many logos were queued, or null when it did nothing.
 */
export async function syncLogoCache(now = Date.now()): Promise<number | null> {
  if (running) return null;
  const cat = localCatalogue();
  if (cat === null) return null;
  const mark = `${cat.generation}:${cat.builtAt}`;
  try {
    const raw = kv.get(SYNCED_KEY);
    if (raw !== null) {
      const [m, at] = raw.split('|');
      if (m === mark && now - Number(at) < EVERY_MS) return null;
    }
  } catch { /* private mode: just run */ }
  running = true;
  try {
    const dev = await deviceInfo();
    if (dev?.logoPrefetch === undefined || dev.logoRetain === undefined) return null;
    const prefs = getPrefs();
    const urls = await wantedLogos(scopeParams(prefs) as ItemQuery, prefs.favs.live, topicSet('sports'));
    if (urls.length === 0) return null;
    const sources = urls.map(logoSource);
    /* Clean first, so a line that shrank frees its space before anything new
       is written. */
    const { removed } = await dev.logoRetain({ urls });
    let queued = 0;
    for (let i = 0; i < urls.length; i += CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      queued += (await dev.logoPrefetch({ urls: urls.slice(i, i + CHUNK), sources: sources.slice(i, i + CHUNK) })).queued;
    }
    try { kv.set(SYNCED_KEY, `${mark}|${now}`); } catch { /* next launch runs it again */ }
    dlog.info('catalogue', `channel logos: ${urls.length} wanted, ${queued} to download, ${removed} removed`);
    return queued;
  } catch (err) {
    /* An APK without the methods, or a store that refused: logos load from
       their hosts as they always have. */
    dlog.warn('catalogue', `channel logos not stored — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    running = false;
  }
}

/** What the store holds, for the debug panel and the probes. */
export async function logoCacheStats(): Promise<{ files: number; bytes: number; pending: number } | null> {
  try {
    const dev = await deviceInfo();
    return (await dev?.logoStats?.()) ?? null;
  } catch { return null; }
}
