import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysUntilExpiry, expiryPhrase, expiryTone } from './planExpiry.ts';

test('no expiry at all is null, not zero — a free viewer must not read as "expires today"', () => {
  assert.equal(daysUntilExpiry(null), null);
  assert.equal(daysUntilExpiry(undefined), null);
});

test('junk is null rather than NaN leaking into the screen', () => {
  assert.equal(daysUntilExpiry('not a date'), null);
});

test('counts whole days, rounded to how an operator would say it', () => {
  const now = Date.parse('2026-09-16T00:00:00Z');
  assert.equal(daysUntilExpiry('2026-09-23T00:00:00Z', now), 7);
  // 6 days and 23 hours reads as 7, not 6 — round, not floor.
  assert.equal(daysUntilExpiry('2026-09-22T23:00:00Z', now), 7);
  assert.equal(daysUntilExpiry('2026-09-16T00:00:00Z', now), 0);
});

test('a past expiry is negative', () => {
  const now = Date.parse('2026-09-16T00:00:00Z');
  assert.equal(daysUntilExpiry('2026-09-01T00:00:00Z', now), -15);
});

test('tone: no date is "none", not "ok" — it must not look like a healthy plan', () => {
  assert.equal(expiryTone(null), 'none');
});

test('tone: negative days is expired, however old', () => {
  assert.equal(expiryTone(-1), 'expired');
  assert.equal(expiryTone(-400), 'expired');
});

test('tone: the seven-day window matches the aggregate the overview counts by', () => {
  assert.equal(expiryTone(0), 'soon');
  assert.equal(expiryTone(7), 'soon');
  assert.equal(expiryTone(8), 'ok');
});

test('phrase spells out the three cases', () => {
  assert.equal(expiryPhrase(null), '—');
  assert.equal(expiryPhrase(0), 'today');
  assert.equal(expiryPhrase(5), 'in 5d');
  assert.equal(expiryPhrase(-5), 'expired 5d ago');
});
