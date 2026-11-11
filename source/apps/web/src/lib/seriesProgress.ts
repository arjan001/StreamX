/**
 * What has already been watched, per episode and per season.
 *
 * Asked for in one sentence — "add the progress and if they already watched it,
 * like all those kinds of things highlighted in a different color, they already
 * watched a season or an episode" — and answering it honestly means saying what
 * this device actually knows, because it is less than it looks.
 *
 * ── the two records, and why neither is enough alone ──
 *
 * `history` (lib/watch.ts) holds ONE `WatchRecord` per series. `saveWatch`
 * filters out every record for the same `(section, streamId)` before writing the
 * new one, so starting episode 4 erases the playhead for episode 3 — and
 * finishing an episode deletes the record outright (`done` → the record and the
 * resume mark retire together). So history answers "where am I in this series",
 * exactly once, and by design it forgets everything behind it.
 *
 * `plays` (prefs.notePlay, called from resume.noteLastPlayed) holds one counter
 * per opened stream, keyed `3.<episodeId>` — `Kind.Episode`. It is the only
 * per-episode record that survives moving on to the next one. It counts OPENS,
 * not completions, and it is capped at 300 entries trimmed by count then
 * recency, so on a very long history the oldest marks fall off.
 *
 * Together they are enough for the two states the request names:
 *
 *   started   the one episode history is holding a playhead for — a resume
 *             point, so it gets a bar showing how far in.
 *   watched   opened at least once and NOT the one being resumed, which after
 *             the deletion above is what "played to the end" leaves behind.
 *
 * The over-claim is deliberate and worth naming: an episode opened for three
 * seconds and abandoned is under MIN_SAVE, writes no record, and comes back as
 * "watched". The alternative is a list with no marks at all on precisely the
 * episodes somebody has been through, which is the worse of the two errors on a
 * screen whose whole job is "where was I".
 *
 * Nothing here reads or writes storage: both inputs arrive from `usePrefs`, so a
 * favourite or a playhead written anywhere in the app re-renders the marks, and
 * the rules are testable without a browser (`seriesProgress.test.ts`).
 */
import { Kind } from '@iptv/core-xtream';
import type { Episode } from './api.ts';
import type { PlayCount, WatchRecord } from './prefs.ts';
import { watchFraction } from './watch.ts';

export type EpisodeState = 'unseen' | 'started' | 'watched';

export interface EpisodeProgress {
  state: EpisodeState;
  /** How far in, 0–1. Only ever meaningful for `started`; 1 for `watched`. */
  fraction: number;
}

export type SeasonState = 'unseen' | 'partial' | 'watched';

export interface SeasonProgress {
  state: SeasonState;
  /** Episodes in the season. Zero seasons never reach here — see `bySeason`. */
  total: number;
  /** Whole episodes behind us, plus the part-watched one, 0–1 of the season. */
  fraction: number;
}

/** The `plays` key an episode is filed under. See `resume.noteLastPlayed`. */
export function episodeKey(episodeId: number): string {
  return `${Kind.Episode}.${episodeId}`;
}

/**
 * The mark for every episode of one series.
 *
 * `record` is that series' single history row — pass null when there is none.
 * `plays` is the whole profile's counter list; filtering it here rather than at
 * the call site keeps the "which prefix means an episode" question in one place.
 */
export function episodeProgress(
  episodes: readonly Episode[],
  plays: readonly PlayCount[],
  record: WatchRecord | null,
): Map<number, EpisodeProgress> {
  const opened = new Set<string>();
  for (const p of plays) if (p.k.startsWith(`${Kind.Episode}.`)) opened.add(p.k);

  /*
   * The playhead is only worth showing while it is still a resume point.
   * `watchFraction` returns null for a record that is within 15s of the end or
   * under the 5s floor — the two cases where resuming would be a no-op — and a
   * bar drawn from a position nothing will ever seek to is a lie about what the
   * next press does.
   */
  const resumable = watchFraction(record);
  const at = resumable === null ? null : record?.episodeId ?? null;

  const out = new Map<number, EpisodeProgress>();
  for (const e of episodes) {
    if (at !== null && e.episodeId === at) {
      out.set(e.episodeId, { state: 'started', fraction: resumable ?? 0 });
      continue;
    }
    if (opened.has(episodeKey(e.episodeId))) {
      out.set(e.episodeId, { state: 'watched', fraction: 1 });
      continue;
    }
    out.set(e.episodeId, { state: 'unseen', fraction: 0 });
  }
  return out;
}

