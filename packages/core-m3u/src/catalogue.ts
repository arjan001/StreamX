/**
 * Turning a playlist into a catalogue.
 *
 * A playlist is a flat list of names and URLs. Everything a browsable catalogue
 * needs - which section an entry belongs to, a stable id to hang a favourite on,
 * a category to group it under - has to be derived, because the format carries
 * none of it. These are the two derivations that matter, kept pure because both
 * are the kind of rule that is easy to get subtly wrong and cheap to test.
 */
import type { M3uEntry } from './parse.ts';

/** Same numbering as the Xtream side, so one read model serves both. */
export const M3U_KIND = { Opaque: 0, Live: 1, Movie: 2, Episode: 3 } as const;
export type M3uKind = (typeof M3U_KIND)[keyof typeof M3U_KIND];

function urlPath(url: string): string {
  const at = url.indexOf('://');
  const rest = at === -1 ? url : url.slice(at + 3);
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(slash);
}

/**
 * The legacy Xtream live URL: two path segments, then a numeric id, no extension.
 *
 * `/{username}/{password}/{id}` is the form one production panel emits for EVERY
 * live channel, and it is unambiguous — a film or an episode always carries an
 * extension in a playlist.
 */
const LEGACY_LIVE = /^\/[^/]+\/[^/]+\/\d+$/;
/** A container extension is what a file has and a channel does not. */
const VOD_FILE = /\.(mp4|mkv|avi|mov|m4v|flv|wmv|mpg|mpeg)$/i;

/**
 * A manifest or a transport stream: something that plays continuously.
 *
 * This is the other half of "the URL is the provider's own statement". A group
 * called `Movies` on a public list is a channel that SHOWS films — Afghan Nobel
 * Movies, Maah TV — and filing it under Films put channels in a films rail, on a
 * home page that then advertised a video library nobody has. An `.m3u8` is not a
 * film, whatever the group is called.
 */
const LIVE_STREAM = /\.(m3u8|ts|mpd)(\?|$)/i;

/**
 * Which section an entry belongs in.
 *
 * The URL is asked first and trusted absolutely, because it is the provider's own
 * statement of what the entry is. Only when it says nothing does the group title
 * get a vote — and that ordering is not academic. On a real 592,752-entry
 * playlist, group-first classification filed "STARZ KIDS & FAMILY HD" and
 * "COMEDY CENTRAL +1" as FILMS, because the channel groups they sit in are
 * called things like "UK| MOVIES". Channel groups are named after what they
 * broadcast; that is not the same as being video on demand, and the URL knew the
 * difference all along.
 *
 * Live is the default rather than Opaque: a playlist that says nothing at all is
 * a channel list far more often than not, and putting those entries in a section
 * nobody browses is the same as losing them.
 */
export function classifyEntry(entry: Pick<M3uEntry, 'url' | 'groups' | 'name'>): M3uKind {
  const path = urlPath(entry.url);
  if (/\/series\//i.test(path)) return M3U_KIND.Episode;
  if (/\/movie\//i.test(path)) return M3U_KIND.Movie;
  if (LEGACY_LIVE.test(path)) return M3U_KIND.Live;
  if (/\/live\//i.test(path)) return M3U_KIND.Live;

  /* Before the group vote, not after it: a group name cannot outrank the file
     the provider is actually serving. */
  if (LIVE_STREAM.test(path)) return M3U_KIND.Live;

  const hay = ` ${entry.groups.join(' ')} `.toUpperCase();
  // Series before films: "VOD SERIES" is a series group and contains both words.
  if (/\b(SERIE|SERIES|SERIEN|SEASON|TV SHOWS?)\b/.test(hay)) return M3U_KIND.Episode;
  if (/\b(VOD|FILM|FILMS|FILME|MOVIE|MOVIES|CINE|CINEMA|PELICULA|PELICULAS)\b/.test(hay)) {
    return M3U_KIND.Movie;
  }
  // No group signal either: a file is a film, a stream is a channel.
  return VOD_FILE.test(path) ? M3U_KIND.Movie : M3U_KIND.Live;
}

/**
 * A stable id for an entry that has none.
 *
 * Favourites, continue-watching and hidden lists all key on a provider id, and a
 * playlist entry has no id at all - so one is derived from the two things that
 * identify it in practice: its name and its URL. Both, deliberately. Name alone
 * collides across qualities of the same channel; URL alone changes whenever a
 * provider rotates a token, which would silently drop every favourite.
 *
 * FNV-1a, folded into a positive 31-bit integer because that is what the
 * `stream_id` column and the client\'s favourite lists hold. Collisions are
 * possible in principle - one in ~2.1 billion per pair - and the consequence is
 * bounded: two entries sharing a star.
 */
export function syntheticId(name: string, url: string): number {
  let h = 0x811c9dc5;
  const s = `${name}\n${url}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime. Math.imul keeps the multiply in 32-bit integer space.
    h = Math.imul(h, 0x01000193);
  }
  // Shift rather than Math.abs: abs(-2147483648) is still negative.
  const positive = (h >>> 1) & 0x7fffffff;
  // Never 0: an id of zero reads as "no id" everywhere else in this codebase.
  return positive === 0 ? 1 : positive;
}

/** The group an entry is filed under. */
export function categoryOf(entry: Pick<M3uEntry, 'groups'>): string {
  const first = entry.groups[0]?.trim();
  return first !== undefined && first !== '' ? first : 'Ungrouped';
}
