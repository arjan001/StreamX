/** Typed reads of the on-device catalogue. Every list call is a bounded page. */

/**
 * Where the API lives.
 *
 * On the web it lives nowhere in particular: one Fastify process serves the built
 * app AND its few routes (error reports, remote config, captions) on a single
 * port, so a relative path is same-origin and strictly better — no CORS, no
 * config, no absolute URL baked into a bundle that might be served from a
 * different host tomorrow.
 *
 * A wrapped build has no such luxury. Electron loads the app over `file://` and
 * Capacitor over `https://localhost` (Android) or `capacitor://localhost` (iOS);
 * in all three the relative path resolves against an origin that has no API
 * behind it, and every request 404s with no clue why. So packaged builds set
 * `VITE_API_ORIGIN` and every path goes through `apiUrl()`.
 *
 * Deliberately NOT the existing `VITE_API_BASE`: that one is read by vite.config
 * as the dev proxy TARGET. Because it is `VITE_`-prefixed it also reaches the
 * client, so reusing it would make the dev browser bypass its own proxy and hit
 * the API cross-origin — which fails, because nothing serves CORS headers for the
 * vite dev origin.
 */
/* Defined in vite.config (`apiOrigin`). */
const ORIGIN = ((import.meta.env?.VITE_API_ORIGIN as string | undefined) ?? '').replace(/\/+$/, '');

/* Imported for their side-effect-free readers only. `localItems` and friends
   return null whenever the on-device catalogue is absent or disabled. */
import {
  localCategories, localFacets, localGroups, localInventory, localItem, localItems, localMarkets,
  localVariants, localEpg, localEpgGrid, localEpgTopup, localSource,
  localSeriesDetail, localMovieDetailFull, localEpisodePlay, localEpisodePlayReason, localRelated,
  localMovieDetail, localPlay, localPlayReason, localSearch,
} from './localRead.ts';
import { localEnabled } from './localCatalogue.ts';
import { PlayUnavailable } from './playUnavailable.ts';
import { stalkerActive } from './providers/index.ts';
import { stalkerEpisodePlay, stalkerPlay } from './stalkerPlay.ts';
/* The archive builder is its own module rather than a `localRead.ts` export:
   unlike every read above it makes a network probe (family detection) and
   throws on a well-formed-but-unplayable request, instead of only ever
   returning null. See `localArchive.ts` for why. */
import { localArchivePlay } from './localArchive.ts';

/**
 * Absolute form of an API path.
 *
 * Identity on the web, origin-prefixed in a wrapper. Anything that hands a URL to
 * the platform rather than to `fetch` — a `<track src>`, a media element, a player
 * engine — has to go through here too, because those resolve against the document,
 * not against this module.
 */
export function apiUrl(path: string): string {
  if (ORIGIN === '' || !path.startsWith('/')) return path;
  return ORIGIN + path;
}

/**
 * The id to put in a URL or an API path.
 *
 * Prefers the stable ref and falls back to the row id, which is right for the two
 * cases that have no provider id: the opaque third-party entries, and the
 * on-device catalogue, whose ids are its own and which resolves them itself.
 */
export function linkId(item: { ref?: string | null; id: number }): string {
  return item.ref ?? String(item.id);
}

export interface Item {
  id: number;
  /**
   * The refresh-proof name for this row: `<kind>.<provider id>`.
   *
   * `id` is per generation — a re-ingest renumbers the whole
   * catalogue, so any link built from `id` dies at the next refresh. Every URL
   * and every API path should carry this instead; use `linkId()` rather than
   * reading it directly, because the on-device catalogue and the opaque
   * third-party entries have no provider id and fall back to `id`.
   */
  ref: string | null;
  kind: number;
  streamId: number | null;
  /**
   * The category this row sits in.
   *
   * Cheap and load-bearing: the client already holds the category list for its
   * filter bar, and each category carries genres, region and provider — so this
   * one integer is what lets a taste profile be built from watch history with no
   * extra requests. See `lib/taste.ts`.
   */
  categoryId: number | null;
  name: string;
  logo: string | null;
  ext: string | null;
  tvgId: string | null;
  archive: boolean;
  archiveDays: number;
  rating: number | null;
  year: string | null;
  direct: boolean;
}
export interface Category {
  id: number;
  /**
   * `<kind>.<provider id>`, the name that survives a refresh.
   *
   * `id` is per generation: every re-ingest renumbers the category
   * table, so a hidden list or a custom order stored as ids quietly starts
   * pointing at different packages the next morning. Same reason favourites key
   * on `stream_id` and never on `item.id`.
   */
  ref: string;
  name: string; cleanName: string; count: number;
  genres: string[]; region: string | null; source: string | null;
  /**
   * Market / package / group, e.g. `['EN', 'NEWS']`. Depth 1 IS the market.
   *
   * `region` is not a substitute. It is derived from the category NAME and is
   * null on most of this catalogue, whereas the sidebar's countries come from
   * the group tree — so a channel matched by `region` alone could not be located
   * in the list it is playing from.
   */
  path?: string[];
}
export interface FacetCount { id: string; label: string; count: number }

