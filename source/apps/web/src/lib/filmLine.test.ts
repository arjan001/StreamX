import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onTheLine, onTheLineNow } from './filmLine.ts';

const tick = (ms = 0): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

test('two readers take turns rather than racing', async () => {
  const order: string[] = [];
  const job = (name: string, ms: number): Promise<void> => onTheLine(async () => {
    order.push(`${name} in`);
    await tick(ms);
    order.push(`${name} out`);
  });
  /* The film's read is slow and the preview's is quick: without the queue the
     preview would start while the film was still reading, which on a line
     allowing one stream is a refusal rather than a wait. */
  await Promise.all([job('film', 30), job('frame', 1)]);
  assert.deepEqual(order, ['film in', 'film out', 'frame in', 'frame out']);
});

test('a read that fails still lets the next one through', async () => {
  const order: string[] = [];
  const bad = onTheLine(async () => { order.push('bad'); throw new Error('509'); });
  const good = onTheLine(async () => { order.push('good'); return 1; });
  await assert.rejects(bad, /509/);
  assert.equal(await good, 1);
  assert.deepEqual(order, ['bad', 'good']);
});

test('what a job answers is what its caller gets', async () => {
  assert.equal(await onTheLine(async () => 'bytes'), 'bytes');
});

test('the queue says how many are waiting, and empties', async () => {
  const before = onTheLineNow().served;
  const all = [onTheLine(async () => tick(5)), onTheLine(async () => tick(5))];
  assert.equal(onTheLineNow().waiting, 2);
  await Promise.all(all);
  assert.equal(onTheLineNow().waiting, 0);
  assert.equal(onTheLineNow().served, before + 2);
});
