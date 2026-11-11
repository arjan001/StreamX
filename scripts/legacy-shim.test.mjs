/**
 * The shims a 2020 television needs, checked against the real methods.
 *
 * `apps/web/index.html` carries an inline block that installs
 * `Array.prototype.flat`, `Array.prototype.flatMap` and `Object.fromEntries`
 * where the engine lacks them — Chromium 69, 69 and 73, against the 68-69 that
 * Samsung and LG shipped on their 2020 sets. A shim that is subtly wrong is
 * worse than no shim: it turns a loud crash into quietly wrong lists.
 *
 * So this does not re-implement them to compare against. It EXTRACTS the block
 * from index.html and runs that, which is the only version that can ship —
 * a copy pasted into a test is a copy that drifts, and the drift would be
 * invisible precisely because both sides would agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
const between = /\/\* legacy-shim:start \*\/([\s\S]*?)\/\* legacy-shim:end \*\//.exec(html);
assert.notEqual(between, null, 'index.html no longer carries a legacy-shim block');
const source = between[1];

/* The real ones go away for the duration, so the block's own code is what every
   assertion below actually exercises. Node runs each test file in its own
   process, so nothing outside this file sees them missing. */
const real = {
  flat: Array.prototype.flat,
  flatMap: Array.prototype.flatMap,
  fromEntries: Object.fromEntries,
  structuredClone: globalThis.structuredClone,
};
delete Array.prototype.flat;
delete Array.prototype.flatMap;
delete Object.fromEntries;
delete globalThis.structuredClone;
new Function(source)();

test('the block installs all four', () => {
  assert.equal(typeof [].flat, 'function');
  assert.equal(typeof [].flatMap, 'function');
  assert.equal(typeof Object.fromEntries, 'function');
  assert.equal(typeof structuredClone, 'function');
});

test('flat matches the real one, depth included', () => {
  assert.deepEqual([1, [2, 3], [4, [5]]].flat(), [1, 2, 3, 4, [5]]);
  assert.deepEqual([1, [2, [3, [4]]]].flat(3), [1, 2, 3, 4]);
  assert.deepEqual([[1], [2]].flat(0), [[1], [2]], 'depth 0 is a shallow copy');
  assert.deepEqual([].flat(), []);
});

test('flat skips holes rather than turning them into undefined', () => {
  /* The difference is invisible until something counts the results, and then
     it is a wrong number rather than an error. */
  // eslint-disable-next-line no-sparse-arrays
  assert.deepEqual([1, , 3].flat(), [1, 3]);
});

test('flatMap flattens one level and passes index and array through', () => {
  assert.deepEqual([1, 2, 3].flatMap((x) => [x, x * 2]), [1, 2, 2, 4, 3, 6]);
  assert.deepEqual([1, 2].flatMap((x) => x), [1, 2], 'a non-array result is kept as-is');
  assert.deepEqual([[1], [2]].flatMap((x) => x), [1, 2], 'one level only');
  const seen = [];
  ['a', 'b'].flatMap((v, i, arr) => { seen.push([v, i, arr.length]); return v; });
  assert.deepEqual(seen, [['a', 0, 2], ['b', 1, 2]]);
});

test('fromEntries takes an array of pairs and a Map alike', () => {
  assert.deepEqual(Object.fromEntries([['a', 1], ['b', 2]]), { a: 1, b: 2 });
  assert.deepEqual(Object.fromEntries(new Map([['x', 9]])), { x: 9 });
  assert.deepEqual(Object.fromEntries([]), {});
  /* Both shapes the app actually passes: `deviceSummary()` returns pairs and
     `PHASES.map(...)` builds them — see lib/debugLog.ts and lib/localCatalogue.ts. */
});

test('structuredClone copies plain data, cycles included, and refuses functions', () => {
  const src = { a: [1, { b: 2 }], d: new Date(5), m: new Map([['k', { z: 1 }]]), s: new Set([1]) };
  src.self = src;
  const out = structuredClone(src);
  assert.notEqual(out, src);
  assert.deepEqual(out.a, [1, { b: 2 }]);
  assert.notEqual(out.a[1], src.a[1], 'a deep copy, not a shared reference');
  assert.equal(out.d.getTime(), 5);
  assert.deepEqual(out.m.get('k'), { z: 1 });
  assert.ok(out.s.has(1));
  assert.equal(out.self, out, 'a cycle stays a cycle');
  assert.throws(() => structuredClone({ f() {} }), (e) => e.name === 'DataCloneError');
  assert.throws(() => structuredClone(Symbol('x')), (e) => e.name === 'DataCloneError');
  const bytes = structuredClone(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test('a modern engine keeps its own implementations', () => {
  /* The block only fills gaps. Restore the natives, run it again, and every one
     of them must still be the engine's. */
  Array.prototype.flat = real.flat;
  Array.prototype.flatMap = real.flatMap;
  Object.fromEntries = real.fromEntries;
  globalThis.structuredClone = real.structuredClone;
  new Function(source)();
  assert.equal(Array.prototype.flat, real.flat);
  assert.equal(Array.prototype.flatMap, real.flatMap);
  assert.equal(Object.fromEntries, real.fromEntries);
  assert.equal(globalThis.structuredClone, real.structuredClone);
});
