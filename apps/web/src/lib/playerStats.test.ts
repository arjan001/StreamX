import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameStats } from './playerCore.ts';

const base = { resolution: null, bitrateKbps: null, droppedFrames: 0, latencyS: null, lagS: null, stalls: 0, codec: null };

test('an unchanged report is not a new one — the libVLC path reports nothing, twice a second', () => {
  assert.ok(sameStats(base, { ...base }));
});

test('the lag moves by milliseconds every tick; half a second is the grain that shows', () => {
  assert.ok(sameStats({ ...base, lagS: 3.21 }, { ...base, lagS: 3.4 }));
  assert.ok(!sameStats({ ...base, lagS: 3.2 }, { ...base, lagS: 3.8 }));
  assert.ok(!sameStats({ ...base, lagS: null }, { ...base, lagS: 0.1 }));
});

test('anything else that changes is news', () => {
  assert.ok(!sameStats(base, { ...base, resolution: '1920x1080' }));
  assert.ok(!sameStats(base, { ...base, droppedFrames: 1 }));
  assert.ok(!sameStats(base, { ...base, stalls: 1 }));
});
