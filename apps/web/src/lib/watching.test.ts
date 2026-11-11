import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrefs, notePlay, setPlays, setWatchHistory, type WatchRecord } from './prefs.ts';
import {
  forgetAllChannels, forgetAllTitles, forgetChannel, forgetTitle, recentChannels, titlesInProgress,
} from './watching.ts';

/**
 * "an area … where they left off … they can clear, expand and collapse and
 * remove". These pin the removing: a list somebody cannot take things off is
 * the complaint, not the feature.
 */
const rec = (section: 'movies' | 'series', streamId: number, updatedAt: number, episodeId: number | null = null): WatchRecord =>
  ({ section, streamId, positionS: 600, durationS: 3000, episodeId, season: null, episode: null, updatedAt });

beforeEach(() => { setWatchHistory([]); setPlays([]); });

test('channels come back newest first, and only channels', () => {
  setPlays([
    { k: '1.100', n: 9, at: 1_000 },
    { k: '1.200', n: 1, at: 3_000 },
    { k: '2.300', n: 5, at: 4_000 },   // a film, not a channel
    { k: '1.400', n: 2, at: 2_000 },
  ]);
  assert.deepEqual(recentChannels(), [200, 400, 100], 'by when, not by how often');
});

test('a channel can be taken off, and the list can be cleared, without touching films', () => {
  setPlays([{ k: '1.100', n: 1, at: 1 }, { k: '1.200', n: 1, at: 2 }, { k: '2.300', n: 1, at: 3 }]);
  forgetChannel(200);
  assert.deepEqual(recentChannels(), [100]);
  forgetAllChannels();
  assert.deepEqual(recentChannels(), []);
  assert.equal(getPrefs().plays.length, 1, 'the film play is still counted');
});

test('a series is one entry at its newest episode, and removing it removes every episode', () => {
  setWatchHistory([
    rec('series', 7, 1_000, 71), rec('series', 7, 5_000, 73), rec('series', 7, 3_000, 72),
    rec('movies', 9, 4_000),
  ]);
  const titles = titlesInProgress();
  assert.deepEqual(titles.map((t) => `${t.section}:${t.streamId}:${t.episodeId}`), ['series:7:73', 'movies:9:null']);
  forgetTitle('series', 7);
  assert.deepEqual(titlesInProgress().map((t) => t.streamId), [9]);
  assert.equal(getPrefs().history.length, 1, 'no stray episode records left behind');
});

test('clearing films leaves series alone, and clearing everything clears everything', () => {
  setWatchHistory([rec('series', 7, 1), rec('movies', 9, 2), rec('movies', 10, 3)]);
  forgetAllTitles('movies');
  assert.deepEqual(titlesInProgress().map((t) => t.section), ['series']);
  forgetAllTitles();
  assert.deepEqual(titlesInProgress(), []);
});

test('playing a channel puts it at the front', () => {
  notePlay('1.100');
  notePlay('1.200');
  assert.equal(recentChannels()[0], 200);
});
