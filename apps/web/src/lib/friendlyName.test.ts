/**
 * The roster's names. Derived, so the only properties worth pinning are the ones
 * a person relies on: the same id always reads the same, and the shared buckets
 * are never given a name of their own.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendlyName, shortId } from './friendlyName.ts';

test('one id always reads as the same name', () => {
  /* A roster is read across sessions and across screens — a name that changed
     between the Live tab and the Devices tab would be worse than the digest. */
  const id = 'c8e6fba8f1d24e0b9a7c3e5d6f80a1b2';
  assert.equal(friendlyName(id), friendlyName(id));
  assert.match(friendlyName(id) ?? '', /^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

test('two ids that differ by one character read differently', () => {
  /* The two halves come from different slices of the hash, so neighbouring ids
     must not share a word and look like the same device. */
  const a = friendlyName('aaaaaaaaaaaaaaaa');
  const b = friendlyName('aaaaaaaaaaaaaaab');
  assert.notEqual(a, b);
});

test('the shared buckets keep their own words', () => {
  /* Every guest on the installation reports the literal account `anonymous`.
     Naming that bucket would say there is one subscription called Amber Falcon
     with nine devices on it, which is false. */
  assert.equal(friendlyName('anonymous'), null);
  assert.equal(friendlyName('unknown'), null);
  assert.equal(friendlyName(''), null);
  assert.equal(friendlyName('   '), null);
  assert.equal(friendlyName(null), null);
  assert.equal(friendlyName(undefined), null);
});

test('the id stays available beside the name', () => {
  /* 1,024 pairs collide about one time in nine across fourteen rows, so the
     digest has to be readable too — a nickname is never the only handle. */
  assert.equal(shortId('c8e6fba8f1d24e0b'), 'c8e6fba8');
  assert.equal(shortId('short'), 'short');
  assert.equal(shortId(null), '');
  assert.equal(shortId('c8e6fba8f1d24e0b', 4), 'c8e6');
});

test('every pair is drawn from the lists, for any input', () => {
  /* A hash that indexed past the end would render "undefined Falcon" on a
     roster, and only for some ids — the worst kind of bug to find later. */
  for (let i = 0; i < 400; i += 1) {
    const name = friendlyName(`device-${i}-${i * 7919}`);
    assert.match(name ?? '', /^[A-Z][a-z]+ [A-Z][a-z]+$/, `id ${i}`);
    assert.ok(!(name ?? '').includes('undefined'), `id ${i} → ${name}`);
  }
});
