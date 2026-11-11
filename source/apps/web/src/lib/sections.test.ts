import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelsOnly, hasSection, showcaseReady } from './sections.ts';
import type { Inventory } from './api.ts';

function inv(over: Partial<Inventory> = {}): Inventory {
  return {
    generation: 1,
    live: 1000, movies: 500, series: 200, archive: 40, guide: 800,
    partial: false,
    ...over,
  };
}

/** What a device holding only the free public lists actually reports. */
const FREE: Inventory = inv({ live: 1466, movies: 0, series: 0, archive: 0, guide: 260 });

test('unknown means show it: a tab must not flash away half a second in', () => {
  for (const id of ['live', 'movies', 'series', 'catchup', 'guide', 'home'] as const) {
    assert.equal(hasSection(id, null), true, id);
  }
});

test('a section with nothing behind it is not offered', () => {
  assert.equal(hasSection('movies', FREE), false);
  assert.equal(hasSection('series', FREE), false);
  assert.equal(hasSection('catchup', FREE), false);
  // The channels themselves are the whole point of that device.
  assert.equal(hasSection('live', FREE), true);
});

test('home is the showcase, so it needs something to show', () => {
  // Rails of artwork over a video library. With neither, it redirects to Live,
  // which makes the tab a second button for the destination beside it.
  assert.equal(hasSection('home', FREE), false);
  assert.equal(hasSection('home', inv({ movies: 0, series: 12 })), true);
  assert.equal(hasSection('home', inv({ movies: 3, series: 0 })), true);
});

test('a full subscription is offered everything', () => {
  const full = inv();
  for (const id of ['live', 'movies', 'series', 'catchup', 'home'] as const) {
    assert.equal(hasSection(id, full), true, id);
  }
});

test('a boundary of one is still content', () => {
  assert.equal(hasSection('movies', inv({ movies: 1 })), true);
  assert.equal(hasSection('movies', inv({ movies: 0 })), false);
  assert.equal(hasSection('catchup', inv({ archive: 1 })), true);
});

test('channels-only is a question about content, not about paying', () => {
  // The free device: this is what sends it straight to Live TV.
  assert.equal(channelsOnly(FREE), true);
  // A subscription that happens to sell only live TV lands the same way. That is
  // the point of asking about content rather than about a tier.
  assert.equal(channelsOnly(inv({ movies: 0, series: 0, archive: 900 })), true);
  // Anything on demand, and the showcase has something to show.
  assert.equal(channelsOnly(inv({ movies: 1, series: 0 })), false);
  assert.equal(channelsOnly(inv({ movies: 0, series: 1 })), false);
  assert.equal(channelsOnly(inv()), false);
});

test('channels-only never fires on an unknown or empty library', () => {
  // Unknown: the app must not commit to a landing page it cannot justify.
  assert.equal(channelsOnly(null), false);
  // A device mid-first-download has nothing at all, which is not "channels only";
  // sending it to an empty channel list would be the same bug in a new place.
  assert.equal(channelsOnly(inv({ live: 0, movies: 0, series: 0 })), false);
});

/* ── a library whose packages are not here yet ────────────────────────────────
   Reported as "it doesn't show everything, it's like showing only a few things"
   on an account with 141,085 items.
   `archive` and `guide` are counted by SCANNING the items a device holds, so with
   nothing downloaded they are 0 because nothing is here — not because the
   subscription lacks them. */

const NOT_YET_FETCHED = inv({
  // Structure is known, so these are real: they come from the categories.
  live: 8994, movies: 63975, series: 20504,
  // These are scans over items nobody has downloaded. They mean nothing yet.
  archive: 0, guide: 0,
  partial: true,
});

test('a section is never hidden on a count the device could not take', () => {
  assert.equal(hasSection('catchup', NOT_YET_FETCHED), true);
});

test('the sections that CAN be counted from structure are still trusted', () => {
  assert.equal(hasSection('live', NOT_YET_FETCHED), true);
  assert.equal(hasSection('movies', NOT_YET_FETCHED), true);
  assert.equal(hasSection('series', NOT_YET_FETCHED), true);
});

test('once something is downloaded, a zero means zero again', () => {
  const fetched = inv({ archive: 0, partial: false });
  assert.equal(hasSection('catchup', fetched), false);
});

test('live is never hidden on a subscription that has channels', () => {
  // The worst of the reported symptoms: LIVE TV missing from an IPTV app,
  // because `live` was the count of channels DOWNLOADED rather than offered.
  assert.equal(hasSection('live', inv({ live: 8994, partial: true })), true);
});

/* ── the showcase, and what it is allowed to draw ─────────────────────────────
   Reported as "sections leak to the home page", with a screenshot of a hero
   showing a live channel and a rail of channel logos, on a subscription. */

test('a library whose films are not downloaded has nothing to show yet', () => {
  const offered = inv({
    live: 8994, movies: 63975, series: 20504,
    onDevice: { live: 1624, movies: 0, series: 0 },
  });
  // Navigable — the tabs stay, the films are real and one press away.
  assert.equal(hasSection('movies', offered), true);
  assert.equal(hasSection('series', offered), true);
  // But there is no artwork on this device, so the showcase must not pretend.
  assert.equal(showcaseReady(offered), false);
});

test('one downloaded group is enough for a showcase', () => {
  assert.equal(showcaseReady(inv({ onDevice: { live: 0, movies: 12, series: 0 } })), true);
  assert.equal(showcaseReady(inv({ onDevice: { live: 0, movies: 0, series: 3 } })), true);
});

test('a server catalogue is never waiting for anything', () => {
  // No `onDevice` at all: the whole catalogue is queryable, so there is nothing
  // to download and nothing to hold the page back.
  assert.equal(showcaseReady(inv()), true);
  // And an unanswered inventory shows the page rather than a holding screen.
  assert.equal(showcaseReady(null), true);
});
