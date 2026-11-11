import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setKVBackend, kv } from './kv.ts';
import { TERMS_VERSION, acceptRights, rightsAccepted, rightsAcceptance } from './rights.ts';

function memoryKV() {
  const store = new Map<string, string>();
  setKVBackend({
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  });
  return store;
}

test('nothing is accepted on a fresh device', () => {
  memoryKV();
  assert.equal(rightsAccepted(), false);
  assert.equal(rightsAcceptance(), null);
});

test('acceptance is stored with its date and the Terms version', () => {
  memoryKV();
  acceptRights(new Date('2026-10-01T10:00:00Z'));
  assert.equal(rightsAccepted(), true);
  assert.deepEqual(rightsAcceptance(), { version: TERMS_VERSION, at: '2026-10-01T10:00:00.000Z' });
});

test('a new Terms version asks again', () => {
  memoryKV();
  /* What an earlier build wrote, one version behind. */
  kv.set('iptv.rights.v1', JSON.stringify({ version: TERMS_VERSION - 1, at: '2025-01-01T00:00:00.000Z' }));
  assert.equal(rightsAccepted(), false);
  acceptRights();
  assert.equal(rightsAccepted(), true);
});

test('a damaged record is treated as not accepted', () => {
  const store = memoryKV();
  store.set('iptv.rights.v1', '{not json');
  assert.equal(rightsAccepted(), false);
});