/** A node in the derived market -> package -> group tree. */
export interface GroupNode {
  /** Slash-joined path, e.g. "EN/NETFLIX/KIDS". This is what filters by. */
  id: string;
  label: string;
  /** Items under this node and everything below it. */
  count: number;
  /** Depth-1 = market, 2 = package/group, 3 = nested group. */
  depth: number;
  children: GroupNode[];
}
export interface GroupsResponse { tree: GroupNode[]; total: number; ungrouped: number }

export interface Market {
  id: string;
  label: string;
  count: number;
  /** How many categories sit under this market. */
  categories: number;
}

export interface CategoryFacts {
  id: number; name: string; cleanName: string;
  genres: string[]; region: string | null; source: string | null;
  path?: string[];
}
export interface Facets { genres: FacetCount[]; regions: FacetCount[]; sources: FacetCount[] }
export interface Page<T> { rows: T[]; total: number; offset: number; limit: number }

export interface SourceInfo {
  /** Null on an installation nobody has signed into — the ordinary first state. */
  source: {
    id: number; label: string | null; streamHost: string;
    serverTimezone: string | null; allowedFormats: string[];
    currentGeneration: number | null; lastIngestAt: string | null; itemCount: number;
  } | null;
  account:
    | { status: string | null; expDate: string | null; isTrial: boolean;
        activeCons: number; maxConnections: number | null; allowedOutputFormats: string[] }
    | { error: 'busy' | 'unreachable' | string; status?: number | null; message?: string }
    | null;
}

export interface PlaybackTarget {
  url: string;
  container: 'hls' | 'mpegts' | 'file';
  direct: boolean;
  notes: string[];
  /**
   * What the panel says is inside this file, as `"<video>,<audio>"`.
   *
   * `chooseEngine` has always taken a `codec` argument and nothing on the device
   * has ever passed one — every local resolver returned a target without this
   * field, so the whole codec branch of that function was unreachable outside its
   * own tests, and the engine was picked from the file extension alone. That is
   * why an `.mkv` went to libVLC and an `.mp4` full of HEVC did not.
   *
   * Optional and often absent, which is honest rather than convenient: measured
   * 2026-09-07, `get_series_info` published a codec for 26 of 26 sampled episodes
   * and `get_vod_info` for 17 of 25 films, and a playlist entry has no panel
   * behind it to ask at all. Absent means "unknown", and the extension rule and
   * the escalation ladder handle it exactly as they did before.
   */
  codec?: string | null;
  /**
   * Request headers this stream asks for — a playlist's `#EXTVLCOPT` / `#EXTHTTP`
   * / `url|Header=value`. Only the native player can send `User-Agent` and
   * `Referer`; a browser ignores them and playback goes on without.
   */
  headers?: Record<string, string>;
  /**
   * Ask the source for a fresh link. Set for a Stalker portal, whose links expire:
   * the player calls it once when the first link will not open.
   */
  reresolve?: () => Promise<PlaybackTarget>;
}

export interface Episode {
  episodeId: number; seasonNumber: number; episodeNumber: number | null;
  title: string; ext: string | null; plot: string | null;
  durationSecs: number | null; image: string | null;
  /** The panel's own ffprobe of the file. See `PlaybackTarget.codec`. */
  videoCodec?: string | null; audioCodec?: string | null;
}
export interface SeriesDetail {
  series: { id: number; series_id: number; name: string; cover: string | null;
            plot: string | null; genre: string | null; rating: number | null;
            release_date: string | null };
  category: CategoryFacts | null;
  detail: { seasons: number[]; episodes: Episode[] };
  /** Panel-side series metadata: cast, director, trailer, artwork. */
  meta: Partial<VodDetail> | null;
}

export interface EpgSlot {
  title: string | null; description: string | null;
  startTs: number | null; stopTs: number | null;
  nowPlaying: boolean; hasArchive: boolean;
}
export interface EpgResponse {
  channel: { id: number; name: string; tvgId: string | null; archive: boolean; archiveDays: number };
  /** The panel's own timezone, for rendering times the way the panel means them. */
  timezone: string | null;
  now: EpgSlot | null;
  upcoming: EpgSlot[];
  /** The whole window, past included — which is what catch-up is built on. */
  slots: EpgSlot[];
  archive: number;
}

