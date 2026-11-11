import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TURNS, takeTurn, turnsInUse } from './imageTurns.ts';

test('no more than three pictures at a time; the rest wait their turn in order', () => {
  const started: number[] = [];
  const release = Array.from({ length: 6 }, (_, i) => takeTurn(() => started.push(i)));
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(turnsInUse(), { active: MAX_TURNS, waiting: 3 });
  release[1]!();
  assert.deepEqual(started, [0, 1, 2, 3]);
  /* A tile that scrolled away before its turn came gives up its place. */
  release[4]!();
  release[0]!();
  assert.deepEqual(started, [0, 1, 2, 3, 5]);
  for (const r of release) r();
  assert.deepEqual(turnsInUse(), { active: 0, waiting: 0 });
});

test('releasing twice frees only one turn', () => {
  const started: number[] = [];
  const a = takeTurn(() => started.push(1));
  a(); a();
  const release = Array.from({ length: 4 }, (_, i) => takeTurn(() => started.push(10 + i)));
  assert.deepEqual(started, [1, 10, 11, 12]);
  for (const r of release) r();
  assert.deepEqual(turnsInUse(), { active: 0, waiting: 0 });
});
