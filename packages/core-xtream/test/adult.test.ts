import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdultCategoryName, isAdultTitle } from '../src/adult.ts';

const ADULT_CATEGORIES = [
  'XXX Movies', 'xxx', 'XXXX', 'Adult', 'Adults', 'ADULT MOVIES', 'Adults Only',
  'Porn', 'Pornstars', 'Erotic Films', 'Erotica', 'Erotik', '18+', '+18',
  'Movies 18+', '18 +', 'NSFW', 'For Adults', 'Films pour adultes', 'Adulte',
  'Películas adultos', 'Contenuti adulti', 'Erwachsene', 'Erwachsenen Filme',
  'Erótico', 'Hentai', 'X-Rated', 'Adult: Live', 'US| ADULT', 'EN | XXX',
];

const INNOCENT_CATEGORIES = [
  'Adult Swim', 'ADULT SWIM HD', 'Adulthood (2025)', 'Kids', 'Family', 'Movies',
  'Young Adult', 'Adult Contemporary', 'Adult Education', 'Sports', 'Documentary',
  'Top 2018+ Hits', 'Class of 1918+', 'Mixed Martial Arts', 'Sex Education',
  'Adultery', 'US| NETFLIX', '',
];

test('adult category names are flagged', () => {
  for (const n of ADULT_CATEGORIES) assert.equal(isAdultCategoryName(n), true, n);
});

test('innocent names that contain an adult-looking word are not', () => {
  for (const n of INNOCENT_CATEGORIES) assert.equal(isAdultCategoryName(n), false, n);
  assert.equal(isAdultCategoryName(null), false);
  assert.equal(isAdultCategoryName(undefined), false);
});

test('a title opening with an adult tag is flagged', () => {
  for (const t of [
    '[X] Studio - Performer - Title', '[XXX] Title', '[xx] Title', '(XXX) Title',
    'XXX | Title', 'XXX - Title', 'XXX] Title',
  ]) assert.equal(isAdultTitle(t), true, t);
});

test('real films that start like a tag are not', () => {
  for (const t of [
    'xXx (2002)', 'XXX: Return of Xander Cage', 'Adulthood (2025)', 'X-Men',
    'The X Files', 'Plain Title', '',
  ]) assert.equal(isAdultTitle(t), false, t);
});