/** One channel's row in the guide grid. */
export interface GridChannel {
  id: number;
  /** Stable `<kind>.<provider id>` — what the guide's links are built from. */
  ref: string | null;
  name: string;
  logo: string | null;
  archive: boolean;
  archiveDays: number;
  slots: EpgSlot[];
  /** False when the guide for this channel has never been fetched. */
  known: boolean;
  until: number | null;
}
export interface GridResponse {
  from: number;
  hours: number;
  now: number;
  timezone: string | null;
  channels: GridChannel[];
}

/** A catch-up stream. `minutes` is what was asked of the panel, for the record. */
export interface ArchiveTarget extends PlaybackTarget {
  isLive: false;
  minutes: number;
}

export type Section = 'live' | 'movies' | 'series';

/**
 * The app-wide hidden list, applied to every listing call.
 *
 * Counts that ignore it are worse than no counts: a genre chip reading 2,895 that
 * yields 1,931 rows reads as a bug. Every read honours both fields, so they
 * travel together.
 */
export interface Hidden {
  /** Allow-list of country codes. Empty/absent means every country. */
  markets?: string[];
  /** Group-tree prefixes to include (selected country or group). */
  paths?: string[];
  /** Derived category genres, all-of: each one narrows. */
  genres?: string[];
  /**
   * Include only these category ids, any-of.
   *
   * The listing reads have always taken `cats`; this scope could not express it,
   * so a page filtered to one package still asked for the genre chips, the group
   * tree and the country list of the WHOLE library. That is the half of
   * cross-filtering that was missing: pick a package and every other control kept
   * offering values it has none of.
   */
  cats?: number[];
  region?: string;
  source?: string;
  /** Title year window — same axes the grid uses, so chip counts match the page. */
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
  q?: string;
  hidePaths?: string[];
  hideCats?: number[];
  /** Refresh-proof category names; see `Category.ref`. */
  hideCatRefs?: string[];
  /** Individual provider ids to leave out. */
  hideStreams?: number[];
  /** A whole topic to leave out, counts included — see `ItemQuery.excludeTopic`. */
  excludeTopic?: string;
}

/** `epg` puts channels that are likely to have a schedule first — see catalogue.ts. */
export type SortKey = 'default' | 'name' | 'year' | 'rating' | 'added' | 'epg';

export interface VodCastMember {
  name: string;
  image: string | null;
  sex?: string;
}

export interface VodDetail {
  name: string | null; plot: string | null; cast: (string | VodCastMember)[]; director: string | null;
  genres: string[]; country: string | null; releaseDate: string | null;
  durationSecs: number | null; duration: string | null; rating: number | null;
  mpaa: string | null; tmdbId: string | null; youtubeTrailer: string | null;
  cover: string | null; backdrops: string[]; bitrate: number | null;
  video: { codec: string | null; width: number | null; height: number | null } | null;
  audio: { codec: string | null; channels: number | null } | null;
  containerExtension: string | null; streamId: number | null;
}
export interface MovieDetailResponse {
  item: Item;
  category: CategoryFacts | null;
  detail: VodDetail | null;
}

export interface ItemQuery {
  categoryId?: number | null;
  offset?: number;
  limit?: number;
  sort?: SortKey;
  dir?: 'asc' | 'desc';
  q?: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  minRating?: number | null;
  /** Added at or after this instant, unix seconds — "Just added". */
  addedSince?: number | null;
  /** One row per title, not one per country package — see `oneCopy` in core-store. */
  oneCopy?: boolean;
  archiveOnly?: boolean;
  genre?: string | null;
  /** Several genres, all-of: each one narrows. */
  genres?: string[];
  region?: string | null;
  source?: string | null;
  /** Group-tree path prefix, e.g. "EN/NETFLIX". Matches that node and below. */
  path?: string | null;
  /** Country codes, any-of. A market is depth-1 of the group tree. */
  markets?: string[];
  /** Show ONLY these group paths (any-of). Union with `path` when both are set. */
  paths?: string[];
  /** Show ONLY these categories (any-of). */
  cats?: number[];
  /** Never show these group paths — the app-wide hidden list. */
  hidePaths?: string[];
  /** Never show these categories. */
  hideCats?: number[];
  hideCatRefs?: string[];
  hideStreams?: number[];
  /**
   * Only these PROVIDER ids — `stream_id` for channels and films, `series_id` for
   * series. This is how favourites are resolved: row ids change every re-ingest.
   * An empty array means nothing, not everything.
   */
  streamIds?: number[];
  /**
   * Leave out every channel of this topic (see `lib/topics.ts`) — how Live TV
   * stops listing the channels Sports TV already shows. Only honoured once the
   * topic index is built; see `topicSet`.
   */
  excludeTopic?: string;
  /** Show ONLY adult-flagged items; see `Query.adultOnly`. */
  adultOnly?: boolean;
}

