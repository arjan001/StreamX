import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWatch, resumeAt, saveWatch, watchFraction } from './watch.ts';
import { setWatchHistory } from './prefs.ts';

function rec(
  positionS: number,
  durationS: number,
): Parameters<typeof resumeAt>[0] {
  return {
    section: 'movies',
    streamId: 1,
    positionS,
    durationS,
    episodeId: null,
    season: null,
    episode: null,
    updatedAt: 1,
  };
}

test('saveWatch keeps a mid-title position', () => {
  setWatchHistory([]);
  saveWatch({ section: 'movies', streamId: 9 }, 120, 3600);
  assert.equal(getWatch('movies', 9)?.positionS, 120);
  assert.equal(getWatch('movies', 9)?.durationS, 3600);
});

test('saveWatch drops a position under 5s so a reopen starts from the beginning', () => {
  setWatchHistory([]);
  saveWatch({ section: 'movies', streamId: 9 }, 120, 3600);
  saveWatch({ section: 'movies', streamId: 9 }, 2, 3600);
  assert.equal(getWatch('movies', 9), null);
});

test('saveWatch drops a title within 15s of the end', () => {
  setWatchHistory([]);
  saveWatch({ section: 'movies', streamId: 9 }, 120, 3600);
  saveWatch({ section: 'movies', streamId: 9 }, 3590, 3600);
  assert.equal(getWatch('movies', 9), null);
});

test('saveWatch keeps position when duration is still unknown', () => {
  setWatchHistory([]);
  saveWatch({ section: 'movies', streamId: 9 }, 90, 0);
  assert.equal(getWatch('movies', 9)?.positionS, 90);
  assert.equal(getWatch('movies', 9)?.durationS, 0);
});

test('saveWatch ignores a non-finite duration instead of storing Infinity', () => {
  setWatchHistory([]);
  saveWatch({ section: 'movies', streamId: 9 }, 90, Number.POSITIVE_INFINITY);
  assert.equal(getWatch('movies', 9)?.durationS, 0);
  assert.equal(getWatch('movies', 9)?.positionS, 90);
});

test('resumeAt skips finished and too-early records', () => {
  assert.equal(resumeAt(null), undefined);
  assert.equal(resumeAt(rec(3, 100)), undefined);
  assert.equal(resumeAt(rec(90, 100)), undefined);
  assert.equal(resumeAt(rec(80, 100)), 80);
  assert.equal(resumeAt(rec(90, 0)), 90);
});

test('watchFraction is only for in-progress titles with a known duration', () => {
  assert.equal(watchFraction(null), null);
  assert.equal(watchFraction(rec(80, 0)), null);
  assert.equal(watchFraction(rec(80, 100)), 0.8);
  assert.equal(watchFraction(rec(3, 100)), null);
});

/* ── one mark per EPISODE, not one per series ─────────────────────────────── */

test('starting the next episode does not erase the last one', () => {
  /*
    "It doesn't save the progress of how much watched… if I go next, it's lost."
    The record was identified by section + streamId, and for a series streamId is
    the SERIES — `episodeId` was stored but took no part in deciding what it
    replaced. So a series could only ever remember one place.
  */
  setWatchHistory([]);
  saveWatch({ section: 'series', streamId: 7, episodeId: 101, season: 1, episode: 1 }, 300, 3000);
  saveWatch({ section: 'series', streamId: 7, episodeId: 102, season: 1, episode: 2 }, 60, 3000);
  assert.equal(getWatch('series', 7, 101)?.positionS, 300, 'episode 1 survived');
  assert.equal(getWatch('series', 7, 102)?.positionS, 60, 'episode 2 was saved');
});

test('asking about the series answers with the episode you stopped on', () => {
  /* The Continue strip and the poster overlays want "resume this series", which
     is the NEWEST episode of it, not the first one found. */
  setWatchHistory([]);
  saveWatch({ section: 'series', streamId: 7, episodeId: 101, season: 1, episode: 1 }, 300, 3000);
  saveWatch({ section: 'series', streamId: 7, episodeId: 102, season: 1, episode: 2 }, 60, 3000);
  assert.equal(getWatch('series', 7)?.episodeId, 102);
});

test('a film keeps exactly one mark, as it always did', () => {
  /* Both sides have a null episodeId, so the identity collapses to section +
     stream and nothing about films changes. */
  setWatchHistory([]);
  saveWatch({ section: 'movies', streamId: 9 }, 120, 3600);
  saveWatch({ section: 'movies', streamId: 9 }, 240, 3600);
  assert.equal(getWatch('movies', 9)?.positionS, 240);
});
