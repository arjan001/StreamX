/**
 * How long an answer from the panel is believed.
 *
 * The distinction this file exists for cost a channel list its second line. A
 * guide that arrived is settled; an EMPTY answer is not an answer, and treating
 * the two the same meant a device that once got nothing would not ask again for
 * six hours. Measured on a real subscription: 43 of 55 channels stored with no
 * listings, and the Live screen making zero requests in thirty seconds.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_FRESH_S, FRESH_S, isFresh } from '../src/epg.ts';

const NOW = 1_700_000_000;
const cov = (listings: number, agoS: number, until: number | null = NOW + 86_400) => ({
  listings, fetchedAt: NOW - agoS, until: listings > 0 ? until : null,
});

test('never asked is never fresh', () => {
  assert.equal(isFresh(undefined, NOW), false);
  assert.equal(isFresh({ listings: 0, fetchedAt: null, until: null }, NOW), false);
});

test('a guide that arrived is settled for hours', () => {
  assert.equal(isFresh(cov(120, 60), NOW), true);
  assert.equal(isFresh(cov(120, FRESH_S - 60), NOW), true);
  assert.equal(isFresh(cov(120, FRESH_S + 60), NOW), false);
});

test('an empty answer is re-asked long before a real one would be', () => {
  /* The whole point: this used to be `true` for six hours. */
  assert.equal(isFresh(cov(0, EMPTY_FRESH_S + 60), NOW), false);
  assert.equal(isFresh(cov(0, 60), NOW), true, 'but not on every single press');
  assert.ok(EMPTY_FRESH_S < FRESH_S, 'an unanswered question must expire sooner');
});

test('listings that have run out are refetched inside the window', () => {
  assert.equal(isFresh(cov(120, 60, NOW - 1), NOW), false);
});
