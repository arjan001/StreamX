import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDbStore } from '../src/persist.ts';

/**
 * A transaction that aborts must reject, not vanish.
 *
 * The catalogue that never appeared: "Saving what was downloaded" on screen for
 * as long as anyone would watch, main thread responsive, heap low, nothing in
 * the console. A write past the origin's quota does not fail the REQUEST — it
 * aborts the TRANSACTION — and with only `req.onerror` wired, the promise was
 * neither resolved nor rejected. Forever.
 *
 * Not exotic on this product: the site is served over plain HTTP from an IP, so
 * it is not a secure context, `navigator.storage` does not exist, the origin
 * cannot request persistent storage, and IndexedDB runs on a small best-effort
 * quota. 159MB of payloads does not fit.
 *
 * Driven through a fake IDB that ends the transaction each of the ways a real
 * one can, because the only thing worth asserting is that EVERY ending is an
 * ending.
 */
function fakeIdb(ending: 'complete' | 'abort' | 'txerror' | 'reqerror') {
  const req: Record<string, unknown> = { result: 'stored' };
  const tx: Record<string, unknown> = {
    error: new Error(`transaction ${ending}`),
    objectStore: () => ({ put: () => req, get: () => req }),
  };
  const db = { transaction: () => tx };
  const openReq: Record<string, unknown> = {
    result: { ...db, objectStoreNames: { contains: () => true } },
  };
  const factory = {
    open: () => {
      queueMicrotask(() => {
        (openReq['onsuccess'] as (() => void) | undefined)?.();
        queueMicrotask(() => {
          if (ending === 'reqerror') {
            (req['error'] as unknown) = new Error('request failed');
            (req['onerror'] as (() => void) | undefined)?.();
            return;
          }
          if (ending !== 'abort' && ending !== 'txerror') {
            (req['onsuccess'] as (() => void) | undefined)?.();
          }
          if (ending === 'complete') (tx['oncomplete'] as (() => void) | undefined)?.();
          if (ending === 'abort') (tx['onabort'] as (() => void) | undefined)?.();
          if (ending === 'txerror') (tx['onerror'] as (() => void) | undefined)?.();
        });
      });
      return openReq;
    },
  };
  /* The module reaches for the global, so the seam is the global. */
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true });
}

const settles = async (p: Promise<unknown>) => {
  const guard = new Promise((_r, rej) => setTimeout(() => rej(new Error('NEVER SETTLED')), 500));
  return Promise.race([p.then(() => 'resolved', () => 'rejected'), guard]);
};

test('a committed write resolves', async () => {
  fakeIdb('complete');
  const s = indexedDbStore('db', 'store');
  assert.equal(await settles(s.put('k', { a: 1 })), 'resolved');
});

test('a write the browser aborts rejects rather than hanging', async () => {
  /* The one that shipped. Without `tx.onabort` this call never came back, and
     the whole catalogue build stopped behind it with nothing on screen. */
  fakeIdb('abort');
  const s = indexedDbStore('db', 'store');
  assert.equal(await settles(s.put('k', { a: 1 })), 'rejected');
});

test('a transaction error rejects', async () => {
  fakeIdb('txerror');
  const s = indexedDbStore('db', 'store');
  assert.equal(await settles(s.put('k', { a: 1 })), 'rejected');
});

test('a failed request rejects', async () => {
  fakeIdb('reqerror');
  const s = indexedDbStore('db', 'store');
  assert.equal(await settles(s.put('k', { a: 1 })), 'rejected');
});
