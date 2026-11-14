/**
 * The on-device answers, in the API's own shapes.
 *
 * Every function here returns `null` when there is no local catalogue — because
 * the mode is off, or because the download has not finished — and the caller in
 * `api.ts` turns that into a rejection.
 *
 * The translation is deliberately thin. `core-store` already implements the read
 * model; this only maps its shapes onto the DTOs the components expect, and
 * decides how each piece of artwork is loaded (`safeImage`).
 */
import { fetchesItsOwnMedia, isNativeShell } from './direct.ts';
import { breather } from './breather.ts';
import { rewriteArtwork } from './artwork.ts';
import {
  buildStreamUrl, normaliseServerUrl, resolveLiveExt,
} from '@iptv/core-xtream';
import {
  activeProvider, credentials, scheduler, streamBase, subscription, subscriptionOf,
} from './providers/index.ts';
import { localEpgFor, localEpgGrid as localEpgGridSlots, topUp } from './localEpg.ts';
import { bulkGuideUsable, bulkSlots } from './bulkGuide.ts';
import { movieInfo, seriesInfo } from './localDetail.ts';
import { headersFor } from './playSide.ts';
import { closeGaps, nowNext, windowOf, type Slot } from '@iptv/core-store';

const schedulerDepth = () => scheduler.depth;
import { FLAG, KIND, isAdultCategory, rowIsAdult, adultCategoryIds, familyKey, getItem, indexOfItem, listCategories, listFacets, listGroups, listItems,
  qualityOf,
  CORRECTION_FLOOR,
  listAll, listAllSorted, listMarkets, matchRows, readText as readTextCol, search, viewItem, type Catalogue, type ItemView, type Query } from '@iptv/core-store';
import { libraryMode, localCatalogue, localEnabled } from './localCatalogue.ts';
import { ensureSearchIndex } from './searchIndex.ts';
import { topicSet } from './topicIndex.ts';
import { liveName } from './liveNames.ts';
import { whyNoPlay, type PlayUnavailableReason } from './playUnavailable.ts';
import { currentPlatform, liveFormatFor } from './platform.ts';
import type {
  Category, CategoryFacts, Facets, GroupsResponse, Hidden, Inventory, Item, ItemQuery, Market,
  EpgResponse, EpgSlot, GridResponse, SeriesDetail as SeriesDetailResponse,
  MovieDetailResponse, Page, PlaybackTarget, Section, Variant,
} from './api.ts';

const SECTION_KIND: Record<Section, number> = {
  live: KIND.Live,
  movies: KIND.Movie,
  series: KIND.Series,
};

/**
 * Fast category-to-items index for search queries.
 *
 * Instead of scanning all 40,000+ items on every filter keystroke, this index
 * maps each category id to the set of compact search keys it contains. Built
 * once per catalogue generation and invalidated when the catalogue changes.
 */
let categoryIndex: Map<number, string[]> | null = null;
let categoryIndexGeneration = 0;
let categoryIndexSection: Section | null = null;
let categoryIndexExcludeTopic: string | null = null;

/**
 * Find which categories contain items matching a search query, without
 * scanning all items through `toItem`. Uses the pre-built category index
 * for fast lookup.
 */
export function findMatchingCategories(section: Section, query: string, excludeTopic?: string): Set<number> {
  const cat = localCatalogue();
  if (cat === null || query.length < 2) return new Set();

  const excl = excludeTopic ?? null;
  /* Rebuild index if catalogue or section changed. */
  if (cat.generation !== categoryIndexGeneration || categoryIndexSection !== section || categoryIndexExcludeTopic !== excl) {
    categoryIndex = new Map();
    categoryIndexGeneration = cat.generation;
    categoryIndexSection = section;
    categoryIndexExcludeTopic = excl;
    const kind = SECTION_KIND[section];
    const cols = cat.items;
    const topicIds = excl ? topicSet(excl) : null;
    for (let i = 0; i < cols.count; i++) {
      if (cols.kind[i] !== kind) continue;
      if (topicIds !== null && topicIds.has(i)) continue;
      const cid = cols.categoryId[i];
      if (cid == null || cid === 0) continue;
      const text = readTextCol(cols.compact, i);
      const existing = categoryIndex.get(cid);
      if (existing === undefined) {
        categoryIndex.set(cid, [text]);
      } else {
        existing.push(text);
      }
    }
  }

  const needle = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  const result = new Set<number>();
  for (const [cid, keys] of categoryIndex!) {
    for (const key of keys) {
      if (key.includes(needle)) {
        result.add(cid);
        break;
      }
    }
  }
  return result;
}

/**
 * Artwork, loaded from its own host.
 *
 * An HTTPS page cannot load a plaintext image, and many live picons are
 * plaintext on IP-literal hosts that can never hold a certificate; a letter tile
 * covers those. Per scheme:
 *
 *   https           taken as-is. Films and series are already 118,624 HTTPS
 *                   against 8,954 plaintext — almost all of them tmdb.
 *   http, upgradable a few hosts do answer TLS. `TLS_OK` names the measured ones,
 *                   and upgrading is free.
 *   http, otherwise  the origin URL. In the APK that is the native layer's
 *                   same-origin `/_img`; on a web page it is the address itself,
 *                   which a secure page upgrades to https or refuses — and a
 *                   refused picture is a letter tile.
 *
 * A host that hangs from one network is not a host that hangs from a
 * television on a home line, so the origin is always tried, and `Poster` /
 * `deadArt` learn per session, on the device that is actually loading the
 * picture.
 */
/** Plaintext hosts that do answer TLS. Upgrading costs nothing. */
const TLS_OK = new Set(['picons.cmshulk.com', 'icon-tmdb.me']);

/**
 * Stream hosts a browser can never play, however the page is served.
 *
 * hls.js fetches manifests and segments by XHR, so a host that pins
 * `Access-Control-Allow-Origin` to somebody else's site refuses every request no
 * matter what we do. `jmp2.uk` pins it to `http://pluto.tv`, and public
 * playlists carry it widely.
 *
 * Naming it does not make it play. It turns a channel that fails silently after a
 * timeout into one that says why, in a sentence a viewer can act on — and the
 * action is real, because a native player is not subject to CORS and these play
 * perfectly in the app. Most public stream hosts send `*` and are fine.
 */
const BROWSER_HOSTILE = new Set(['jmp2.uk']);

