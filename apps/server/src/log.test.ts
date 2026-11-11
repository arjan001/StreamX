/**
 * Nothing that identifies a subscription may be stored.
 *
 * The client redacts before sending and this redacts again on arrival, on the
 * stated grounds that one of the two will be wrong eventually. It was: a relay
 * URL carries the provider URL as a query parameter, percent-encoded, and the
 * rule was written for literal slashes. Both spellings now, on both sides.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchRows, redact } from './log.ts';

const USER = 'UUUUUUUUUU';
const PASS = 'PPPPPPPPPP';

test('path credentials go, with either spelling of the separator', () => {
  for (const line of [
    `load mpegts http://h/live/${USER}/${PASS}/812064.ts`,
    `relay?u=http%3A%2F%2Fh%2Fmovie%2F${USER}%2F${PASS}%2F2129873.mp4`,
    `http://h/series/${USER}/${PASS}/9.mkv`,
  ]) {
    const out = redact(line);
    assert.ok(!out.includes(USER), out);
    assert.ok(!out.includes(PASS), out);
  }
});

test('query credentials go, encoded or not', () => {
  for (const line of [
    `GET http://h/player_api.php?username=${USER}&password=${PASS}`,
    `u=http%3A%2F%2Fh%2Fplayer_api.php%3Fusername%3D${USER}%26password%3D${PASS}`,
  ]) {
    const out = redact(line);
    assert.ok(!out.includes(USER), out);
    assert.ok(!out.includes(PASS), out);
  }
});

test('a line with nothing to hide is left alone', () => {
  const line = 'native: error — nothing arrived at all';
  assert.equal(redact(line), line);
});

/*
 * ── what a flush is allowed to be ──
 *
 * `/api/log/batch` takes what a television sends by itself, on a timer, with
 * nobody watching. Every fixture below is a shape that would arrive from a real
 * client eventually: an old build with a field this one does not have, a level
 * that is not one of the three, a count that came back from JSON as a string.
 */

test('a flush becomes one row per distinct error, tagged', () => {
  const rows = batchRows([
    { tag: 'native', text: 'decoder refused', level: 'error', count: 4, ago: 120 },
    { tag: 'fetch', text: 'timeout', level: 'warn', count: 1, ago: 5 },
  ], null);
  assert.equal(rows.length, 2);
  /* The tag leads, because the admin screen groups on the first ninety
     characters and it is what separates one kind of failure from another. */
  assert.equal(rows[0]!.message, 'native: decoder refused');
  assert.equal(rows[1]!.level, 'warn');
  assert.equal(JSON.parse(rows[0]!.context).count, 4);
  assert.equal(JSON.parse(rows[0]!.context).agoSeconds, 120);
  assert.equal(JSON.parse(rows[0]!.context).auto, true);
});

test('credentials are redacted again on arrival', () => {
  const [row] = batchRows(
    [{ tag: 'player', text: `gave up on http://h/live/${USER}/${PASS}/812064.ts` }],
    null,
  );
  assert.ok(!row!.message.includes(USER), row!.message);
  assert.ok(!row!.message.includes(PASS), row!.message);
});

test('the device header rides on every row, so one row is worth reading alone', () => {
  const rows = batchRows(
    [{ tag: 'a', text: 'one' }, { tag: 'b', text: 'two' }],
    { Device: 'Hisense HE55A6100UW', Build: '1.29.0+151' },
  );
  for (const r of rows) assert.equal(JSON.parse(r.context).device.Device, 'Hisense HE55A6100UW');
});

test('a flush longer than the cap is cut, not refused', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ tag: 'p', text: `failure ${i}` }));
  assert.equal(batchRows(many, null).length, 30);
});

test('nonsense in a flush is dropped line by line, never the whole flush', () => {
  /* One malformed line from an old build must not cost the twenty-nine good
     ones beside it. */
  const rows = batchRows([
    null,
    'not an object',
    { tag: 'p', text: '   ' },
    { tag: 'p', text: 'a real one' },
  ], null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.message, 'p: a real one');
});

test('a level that is not one of the three is stored as an error', () => {
  assert.equal(batchRows([{ tag: 'p', text: 'x', level: 'fatal' }], null)[0]!.level, 'error');
  assert.equal(batchRows([{ tag: 'p', text: 'x' }], null)[0]!.level, 'error');
});

test('a count or an age that is not a number cannot poison the row', () => {
  const [row] = batchRows([{ tag: 'p', text: 'x', count: 'lots', ago: -9 }], null);
  const ctx = JSON.parse(row!.context);
  assert.equal(ctx.count, 1);
  assert.equal(ctx.agoSeconds, 0);
});

test('a body that is not a list at all is an empty flush', () => {
  assert.deepEqual(batchRows(undefined, null), []);
  assert.deepEqual(batchRows({ entries: [] }, null), []);
  assert.deepEqual(batchRows('[]', null), []);
});

test('a line long enough to be an attack is clamped', () => {
  const [row] = batchRows([{ tag: 'p', text: 'x'.repeat(50_000) }], null);
  assert.ok(row!.message.length <= 2_000);
});
