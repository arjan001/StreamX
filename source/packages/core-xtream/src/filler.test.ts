import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFillerName, isIdleEventName, isSeparatorName } from './filler.ts';

test('a heading dressed as a channel is a heading', () => {
  // Every one of these is a real row from this line's live list.
  for (const n of [
    '##### PT NOTICIAS #####',
    '##### ABC DISTRICT OF COLUMBIA #####',
    '######  MOROCCO HD #######',
    '#### [ SPORTS ] ####',
    '=== FRANCE ===',
    '--- KIDS ---',
    // A heading with a country prefix in front of its first bar. Caught because
    // the rule keys on the CLOSING bar, not the opening one.
    'TR| ##### TR DINI KANALLARI #####',
  ]) assert.equal(isSeparatorName(n), true, n);
});

test('a bar with nothing in it is one too', () => {
  assert.equal(isSeparatorName('========'), true);
  assert.equal(isSeparatorName('   '), true);
  assert.equal(isSeparatorName('|||||'), true);
});

test('decoration at one end only is not a heading', () => {
  /*
    The guard that keeps 3,946 ordinary channels in the list. A name that merely
    begins with punctuation is common; a name that is WRAPPED in it was typed to
    look like a divider.
  */
  assert.equal(isSeparatorName('- BBC One HD'), false);
  assert.equal(isSeparatorName('| ES: LALIGA'), false);
  assert.equal(isSeparatorName('##1 SPORT'), false);
});

test('ordinary channels are never mistaken for filler', () => {
  for (const n of [
    'SAUDI CH QURAN',
    'BEIN SPORTS 1 HD',
    'CNN International',
    'M6 (FR)',
    'A&E',
    'C+ SÉRIES 4K',
    '4K EXCLUSIVE | FI: PLAY+ PPV 18',
    // Censored punctuation mid-name, which an "any two runs of bars" rule would
    // have swallowed. It does not end in a bar, so it is a film.
    'FR - My Dear F***ing Prince (2023)',
  ]) assert.equal(isFillerName(n), false, n);
});

test('an idle pay-per-view slot says so in its own name', () => {
  assert.equal(isIdleEventName('ES: LALIGA+ PPV 4 - NO EVENT STREAMING -'), true);
  assert.equal(isIdleEventName('Matchroom Event 3 | No Event Scheduled'), true);
  assert.equal(isIdleEventName('LIVE EVENT 2 - NO EVENT'), true);
});

test('a channel that merely has "event" in its name is left alone', () => {
  // "no event" is the phrase; "event" is a normal word on a sports line.
  assert.equal(isIdleEventName('DAZN EVENT 1'), false);
  assert.equal(isIdleEventName('MAIN EVENT HD'), false);
  assert.equal(isIdleEventName('EVENTIM LIVE'), false);
});
