import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyKey, qualityLabel, tidyGroups, tidyName } from '../src/tidy.ts';

test('the resolution comes off the name and stays as a fact', () => {
  const t = tidyName('1Almere TV (720p)');
  assert.equal(t.name, '1Almere TV');
  assert.equal(t.height, 720);
  assert.equal(t.quality, 'HD');
  // Never destroyed: a viewer choosing between two feeds needs to know which.
  assert.equal(t.raw, '1Almere TV (720p)');
});

test('the two tags that are 92% of the noise, and their typos', () => {
  assert.deepEqual(tidyName('A1 TV (1080p) [Not 24/7]').notes, ['part-time']);
  assert.deepEqual(tidyName('BNR Nieuwsradio (720p) [Geo-blocked]').notes, ['geo-blocked']);
  // One row in the real data has no closing bracket, and one is underscored.
  assert.deepEqual(tidyName('Some Channel [Not 24/7').notes, ['part-time']);
  assert.deepEqual(tidyName('Other [_Geo-blocked_]').notes, ['geo-blocked']);
});

test('a tag that says the opposite is not recorded as the thing it resembles', () => {
  // "[Non geo blocked]" contains "geo block" and means the reverse of it.
  const t = tidyName('Some Channel [Non geo blocked]');
  assert.deepEqual(t.notes, []);
  assert.equal(t.name, 'Some Channel');
});

test('a bracket that is part of the name is left alone', () => {
  // "[Beverly Hills]" is a real row and is not machinery.
  const t = tidyName('KTLA [Beverly Hills] (1080p)');
  assert.equal(t.name, 'KTLA [Beverly Hills]');
  assert.deepEqual(t.notes, []);
  assert.equal(t.height, 1080);
});

test('both suffixes at once leave no double spaces behind', () => {
  assert.equal(tidyName('A1 TV (1080p) [Not 24/7]').name, 'A1 TV');
  assert.equal(tidyName('Foo  (720p)  [Geo-blocked]  ').name, 'Foo');
});

test('a name that is nothing but machinery keeps something to click', () => {
  // An empty row label is a row nobody can identify.
  assert.equal(tidyName('(1080p)').name, '(1080p)');
  assert.equal(tidyName('   ').name, '');
});

test('quality labels are bands, not numbers', () => {
  assert.equal(qualityLabel(2160), 'UHD');
  assert.equal(qualityLabel(1080), 'FHD');
  assert.equal(qualityLabel(720), 'HD');
  assert.equal(qualityLabel(576), 'SD');
  assert.equal(qualityLabel(null), null);
});

test('groups are semicolon-separated, and "Undefined" is not a group', () => {
  assert.deepEqual(tidyGroups('Entertainment;Music'), ['Entertainment', 'Music']);
  assert.deepEqual(tidyGroups('Undefined'), []);
  assert.deepEqual(tidyGroups('General;Undefined;General'), ['General']);
  assert.deepEqual(tidyGroups(null), []);
  assert.deepEqual(tidyGroups(''), []);
});

test('the same channel at two resolutions is one family', () => {
  assert.equal(familyKey('BE@TTV (1080p)'), familyKey('BE@TTV (720p)'));
  assert.notEqual(familyKey('BBC One'), familyKey('BBC Two'));
  // And the tags do not split a family either.
  assert.equal(familyKey('A1 TV (1080p) [Not 24/7]'), familyKey('A1 TV (720p)'));
});
