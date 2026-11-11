import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchHref, sectionForPath, tabForPath } from './sections.ts';

test('a section page names itself, and its satellites name their catalogue', () => {
  assert.equal(sectionForPath('/movies'), 'movies');
  assert.equal(sectionForPath('/movies?genres=comedy'), 'movies');
  assert.equal(sectionForPath('/movie/2.123'), 'movies');
  assert.equal(sectionForPath('/series'), 'series');
  assert.equal(sectionForPath('/series/2.9'), 'series');
  assert.equal(sectionForPath('/live'), 'live');
  // The guide and catch-up are views onto live television.
  assert.equal(sectionForPath('/guide'), 'live');
  assert.equal(sectionForPath('/catchup'), 'live');
  assert.equal(sectionForPath('/favourites'), 'live');
});

test('somewhere with no section is null, not a guess', () => {
  assert.equal(sectionForPath('/home'), null);
  assert.equal(sectionForPath('/more?s=appearance'), null);
  assert.equal(sectionForPath('/search'), null);
  assert.equal(sectionForPath('/'), null);
});

/* `/livestream` must not read as `/live`, or every unrelated route that happens
   to start with a section's letters would rank the wrong block first. */
test('a longer word that merely starts the same is not that section', () => {
  assert.equal(sectionForPath('/livestream'), null);
  assert.equal(sectionForPath('/guidebook'), null);
});

/*
 * `from` is a nav TAB, because it answers two questions at once: the search page
 * ranks its blocks by `sectionForPath('/' + from)`, and the header keeps that tab
 * lit so the whole strip does not go dim the moment search opens.
 */
test('the origin travels in the URL, so a reload or a shared link keeps it', () => {
  assert.equal(searchHref('/movies'), '/search?from=movies');
  assert.equal(searchHref('/live', 'star'), '/search?q=star&from=live');
  // Home is a tab even though it is not a catalogue: it still lights.
  assert.equal(searchHref('/home'), '/search?from=home');
  // Settings is neither, so nothing is claimed and nothing lights.
  assert.equal(searchHref('/more'), '/search');
});

test('the guide and catch-up keep their own tabs, and rank as live', () => {
  assert.equal(searchHref('/guide'), '/search?from=guide');
  assert.equal(tabForPath('/catchup'), 'catchup');
  // The round trip the search page makes to order its blocks.
  assert.equal(sectionForPath('/guide'), 'live');
  assert.equal(sectionForPath('/catchup'), 'live');
  assert.equal(sectionForPath('/home'), null);
});

/* `/favourites` is absent from the nav, so it has no tab to light — but
   its results should still be ranked live-first, which is what the fallback to
   the section is for. */
test('a page with no tab still travels as its catalogue', () => {
  assert.equal(searchHref('/favourites'), '/search?from=live');
});

/* Same floor the page itself uses: under two letters is not a search yet, and a
   `?q=s` in the address would show "type at least two letters" beside a query. */
test('a query too short to run is not put in the address', () => {
  assert.equal(searchHref('/movies', 's'), '/search?from=movies');
  assert.equal(searchHref('/movies', '  '), '/search?from=movies');
  assert.equal(searchHref('/movies', '  star  '), '/search?q=star&from=movies');
});