function browserHostile(url: string): boolean {
  try { return BROWSER_HOSTILE.has(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

/**
 * Artwork, made loadable.
 *
 * https        taken as-is.
 * upgradable   a few hosts do answer TLS; upgrading is free.
 * plaintext    the APK's native layer (`/_img`), which fetches it on the device;
 *              anywhere else the address itself.
 *
 * Exported for `artworkRoute.test.ts`, which pins each outcome above against the
 * hosts this catalogue actually carries — the routing decision is invisible from
 * the outside, since every wrong answer is still a perfectly valid-looking URL
 * string, so a regression here is silent until it reaches a television.
 */
export function safeImage(url: string | null): string | null {
  if (url === null || url === '') return null;
  /* Some catalogues' posters are TMDB files copied onto a copy host that is
     both dead and plaintext. The original is still on image.tmdb.org, so the
     rewrite recovers a real picture rather than a letter tile. */
  const t = rewriteArtwork(url.trim()) || url.trim();
  if (t.startsWith('https://')) return t;
  if (!t.startsWith('http://')) return null;
  const host = (t.slice(7).split(/[/:?#]/)[0] ?? '').toLowerCase();
  if (TLS_OK.has(host)) return `https://${t.slice(7)}`;
  /*
   * The television app draws plain-http pictures through its OWN native layer.
   *
   * Its page is `https://localhost`, and the WebView blocks a plain-http image
   * on it however the app is configured — measured on the TV emulator (Chromium
   * 143, `MIXED_CONTENT_ALWAYS_ALLOW` set): "requested an insecure image … This
   * request has been blocked", with the request never leaving the renderer. Most
   * provider logos and covers are plain http, so on a current box they could not
   * show at all. A same-origin address is not mixed content, and the native
   * interceptor answers it (MainActivity: LogoStore, then PosterImageCache, which
   * fetch the original themselves) on the device.
   */
  if (isNativeShell()) return nativeImage(t);
  return t;
}

/** The same-origin address the app's native layer answers for a plain-http picture. */
export const NATIVE_IMAGE_PATH = '/_img';
export function nativeImage(httpUrl: string): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'https://localhost';
  return `${origin}${NATIVE_IMAGE_PATH}?u=${encodeURIComponent(httpUrl)}`;
}

function toItem(v: ItemView): Item {
  return {
    id: v.id,
    // `<kind>.<provider id>`: survives a rebuild, unlike `id`.
    ref: v.streamId === null ? null : `${v.kind}.${v.streamId}`,
    kind: v.kind,
    streamId: v.streamId,
    categoryId: v.categoryId,
    /* A channel's name as the panel says it now — see lib/liveNames.ts. */
    name: v.kind === KIND.Live ? liveName(v.streamId, v.name) : v.name,
    logo: safeImage(v.logo),
    ext: v.ext,
    tvgId: v.tvgId,
    archive: v.archive,
    archiveDays: v.archiveDays,
    rating: v.rating,
    year: v.year,
    direct: v.direct,
  };
}

/**
 * The client query, from the wire query. One place, so the mapping is checkable.
 *
 * Exported for `localQuery.test.ts`, which exists because "checkable" was not the
 * same as "checked": a clause dropped here does not throw, does not log, and does
 * not return an error — it returns MORE rows than were asked for. The adult
 * exclusion is deliberately NOT a clause: core-store applies it on every read, so
 * there is nothing here to forget.
 */
/** The channels a topic exclusion leaves out, once the topic index can say. */
function excluded(topic: string | undefined): ReadonlySet<number> | null {
  if (topic === undefined || topic === '') return null;
  const set = topicSet(topic);
  return set === null || set.size === 0 ? null : set;
}

export function toQuery(section: Section, q: ItemQuery): Query {
  const paths = [
    ...(q.path ? [q.path] : []),
    ...(q.paths ?? []),
    ...(q.markets ?? []),
  ];
  // Check if we're on the adult section to bypass adult filter
  const isAdult = typeof window !== 'undefined' && window.location.pathname.startsWith('/adult');
  return {
    kind: SECTION_KIND[section],
    ...(q.offset !== undefined ? { offset: q.offset } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.categoryId != null ? { categoryId: q.categoryId } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(q.cats && q.cats.length > 0 ? { cats: q.cats } : {}),
    ...(q.hidePaths && q.hidePaths.length > 0 ? { hidePaths: q.hidePaths } : {}),
    ...(hiddenCatIds(q) ? { hideCats: hiddenCatIds(q)! } : {}),
    ...(q.genres && q.genres.length > 0
      ? { genres: q.genres }
      : q.genre ? { genres: [q.genre] } : {}),
    ...(q.region ? { region: q.region } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.archiveOnly ? { archiveOnly: true } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.yearFrom != null ? { yearFrom: q.yearFrom } : {}),
    ...(q.yearTo != null ? { yearTo: q.yearTo } : {}),
    ...(q.minRating != null ? { minRating: q.minRating } : {}),
    ...(q.addedSince != null ? { addedSince: q.addedSince } : {}),
    ...(q.oneCopy ? { oneCopy: true } : {}),
    ...(q.streamIds !== undefined ? { streamIds: q.streamIds } : {}),
    ...(q.hideStreams && q.hideStreams.length > 0 ? { hideStreams: q.hideStreams } : {}),
    ...(excluded(q.excludeTopic) ? { excludeStreams: excluded(q.excludeTopic)! } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(isAdult ? { includeAdult: true } : {}),
    ...(q.adultOnly ? { adultOnly: true } : {}),
    ...(q.dir ? { dir: q.dir } : {}),
  };
}

/**
 * Every matching row of a section, unclamped — for faceting and client filters.
 *
 * `localItems` is a PAGE and the store caps a page at 200. That cap is correct,
 * and it is also why this exists: counting the studios across 14,839 films
 * through a paged reader counts them across the first 200 and reports the answer
 * with the same confidence.
 *
 * Rows go through `toItem`, the same mapper `localItems` uses, and that matters
 * most for the artwork. Posters on this catalogue come from several places —
 * `image.tmdb.org`, `www.themoviedb.org`, plaintext picon hosts, IP-literal hosts
 * that can never hold a certificate — and `toItem` is where `safeImage` decides
 * which of those answer, which need their scheme upgraded, and which go through
 * the app's native layer. A second route to a row that built its
 * own logo would produce blank tiles for a reason invisible in the markup.
 */
export function localAllItems(section: Section, q: ItemQuery): Item[] {
  const cat = localCatalogue();
  if (cat === null) return [];
  return listAll(cat, toQuery(section, q)).map(toItem);
}

/**
 * Every matching row, SORTED as `q` says, one poster per title when it asks.
 *
 * `localAllItems` is match order and ignores `sort` and `oneCopy` — right for
 * counting, wrong for a list somebody reads from the top. See `listAllSorted`.
 */
export function localAllItemsSorted(section: Section, q: ItemQuery): Item[] {
  const cat = localCatalogue();
  if (cat === null) return [];
  return listAllSorted(cat, toQuery(section, q)).map(toItem);
}

/**
 * Every matching row, one at a time, handing the screen back between slices.
 *
 * `localAllItems` is right for a list somebody is waiting to see and wrong for
 * work nobody is waiting for: on a 40,000-channel line it builds every row in
 * one go — 877 ms on the TV emulator, several seconds on a real box's slower
 * processor — and every press in that time waits. A background job walks the
 * library here instead: `budgetMs` of rows, then a pause for whatever the
 * viewer did meanwhile, then the next. The same rows, the same `Item`s.
 * `visit` returning false stops the walk.
 */
export async function eachLocalItem(
  section: Section, q: ItemQuery, visit: (item: Item, n: number) => boolean | void, budgetMs = 8,
): Promise<void> {
  const cat = localCatalogue();
  if (cat === null) return;
  const rows = matchRows(cat, toQuery(section, q));
  let since = performance.now();
  for (let n = 0; n < rows.length; n += 1) {
    if (visit(toItem(viewItem(cat.items, rows[n]!)), n) === false) return;
    if ((n & 63) === 63 && performance.now() - since > budgetMs) {
      // eslint-disable-next-line no-await-in-loop
      await breather();
      since = performance.now();
    }
  }
}


/**
 * Hidden packages, as ids this store understands.
 *
 * The app stores them as `<kind>.<provider id>` refs, because row ids are
 * per-build — the on-device store assigns its own sequential ids and keeps
 * `remoteId` for matching, which is precisely the mapping this needs.
 */
function hiddenCatIds(q: { hideCats?: number[]; hideCatRefs?: string[] }): number[] | null {
  const ids = [...(q.hideCats ?? [])];
  const refs = q.hideCatRefs ?? [];
  if (refs.length > 0) {
    const cat = localCatalogue();
    if (cat) {
      const want = new Set(refs);
      for (const c of cat.categories) {
        if (want.has(`${c.kind}.${c.remoteId}`)) ids.push(c.id);
      }
    }
  }
  return ids.length > 0 ? ids : null;
}

function scopeQuery(section: Section, hide?: Hidden): Query {
  return {
    ...scopeQueryInner(section, hide),
    /* Structure over contents: on an on-demand library the packages that have not
       been downloaded still have to be listed, or there is nothing to press. */
    ...(libraryMode() === 'ondemand' ? { includeEmpty: true } : {}),
  };
}

function scopeQueryInner(section: Section, hide?: Hidden): Query {
  return toQuery(section, {
    ...(hide?.markets ? { markets: hide.markets } : {}),
    ...(hide?.paths ? { paths: hide.paths } : {}),
    ...(hide?.genres ? { genres: hide.genres } : {}),
    ...(hide?.cats ? { cats: hide.cats } : {}),
    ...(hide?.region ? { region: hide.region } : {}),
    ...(hide?.source ? { source: hide.source } : {}),
    ...(hide?.yearFrom != null ? { yearFrom: hide.yearFrom } : {}),
    ...(hide?.yearTo != null ? { yearTo: hide.yearTo } : {}),
    ...(hide?.minRating != null ? { minRating: hide.minRating } : {}),
    ...(hide?.q ? { q: hide.q } : {}),
    ...(hide?.hidePaths ? { hidePaths: hide.hidePaths } : {}),
    ...(hide?.hideCats ? { hideCats: hide.hideCats } : {}),
    ...(hide?.hideCatRefs ? { hideCatRefs: hide.hideCatRefs } : {}),
    ...(hide?.hideStreams ? { hideStreams: hide.hideStreams } : {}),
    ...(hide?.excludeTopic ? { excludeTopic: hide.excludeTopic } : {}),
  });
}

/**
 * "Nothing here" is an ANSWER when this device IS the library.
 *
 * Every reader below returns null when there is no catalogue, and `api.ts`
 * turns null into a rejection. react-query keeps the LAST SUCCESSFUL data when a
 * refetch fails, so the failure would be invisible: after switching accounts the
 * previous account's categories would stay on screen indefinitely, although the
 * store was already correct and the rows had already gone.
 *
 * So: while the on-device library is on, an empty catalogue answers emptily.
 * With it off, null still means "not answerable here".
 */
function whenEmpty<T>(answer: T): T | null {
  return localEnabled() ? answer : null;
}

export function localItems(section: Section, q: ItemQuery): Page<Item> | null {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ rows: [], total: 0, offset: q.offset ?? 0, limit: q.limit ?? 0 });
  const page = listItems(cat, toQuery(section, q));
  return { rows: page.rows.map(toItem), total: page.total, offset: page.offset, limit: page.limit };
}

/**
 * Index of a live/vod row in the filtered list, or -1 when absent / no catalogue.
 */
export function localIndexOfItem(
  section: Section,
  q: ItemQuery,
  itemId: number,
  familyIds?: ReadonlySet<number>,
): number {
  const cat = localCatalogue();
  if (!cat) return -1;
  return indexOfItem(cat, toQuery(section, q), itemId, familyIds);
}

/**
 * A stable ref, or this store's own row id.
 *
 * Refs (`<kind>.<provider id>`) reach here whenever a link was built on one —
 * which is every link — so resolving them is what keeps bookmarks and restored
 * tabs working across a rebuild.
 */
export function localItem(id: number | string): Item | null {
  const row = rowFor(id);
  return row === null ? null : toItem(row);
}


/** The row behind a ref or an id, or null. Shared by every by-id read. */
function rowFor(id: number | string, includeAdult?: boolean): ItemView | null {
  const cat = localCatalogue();
  if (!cat) return null;
  const ref = typeof id === 'string' ? /^([0-3])\.(\d{1,12})$/.exec(id) : null;
  if (ref === null) return getItem(cat, Number(id), includeAdult);
  const at = streamRowIndex(cat, Number(ref[1]), Number(ref[2]));
  return at === null ? null : getItem(cat, at, includeAdult);
}

/**
 * Provider-ref → row, rebuilt once per catalogue generation.
 *
 * Channel open used to call `findByStream` (linear over every row) for play and
 * again for variants — tens of milliseconds of main-thread work before the
 * demuxer even started. The map is built lazily on first lookup.
 */
let streamIndex: Map<string, number> | null = null;
let streamIndexGen: number | null = null;

function streamRowIndex(cat: Catalogue, kind: number, streamId: number): number | null {
  if (streamIndex === null || streamIndexGen !== cat.generation) {
    const map = new Map<string, number>();
    const { count, streamId: ids, kind: kinds } = cat.items;
    for (let i = 0; i < count; i++) {
      const sid = ids[i] ?? 0;
      if (sid === 0) continue;
      map.set(`${kinds[i]}.${sid}`, i);
    }
    streamIndex = map;
    streamIndexGen = cat.generation;
  }
  return streamIndex.get(`${kind}.${streamId}`) ?? null;
}

/**
 * Live family key → sibling rows, same lifetime as `streamIndex`.
 *
 * `localVariants` used to walk the whole live catalogue on every channel press
 * (~20ms on a 55k catalogue). The quality menu only needs the handful of feeds
 * that share a key.
 */
let familyIndex: Map<string, number[]> | null = null;
let familyIndexGen: number | null = null;

function familyRows(cat: Catalogue, key: string): readonly number[] {
  if (familyIndex === null || familyIndexGen !== cat.generation) {
    const map = new Map<string, number[]>();
    const { count, kind } = cat.items;
    for (let i = 0; i < count; i++) {
      if (kind[i] !== KIND.Live || rowIsAdult(cat, i)) continue;
      const k = familyKey(cat, i);
      const held = map.get(k);
      if (held) held.push(i);
      else map.set(k, [i]);
    }
    familyIndex = map;
    familyIndexGen = cat.generation;
  }
  return familyIndex.get(key) ?? [];
}

/**
 * Playing something the device already holds the URL for.
 *
 * A playlist entry needs no resolving: the URL IS the item. Measured on a real
 * country list — 160 channels — 94% are HLS and 85% are already HTTPS, so the
 * ordinary case is a direct play from the broadcaster. The remaining plaintext
 * ones are named honestly rather than failing
 * as a blocked request nobody can interpret: a browser on an HTTPS page will not
 * load them, and the Android app will.
 */
export function localPlay(
  id: number | string, format?: 'ts' | 'm3u8',
): PlaybackTarget | null {
  // Try normal lookup first, then adult-aware lookup for items from /adult
  let row = rowFor(id);
  if (row === null) row = rowFor(id, true);
  if (row === null) return null;

  /* A playlist entry needs no resolving: the URL IS the item. */
  if (row.url !== null && row.url !== '') {
    const url = row.url;
    const lower = url.toLowerCase();
    const container: PlaybackTarget['container'] = lower.includes('.m3u8')
      ? 'hls'
      : (lower.endsWith('.ts') || lower.includes('.ts?') ? 'mpegts' : 'file');
    const notes: string[] = [];
    if (url.startsWith('http://') && !fetchesItsOwnMedia() && typeof location !== 'undefined'
        && location.protocol === 'https:') {
      notes.push('This channel is published over plain HTTP. A browser on a secure page '
        + 'refuses to load it; it plays in the Android app.');
    }
    if (!fetchesItsOwnMedia() && browserHostile(url)) {
      notes.push('This channel only allows playback from its own site, so a browser '
        + 'cannot open it. It plays in the Android app.');
    }
    /* What the playlist said this stream wants sent with it. Only the native player
       can act on a User-Agent or Referer; the page ignores them and plays on. */
    const headers = headersFor(row.streamId);
    return { url, container, direct: true, notes, ...(headers === null ? {} : { headers }) };
  }

  /*
   * A panel item is BUILT, not fetched.
   *
   * The panel has no endpoint that hands out a stream URL — the path shape is the
   * contract. The device holds the credentials, so it does the building.
   *
   * `buildStreamUrl` and `resolveLiveExt` are browser-safe and covered by
   * `core-xtream/test/urls.test.ts`.
   */
  const base = streamBase();
  const cred = credentials();
  if (base === null || cred === null || row.streamId === null) return null;
  // See `localPlayReason` below for what each of the checks above means to a
  // viewer, once `api.ts` has decided this null is worth explaining.

  const isLive = row.kind === KIND.Live;
  /* `allowed_output_formats` gates what this account may ask for; measured on the
     live line it is m3u8,ts,rtmp. m3u8 first because hls.js plays it in every
     webview, where a raw transport stream needs a demuxer we may not have. */
  const ext = isLive
    ? resolveLiveExt(subscription()?.allowedFormats ?? null, liveFormatFor(currentPlatform(), format))
    : (row.ext ?? 'mp4');
  const url = buildStreamUrl(
    normaliseServerUrl(base), cred,
    { kind: row.kind as 1 | 2 | 3, streamId: row.streamId, ext },
  );
  const container: PlaybackTarget['container'] = ext === 'm3u8'
    ? 'hls' : (ext === 'ts' ? 'mpegts' : 'file');
  /* Only ever set for a film, and only when the detail page has already been
     opened — which for a film is always, because there is no other way to reach
     PLAY. A live channel is never in this map: this panel publishes no codec for
     one, which is the gap `escalate()` and the picture watchdog exist to cover. */
  const codec = titleCodec(row.id);
  return { url, container, direct: true, notes: [], ...(codec === null ? {} : { codec }) };
}

/**
 * Why `localPlay` just answered null, for a caller that is about to say so out
 * loud.
 *
 * Read straight off the same checks `localPlay` makes above — this is not a
 * second opinion, it is the reason worded for a viewer instead of for a branch.
 * `whyNoPlay` (`lib/playUnavailable.ts`) is the part that is actually tested;
 * this is just the plumbing that hands it the facts.
 */
export function localPlayReason(id: number | string): PlayUnavailableReason {
  let row = rowFor(id);
  if (row === null) row = rowFor(id, true);
  return whyNoPlay({
    hasCatalogue: localCatalogue() !== null,
    rowFound: row !== null,
    hasCredentials: streamBase() !== null && credentials() !== null,
    hasStreamId: row !== null && row.streamId !== null,
  });
}

/**
 * A film this device holds, without asking a panel for metadata it has none of.
 *
 * A playlist carries a name, a logo and a URL — there is no plot, no cast and no
 * runtime to fetch, and pretending otherwise turns opening a playlist title into
 * an error. `detail: null` is the honest answer and the page already renders it:
 * it is the same shape a panel returns for a title it knows nothing about.
 */
export function localMovieDetail(id: number | string, fromAdult?: boolean): MovieDetailResponse | null {
  const cat = localCatalogue();
  const row = rowFor(id, fromAdult);
  if (cat === null || row === null) return null;
  const c = row.categoryId === null
    ? null
    : cat.categories.find((x) => x.id === row.categoryId) ?? null;
  const category: CategoryFacts | null = c === null ? null : {
    id: c.id,
    name: c.name,
    cleanName: c.cleanName,
    genres: [...c.genres],
    region: c.region,
    source: c.source,
    path: [...c.path],
  };
  return { item: toItem(row), category, detail: null };
}

/**
 * The same page, with the panel's own metadata filled in.
 *
 * `localMovieDetail` stays synchronous and keeps answering `detail: null`, which
 * is the honest shape for a playlist entry and what the page already renders. This
 * is the async sibling for a panel title, so the plot, cast, runtime and backdrops
 * arrive without the page having to wait for them to decide what it is.
 */
export async function localMovieDetailFull(id: number | string, fromAdult?: boolean): Promise<MovieDetailResponse | null> {
  const base = localMovieDetail(id, fromAdult);
  if (base === null) return null;
  const row = rowFor(id, fromAdult);
  /* A playlist entry carries a name, a logo and a URL. There is no plot to fetch
     and no panel to ask. */
  if (row === null || row.direct || row.streamId === null) return base;
  const detail = await movieInfo(row.streamId);
  if (detail === null) return base;
  /* Remembered on the way past, for the same reason episodes are: `api.play`
     takes an item id and a container format and has no room for a codec, and
     this is the one moment the panel's answer is in hand. Measured 2026-09-07,
     `get_vod_info` published a codec for 17 of 25 sampled films — enough to be
     worth reading, not enough to depend on, which is what an optional field on
     `PlaybackTarget` says. */
  rememberTitleCodecs(row.id, detail.video?.codec ?? null, detail.audio?.codec ?? null);
  return {
    ...base,
    detail: {
      ...detail,
      cover: safeImage(detail.cover ?? null),
      backdrops: (detail.backdrops ?? []).map((b) => safeImage(b)).filter((b): b is string => b !== null),
    },
  } as MovieDetailResponse;
}

/**
 * One series, its episode tree, and the artwork made loadable.
 *
 * Shaped as `SeriesDetail` in `api.ts`. The row supplies name, cover and rating —
 * the catalogue already holds those — and the panel supplies only what it alone
 * knows: the seasons, the episodes, and the cast and plot.
 */
export async function localSeriesDetail(id: number | string): Promise<SeriesDetailResponse | null> {
  const cat = localCatalogue();
  const row = rowFor(id);
  if (cat === null || row === null || row.streamId === null) return null;
  const c = row.categoryId === null
    ? null
    : cat.categories.find((x) => x.id === row.categoryId) ?? null;
  const category: CategoryFacts | null = c === null ? null : {
    id: c.id, name: c.name, cleanName: c.cleanName,
    genres: [...c.genres], region: c.region, source: c.source, path: [...c.path],
  };
  const info = await seriesInfo(row.streamId);
  return {
    series: {
      id: row.id, series_id: row.streamId, name: row.name,
      cover: safeImage(row.logo), plot: info?.meta?.plot ?? null,
      genre: c?.genres.join(', ') ?? null,
      rating: row.rating, release_date: row.year,
    },
    category,
    detail: {
      seasons: info?.seasons ?? [],
      episodes: (info?.episodes ?? []).map((e) => {
        /* Nullish rather than a plain read: `localDetail` caches this payload in
           IndexedDB for twelve hours, so a device that opened this series before
           the codec fields existed has rows without them, and `undefined` there
           must mean "unknown" rather than reach the player as a codec string. */
        const videoCodec = e.videoCodec ?? null;
        const audioCodec = e.audioCodec ?? null;
        rememberTitleCodecs(e.episodeId, videoCodec, audioCodec);
        return {
          episodeId: e.episodeId, seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber, title: e.title, ext: e.ext,
          plot: e.plot, durationSecs: e.durationSecs, image: safeImage(e.image),
          videoCodec, audioCodec,
        };
      }),
    },
    meta: info?.meta ?? null,
  } as SeriesDetailResponse;
}

/**
 * What the panel said is inside a title, kept between opening its page and
 * pressing PLAY on it.
 *
 * The resolvers below are handed an id and, at most, a container format. They
 * cannot go and look the codec up: for an episode there is nothing to look it up
 * IN — an episode is not in the on-device catalogue at all, it exists only inside
 * a `get_series_info` payload — and for a film the catalogue row carries a name,
 * an extension and an image, never a codec. The fact lives for one function call
 * in `localSeriesDetail` / `localMovieDetailFull` and is then thrown away.
 *
 * Widening the resolvers' signatures would mean widening `api.episodePlay` and
 * `api.play`, and then every caller of both, to carry a value that was in this
 * module thirty milliseconds earlier. So it is remembered on the way past
 * instead, and the ORDER makes that sound rather than lucky: nothing can press
 * play on an episode without `localSeriesDetail` having run first, because the
 * extension the URL needs comes from that same payload; nothing can press play on
 * a film without its detail page having opened.
 *
 * Bounded, because a viewer who browses forty series in a session should not be
 * holding forty episode trees: `TITLE_CODEC_MAX` entries, oldest evicted. A miss
 * is not a failure — the engine is then chosen from the file extension, exactly
 * as it was before any of this existed.
 */
const TITLE_CODEC_MAX = 2_000;
/* Two id namespaces share this map and cannot collide: an episode is keyed on
   `episode.id` from the panel and a film on its catalogue ROW id, and a film's
   row id is only ever read back by `localPlay` for that same row. Keeping them
   apart would buy nothing and would mean two identical evictions to maintain. */
const titleCodecs = new Map<number, string>();

function rememberTitleCodecs(id: number, video: string | null, audio: string | null): void {
  const codec = [video, audio].filter((c): c is string => typeof c === 'string' && c !== '').join(',');
  if (codec === '') return;
  /* Delete before set so a re-open moves the entry to the end of the insertion
     order rather than leaving it as the next thing to be evicted. */
  titleCodecs.delete(id);
  titleCodecs.set(id, codec);
  while (titleCodecs.size > TITLE_CODEC_MAX) {
    const oldest = titleCodecs.keys().next();
    if (oldest.done) break;
    titleCodecs.delete(oldest.value);
  }
}

/** Exported for the tests, and for a debug panel that wants to show the miss. */
export function titleCodec(id: number): string | null {
  return titleCodecs.get(id) ?? null;
}

/**
 * The stream URL for one episode.
 *
 * An episode is `kind: 3` with the EPISODE's own id, not the series' — the two are
 * different namespaces and using the wrong one plays a different programme.
 *
 * ── the extension is not a formality ──
 *
 * `ext ?? 'mp4'` reads like a harmless default and is not one. Measured against
 * the live panel 2026-09-07 (`scripts/series-probe.mjs`): asking
 * `/series/<user>/<pass>/<id>.mp4` for an episode the panel holds as `.mkv`
 * answers **551**, and asking with no extension at all answers 551 as well —
 * where the right extension answers 302 and then 206 with the file. 54% of
 * sampled episodes are `.mkv`. So the default is only ever correct by luck, and
 * it exists solely because the caller's `ext` is typed nullable; the panel
 * published one for every episode in the sample.
 */
export function localEpisodePlay(episodeId: number, ext?: string): PlaybackTarget | null {
  const base = streamBase();
  const cred = credentials();
  if (base === null || cred === null) return null;
  const use = ext ?? 'mp4';
  const codec = titleCodec(episodeId);
  return {
    url: buildStreamUrl(normaliseServerUrl(base), cred,
      { kind: 3, streamId: episodeId, ext: use }),
    container: use === 'm3u8' ? 'hls' : (use === 'ts' ? 'mpegts' : 'file'),
    direct: true,
    notes: [],
    ...(codec === null ? {} : { codec }),
  };
}

/**
 * Why `localEpisodePlay` just answered null.
 *
 * It never looks at the catalogue — an episode is not a row in it, only
 * something inside a `get_series_info` payload — so `base`/`cred` missing is the
 * only path in, and that is always the account this device holds no longer
 * being signed in.
 */
export function localEpisodePlayReason(): PlayUnavailableReason {
  return whyNoPlay({
    hasCatalogue: true, rowFound: true, hasStreamId: true,
    hasCredentials: streamBase() !== null && credentials() !== null,
  });
}

export function localCategories(section: Section, hide?: Hidden): { categories: Category[] } | null {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ categories: [] });
  return {
    categories: listCategories(cat, scopeQuery(section, hide)).map((c) => ({
      id: c.id,
      /* `<kind>.<provider id>`, from the store's own `remoteId` — so a hidden
         package stays hidden across a rebuild, not tied to a row id. */
      ref: `${c.kind}.${c.remoteId}`,
      name: c.name,
      cleanName: c.cleanName,
      count: c.count,
      genres: c.genres,
      region: c.region,
      source: c.source,
      path: [...c.path],
    })),
  };
}

export function localFacets(section: Section, hide?: Hidden): Facets | null {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ genres: [], regions: [], sources: [] });
  return listFacets(cat, scopeQuery(section, hide));
}

export function localGroups(section: Section, hide?: Hidden): GroupsResponse | null {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ tree: [], total: 0, ungrouped: 0 });
  const { tree, total, ungrouped } = listGroups(cat, scopeQuery(section, hide));
  return { tree, total, ungrouped };
}

