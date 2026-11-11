import { test } from 'node:test';
import assert from 'node:assert/strict';

/* A stand-in observer: records targets, and lets the test say which intersect. */
let fire: ((targets: object[]) => void) | null = null;
const observed = new Set<object>();
class FakeIO {
  constructor(cb: (entries: { target: object; isIntersecting: boolean }[]) => void) {
    fire = (targets) => cb(targets.map((target) => ({ target, isIntersecting: true })));
  }
  observe(el: object): void { observed.add(el); }
  unobserve(el: object): void { observed.delete(el); }
  disconnect(): void { observed.clear(); }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
const { whenOnScreen, watchedCount } = await import('./onScreen.ts');

test('one observer for every element; each ask fires once and is then forgotten', () => {
  const a = {} as Element;
  const b = {} as Element;
  const hits: string[] = [];
  whenOnScreen(a, () => hits.push('a1'));
  whenOnScreen(a, () => hits.push('a2'));
  whenOnScreen(b, () => hits.push('b'));
  assert.equal(watchedCount(), 2);
  assert.equal(observed.size, 2);
  fire!([a]);
  assert.deepEqual(hits, ['a1', 'a2']);
  assert.equal(watchedCount(), 1);
  fire!([a]);
  assert.deepEqual(hits, ['a1', 'a2']);
  fire!([b]);
  assert.deepEqual(hits, ['a1', 'a2', 'b']);
  assert.equal(watchedCount(), 0);
  assert.equal(observed.size, 0);
});

test('a cancelled ask never fires, and the last cancel stops watching the element', () => {
  const el = {} as Element;
  const hits: string[] = [];
  const stop1 = whenOnScreen(el, () => hits.push('one'));
  const stop2 = whenOnScreen(el, () => hits.push('two'));
  stop1();
  assert.equal(watchedCount(), 1);
  stop2();
  assert.equal(watchedCount(), 0);
  assert.equal(observed.has(el), false);
  fire!([el]);
  assert.deepEqual(hits, []);
});
