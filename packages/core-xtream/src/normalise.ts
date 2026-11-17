/**
 * Panel JSON -> catalogue rows.
 *
 * Every field goes through the coercion layer. The two shapes that break naive
 * clients are handled explicitly:
 *   - `info` / `seasons` / `episodes` arriving as `[]` instead of `{}`
 *   - `episodes` keyed by season number as a STRING, so "10" sorts before "2"
 *
 * See docs/02-xtream-api.md section 5.
 */
import {
  decodeMaybeBase64,
  flexBool,
  flexFloat,
  flexInt,
  flexStr,
  flexStrArray,
  objOrNull,
} from './coerce.ts';
import { Kind } from './urls.ts';

export interface CategoryRow {
  readonly remoteId: string;
  readonly name: string;
  readonly parentId: number;
}

export interface ItemRow {
  readonly kind: Kind;
  readonly streamId: number | null;
  readonly ext: string | null;
  readonly url: string | null;
  readonly name: string;
  readonly categoryRemoteId: string | null;
  readonly tvgId: string | null;
  readonly logo: string | null;
  readonly tvArchive: boolean;
  readonly tvArchiveDuration: number;
  readonly isAdult: boolean;
  readonly added: number | null;
  readonly rating: number | null;
  readonly year: string | null;
  /** Panels sometimes hand back a ready-made URL; it wins over construction. */
  readonly directSource: string | null;
}

/**
 * Release year, falling back to the title.
 *
 * Measured: the reference panel populates the `year` field on 0 of 50,343 movies
 * while 47,498 of them carry it in the name as "(2011)". Without this fallback,
 * sorting or filtering by year matches nothing at all.
 */
const YEAR_IN_NAME = /\((19|20)(\d{2})\)/;

export function resolveYear(field: unknown, name: string | null): string | null {
  const direct = flexStr(field);
  if (direct && /^(19|20)\d{2}/.test(direct)) return direct.slice(0, 4);
  const m = name ? YEAR_IN_NAME.exec(name) : null;
  return m ? `${m[1]}${m[2]}` : null;
}

export function normaliseCategory(raw: unknown): CategoryRow | null {
  const o = objOrNull(raw);
  if (!o) return null;
  const remoteId = flexStr(o['category_id']);
  const name = flexStr(o['category_name']);
  if (!remoteId || !name) return null;
  return { remoteId, name, parentId: flexInt(o['parent_id']) ?? 0 };
}

export function normaliseLive(raw: unknown): ItemRow | null {
  const o = objOrNull(raw);
  if (!o) return null;
  const streamId = flexInt(o['stream_id']);
  const name = flexStr(o['name']);
  if (streamId === null || !name) return null;
  return {
    kind: Kind.Live,
    streamId,
    ext: null,
    url: null,
    name,
    categoryRemoteId: flexStr(o['category_id']),
    tvgId: flexStr(o['epg_channel_id']),
    logo: flexStr(o['stream_icon']),
    tvArchive: flexBool(o['tv_archive']),
    tvArchiveDuration: flexInt(o['tv_archive_duration']) ?? 0,
    isAdult: flexBool(o['is_adult']),
    added: flexInt(o['added']),
    rating: null,
    year: null,
    directSource: flexStr(o['direct_source']),
  };
}

export function normaliseVod(raw: unknown): ItemRow | null {
  const o = objOrNull(raw);
  if (!o) return null;
  const streamId = flexInt(o['stream_id']);
  const name = flexStr(o['name']);
  if (streamId === null || !name) return null;
  return {
    kind: Kind.Movie,
    streamId,
    // Required to build the /movie/ URL; without it playback cannot be formed.
    ext: flexStr(o['container_extension']),
    url: null,
    name,
    categoryRemoteId: flexStr(o['category_id']),
    tvgId: null,
    logo: flexStr(o['stream_icon']) ?? flexStr(o['cover']),
    tvArchive: false,
    tvArchiveDuration: 0,
    isAdult: flexBool(o['is_adult']),
    added: flexInt(o['added']),
    rating: flexFloat(o['rating']),
    year: resolveYear(o['year'], name),
    directSource: flexStr(o['direct_source']),
  };
}

