/**
 * What a row needs at PLAY time that the catalogue columns do not carry.
 *
 * Two kinds of source hand the player something more than a bare URL:
 *
 *   playlist   `#EXTVLCOPT http-user-agent` / `http-referrer`, `#EXTHTTP` and a
 *              `url|Header=value` suffix say what request headers the stream
 *              wants. `core-m3u` parses them; they used to be dropped when the
 *              catalogue was built, which is why a channel that needs its
 *              referrer played in another app and not here.
 *   portal     a Stalker row is a `cmd` to be turned into a link right before
 *              playback — the link is short-lived and is never stored.
 *
 * Kept as a side map keyed by the row's provider id, one blob per source, loaded
 * with the catalogue. The columnar store stays as it was: a column for something
 * 99% of rows do not have would cost every row.
 */

export type RequestHeaders = Record<string, string>;

/** A portal's own identity for a row: what `create_link` and the guide ask by. */
export interface StalkerRef {
  readonly cmd: string;
  readonly remoteId: string;
}

export interface SideMap {
  /** Live playlist entries that asked for headers, by stream id. */
  headers: Record<string, RequestHeaders>;
  /** Portal rows by `<kind>.<stream id>` (kind 1 live, 2 film, 3 series). */
  stalker: Record<string, StalkerRef>;
}

export const sideKey = (providerId: number): string => `side.${providerId}`;

export function emptySide(): SideMap {
  return { headers: {}, stalker: {} };
}

/** Whatever came back from storage, made safe to read. */
export function toSide(raw: unknown): SideMap {
  const out = emptySide();
  if (raw === null || typeof raw !== 'object') return out;
  const o = raw as Partial<SideMap>;
  if (o.headers !== null && typeof o.headers === 'object') out.headers = o.headers;
  if (o.stalker !== null && typeof o.stalker === 'object') out.stalker = o.stalker;
  return out;
}

let current: SideMap = emptySide();

/** The active source's map; replaced whenever the catalogue is rebuilt. */
export function setSide(map: SideMap | null): void {
  current = map ?? emptySide();
}

/** Headers a stream asked for, or null. Never more than the playlist said. */
export function headersFor(streamId: number | null): RequestHeaders | null {
  if (streamId === null) return null;
  const h = current.headers[String(streamId)];
  return h !== undefined && Object.keys(h).length > 0 ? h : null;
}

export function stalkerRefFor(kind: number, streamId: number | null): StalkerRef | null {
  if (streamId === null) return null;
  return current.stalker[`${kind}.${streamId}`] ?? null;
}

/**
 * Episodes are not rows in the catalogue — they exist inside a series' detail —
 * so their `cmd` is remembered when that detail is read, which is always before
 * PLAY can be pressed on one. Bounded: forty series browsed is not forty trees.
 */
const EPISODE_MAX = 4_000;
const episodes = new Map<number, { cmd: string; seriesParam: string }>();

export function rememberEpisode(episodeId: number, ref: { cmd: string; seriesParam: string }): void {
  episodes.delete(episodeId);
  episodes.set(episodeId, ref);
  while (episodes.size > EPISODE_MAX) {
    const oldest = episodes.keys().next();
    if (oldest.done) break;
    episodes.delete(oldest.value);
  }
}

export function episodeRef(episodeId: number): { cmd: string; seriesParam: string } | null {
  return episodes.get(episodeId) ?? null;
}
