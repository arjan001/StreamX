/**
 * A device must rebuild when the RULES change, not only when the provider does.
 *
 * `catalogueIsCurrent` compared the server's generation id and nothing else. That
 * answers "has the provider published a new catalogue" — it does not answer "do
 * we still agree with ourselves about what a catalogue contains". When the ingest
 * started dropping section headers and idle pay-per-view slots, the generation id
 * did not move, so every device already holding a copy went on showing all 1,834
 * of the rows that had just been declared not-channels, until the provider
 * happened to re-publish.
 *
 * This pins the coupling rather than the mechanism: the rules version has to be a
 * real, positive number that the local store records, so bumping the one in
 * `core-xtream` is all a future rule change needs to do.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CATALOGUE_RULES_VERSION } from '@iptv/core-xtream';

test('the rules version is a usable staleness key', () => {
  assert.equal(typeof CATALOGUE_RULES_VERSION, 'number');
  assert.ok(Number.isInteger(CATALOGUE_RULES_VERSION), 'must be an integer');
  assert.ok(CATALOGUE_RULES_VERSION > 0, 'zero and NaN both read as "never recorded"');
});

test('it is past 2, because DOC package matching bumped the rules', () => {
  assert.ok(CATALOGUE_RULES_VERSION >= 3);
});