export function localMarkets(section: Section, hide?: Hidden): { markets: Market[] } | null {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ markets: [] });
  return {
    markets: listMarkets(cat, scopeQuery(section, hide)).map((m) => ({
      id: m.id,
      label: m.label,
      count: m.count,
      /* The API type's `categories` is a COUNT while the store's is a list of
         ids — two types, one name. */
      categories: m.categories.length,
    })),
  };
}

/**
 * Search, in two passes, and only the second one can ever wait for anything.
 *
 * The exact pass needs no dictionary and answers every keystroke: measured on
 * this provider's 266,141-row catalogue, 4-8ms for all three sections against
 * 15-45ms for the three `matchRows` scans it replaces. It runs first, always.
 *
 * The correction pass runs only when that answer was too thin to be an answer,
 * and it is the only thing here that awaits: `ensureSearchIndex` resolves
 * immediately once the dictionary is built, and the build was started when the
 * search screen mounted, several seconds and a dozen D-pad presses ago. When it
 * has not finished — or the device is short of memory, or there is no local
 * catalogue at all — the exact answer stands. A missing correction is a smaller
 * failure than a stalled keyboard.
 *
 * Async, so this goes through `fromDeviceAsync` in `api.ts` rather than the
 * synchronous helper the other catalogue reads use.
 */
