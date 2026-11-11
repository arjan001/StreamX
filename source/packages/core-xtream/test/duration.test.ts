import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseVodInfo, parseClock, resolveDuration } from '../src/normalise.ts';

test('parseClock reads both HH:MM:SS and MM:SS', () => {
  assert.equal(parseClock('02:00:29'), 7229);
  assert.equal(parseClock('04:11:08'), 15068);
  assert.equal(parseClock('42:30'), 2550);
  assert.equal(parseClock('1:05:00'), 3900);
});

test('parseClock rejects placeholders and junk', () => {
  assert.equal(parseClock('00:00:00'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock('unknown'), null);
  assert.equal(parseClock(null), null);
  assert.equal(parseClock(122), null);
});

test('the runtime string beats duration_secs when they disagree', () => {
  // Measured live: 4 of 13 cached VOD payloads held MINUTES in duration_secs
  // while the string was correct. The field is inconsistent with itself.
  assert.deepEqual(resolveDuration({ duration: '02:00:29', duration_secs: 122 }), {
    duration: '02:00:29',
    durationSecs: 7229,
  });
  assert.deepEqual(resolveDuration({ duration: '02:25:00', duration_secs: '118' }), {
    duration: '02:25:00',
    durationSecs: 8700,
  });
});

test('duration_secs is still used when no string is published', () => {
  assert.deepEqual(resolveDuration({ duration_secs: 7380 }), {
    duration: null,
    durationSecs: 7380,
  });
  assert.deepEqual(resolveDuration({ duration: '', duration_secs: 3900 }).durationSecs, 3900);
});

test('agreeing fields stay put', () => {
  assert.equal(resolveDuration({ duration: '01:05:00', duration_secs: 3900 }).durationSecs, 3900);
});

test('normaliseVodInfo applies the reconciliation', () => {
  const d = normaliseVodInfo({
    info: { name: 'Water for Elephants (2011)', duration: '02:00:29', duration_secs: 122 },
  });
  assert.equal(d.durationSecs, 7229);
  assert.equal(d.duration, '02:00:29');
});
