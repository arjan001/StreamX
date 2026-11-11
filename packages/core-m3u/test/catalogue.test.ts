import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M3U_KIND, categoryOf, classifyEntry, syntheticId } from '../src/catalogue.ts';

const e = (over: { url?: string; groups?: string[]; name?: string } = {}) => ({
  url: over.url ?? 'http://h/live/u/p/1.ts',
  groups: over.groups ?? [],
  name: over.name ?? 'Something',
});

test('an Xtream-exported path is believed over any group title', () => {
  assert.equal(classifyEntry(e({ url: 'http://h/movie/u/p/9.mp4', groups: ['NEWS'] })), M3U_KIND.Movie);
  assert.equal(classifyEntry(e({ url: 'http://h/series/u/p/9.mkv', groups: ['NEWS'] })), M3U_KIND.Episode);
});

test('series is decided before films, because "VOD SERIES" contains both words', () => {
  // A URL with no signal in it, so the group is what decides.
  const u = 'http://h/stream?id=1';
  assert.equal(classifyEntry(e({ url: u, groups: ['VOD SERIES'] })), M3U_KIND.Episode);
  assert.equal(classifyEntry(e({ url: u, groups: ['FR - SERIES'] })), M3U_KIND.Episode);
  assert.equal(classifyEntry(e({ url: u, groups: ['TV Shows'] })), M3U_KIND.Episode);
});

test('the words providers actually use for films are recognised', () => {
  // No URL signal, so the group decides. `notaurl` has no path at all.
  for (const g of ['VOD', 'EN - MOVIES', 'FILMS 4K', 'CINEMA', 'Peliculas', 'FILME']) {
    assert.equal(classifyEntry(e({ url: 'http://h/x.mp4', groups: [g] })), M3U_KIND.Movie, g);
  }
});

test('a legacy live URL beats a group called MOVIES', () => {
  /*
   * The real failure this was written for: on a 592,752-entry playlist,
   * "STARZ KIDS & FAMILY HD" and "COMEDY CENTRAL +1" were filed as films,
   * because their channel groups are named "UK| MOVIES". Channel groups are
   * named after what they broadcast.
   */
  const legacy = { url: 'http://line.example:80/user/pass/2116347', groups: ['UK| MOVIES'], name: 'GREAT! MOVIES' };
  assert.equal(classifyEntry(legacy), M3U_KIND.Live);
  assert.equal(classifyEntry({ ...legacy, groups: ['UK| SERIES'] }), M3U_KIND.Live);
});

test('an extension decides when nothing else does', () => {
  assert.equal(classifyEntry(e({ url: 'http://h/a/b/c.mp4', groups: [] })), M3U_KIND.Movie);
  assert.equal(classifyEntry(e({ url: 'http://h/a/b/c.mkv', groups: [] })), M3U_KIND.Movie);
  assert.equal(classifyEntry(e({ url: 'http://h/a/b/c.ts', groups: [] })), M3U_KIND.Live);
  assert.equal(classifyEntry(e({ url: 'http://h/a/b/c.m3u8', groups: [] })), M3U_KIND.Live);
});

test('a playlist that says nothing is treated as channels, not as nothing', () => {
  assert.equal(classifyEntry(e({ url: 'http://h/x', groups: [] })), M3U_KIND.Live);
  assert.equal(classifyEntry(e({ url: 'http://h/x', groups: ['Sky Sports'] })), M3U_KIND.Live);
  assert.equal(classifyEntry(e({ url: 'notaurl', groups: [] })), M3U_KIND.Live);
});

test('an id is stable for the same pair, and moves if either half changes', () => {
  const a = syntheticId('BBC One HD', 'http://h/1.ts');
  assert.equal(a, syntheticId('BBC One HD', 'http://h/1.ts'));
  assert.notEqual(a, syntheticId('BBC Two HD', 'http://h/1.ts'));
  assert.notEqual(a, syntheticId('BBC One HD', 'http://h/2.ts'));
});

test('an id is always a usable positive int32, never 0', () => {
  for (const n of ['', 'a', 'x'.repeat(500), ' ', 'multi word name']) {
    const id = syntheticId(n, n);
    assert.ok(Number.isInteger(id), n);
    assert.ok(id > 0 && id <= 0x7fffffff, `${n} -> ${id}`);
  }
});

test('the two halves cannot be swapped without changing the id', () => {
  assert.notEqual(syntheticId('ab', 'c'), syntheticId('a', 'bc'));
});

test('an ungrouped entry still gets a category', () => {
  assert.equal(categoryOf({ groups: [] }), 'Ungrouped');
  assert.equal(categoryOf({ groups: ['  '] }), 'Ungrouped');
  assert.equal(categoryOf({ groups: ['News', 'Sport'] }), 'News');
});

test('a group called Movies does not turn a channel into a film', () => {
  /* Both are real rows from a public list: channels that broadcast films, in a
     group named after what they broadcast. Filing them as films is what put
     channel logos in a "Just added — films" rail on the home page. */
  assert.equal(
    classifyEntry({
      url: 'https://cdn.example.com/afghan-nobel/index.m3u8',
      groups: ['Movies'],
      name: 'Afghan Nobel Movies',
    }),
    M3U_KIND.Live,
  );
  assert.equal(
    classifyEntry({ url: 'https://x.example/live/ch.m3u8?token=abc', groups: ['Series'], name: 'Maah TV' }),
    M3U_KIND.Live,
  );
  /* And a real file still is one — the URL is what decides, in both directions. */
  assert.equal(
    classifyEntry({ url: 'http://p.example/movie/u/p/9.mkv', groups: ['VOD'], name: 'A Film' }),
    M3U_KIND.Movie,
  );
  assert.equal(
    classifyEntry({ url: 'http://p.example/x/9.mp4', groups: ['VOD'], name: 'A Film' }),
    M3U_KIND.Movie,
  );
});