/**
 * The episodes of one series, grouped by season number, in season order.
 *
 * Seasons come from the episodes themselves and never from `detail.seasons`, for
 * the reason the old page already recorded: on live data both were observed
 * empty independently of each other, so trusting the declared list shows an
 * empty series that actually has 22 of them.
 */
export function bySeason(episodes: readonly Episode[]): { season: number; episodes: Episode[] }[] {
  const groups = new Map<number, Episode[]>();
  for (const e of episodes) {
    const list = groups.get(e.seasonNumber);
    if (list === undefined) groups.set(e.seasonNumber, [e]);
    else list.push(e);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, list]) => ({
      season,
      /* Panels return episodes in whatever order the JSON object enumerated, and
         a season that lists E10 before E2 reads as a broken page. Null episode
         numbers sort last rather than as zero. */
      episodes: [...list].sort(
        (a, b) => (a.episodeNumber ?? Infinity) - (b.episodeNumber ?? Infinity),
      ),
    }));
}

/** The rollup a season header draws: how much of it is behind the viewer. */
export function seasonProgress(
  episodes: readonly Episode[],
  marks: Map<number, EpisodeProgress>,
): SeasonProgress {
  const total = episodes.length;
  if (total === 0) return { state: 'unseen', total: 0, fraction: 0 };
  let done = 0;
  let part = 0;
  for (const e of episodes) {
    const m = marks.get(e.episodeId);
    if (m === undefined) continue;
    if (m.state === 'watched') done += 1;
    else if (m.state === 'started') part += m.fraction;
  }
  const fraction = Math.min(1, (done + part) / total);
  const state: SeasonState = done === total ? 'watched' : done + part > 0 ? 'partial' : 'unseen';
  return { state, total, fraction };
}

/**
 * The one episode to put on when the viewer opens this series.
 *
 * "when you open a series it should automatically play the 1st one instead of me
 * picking or continue from where it stopped."
 *
 * The obvious reading — "the episode the playhead is in, else the first" — is
 * wrong for the commonest case, and the reason is written at the top of this
 * file: finishing an episode DELETES the history row. So a viewer who watched
 * S01E03 to the end has no playhead at all, and that rule hands them S01E01,
 * full screen, automatically. Somebody three episodes in would be restarted at
 * the beginning by a feature meant to save them a press.
 *
 * `plays` survives that deletion, which is what makes the right answer
 * reachable. In order:
 *
 *   1. the episode holding a live playhead — the true "where I stopped", and
 *      the only one that also carries a position to resume at;
 *   2. otherwise the first episode after the LAST one that has been opened,
 *      which is "the next one" after a finished episode;
 *   3. otherwise the first episode, which is a series never played.
 *
 * Step 2 reads the last watched mark rather than the first unseen one on
 * purpose: a viewer who dipped into the finale, or who has a gap because a
 * `plays` entry aged out of its 300-entry cap, should carry on from the furthest
 * point they reached and not be sent back to fill in a hole.
 *
 * Returns null only for a series with no episodes at all.
 */
export function nextUp(
  episodes: readonly Episode[],
  marks: ReadonlyMap<number, EpisodeProgress>,
): Episode | null {
  if (episodes.length === 0) return null;
  let lastWatched = -1;
  for (let i = 0; i < episodes.length; i++) {
    const state = marks.get(episodes[i]!.episodeId)?.state;
    if (state === 'started') return episodes[i]!;
    if (state === 'watched') lastWatched = i;
  }
  /* Everything has been seen: the last one is where they are, not the first —
     a viewer at the end of a series is not at the start of it. */
  return episodes[lastWatched + 1] ?? episodes[episodes.length - 1] ?? null;
}
