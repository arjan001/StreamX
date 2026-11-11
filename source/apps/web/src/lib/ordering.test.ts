import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, moveTo, reorderFrom } from './ordering.ts';

const rows = (...refs: string[]) => refs.map((ref) => ({ ref }));
const refs = (list: { ref: string }[]) => list.map((r) => r.ref);

test('no order means the provider\'s order', () => {
  const list = rows('1.a', '1.b', '1.c');
  assert.deepEqual(refs(applyOrder(list, [])), ['1.a', '1.b', '1.c']);
});

test('a partial order lifts what it names and leaves the rest alone', () => {
  // The point of the whole design: nobody is ranking 829 packages, they are
  // dragging four to the top.
  const list = rows('1.a', '1.b', '1.c', '1.d', '1.e');
  assert.deepEqual(refs(applyOrder(list, ['1.d', '1.b'])), ['1.d', '1.b', '1.a', '1.c', '1.e']);
});

test('the unranked tail keeps the order it arrived in', () => {
  const list = rows('1.z', '1.y', '1.x');
  assert.deepEqual(refs(applyOrder(list, ['1.x'])), ['1.x', '1.z', '1.y']);
});

test('a ref that is not in the catalogue right now is ignored, not dropped', () => {
  // A package that vanishes from one refresh and returns in the next should come
  // back where it was put, not at the bottom.
  const list = rows('1.a', '1.b');
  assert.deepEqual(refs(applyOrder(list, ['1.gone', '1.b'])), ['1.b', '1.a']);
});

test('a duplicated ref does not corrupt the ranking', () => {
  const list = rows('1.a', '1.b', '1.c');
  assert.deepEqual(refs(applyOrder(list, ['1.c', '1.a', '1.c'])), ['1.c', '1.a', '1.b']);
});

test('moving downwards lands where it was dropped', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
});

test('moving upwards lands where it was dropped', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
});

test('a move to nowhere changes nothing', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 9, 0), ['a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], -1, 0), ['a', 'b', 'c']);
  assert.deepEqual(moveTo([], 0, 0), []);
});

test('a move past the end clamps rather than losing the row', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
});

test('a drag in the displayed list is what gets stored', () => {
  /*
    The case this exists for. Only "1.c" is ranked, so the displayed list is
    c, a, b, d. Dragging "d" to the top must store an order that reproduces
    exactly that view — if it stored only ["1.d"], the next render would put c
    second, and the row a viewer just dropped at the top would appear to jump.
  */
  const displayed = applyOrder(rows('1.a', '1.b', '1.c', '1.d'), ['1.c']);
  assert.deepEqual(refs(displayed), ['1.c', '1.a', '1.b', '1.d']);
  const next = reorderFrom(displayed, 3, 0);
  assert.deepEqual(next, ['1.d', '1.c', '1.a', '1.b']);
  // …and re-applying it to the raw catalogue order reproduces the view.
  assert.deepEqual(refs(applyOrder(rows('1.a', '1.b', '1.c', '1.d'), next)),
    ['1.d', '1.c', '1.a', '1.b']);
});