/**
 * A catalogue read, answered from the copy on this device.
 *
 * `null` from the reader means the device holds nothing to answer with (the
 * on-device catalogue is switched off, or not built yet); the call then rejects,
 * which every caller already treats as "nothing to show".
 */
function fromDevice<T>(local: () => T | null, what: string): Promise<T> {
  const answer = local();
  return answer === null ? Promise.reject(notOnDevice(what)) : Promise.resolve(answer);
}

function notOnDevice(what: string): Error {
  return new Error(`not on this device: ${what}`);
}

/**
 * What a cross-section search answers with.
 *
 * `corrected` is the honest label on the results: the device's search corrects a
 * mistyped word against the catalogue's own vocabulary, and a page that silently
 * shows results for a different word than the one somebody typed is a page they
 * cannot argue with. Absent reads as "not corrected".
 */
export interface SearchAnswer {
  live: Item[];
  movies: Item[];
  series: Item[];
  corrected?: boolean;
}

/**
 * `fromDevice` for answers that take a moment to produce: the guide, the detail
 * cache, search and the archive probe. The synchronous reads stay synchronous so
 * the thirty-odd list call sites do not allocate a promise per render.
 */
async function fromDeviceAsync<T>(local: () => Promise<T | null>, what: string): Promise<T> {
  const answer = await local();
  if (answer === null) throw notOnDevice(what);
  return answer;
}

/**
 * What this subscription actually contains.
 *
 * Read once and cached hard, because it changes only when the catalogue is
 * re-ingested. Its job is to stop the app advertising what is not there: a line
 * with no series should not offer a Series tab that opens an empty grid.
 */
export interface Inventory {
  generation: number | null;
  live: number;
  movies: number;
  series: number;
  archive: number;
  guide: number;
  adult: number;
  /**
   * The library's structure is known but none of its packages are here yet.
   *
   * Only the device's own catalogue can be in this state, and while it is, any
   * count derived from SCANNING items — `archive`, `guide` — is unknown rather
   * than zero.
   */
  partial?: boolean;
  /**
   * How much of it is ON THIS DEVICE, as opposed to offered by the subscription.
   *
   * `movies` and `series` above are what the library HAS — read from its
   * structure, so they are true before a single package is downloaded, which is
   * what lets the app decide whether a section may be navigated to. That is not
   * the same question as whether there is anything to draw: an on-demand library
   * offers 66,709 films and holds none until somebody opens a group, and a home
   * page that reads the offered number finds no artwork, no rails and no hero —
   * and fills itself with live channels instead.
   */
  onDevice?: { live: number; movies: number; series: number };
}

