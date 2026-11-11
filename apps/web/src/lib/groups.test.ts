/**
 * Market codes: what they mean, and what KIND of thing they name.
 *
 * Both answers are section-dependent because this provider's codes are, and the
 * values here were read off `get_vod_categories` / `get_series_categories` on
 * 2026-09-08 rather than inferred from the letters — which is the only way to
 * know that `AF` is Africa and not Afghanistan.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketKind, marketName } from './groups.ts';

test('a market code can mean two different things in two sections', () => {
  /* Read off the provider's own category names on 2026-09-08: `LA| LATINO
     SERIES` in the VOD lists, `LV|` channels on the live side. One flat table
     labelled Latin American films "Latvia". */
  assert.equal(marketName('LA', 'series'), 'Latin America');
  assert.equal(marketName('LA', 'movies'), 'Latin America');
  assert.equal(marketName('LA'), 'Latvia');
  assert.equal(marketKind('LA', 'movies'), 'region');
  assert.equal(marketKind('LA'), 'country');
});

test('the codes that showed as raw letters have names', () => {
  /* Each one verified against its member categories rather than guessed from
     the code — `AF` is AFRICAN MOVIES / SOUTH AFRICA, not Afghanistan. */
  assert.equal(marketName('AF', 'movies'), 'Africa');
  assert.equal(marketName('SCA', 'movies'), 'Scandinavia');
  assert.equal(marketName('SO', 'movies'), 'Somalia');
  assert.equal(marketName('ISR', 'movies'), 'Israel');
  assert.equal(marketName('CN', 'movies'), 'China');
  assert.equal(marketName('DK', 'movies'), 'Denmark');
  assert.equal(marketName('IN', 'movies'), 'India');
});

test('IR is Persian in the film lists and stays ambiguous elsewhere', () => {
  /* The shared table leaves IR blank on purpose — the provider uses it for both
     Ireland and Iran — and in the VOD lists all nine of its categories are
     Persian, so there it is not a guess. */
  assert.equal(marketName('IR', 'movies'), 'Iran');
  assert.equal(marketName('IR'), 'IR');
});

test('languages and topics are not countries', () => {
  assert.equal(marketKind('EN'), 'language');
  assert.equal(marketKind('AR'), 'language');
  assert.equal(marketKind('MU'), 'topic');
  assert.equal(marketKind('SPT'), 'topic');
  assert.equal(marketKind('18'), 'topic');
  assert.equal(marketKind('AF', 'movies'), 'region');
  assert.equal(marketKind('EXYU'), 'region');
  /* Everything unlisted is a country, which is what an unknown two-letter code
     nearly always is. */
  assert.equal(marketKind('BE'), 'country');
  assert.equal(marketKind('ZZ'), 'country');
});
