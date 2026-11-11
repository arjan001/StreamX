/**
 * Stalker JSON -> the row shapes core-xtream produces, so core-store and the app
 * treat a portal like an Xtream line. Everything goes through core-xtream's
 * coercion helpers: portals send ids and flags as strings, and `[]` for `{}`.
 *
 * Portal ids are kept verbatim in `remoteId`; `streamId` is the numeric form the
 * shared row types want (null when a portal uses non-numeric ids, and such rows
 * are dropped by the normalisers since the store keys on it).
 */
import {
  Kind,
  flexBool,
  flexFloat,
  flexInt,
  flexStr,
  objOrNull,
  parseClock,
  resolveYear,
  type CategoryRow,
  type EpgEntry,
  type EpisodeRow,
  type ItemRow,
  type SeriesRow,
} from '@iptv/core-xtream';

export interface StalkerItemRow extends ItemRow {
  /** The portal's own id, verbatim (string). */
  readonly remoteId: string;
  /** The `cmd` to feed `create_link`. Never a playable URL on its own. */
  readonly cmd: string;
  readonly number: number | null;
  readonly description: string | null;
  readonly durationSecs: number | null;
}

export interface StalkerSeriesRow extends SeriesRow {
  readonly remoteId: string;
  readonly cmd: string | null;
}

export interface StalkerEpisodeRow extends EpisodeRow {
  readonly remoteId: string;
  readonly cmd: string;
  /** Value for `create_link`'s `series=` parameter. */
  readonly seriesParam: string;
}

/** Conservative name match so a portal that forgets `censored` still filters. */
const ADULT_NAME = /\b(adult|xxx|porn|erotic|18\+|sex)\b|\+18\b/i;

export interface GenreInfo {
  readonly categories: CategoryRow[];
  readonly adultIds: ReadonlySet<string>;
}

/** `get_genres` / `get_categories` list -> categories + the set of adult ids. */
export function normaliseGenres(raw: unknown): GenreInfo {
  const list = Array.isArray(raw) ? raw : [];
  const categories: CategoryRow[] = [];
  const adultIds = new Set<string>();
  for (const g of list) {
    const o = objOrNull(g);
    if (!o) continue;
    const remoteId = flexStr(o['id']);
    const name = flexStr(o['title']) ?? flexStr(o['name']);
    if (!remoteId || !name || remoteId === '*') continue; // '*' is the "All" pseudo genre
    categories.push({ remoteId, name, parentId: 0 });
    if (flexBool(o['censored']) || ADULT_NAME.test(name)) adultIds.add(remoteId);
  }
  return { categories, adultIds };
}

/** Logos arrive absolute, root-relative or as a bare file name under misc/logos. */
export function resolveAsset(v: unknown, origin: string, portalRoot: string): string | null {
  const s = flexStr(v);
  if (s === null) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `${origin.split(':')[0]}:${s}`;
  if (s.startsWith('/')) return `${origin}${s}`;
  return `${portalRoot}/misc/logos/320/${s}`;
}

/** `ffmpeg http://x` | `ffrt3 http://x` | `auto http://x` -> `http://x`. */
export function stripCmdPrefix(cmd: string): string {
  return cmd.trim().replace(/^(?:ffmpeg|ffrt\d*|auto)\s+/i, '').trim();
}

export interface NormOpts {
  readonly origin: string;
  readonly portalRoot: string;
  readonly adultIds: ReadonlySet<string>;
}

export function normaliseChannel(raw: unknown, o: NormOpts): StalkerItemRow | null {
  const c = objOrNull(raw);
  if (!c) return null;
  const remoteId = flexStr(c['id']);
  const streamId = flexInt(c['id']);
  const name = flexStr(c['name']);
  const cmd = flexStr(c['cmd']);
  if (!remoteId || streamId === null || !name || !cmd) return null;
  const genre = flexStr(c['tv_genre_id']);
  const archiveHours = flexInt(c['archive_duration']) ?? flexInt(c['tv_archive_duration']) ?? 0;
  const tvArchive = flexBool(c['tv_archive']) || archiveHours > 0;
  return {
    kind: Kind.Live,
    streamId,
    remoteId,
    ext: null,
    url: null,
    cmd,
    name,
    number: flexInt(c['number']),
    categoryRemoteId: genre,
    tvgId: flexStr(c['xmltv_id']),
    logo: resolveAsset(c['logo'], o.origin, o.portalRoot),
    tvArchive,
    // Portals publish hours; the shared row counts days.
    tvArchiveDuration: Math.ceil(archiveHours / 24),
    isAdult: flexBool(c['censored']) || (genre !== null && o.adultIds.has(genre)),
    added: null,
    rating: null,
    year: null,
    directSource: null,
    description: null,
    durationSecs: null,
  };
}

function cast(v: unknown): string | null {
  return flexStr(v);
}

export function normaliseMovie(raw: unknown, o: NormOpts): StalkerItemRow | null {
  const m = objOrNull(raw);
  if (!m) return null;
  const remoteId = flexStr(m['id']);
  const streamId = flexInt(m['id']);
  const name = flexStr(m['name']) ?? flexStr(m['o_name']);
  const cmd = flexStr(m['cmd']);
  if (!remoteId || streamId === null || !name || !cmd) return null;
  const cat = flexStr(m['category_id']);
  const mins = flexInt(m['time']);
  return {
    kind: Kind.Movie,
    streamId,
    remoteId,
    ext: null,
    url: null,
    cmd,
    name,
    number: null,
    categoryRemoteId: cat,
    tvgId: null,
    logo: resolveAsset(m['screenshot_uri'], o.origin, o.portalRoot),
    tvArchive: false,
    tvArchiveDuration: 0,
    isAdult: flexBool(m['censored']) || (cat !== null && o.adultIds.has(cat)),
    added: parseAdded(m['added']),
    rating: flexFloat(m['rating_imdb']) ?? flexFloat(m['rating_kinopoisk']) ?? flexFloat(m['rating']),
    year: resolveYear(m['year'], name),
    directSource: null,
    description: flexStr(m['description']),
    durationSecs: mins !== null && mins > 0 ? mins * 60 : null,
  };
}