export const api = {
  /* A device with a playlist and no subscription can still say what it has,
     which is what the first run and the rabbit both key on. */
  inventory: () => fromDevice(() => localInventory(), 'inventory'),
  /*
   * The subscription badge, from what this device knows.
   *
   * The device holds the line, and `authenticate()` already told it everything
   * the badge shows — status, expiry, trial, and how many of the account's
   * connections are in use — so the answer is cached beside the credentials and
   * re-checked on demand rather than fetched per screen.
   *
   * `activeCons` is deliberately the value from the last check rather than a live
   * one: asking the panel on every render is a request per screen against an
   * account that allows one connection, which is the thing the number is warning
   * about in the first place.
   */
  source: () => Promise.resolve(localSource()),
  categories: (s: Section, hide?: Hidden) => fromDevice(() => localCategories(s, hide), 'categories'),
  facets: (s: Section, hide?: Hidden) => fromDevice(() => localFacets(s, hide), 'facets'),
  items: (s: Section, q: ItemQuery) => fromDevice(() => localItems(s, q), 'items'),
  /*
   * The one catalogue read that is async.
   *
   * Everything else here answers out of typed arrays in a few milliseconds, but
   * search can need the spelling dictionary — half a second to build on a
   * desktop, a couple of seconds on a television — and the two-phase wait for it
   * lives in `localSearch`.
   */
  search: (q: string) => fromDeviceAsync<SearchAnswer>(() => localSearch(q), 'search'),
  item: (id: number | string) => fromDevice(() => localItem(id), 'item'),
  /* A playlist entry needs no resolving: the URL IS the item. */
  play: (itemId: number | string, format?: string) => {
    /* A portal row is a `cmd`, resolved into a link right now — see `stalkerPlay.ts`. */
    if (stalkerActive()) return stalkerPlay(itemId);
    /* The requested container matters: `onNeedCompatible` re-resolves with the
       other extension when an engine cannot demux what it was given, and
       dropping the argument made that retry ask for the same URL again and fail
       identically. */
    const answer = localPlay(itemId, format === 'ts' || format === 'm3u8' ? format : undefined);
    if (answer !== null) return Promise.resolve(answer);
    /* With the on-device catalogue on, a null is explained in words a viewer
       can act on — see `playUnavailable.ts`. */
    return Promise.reject(localEnabled() ? new PlayUnavailable(localPlayReason(itemId)) : notOnDevice('play'));
  },
  seriesDetail: (id: number | string) => fromDeviceAsync(() => localSeriesDetail(id), 'series detail'),
  /* The panel's own metadata, not just the catalogue row. `localMovieDetail`
     answers synchronously with `detail: null` for a playlist entry, which is the
     honest shape; this fills in plot, cast and runtime for a panel title.
     `fromAdult` allows looking up adult-flagged items that the normal path blocks. */
  movieDetail: (id: number | string, fromAdult?: boolean) =>
    fromDeviceAsync(() => localMovieDetailFull(id, fromAdult), 'movie detail'),
  /**
   * The same page, minus everything that has to be ASKED for — answered now.
   *
   * `movieDetail` waits on `get_vod_info`, which is a live request to the panel
   * with 500/1000/2000/4000ms of backoff behind it: measured at over four
   * seconds on one subscription. The page rendered a skeleton for all of it,
   * and a skeleton has no PLAY button — so the arrival-focus ladder found
   * nothing in `<main>`, fell back to the header, and the film opened with its
   * ring on the search icon.
   *
   * Everything the hero needs — name, poster, year, rating, category — is in the
   * catalogue on the device already. This returns that, synchronously, as the
   * placeholder the real query replaces when the panel answers. Null for a title
   * this device does not hold.
   */
  movieDetailSeed: (id: number | string, fromAdult?: boolean): MovieDetailResponse | null =>
    localMovieDetail(id, fromAdult),
  episodePlay: (episodeId: number, ext: string | null) => {
    if (stalkerActive()) return stalkerEpisodePlay(episodeId);
    const answer = localEpisodePlay(episodeId, ext ?? undefined);
    if (answer !== null) return Promise.resolve(answer);
    // Same rule as `play` above.
    return Promise.reject(localEnabled() ? new PlayUnavailable(localEpisodePlayReason()) : notOnDevice('episode'));
  },
  /* A playlist channel has no panel to ask; `localEpg` answers it from the
     stored guide (the playlist's XMLTV link) or with an empty one. */
  epg: (itemId: number | string) => fromDeviceAsync(() => localEpg(itemId), 'guide'),
  /**
   * A window of the guide for many channels, from the guide stored on the device.
   *
   * Never touches the panel — that is the whole point. Channels it has no guide
   * for come back with `known: false`, and `epgTopup` is how they get filled.
   */
  epgGrid: (ids: readonly number[], fromTs: number, hours: number) =>
    fromDeviceAsync(() => localEpgGrid(ids, fromTs, hours), 'guide'),
  epgTopup: (ids: readonly number[], replace = false) =>
    fromDeviceAsync(() => localEpgTopup(ids, replace), 'guide'),
  /** A catch-up stream, built on the device — see `localArchive.ts`. */
  archivePlay: (itemId: number | string, startTs: number, stopTs: number): Promise<ArchiveTarget> =>
    fromDeviceAsync(() => localArchivePlay(itemId, startTs, stopTs), 'catch-up'),
  groups: (s: Section, hide?: Hidden) => fromDevice(() => localGroups(s, hide), 'groups'),
  markets: (s: Section, hide?: Hidden) => fromDevice(() => localMarkets(s, hide), 'markets'),
  related: (id: number | string, kind: 'movies' | 'series', limit = 20, hide?: Hidden) =>
    fromDevice(() => localRelated(id, kind, limit, hide), 'related'),
  variants: (itemId: number | string) => fromDevice(() => localVariants(itemId), 'variants'),
};

/** An alternative feed of the same channel — this panel's real quality switch. */
export interface Variant {
  id: number;
  /** Stable `1.<stream_id>` — use this, not `id`, for anything persisted. */
  ref: string | null;
  name: string;
  quality: string;
  ext: string | null;
  active: boolean;
}

