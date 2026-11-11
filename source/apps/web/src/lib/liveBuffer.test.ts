import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setKVBackend, type KVBackend } from './kv.ts';
import {
  clampBufferSeconds, customBufferProfile, encodeBufferChoice, getChannelBufferChoice,
  getGlobalBufferChoice, parseBufferChoice, profileFromChoice, resolveBufferProfile,
  setChannelBufferChoice, setGlobalBufferChoice, liveReserveS, nativeCachingMs,
} from './liveBuffer.ts';

function memoryKV(): KVBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  };
}

test('legacy preset strings still parse', () => {
  assert.deepEqual(parseBufferChoice('minimal'), { kind: 'preset', mode: 'minimal' });
  assert.deepEqual(parseBufferChoice('smooth'), { kind: 'preset', mode: 'smooth' });
  assert.equal(parseBufferChoice('nope'), null);
});

test('custom encodes and clamps', () => {
  assert.equal(encodeBufferChoice({ kind: 'custom', seconds: 25 }), 'custom:25');
  assert.equal(clampBufferSeconds(1), 2);
  assert.equal(clampBufferSeconds(200), 90);
  assert.deepEqual(parseBufferChoice('custom:40'), { kind: 'custom', seconds: 40 });
});

test('custom profile seconds drive maxBufferS', () => {
  assert.equal(customBufferProfile(30).maxBufferS, 30);
  assert.equal(profileFromChoice({ kind: 'preset', mode: 'balanced' }).maxBufferS, 20);
});

test('channel override beats global', () => {
  const mem = memoryKV();
  setKVBackend(mem);
  setGlobalBufferChoice({ kind: 'preset', mode: 'minimal' });
  setChannelBufferChoice('1.9', { kind: 'custom', seconds: 45 });
  assert.equal(resolveBufferProfile('1.9').maxBufferS, 45);
  assert.equal(resolveBufferProfile('1.8').maxBufferS, 10);
  assert.deepEqual(getChannelBufferChoice('1.9'), { kind: 'custom', seconds: 45 });
  setChannelBufferChoice('1.9', null);
  assert.equal(getChannelBufferChoice('1.9'), null);
  assert.equal(resolveBufferProfile('1.9').maxBufferS, 10);
  assert.equal(getGlobalBufferChoice().kind, 'preset');
});

/* "they added buffer but it didn't work, like 40 seconds" — the number has to
   become lag behind live, in every engine. */
test('a custom buffer is that many seconds behind live, not a fraction of it', () => {
  assert.equal(customBufferProfile(40).targetLag, 40);
  assert.equal(customBufferProfile(2).targetLag, 2);
});

test('the WebView holds a live reserve only for Smooth and real custom lengths, capped', () => {
  assert.equal(liveReserveS(profileFromChoice({ kind: 'preset', mode: 'minimal' })), 0);
  assert.equal(liveReserveS(profileFromChoice({ kind: 'preset', mode: 'balanced' })), 0);
  assert.equal(liveReserveS(profileFromChoice({ kind: 'preset', mode: 'smooth' })), 8);
  assert.equal(liveReserveS(customBufferProfile(40)), 30);
  assert.equal(liveReserveS(customBufferProfile(3)), 0);
});

test('libVLC is given the whole lag as network-caching, between 1.5s and a minute', () => {
  assert.equal(nativeCachingMs(profileFromChoice({ kind: 'preset', mode: 'minimal' })), 1500);
  assert.equal(nativeCachingMs(profileFromChoice({ kind: 'preset', mode: 'balanced' })), 3000);
  assert.equal(nativeCachingMs(customBufferProfile(40)), 40_000);
  assert.equal(nativeCachingMs(customBufferProfile(90)), 60_000);
});
