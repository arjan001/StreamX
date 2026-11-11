import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { installRandomUuid, uuidV4 } from './randomUuid.ts';

test('it makes a real version-4 uuid, not a string that looks like one', () => {
  const u = uuidV4();
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  /* The version and variant nibbles, checked by position as well as by the
     pattern above, because getting those wrong produces something that still
     looks right to a human and is rejected by anything that parses it. */
  assert.equal(u[14], '4');
  assert.ok('89ab'.includes(u[19] ?? ''));
});

test('and a different one every time', () => {
  const seen = new Set(Array.from({ length: 500 }, () => uuidV4()));
  assert.equal(seen.size, 500);
});

test('it never replaces an implementation the platform already has', () => {
  const real = () => 'real-one' as `${string}-${string}-${string}-${string}-${string}`;
  const had = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: real });
  assert.equal(installRandomUuid(), false, 'it stepped in where it was not needed');
  assert.equal(globalThis.crypto.randomUUID, real);
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: had });
});

test('and it does step in where the platform withheld one', () => {
  const had = globalThis.crypto.randomUUID;
  /* Shadowed rather than deleted: in Node `randomUUID` lives on
     `Crypto.prototype`, so `delete` on the instance removes nothing and the
     test would silently assert against the real one. On an insecure browser
     origin the property is genuinely not exposed at all. */
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  assert.equal(installRandomUuid(), true);
  assert.equal(typeof globalThis.crypto.randomUUID, 'function');
  assert.match(globalThis.crypto.randomUUID(), /^[0-9a-f]{8}-/);
  /* Twice is not an error, and the second time there is nothing left to do. */
  assert.equal(installRandomUuid(), false);
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: had });
});

/**
 * The ordering this depends on, which no type checker can see.
 *
 * ES imports are hoisted and every one of them is evaluated before any
 * statement in the importing module's body — so the polyfill placed among the
 * imports, as it was first written, ran AFTER them. A module whose own
 * evaluation does the work, imported first, is the only guarantee there is.
 */
test('the shim is the first thing main.tsx imports', () => {
  const src = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s+[^;]*?['"]([^'"]+)['"];/gm)].map((m) => m[1]);
  assert.ok(imports.length > 3, 'main.tsx no longer looks like a module');
  assert.equal(imports[0], './lib/installShims', `first import is ${imports[0]}`);
});