export interface SeriesRow {
  readonly seriesId: number;
  readonly name: string;
  readonly categoryRemoteId: string | null;
  readonly cover: string | null;
  readonly plot: string | null;
  readonly genre: string | null;
  /**
   * Comma-separated cast, straight off the BULK list.
   *
   * The surprise worth writing down: `get_series` carries `cast`, `director`,
   * `genre` and `plot` on every one of this panel's 45,140 rows, while
   * `get_vod_streams` carries none of the four on any of its 211,168. Measured
   * 2026-09-07 — 33,636 series (74.5%) have a non-empty cast, 203,540 credits,
   * 49,438 distinct people. It was being parsed and thrown away, which is why
   * the on-device catalogue had no cast to search until now.
   */
  readonly cast: string | null;
  readonly rating: number | null;
  /** camelCase on series, lowercase on VOD — an inconsistency inside the API. */
  readonly releaseDate: string | null;
  readonly lastModified: number | null;
  readonly backdrops: string[];
}

export function normaliseSeries(raw: unknown): SeriesRow | null {
  const o = objOrNull(raw);
  if (!o) return null;
  const seriesId = flexInt(o['series_id']);
  const name = flexStr(o['name']);
  if (seriesId === null || !name) return null;
  return {
    seriesId,
    name,
    categoryRemoteId: flexStr(o['category_id']),
    cover: flexStr(o['cover']),
    plot: flexStr(o['plot']),
    genre: flexStr(o['genre']),
    cast: flexStr(o['cast']),
    rating: flexFloat(o['rating']),
    releaseDate:
      flexStr(o['releaseDate']) ?? flexStr(o['release_date']) ?? resolveYear(null, name),
    lastModified: flexInt(o['last_modified']),
    backdrops: flexStrArray(o['backdrop_path']),
  };
}

