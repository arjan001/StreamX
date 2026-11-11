/**
 * Reopening on its own is the one behaviour in the app that acts without being
 * asked, so its boundaries are the whole test: the setting being off, a mark from
 * six months ago, and a stored route that is not a route at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeRoute } from './prefs.ts';
import { shouldResume, type LastPlayed } from './resume.ts';

const NOW = 1_756_000_000_000;

const mark = (over: Partial<LastPlayed> = {}): LastPlayed => ({
  route: '/live?ch=1.774010',
  label: 'BBC One',
  logo: null,
  kind: 'live',
  key: '1.774010',
  positionS: 0,
  durationS: 0,
  at: NOW - 3600_000,
  ...over,
});

test('a fresh mark reopens', () => {
  assert.equal(shouldResume(mark(), { enabled: true, now: NOW }), '/live?ch=1.774010');
});

test('the setting is respected', () => {
  assert.equal(shouldResume(mark(), { enabled: false, now: NOW }), null);
});

test('nothing remembered means the usual start page', () => {
  assert.equal(shouldResume(null, { enabled: true, now: NOW }), null);
});

test('last month reopens; six months ago does not', () => {
  const days = (n: number) => NOW - n * 24 * 3600_000;
  assert.ok(shouldResume(mark({ at: days(29) }), { enabled: true, now: NOW }) !== null);
  assert.equal(shouldResume(mark({ at: days(31) }), { enabled: true, now: NOW }), null);
  assert.equal(shouldResume(mark({ at: days(180) }), { enabled: true, now: NOW }), null);
});

test('a mark with no timestamp is still honoured', () => {
  // Written by a version that did not stamp it; refusing would silently disable
  // the feature for anyone upgrading mid-film.
  assert.ok(shouldResume(mark({ at: 0 }), { enabled: true, now: NOW }) !== null);
});

test('an off-site route is not a route', () => {
  // This value reaches `Navigate to=`, where a protocol-relative URL is a
  // destination — so the check is what stops a stored preference becoming an open
  // redirect out of the app.
  for (const bad of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'live', '']) {
    assert.equal(shouldResume(mark({ route: bad }), { enabled: true, now: NOW }), null, bad);
  }
});

test('safeRoute keeps in-app paths and refuses everything else', () => {
  assert.equal(safeRoute('/movie/2.123?play=1'), '/movie/2.123?play=1');
  assert.equal(safeRoute('//host'), null);
  assert.equal(safeRoute('/\\host'), null);
  assert.equal(safeRoute(42), null);
  assert.equal(safeRoute(null), null);
  assert.equal(safeRoute(`/${'x'.repeat(400)}`)?.length, 300);
});

test('every playing surface in the app is expressible as a mark', () => {
  // The four routes this feature relies on. If one of them stops being
  // link-addressable, that is a behaviour change and this is where it shows up.
  const routes = [
    '/live?ch=1.774010',
    '/movie/2.129873?play=1',
    '/series/3.998?ep=44120',
    '/catchup?ch=459618&start=1756000000&stop=1756003600',
  ];
  for (const route of routes) {
    assert.equal(shouldResume(mark({ route }), { enabled: true, now: NOW }), route);
  }
});
