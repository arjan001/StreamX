import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openingScope } from './liveOpening.ts';

const m = (id: string, count: number) => ({ id, count });

/* The subscription in `.env`, trimmed to what this decision reads: several of
   the six, a country that is none of them, and the language markets its films
   are filed under — which carry no channels at all. */
const LIBRARY = [
  m('UK', 611), m('NL', 1204), m('BE', 495), m('IT', 402), m('DE', 1782),
  m('TR', 380), m('EN', 0), m('MULTI', 0), m('OTHER', 0),
];

/* A profile's allow-list on that library: countries plus every film/series
   market, because one list scopes all three sections. */
const SEEDED = ['UK', 'NL', 'BE', 'IT', 'EN', 'MULTI', 'OTHER'];

test('an untouched profile with nothing starred opens the way it always has', () => {
  assert.equal(openingScope(0, SEEDED, LIBRARY), null);
});

test('starred channels win: that is the list somebody built themselves', () => {
  assert.deepEqual(openingScope(12, SEEDED, LIBRARY), { favs: true, markets: [] });
  /* Even over a narrowed country — a favourite is a channel, a country is a
     shelf, and the channel is the nearer answer. */
  assert.deepEqual(openingScope(1, ['NL', 'EN'], LIBRARY), { favs: true, markets: [] });
});

/*
 * Favourites that no longer exist here are not a list.
 *
 * They survive a change of provider — they are provider stream ids, not rows —
 * so a device pointed at a new line can hold a hundred of them and show none.
 * Opening on that is answering a wall with an empty screen.
 */
test('favourites the catalogue cannot show are not opened on', () => {
  /* A profile can hold a hundred stars and resolve none of them here. The
     decision is made on what can be SHOWN, so this falls through to the country
     rather than opening on an empty list. */
  assert.deepEqual(openingScope(0, ['NL', 'EN'], LIBRARY), { favs: false, markets: ['NL'] });
});

test('a profile narrowed to one television country opens on it', () => {
  assert.deepEqual(openingScope(0, ['NL', 'EN', 'MULTI'], LIBRARY), { favs: false, markets: ['NL'] });
});

test('the country does not have to be one of the six — any single one counts', () => {
  assert.deepEqual(openingScope(0, ['TR'], LIBRARY), { favs: false, markets: ['TR'] });
});

/*
 * Two countries is already a two-row sidebar and an "All countries" that means
 * exactly those two. There is no wall left to open past, and the heading can
 * only ever name one of them.
 */
test('several countries are left alone', () => {
  assert.equal(openingScope(0, ['UK', 'NL', 'EN'], LIBRARY), null);
});

test('a profile that allows everything is left alone', () => {
  assert.equal(openingScope(0, [], LIBRARY), null);
});

test('nothing is decided while the catalogue is still building', () => {
  assert.equal(openingScope(0, ['NL'], null), null);
  /* Except the favourites, which need no catalogue to be a shorter list. */
  assert.deepEqual(openingScope(3, ['NL'], null), { favs: true, markets: [] });
});

/* A market in the profile that this library does not carry is not a country
   somebody is watching — it is a leftover from the line before. */
test('markets the library does not carry do not count as the one', () => {
  assert.equal(openingScope(0, ['ES', 'PT'], LIBRARY), null);
  assert.deepEqual(openingScope(0, ['ES', 'NL'], LIBRARY), { favs: false, markets: ['NL'] });
});