export async function localSearch(
  q: string,
): Promise<{ live: Item[]; movies: Item[]; series: Item[]; corrected: boolean } | null> {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ live: [], movies: [], series: [], corrected: false });
  const shape = (found: ReturnType<typeof search>) => ({
    live: found.live.map(toItem),
    movies: found.movies.map(toItem),
    series: found.series.map(toItem),
    corrected: found.corrected,
  });

  const exact = search(cat, q, { limit: 24 });
  if (exact.total >= CORRECTION_FLOOR) return shape(exact);
  const index = await ensureSearchIndex();
  if (index === null) return shape(exact);
  /* Re-read the catalogue: an ingest can land while the dictionary is building,
     and searching the old columns with the new generation's index would answer
     with rows that no longer exist. */
  const now = localCatalogue();
  if (now === null || now.generation !== cat.generation) return shape(exact);
  return shape(search(now, q, { limit: 24, index }));
}

/**
 * Fast synchronous search for autocomplete suggestions.
 *
 * Returns content titles AND cast/actor names that match the query,
 * suitable for showing as autocomplete suggestions while typing.
 * When the user types an actor's name, they see both the actor suggestion
 * and movies featuring that actor.
 * Uses the exact search pass only — no spelling correction needed for suggestions.
 */
export function localSearchSuggestions(q: string, limit: number = 12): { name: string; type: string }[] {
  const cat = localCatalogue();
  if (!cat || q.length < 2) return [];
  const found = search(cat, q, { limit });
  const suggestions: { name: string; type: string }[] = [];
  const seen = new Set<string>();

  const add = (name: string, type: string) => {
    const key = `${type}:${name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      suggestions.push({ name, type });
    }
  };

  // Phase 1: Content titles from search results
  for (const view of found.live) {
    add(view.name ?? '', 'channel');
  }
  for (const view of found.movies) {
    add(view.name ?? '', 'movie');
  }
  for (const view of found.series) {
    add(view.name ?? '', 'series');
  }

  // Phase 2: Cast/actor names — scan all items for matching cast members
  const needle = q.toLowerCase().trim();
  const parts = needle.split(/\s+/).filter((w) => w.length > 0);
  const cast = cat.items.cast;
  const count = cat.items.count;

  // Collect matching actor names from cast column
  const actorNames = new Map<string, number>(); // folded name -> count
  for (let i = 0; i < count; i++) {
    const castText: string | undefined = (cast as any)[i];
    if (!castText || castText === '') continue;
    const words: string[] = castText.split(' ').filter((w: string) => w.length > 0);
    if (parts.length >= 2) {
      // Multi-word: look for consecutive match
      for (let j = 0; j <= words.length - parts.length; j++) {
        let ok = true;
        for (let k = 0; k < parts.length; k++) {
          if (words[j + k] !== parts[k]) { ok = false; break; }
        }
        if (!ok) continue;
        const id = parts.join(' ');
        actorNames.set(id, (actorNames.get(id) ?? 0) + 1);
      }
    } else {
      // Single word: find actors whose name starts with the query
      const token = parts[0]!;
      for (let j = 0; j < words.length; j++) {
        const w = words[j]!;
        if (w !== token && !w.startsWith(token)) continue;
        // Build a 2-word name if possible
        const next = words[j + 1];
        const prev = words[j - 1];
        const id = next && next.length > 1
          ? `${w} ${next}`
          : prev
            ? `${prev} ${w}`
            : w;
        actorNames.set(id, (actorNames.get(id) ?? 0) + 1);
      }
    }
  }

  // Add top actor suggestions (title-cased)
  const sortedActors = [...actorNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4); // cap at 4 actor suggestions

  for (const [id] of sortedActors) {
    const label = id.split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    add(label, 'actor');
  }

  return suggestions.slice(0, limit);
}

/**
 * What this device actually holds, counted from the columns.
 *
 * One scan over the flags column: 124,157 rows is a few milliseconds, and it is only read when a screen
 * asks. Adult rows and adult categories are left out of every count.
 */
/**
 * How much of a kind this library has: what is downloaded, or what it offers.
 *
 * Exported and pure because it is the rule that broke twice. See the note inside
 * `localInventory`. `kind` is the catalogue's own numbering — 2 films, 3 series.
 */
export function heldOrOffered(
  held: number,
  categories: { kind: number; itemCount?: number | undefined }[],
  kind: number,
): number {
  const offered = categories
    .filter((k) => k.kind === kind)
    .reduce((n, k) => n + (k.itemCount ?? 0), 0);
  return Math.max(held, offered);
}

export function localInventory(): Inventory | null {
  const cat = localCatalogue();
  if (!cat) return whenEmpty({ generation: null, live: 0, movies: 0, series: 0, archive: 0, guide: 0, adult: 0 });
  const c = cat.items;
  let archive = 0;
  let adult = 0;
  const onDevice = { live: 0, movies: 0, series: 0 };
  const adultCats = adultCategoryIds(cat);
  for (let i = 0; i < c.count; i++) {
    const f = c.flags[i] ?? 0;
    const kind = c.kind[i];
    const cid = c.categoryId[i] ?? 0;
    /* Check adult once, reusing the pre-computed category set */
    if (((f & FLAG.adult) !== 0) || (cid !== 0 && adultCats.has(cid))) {
      adult++;
      continue;
    }
    if ((f & FLAG.archive) !== 0) archive++;
    if (kind === 1) onDevice.live++;
    else if (kind === 2) onDevice.movies++;
    else if (kind === 3) onDevice.series++;
  }
  /* `tvgIds` is sparse — only the 18% of channels that carry one are keys — so
     its size IS the guide coverage, with no scan. */
  const guide = Object.keys(c.tvgIds).length;

  /* What the subscription OFFERS: packages that hold adult content are not part
     of any count. */
  const offered = cat.categories.filter((k) => !isAdultCategory(k));

  /*
   * Films and series are counted the same way, and for the same reason.
   *
   * `cat.counts.*` is what has been DOWNLOADED, and on an on-demand library that
   * is zero for everything nobody has opened yet. That was survivable while a
   * zero merely produced an empty grid; it stopped being survivable the moment
   * the app started HIDING sections that report zero, because a subscription with
   * 96,821 items behind it lost its Movies and Series tiles and was left with a
   * single enormous LIVE TV button. 
   *
   * `kind` is the catalogue's own: 2 films, 3 series. Categories are structure and
   * arrive with the library, so their item counts describe the whole subscription
   * whether or not a single package has been fetched.
   */
  /*
   * Nothing downloaded yet is NOT the same as nothing to download.
   *
   * `archive` and `guide` are counted by scanning the items this device holds,
   * and no category can tell you whether a channel records or carries listings —
   * so on a library whose packages have not been fetched, both are 0 and both are
   * simply UNKNOWN. Reporting that as "this subscription has no catch-up" is how
   * a device with 141,085 items behind it lost its Guide and Catch-up.
   *
   * `partial` says so out loud, and `hasSection` refuses to hide anything on a
   * zero it cannot trust. Live, films and series do not need it: their categories
   * describe the whole library whether or not a byte has been fetched.
   */
  const held = onDevice.live + onDevice.movies + onDevice.series;
  return {
    generation: cat.generation,
    live: heldOrOffered(onDevice.live, offered, 1),
    movies: heldOrOffered(onDevice.movies, offered, 2),
    series: heldOrOffered(onDevice.series, offered, 3),
    archive,
    guide,
    adult,
    partial: held === 0 && cat.categories.length > 0,
    /*
     * And what is on the device RIGHT NOW, kept beside what is offered.
     *
     * The two numbers above answer "may this section be navigated to", which is a
     * question about the subscription. The showcase asks a different one — "have I
     * any artwork to put on the page" — and answering it with the offered count is
     * what filled the home page with live channels on a library holding 66,709
     * films and no films. One inventory, both questions, neither guessed at.
     */
    onDevice,
  };
}

/**
 * The other feeds of the channel on screen.
 *
 * Pure: no network, no cache, no panel. The store already computes the two things
 * this needs — `familyKey`, which is what makes an FHD, an HD and an HEVC feed of
 * one channel one row in a list, and `qualityOf`, which names and ranks them —
 * because the collapse in `listItems` is built on exactly the same pair. So the
 * quality switch is the collapse read backwards: everything that WOULD have been
 * merged into this row.
 *
 * One honest limitation, and it is a property of the device rather than a bug: on
 * an on-demand library a sibling feed can sit in a package that was never
 * downloaded, so the switch offers what is here rather than what exists. The
 * alternative is downloading the whole catalogue to populate a menu.
 */
export function localVariants(id: number | string): { variants: Variant[] } | null {
  const cat = localCatalogue();
  if (cat === null) return whenEmpty({ variants: [] });
  const row = rowFor(id);
  if (row === null || row.kind !== KIND.Live) return { variants: [] };

  /* `ItemView.id` is the row index — no second catalogue walk. */
  const at = row.id;
  const key = familyKey(cat, at);
  /* A row with no market prefix or no normalised name gets a key of its own
     (`id:<row>`), which is what stops every unlabelled channel collapsing into one
     anonymous bucket — and it also means there is nothing to switch between. */
  if (key.startsWith('id:')) return { variants: [] };

  const found: { row: number; rank: number; label: string }[] = [];
  for (const i of familyRows(cat, key)) {
    const view = getItem(cat, i);
    if (view === null) continue;
    const q = qualityOf(view.name);
    found.push({ row: i, rank: q.rank, label: q.label });
    /* Enough for a menu. A family with more feeds than this is a provider
       publishing duplicates, not a choice anyone wants to scroll. */
    if (found.length >= 24) break;
  }
  if (found.length < 2) return { variants: [] };

  found.sort((a, b) => a.rank - b.rank || a.row - b.row);
  return {
    variants: found.map(({ row: i, label }) => {
      const view = getItem(cat, i)!;
      return {
        id: view.id,
        ref: view.streamId === null ? null : `${view.kind}.${view.streamId}`,
        name: view.name,
        quality: label,
        ext: view.ext,
        active: view.id === row.id,
      };
    }),
  };
}

/* ── the guide ──────────────────────────────────────────────────────────────
   Thin adapters: `localEpg.ts` speaks provider stream ids and slots, `api.ts`
   speaks the response shapes every screen already renders. Keeping the
   translation here means not one route had to learn where its guide comes from. */

/**
 * A stored slot as the screens read it.
 *
 * The one field the store does not keep is `nowPlaying`, deliberately: the panel
 * sets it to 0 on every row including the one that is on air, so storing it would
 * be storing a lie that also goes stale the moment it is written. It is a
 * question about the clock, not about the programme, so it is answered on read.
 */
function toSlot(s: Slot, nowS: number): EpgSlot {
  return {
    title: s.title, description: s.description,
    startTs: s.startTs, stopTs: s.stopTs,
    nowPlaying: s.startTs <= nowS && nowS < (s.stopTs ?? s.startTs + 3600),
    hasArchive: s.hasArchive,
  };
}

/** The provider stream id behind a link, or null for anything without one. */
function streamIdOf(id: number | string): number | null {
  const row = rowFor(id);
  return row === null || row.direct ? null : row.streamId;
}

export async function localEpg(id: number | string): Promise<EpgResponse | null> {
  const row = rowFor(id);
  const streamId = row !== null && row.direct ? row.streamId : streamIdOf(id);
  if (row === null || streamId === null) return null;
  const nowS = Math.floor(Date.now() / 1000);
  const { slots, now, upcoming } = await guideFor(row, streamId, nowS);
  return {
    channel: {
      id: row.id, name: row.name, tvgId: row.tvgId,
      archive: row.archive, archiveDays: row.archiveDays,
    },
    timezone: subscription()?.timezone ?? null,
    now: now === null ? null : toSlot(now, nowS),
    upcoming: upcoming.map((x) => toSlot(x, nowS)),
    slots: slots.map((x) => toSlot(x, nowS)),
    /* How many of these slots are actually reachable as catch-up. The channel's
       own window is the outer bound; the per-programme flag is the precise one. */
    archive: row.archive ? slots.filter((s) => s.hasArchive).length : 0,
  };
}

/**
 * One channel's guide: the bulk download when it has this channel, the
 * per-channel ask when it does not — see `lib/bulkGuide.ts`.
 *
 * A channel with catch-up still asks for itself: only the per-channel table
 * says which programmes can be replayed, and the player and the guide both
 * offer that per programme.
 */
async function guideFor(
  row: ItemView, streamId: number, nowS: number,
): Promise<{ slots: Slot[]; now: Slot | null; upcoming: Slot[] }> {
  /* A playlist channel has no panel to ask: the stored guide, or nothing. */
  if (row.direct) {
    const bulk = await bulkGuideUsable() ? await bulkSlots(row.tvgId, row.name) : null;
    if (bulk === null) return { slots: [], now: null, upcoming: [] };
    const { now, next } = nowNext(bulk, nowS);
    return { slots: closeGaps(bulk), now, upcoming: next };
  }
  if (!row.archive && await bulkGuideUsable()) {
    /* The stored guide has the last word — see `bulkGuideUsable`. */
    const bulk = await bulkSlots(row.tvgId, row.name);
    if (bulk === null) return { slots: [], now: null, upcoming: [] };
    const { now, next } = nowNext(bulk, nowS);
    return { slots: closeGaps(bulk), now, upcoming: next };
  }
  return localEpgFor(streamId);
}

export async function localEpgGrid(
  ids: readonly (number | string)[], fromTs: number, hours: number,
): Promise<GridResponse | null> {
  const cat = localCatalogue();
  if (cat === null) return whenEmpty({ from: Math.floor(fromTs), hours, now: Math.floor(Date.now() / 1000), timezone: null, channels: [] });
  const rows = ids.map((id) => ({ id, row: rowFor(id) })).filter((r) => r.row !== null);
  const streamIds = rows.map((r) => r.row!.streamId).filter((n): n is number => n !== null);
  const grid = await localEpgGridSlots(streamIds, Math.floor(fromTs), hours);
  const nowS = Math.floor(Date.now() / 1000);
  /* A channel the per-channel store has nothing for, answered from the bulk
     guide instead — the whole point of it is that a screen of rows costs no
     requests at all. */
  const toTs = Math.floor(fromTs) + hours * 3600;
  const decided = await bulkGuideUsable();
  for (const { row } of rows) {
    const r = row!;
    if (r.streamId === null) continue;
    const hit = grid.get(r.streamId);
    if (hit !== undefined && hit.slots.length > 0) continue;
    const bulk = await bulkSlots(r.tvgId, r.name);
    if (bulk !== null) {
      grid.set(r.streamId, { slots: windowOf(bulk, Math.floor(fromTs), toTs), known: true, until: null });
    } else if (decided && !r.archive) {
      /* Nothing in the stored guide, and nothing to ask for: known, and empty. */
      grid.set(r.streamId, { slots: [], known: true, until: null });
    }
  }
  return {
    from: Math.floor(fromTs), hours,
    now: nowS,
    timezone: subscription()?.timezone ?? null,
    channels: rows.map(({ row }) => {
      const r = row!;
      const hit = r.streamId === null ? undefined : grid.get(r.streamId);
      return {
        id: r.id,
        ref: r.streamId === null ? null : `${r.kind}.${r.streamId}`,
        name: r.name, logo: safeImage(r.logo),
        archive: r.archive, archiveDays: r.archiveDays,
        slots: (hit?.slots ?? []).map((x) => toSlot(x, nowS)),
        /* A playlist channel is not "not fetched yet" — there is nothing behind it
           to fetch. Saying `known` stops the guide polling it for ever. */
        known: r.direct ? true : (hit?.known ?? false),
        until: hit?.until ?? null,
      };
    }),
  };
}

export async function localEpgTopup(
  ids: readonly (number | string)[],
  /** Supersede what is still queued. The Guide turns pages; a list does not. */
  replace = false,
): Promise<{ queued: number; known: number; depth: number } | null> {
  if (localCatalogue() === null) return null;
  /* Nothing to ask for when the bulk guide already has the channel — unless it
     keeps catch-up, whose replayable flags only the per-channel table carries. */
  const streamIds: number[] = [];
  const decided = await bulkGuideUsable();
  for (const id of ids) {
    const row = rowFor(id);
    const sid = streamIdOf(id);
    if (row === null || sid === null) continue;
    if (!row.archive && (decided || await bulkSlots(row.tvgId, row.name) !== null)) continue;
    streamIds.push(sid);
  }
  const { queued, known } = await topUp(streamIds, { replace });
  return { queued, known, depth: schedulerDepth() };
}

/**
 * The subscription badge, from the device's own record.
 *
 * Shaped as `SourceInfo` in `api.ts`. `source` is null for a device without a
 * panel subscription — an ordinary state, and why the badge renders nothing
 * rather than an error.
 */
export function localSource(): import('./api.ts').SourceInfo {
  const p = activeProvider();
  if (p === null || p.kind !== 'xtream') return { source: null, account: null };
  const sub = subscriptionOf(p.id);
  const cat = localCatalogue();
  return {
    source: {
      id: p.id,
      label: p.name,
      /* Never the real host. It is of no use to a viewer and it is the one fact
         that makes a username and password worth guessing. */
      streamHost: '',
      serverTimezone: sub?.timezone ?? null,
      allowedFormats: sub?.allowedFormats ?? [],
      currentGeneration: cat?.generation ?? null,
      lastIngestAt: cat === null ? null : new Date(cat.builtAt).toISOString(),
      itemCount: cat?.items.count ?? 0,
    },
    account: sub === null ? null : {
      status: sub.status,
      expDate: sub.expiresAt === null ? null : new Date(sub.expiresAt).toISOString(),
      isTrial: sub.trial,
      activeCons: sub.activeConnections,
      maxConnections: sub.maxConnections,
      allowedOutputFormats: sub.allowedFormats,
    },
  };
}


/**
 * More like this, scored on the device.
 *
 * The weights:
 *
 *     3·sameCategory + sharedGenres
 *       + max(0, 1.5 − |Δyear| / 12)
 *       + max(0, 1.0 − |Δrating| / 4)
 *
 * Weighted so the group still dominates — it is the strongest signal the provider
 * gives — without deciding the order on its own.
 *
 * The scope is applied, and that is not incidental: without it this would be
 * the ONE surface where content a profile had excluded reached the screen.
 *
 * Ties break on FNV-1a over `name || anchorId`, so the order is stable.
 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

export function localRelated(
  id: number | string, section: Section, limit: number, hide?: Hidden,
): { category: CategoryFacts | null; rows: Item[] } | null {
  const cat = localCatalogue();
  const anchor = rowFor(id);
  if (cat === null || anchor === null) return null;

  const c = anchor.categoryId === null
    ? null
    : cat.categories.find((x) => x.id === anchor.categoryId) ?? null;
  const category: CategoryFacts | null = c === null ? null : {
    id: c.id, name: c.name, cleanName: c.cleanName,
    genres: [...c.genres], region: c.region, source: c.source, path: [...c.path],
  };

  const genres = new Set(c?.genres ?? []);
  const anchorYear = anchor.year === null ? null : Number(anchor.year);
  const anchorRating = anchor.rating;

  /* The candidate set is the section under the profile's scope — same query the
     grid runs, so anything hidden there is hidden here. */
  const pool = listItems(cat, { ...scopeQuery(section, hide), limit: 200, offset: 0 });
  const wider = listItems(cat, {
    ...scopeQuery(section, hide),
    limit: 200, offset: 0,
    ...(c === null ? {} : { categoryId: c.id }),
  });
  const seen = new Map<number, Item>();
  for (const r of [...wider.rows, ...pool.rows]) if (!seen.has(r.id)) seen.set(r.id, toItem(r));

  const scored: { row: Item; score: number; tie: number }[] = [];
  for (const row of seen.values()) {
    if (row.id === anchor.id) continue;
    const rc = row.categoryId === null
      ? null
      : cat.categories.find((x) => x.id === row.categoryId) ?? null;
    let score = rc !== null && c !== null && rc.id === c.id ? 3 : 0;
    for (const g of rc?.genres ?? []) if (genres.has(g)) score += 1;
    const y = row.year === null ? null : Number(row.year);
    if (y !== null && anchorYear !== null) score += Math.max(0, 1.5 - Math.abs(y - anchorYear) / 12);
    if (row.rating !== null && anchorRating !== null) {
      score += Math.max(0, 1.0 - Math.abs(row.rating - anchorRating) / 4);
    }
    if (score <= 0) continue;
    scored.push({ row, score, tie: fnv1a(`${row.name}${anchor.id}`) });
  }
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie);
  return { category, rows: scored.slice(0, Math.max(1, limit)).map((x) => x.row) };
}
