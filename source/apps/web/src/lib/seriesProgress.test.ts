import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Episode } from './api.ts';
import type { PlayCount, WatchRecord } from './prefs.ts';
import {
  bySeason, episodeKey, episodeProgress, nextUp, seasonProgress,
  type EpisodeProgress, type EpisodeState,
} from './seriesProgress.ts';

function ep(episodeId: number, seasonNumber: number, episodeNumber: number | null): Episode {
  return {
    episodeId,
    seasonNumber,
    episodeNumber,
    title: `E${episodeNumber ?? '?'}`,
    ext: 'mkv',
    plot: null,
    durationSecs: 2400,
    image: null,
  };
}

function opened(...ids: number[]): PlayCount[] {
  return ids.map((id) => ({ k: episodeKey(id), n: 1, at: 1 }));
}

function playhead(episodeId: number, positionS: number, durationS: number): WatchRecord {
  return {
    section: 'series',
    streamId: 900,
    positionS,
    durationS,
    episodeId,
    season: 1,
    episode: 1,
    updatedAt: 1,
  };
}

test('an opened episode is watched, an untouched one is not', () => {
  const eps = [ep(1, 1, 1), ep(2, 1, 2)];
  const marks = episodeProgress(eps, opened(1), null);
  assert.equal(marks.get(1)?.state, 'watched');
  assert.equal(marks.get(2)?.state, 'unseen');
});

/* The whole reason both records are read: history holds ONE row per series, so
   the resume point and the trail behind it can only come from different places. */
test('the episode holding the playhead is started, not watched', () => {
  const eps = [ep(1, 1, 1), ep(2, 1, 2)];
  const marks = episodeProgress(eps, opened(1, 2), playhead(2, 600, 2400));
  assert.equal(marks.get(1)?.state, 'watched');
  assert.equal(marks.get(2)?.state, 'started');
  assert.equal(marks.get(2)?.fraction, 0.25);
});

/* `watchFraction` refuses a record that is within 15s of the end or under the 5s
   floor. Neither is a resume point, so neither draws a bar — the episode falls
   back to what `plays` says about it. */
test('a playhead nothing would seek to is not progress', () => {
  const eps = [ep(1, 1, 1)];
  assert.equal(episodeProgress(eps, opened(1), playhead(1, 2395, 2400)).get(1)?.state, 'watched');
  assert.equal(episodeProgress(eps, opened(1), playhead(1, 2, 2400)).get(1)?.state, 'watched');
  assert.equal(episodeProgress(eps, [], playhead(1, 2, 2400)).get(1)?.state, 'unseen');
});

test('other kinds in the play counter are not episodes', () => {
  const eps = [ep(7, 1, 1)];
  const marks = episodeProgress(eps, [{ k: '2.7', n: 4, at: 1 }], null);
  assert.equal(marks.get(7)?.state, 'unseen');
});

test('seasons come from the episodes, in order, with their episodes sorted', () => {
  const groups = bySeason([ep(1, 2, 10), ep(2, 1, 2), ep(3, 1, 1), ep(4, 2, 2)]);
  assert.deepEqual(groups.map((g) => g.season), [1, 2]);
  assert.deepEqual(groups[0]?.episodes.map((e) => e.episodeNumber), [1, 2]);
  assert.deepEqual(groups[1]?.episodes.map((e) => e.episodeNumber), [2, 10]);
});

/* An unnumbered episode sorts last rather than as zero, which would put it above
   E01 on every specials-carrying series. */
test('an episode with no number sorts to the end of its season', () => {
  const groups = bySeason([ep(1, 1, null), ep(2, 1, 1)]);
  assert.deepEqual(groups[0]?.episodes.map((e) => e.episodeId), [2, 1]);
});

test('a season is only watched when every episode of it is', () => {
  const eps = [ep(1, 1, 1), ep(2, 1, 2), ep(3, 1, 3)];
  const all = seasonProgress(eps, episodeProgress(eps, opened(1, 2, 3), null));
  assert.equal(all.state, 'watched');
  assert.equal(all.fraction, 1);

  const some = seasonProgress(eps, episodeProgress(eps, opened(1), null));
  assert.equal(some.state, 'partial');
  assert.equal(Math.round(some.fraction * 100), 33);

  const none = seasonProgress(eps, episodeProgress(eps, [], null));
  assert.equal(none.state, 'unseen');
  assert.equal(none.fraction, 0);
});

/* Half an episode is still progress: a season nobody has finished a single
   episode of must not read as untouched while its bar is moving. */
test('a part-watched episode counts towards its season', () => {
  const eps = [ep(1, 1, 1), ep(2, 1, 2)];
  const s = seasonProgress(eps, episodeProgress(eps, [], playhead(1, 1200, 2400)));
  assert.equal(s.state, 'partial');
  assert.equal(s.fraction, 0.25);
});

test('a season with no episodes is unseen rather than complete', () => {
  const s = seasonProgress([], new Map());
  assert.equal(s.state, 'unseen');
  assert.equal(s.total, 0);
});

/* ── what opening a series should put on ─────────────────────── */

const marksOf = (pairs: [number, EpisodeState][]): Map<number, EpisodeProgress> =>
  new Map(pairs.map(([id, state]) => [id, { state, fraction: state === 'watched' ? 1 : 0 }]));

const run = (ids: number[]) => ids.map((n) => ep(n, 1, n));

test('a series never played starts at the first episode', () => {
  assert.equal(
    nextUp(run([1, 2, 3]), marksOf([[1, 'unseen'], [2, 'unseen'], [3, 'unseen']]))?.episodeId,
    1,
  );
});

test('a live playhead wins over everything — that IS where they stopped', () => {
  assert.equal(
    nextUp(run([1, 2, 3]), marksOf([[1, 'watched'], [2, 'started'], [3, 'unseen']]))?.episodeId,
    2,
  );
});

/* The case the obvious rule gets wrong: finishing an episode deletes the history
   row, so there is no playhead to find and "else the first" restarts the show. */
test('a finished episode hands over the NEXT one, not the first', () => {
  assert.equal(
    nextUp(
      run([1, 2, 3, 4]),
      marksOf([[1, 'watched'], [2, 'watched'], [3, 'watched'], [4, 'unseen']]),
    )?.episodeId,
    4,
  );
});

/* A gap can be a dip into a later episode or a `plays` entry aged out of its
   300-entry cap. Either way the furthest point reached is where the viewer is. */
test('a gap behind the furthest point watched does not send anyone back to fill it', () => {
  assert.equal(
    nextUp(
      run([1, 2, 3, 4]),
      marksOf([[1, 'watched'], [2, 'unseen'], [3, 'watched'], [4, 'unseen']]),
    )?.episodeId,
    4,
  );
});

test('a series watched to the end stays at the end rather than looping to the start', () => {
  assert.equal(nextUp(run([1, 2]), marksOf([[1, 'watched'], [2, 'watched']]))?.episodeId, 2);
});

test('a series with no episodes has nothing to put on', () => {
  assert.equal(nextUp([], new Map()), null);
});
