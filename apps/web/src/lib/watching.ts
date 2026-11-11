/**
 * What this profile is watching: the films and series it is part-way through, and
 * the channels it has had on lately — and a way to take any of it off the list.
 *
 * Asked for as "an area, a really compact area" on Movies, Series and Live TV
 * "where they left off", that viewers "can clear, expand and collapse and remove",
 * and "a page where they can just say see all".
 *
 * Nothing new is recorded: films and series come from the watch history the
 * players already keep (`watch.ts`), channels from the play log (`notePlay`). This
 * reads them in the order a person thinks of them — most recent first — and gives
 * each a way out.
 */
import { KIND } from '@iptv/core-store';
import { getPrefs, setPlays, setWatchHistory, type WatchRecord } from './prefs.ts';

export type WatchSection = 'movies' | 'series';

/** Channels most recently played, newest first. Stream ids. */
export function recentChannels(limit = 60): number[] {
  const prefix = `${KIND.Live}.`;
  return [...(getPrefs().plays ?? [])]
    .filter((r) => r.k.startsWith(prefix))
    .sort((x, y) => y.at - x.at)
    .slice(0, limit)
    .map((r) => Number(r.k.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Take one channel off "recently watched". Its favourite star is untouched. */
export function forgetChannel(streamId: number): void {
  const key = `${KIND.Live}.${streamId}`;
  setPlays((getPrefs().plays ?? []).filter((r) => r.k !== key));
}

/** Clear "recently watched" channels. Films and series keep their places. */
export function forgetAllChannels(): void {
  const prefix = `${KIND.Live}.`;
  setPlays((getPrefs().plays ?? []).filter((r) => !r.k.startsWith(prefix)));
}

/**
 * Titles in progress, one per film or series, newest first.
 *
 * A series watched over a week has a record per episode; this keeps the newest,
 * which is the one "carry on" should open.
 */
export function titlesInProgress(section?: WatchSection): WatchRecord[] {
  const seen = new Set<string>();
  return [...getPrefs().history]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((r) => section === undefined || r.section === section)
    .filter((r) => {
      const k = `${r.section}:${r.streamId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Take a film, or a whole series, off the list — every episode's place with it. */
export function forgetTitle(section: WatchSection, streamId: number): void {
  setWatchHistory(getPrefs().history.filter((r) => !(r.section === section && r.streamId === streamId)));
}

/** Clear every place in films, series, or both. */
export function forgetAllTitles(section?: WatchSection): void {
  setWatchHistory(section === undefined ? [] : getPrefs().history.filter((r) => r.section !== section));
}
