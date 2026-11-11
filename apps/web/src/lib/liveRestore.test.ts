import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsChannel, type ChannelClaims } from './liveRestore.ts';

/** Nothing claimed: a cold page that has only just read the address. */
const cold: ChannelClaims = { opened: null, pending: null, closed: null };

test('a deep link is a request, and gets opened', () => {
  assert.equal(wantsChannel('1.501495737', cold), true);
  assert.equal(wantsChannel('', cold), false, 'no channel named, nothing to open');
});

test('the address describing what is already playing is not a request', () => {
  const playing: ChannelClaims = { opened: '1.501495737', pending: null, closed: null };
  assert.equal(wantsChannel('1.501495737', playing), false);
  // …but a DIFFERENT channel in the address still is: that is a deep link
  // arriving while something else plays, which is how search and the home rails
  // change channel.
  assert.equal(wantsChannel('1.888', playing), true);
});

test('mid-open, the address still names the OLD channel and must be ignored', () => {
  // `setCurrent` re-renders before `setParams` lands, so for one commit `?ch=`
  // holds the previous channel. Answering it cancels the load in flight — the
  // "one click did nothing, the second stuck" bug.
  const opening: ChannelClaims = { opened: '1.888', pending: '1.888', closed: null };
  assert.equal(wantsChannel('1.501495737', opening), false);
});

/**
 * The bug the box reported: "when you go back instead of going back it goes to
 * another channel".
 *
 * BACK runs `close()`, which clears `opened` on the line it runs and drops
 * `?ch=` a commit later. Without the third ref the gap between the two reads as
 * a deep link, and the channel the viewer just left is re-opened — measured on
 * `/live` with `scripts/back-probe.mjs` as a new stream, the country filter
 * re-armed, and the highlight on a different channel. Only the second BACK
 * closed anything.
 */
test('mid-close, the address still names the channel BACK just closed', () => {
  const closing: ChannelClaims = { opened: null, pending: null, closed: '1.501495737' };
  assert.equal(wantsChannel('1.501495737', closing), false, 'BACK must not re-open it');
});

test('closing one channel never blocks another', () => {
  // The reason `closed` holds a ref instead of being a bare "closing" flag: a
  // flag would also swallow the resume banner or the list row pressed while the
  // close is still settling, and a channel that refuses to open is the worse bug.
  const closing: ChannelClaims = { opened: null, pending: null, closed: '1.501495737' };
  assert.equal(wantsChannel('1.888', closing), true);
});