function parseAdded(v: unknown): number | null {
  const n = flexInt(v);
  if (n !== null && n > 1e8) return n;
  const s = flexStr(v);
  if (s === null) return null;
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function normaliseSeriesItem(raw: unknown, o: NormOpts): (StalkerSeriesRow & { isAdult: boolean }) | null {
  const s = objOrNull(raw);
  if (!s) return null;
  const remoteId = flexStr(s['id']);
  const seriesId = flexInt(s['id']);
  const name = flexStr(s['name']) ?? flexStr(s['o_name']);
  if (!remoteId || seriesId === null || !name) return null;
  const cat = flexStr(s['category_id']);
  return {
    remoteId,
    seriesId,
    name,
    cmd: flexStr(s['cmd']),
    categoryRemoteId: cat,
    cover: resolveAsset(s['screenshot_uri'], o.origin, o.portalRoot),
    plot: flexStr(s['description']),
    genre: flexStr(s['genres_str']),
    cast: cast(s['actors']),
    rating: flexFloat(s['rating_imdb']) ?? flexFloat(s['rating_kinopoisk']) ?? flexFloat(s['rating']),
    releaseDate: flexStr(s['year']) ?? resolveYear(null, name),
    lastModified: parseAdded(s['added']),
    backdrops: [],
    isAdult: flexBool(s['censored']) || (cat !== null && o.adultIds.has(cat)),
  };
}

/** Season number from a season row (`season_num`, else the tail of `id` "123:2"). */
export function seasonNumberOf(row: Record<string, unknown>): number | null {
  const direct = flexInt(row['season_num']) ?? flexInt(row['season_number']) ?? flexInt(row['season']);
  if (direct !== null) return direct;
  const id = flexStr(row['id']);
  const tail = id ? id.split(':')[1] : undefined;
  return tail === undefined ? null : flexInt(tail);
}

/**
 * Episodes of one season row. A season row either carries `series: [1,2,3]`
 * (episode numbers played through `create_link&series=N` on the season's cmd), or
 * the list of rows is itself one row per episode.
 */
export function normaliseEpisodes(
  seasonNumber: number,
  rows: unknown[],
  o: NormOpts,
): StalkerEpisodeRow[] {
  const out: StalkerEpisodeRow[] = [];
  for (const r of rows) {
    const e = objOrNull(r);
    if (!e) continue;
    const cmd = flexStr(e['cmd']);
    if (!cmd) continue;
    const image = resolveAsset(e['screenshot_uri'], o.origin, o.portalRoot);
    const mins = flexInt(e['time']);
    const durationSecs = parseClock(e['duration']) ?? (mins !== null && mins > 0 ? mins * 60 : null);
    const nums = Array.isArray(e['series']) ? (e['series'] as unknown[]).map((x) => flexInt(x)) : null;
    const base = flexInt(e['id']) ?? seasonNumber * 1000;
    if (nums && nums.length > 0) {
      for (const n of nums) {
        if (n === null) continue;
        out.push({
          episodeId: base * 1000 + n,
          remoteId: `${flexStr(e['id']) ?? ''}:${n}`,
          cmd,
          seriesParam: String(n),
          seasonNumber,
          episodeNumber: n,
          title: `Episode ${n}`,
          ext: null,
          plot: flexStr(e['description']),
          durationSecs,
          image,
          videoCodec: null,
          audioCodec: null,
        });
      }
    } else {
      const n = flexInt(e['series_number']) ?? flexInt(e['episode']) ?? flexInt(e['episode_num']);
      out.push({
        episodeId: flexInt(String(e['id']).replace(/\D/g, '')) ?? base,
        remoteId: flexStr(e['id']) ?? '',
        cmd,
        seriesParam: n === null ? '' : String(n),
        seasonNumber,
        episodeNumber: n,
        title: flexStr(e['name']) ?? `Episode ${n ?? '?'}`,
        ext: null,
        plot: flexStr(e['description']),
        durationSecs,
        image,
        videoCodec: null,
        audioCodec: null,
      });
    }
  }
  return out.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
}

/** `2026-09-28 14:00:00` (portal local time, no zone) -> unix seconds as UTC. */
function parsePlain(v: unknown): number | null {
  const s = flexStr(v);
  if (s === null) return null;
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function normaliseEpgList(raw: unknown, now = Math.floor(Date.now() / 1000)): EpgEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: EpgEntry[] = [];
  for (const r of list) {
    const p = objOrNull(r);
    if (!p) continue;
    const startTs = flexInt(p['start_timestamp']) ?? parsePlain(p['time']);
    const stopTs = flexInt(p['stop_timestamp']) ?? parsePlain(p['time_to']);
    const title = flexStr(p['name']);
    if (startTs === null || title === null) continue;
    out.push({
      title,
      description: flexStr(p['descr']) ?? flexStr(p['description']),
      startTs,
      stopTs,
      nowPlaying: stopTs !== null && startTs <= now && now < stopTs,
      hasArchive: flexBool(p['mark_archive']),
    });
  }
  return out.sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}