export interface EpisodeRow {
  /** `episode.id` is a STRING in the payload and is what the /series/ URL uses. */
  readonly episodeId: number;
  readonly seasonNumber: number;
  readonly episodeNumber: number | null;
  readonly title: string;
  readonly ext: string | null;
  readonly plot: string | null;
  readonly durationSecs: number | null;
  readonly image: string | null;
  /**
   * What the PANEL's own ffprobe found inside the file, `codec_name` verbatim.
   *
   * Kept because it is the only place in this API where the codec is known
   * before a byte is fetched, and because the player has a decision that needs
   * it: `chooseEngine` picks the WebView or libVLC up front, and without a codec
   * it can only go on the file extension. That is enough for `.mkv`, which no
   * browser demuxes, and useless for the `.mp4` episodes that carry AC-3 audio
   * or HEVC video — those go to the WebView, which plays half of them and
   * silently drops the other half.
   *
   * Measured 2026-09-07 (`scripts/series-probe.mjs`): `get_series_info` published
   * a video codec for 26 of 26 sampled episodes, where `get_vod_info` managed
   * only 17 of 25 for films. Across 1,586 episodes the split was 87% h264 / 10%
   * HEVC, and 19.5% carried AC-3, E-AC-3 or DTS audio. So this field is
   * populated far more reliably for episodes than the equivalent is for films,
   * which is a good reason to read it and a bad reason to rely on it being there.
   */
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

export interface SeriesDetail {
  readonly seasons: number[];
  readonly episodes: EpisodeRow[];
}

/**
 * `episodes` is an object keyed by season number as a string. `seasons` is often
 * empty while `episodes` is populated — and occasionally the inverse, both
 * observed live. Enumerate from `episodes` keys and sort them NUMERICALLY.
 */
export function normaliseSeriesInfo(raw: Record<string, unknown>): SeriesDetail {
  const epsObj = objOrNull(raw['episodes']);
  const episodes: EpisodeRow[] = [];
  const seasons = new Set<number>();

  if (epsObj) {
    const keys = Object.keys(epsObj).sort((a, b) => (flexInt(a) ?? 0) - (flexInt(b) ?? 0));
    for (const key of keys) {
      const seasonNumber = flexInt(key) ?? 0;
      const list = Array.isArray(epsObj[key]) ? (epsObj[key] as unknown[]) : [];
      if (list.length > 0) seasons.add(seasonNumber);
      for (const e of list) {
        const eo = objOrNull(e);
        if (!eo) continue;
        const episodeId = flexInt(eo['id']);
        if (episodeId === null) continue;
        const info = objOrNull(eo['info']) ?? {};
        episodes.push({
          episodeId,
          seasonNumber: flexInt(eo['season']) ?? seasonNumber,
          episodeNumber: flexInt(eo['episode_num']),
          title: flexStr(eo['title']) ?? `Episode ${flexInt(eo['episode_num']) ?? '?'}`,
          ext: flexStr(eo['container_extension']),
          plot: flexStr(info['plot']),
          // Same reconciliation as VOD. Episode `duration_secs` measured correct
          // on this panel, but it is the same unreliable field, so the string wins
          // wherever it parses rather than relying on that staying true.
          durationSecs: resolveDuration(info).durationSecs,
          image: flexStr(info['movie_image']) ?? flexStr(info['cover_big']),
          /* `info.video` / `info.audio` are objects when the panel probed the
             file and `[]` when it did not, so `objOrNull` is the guard: an array
             has no `codec_name` and must read as "unknown", never as a codec
             called undefined. */
          videoCodec: flexStr(objOrNull(info['video'])?.['codec_name']),
          audioCodec: flexStr(objOrNull(info['audio'])?.['codec_name']),
        });
      }
    }
  }
  return { seasons: [...seasons].sort((a, b) => a - b), episodes };
}

export interface EpgEntry {
  readonly title: string | null;
  readonly description: string | null;
  readonly startTs: number | null;
  readonly stopTs: number | null;
  readonly nowPlaying: boolean;
  /** Per-programme archive availability — more precise than channel-level flags. */
  readonly hasArchive: boolean;
}

export function normaliseEpg(raw: Record<string, unknown>): EpgEntry[] {
  const list = Array.isArray(raw['epg_listings']) ? (raw['epg_listings'] as unknown[]) : [];
  const out: EpgEntry[] = [];
  for (const e of list) {
    const o = objOrNull(e);
    if (!o) continue;
    out.push({
      title: decodeMaybeBase64(o['title']),
      description: decodeMaybeBase64(o['description']),
      // Only the timestamps are reliable; start/end strings carry no timezone.
      startTs: flexInt(o['start_timestamp']),
      stopTs: flexInt(o['stop_timestamp']),
      nowPlaying: flexBool(o['now_playing']),
      hasArchive: flexBool(o['has_archive']),
    });
  }
  return out.sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}


export interface VodCastMember {
  readonly name: string;
  readonly image: string | null;
  readonly sex?: string;
}

export interface VodDetail {
  readonly name: string | null;
  readonly plot: string | null;
  readonly cast: (string | VodCastMember)[];
  readonly director: string | null;
  readonly genres: string[];
  readonly country: string | null;
  readonly releaseDate: string | null;
  readonly durationSecs: number | null;
  readonly duration: string | null;
  readonly rating: number | null;
  readonly mpaa: string | null;
  readonly tmdbId: string | null;
  readonly youtubeTrailer: string | null;
  readonly cover: string | null;
  readonly backdrops: string[];
  readonly bitrate: number | null;
  /** Raw ffprobe-ish stream info; field presence varies wildly per asset. */
  readonly video: { codec: string | null; width: number | null; height: number | null } | null;
  readonly audio: { codec: string | null; channels: number | null } | null;
  readonly containerExtension: string | null;
  readonly streamId: number | null;
}

/**
 * `get_vod_info` -> a usable detail record.
 *
 * `info` is frequently an empty ARRAY rather than an object when the panel has no
 * metadata, so it goes through objOrNull. Cast and genre arrive as
 * comma-separated strings, not lists.
 */
const CLOCK = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/;

/**
 * Seconds from a "HH:MM:SS" (or "MM:SS") runtime string.
 *
 * Returns null on anything else, including the empty strings and "00:00:00"
 * placeholders panels use for "unknown".
 */
export function parseClock(v: unknown): number | null {
  const s = flexStr(v);
  if (s === null) return null;
  const m = CLOCK.exec(s.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] === undefined ? null : Number(m[3]);
  // Two parts is MM:SS, three is HH:MM:SS. Panels emit both.
  const secs = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  return secs > 0 ? secs : null;
}

/**
 * Reconcile the two runtime fields, trusting the string.
 *
 * `duration_secs` is not reliably seconds on this panel — measured across the
 * cached VOD payloads, 4 of 13 held MINUTES ("02:00:29" alongside 122, "02:25:00"
 * alongside 118) while the other 9 held seconds. The field is inconsistent with
 * itself, so no unit heuristic can rescue it. The `duration` string was correct in
 * all 13, so it wins whenever it parses, and the number is only a fallback for
 * panels that omit the string entirely.
 */
export function resolveDuration(info: Record<string, unknown>): {
  duration: string | null;
  durationSecs: number | null;
} {
  const text = flexStr(info['duration']);
  const parsed = parseClock(text);
  const raw = flexInt(info['duration_secs']);
  return {
    duration: text,
    durationSecs: parsed ?? raw,
  };
}

export function normaliseVodInfo(raw: Record<string, unknown>): VodDetail {
  const info = objOrNull(raw['info']) ?? {};
  const md = objOrNull(raw['movie_data']) ?? {};
  const list = (v: unknown): string[] =>
    (flexStr(v) ?? '')
      .split(/[,;/]/)
      .map((x) => x.trim())
      .filter((x) => x !== '');

  const video = objOrNull(info['video']);
  const audio = objOrNull(info['audio']);
  const runtime = resolveDuration(info);

  const rawCast = info['cast'] ?? info['actors'];
  let cast: (string | VodCastMember)[];
  if (Array.isArray(rawCast)) {
    // Panel returned cast as an array of objects with name/image/sex
    cast = rawCast.map((member: unknown) => {
      if (typeof member === 'string') return member;
      if (member && typeof member === 'object') {
        return {
          name: flexStr(member['name']) ?? '',
          image: flexStr(member['image']) ?? null,
          sex: flexStr(member['sex']) ?? undefined,
        };
      }
      return String(member);
    });
  } else {
    // Fallback: comma-separated string
    cast = list(rawCast);
  }

  return {
    name: flexStr(info['name']) ?? flexStr(md['name']),
    plot: flexStr(info['plot']) ?? flexStr(info['description']),
    cast,
    director: flexStr(info['director']),
    genres: list(info['genre']),
    country: flexStr(info['country']),
    releaseDate: flexStr(info['releasedate']) ?? flexStr(info['release_date']),
    durationSecs: runtime.durationSecs,
    duration: runtime.duration,
    rating: flexFloat(info['rating']),
    mpaa: flexStr(info['mpaa_rating']) ?? flexStr(info['age']),
    tmdbId: flexStr(info['tmdb_id']),
    youtubeTrailer: flexStr(info['youtube_trailer']),
    cover: flexStr(info['movie_image']) ?? flexStr(info['cover_big']),
    backdrops: flexStrArray(info['backdrop_path']),
    bitrate: flexInt(info['bitrate']),
    video: video
      ? {
          codec: flexStr(video['codec_name']),
          width: flexInt(video['width']),
          height: flexInt(video['height']),
        }
      : null,
    audio: audio
      ? { codec: flexStr(audio['codec_name']), channels: flexInt(audio['channels']) }
      : null,
    containerExtension: flexStr(md['container_extension']),
    streamId: flexInt(md['stream_id']),
  };
}

/** Series header metadata, shaped like VodDetail so one UI renders both. */
export function normaliseSeriesMeta(raw: Record<string, unknown>): Partial<VodDetail> {
  const info = objOrNull(raw['info']) ?? raw;
  const list = (v: unknown): string[] =>
    (flexStr(v) ?? '').split(/[,;/]/).map((x) => x.trim()).filter((x) => x !== '');
  return {
    plot: flexStr(info['plot']),
    cast: list(info['cast']),
    director: flexStr(info['director']),
    genres: list(info['genre']),
    rating: flexFloat(info['rating']),
    releaseDate: flexStr(info['releaseDate']) ?? flexStr(info['release_date']),
    youtubeTrailer: flexStr(info['youtube_trailer']),
    backdrops: flexStrArray(info['backdrop_path']),
    cover: flexStr(info['cover']),
  };
}
