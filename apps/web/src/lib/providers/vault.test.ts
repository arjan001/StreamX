import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kv, setKVBackend } from '../kv.ts';
import { seal, setKeyStore, unseal, type KeyStore } from './vault.ts';
import {
  addProvider, allProviders, hydrateProviders, providersSettled, redact, removeProvider,
} from './store.ts';

function memoryKV() {
  const store = new Map<string, string>();
  setKVBackend({
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  });
  return store;
}

/** The IndexedDB key store, in a variable. The key object itself is what the browser would keep. */
function memoryKeys(): KeyStore & { held: CryptoKey | null } {
  const ks = {
    held: null as CryptoKey | null,
    async get() { return ks.held; },
    async put(k: CryptoKey) { ks.held = k; },
  };
  return ks;
}

const PASSWORD = 'hunter2-password';

test('a sealed secret round-trips and is not readable as stored', async () => {
  const keys = memoryKeys();
  setKeyStore(keys);
  const sealed = await seal(PASSWORD);
  assert.ok(sealed !== null && sealed.startsWith('v1.'));
  assert.ok(!sealed.includes(PASSWORD));
  assert.equal(await unseal(sealed), PASSWORD);
  /* Non-extractable: nothing can export the key. */
  assert.equal(keys.held?.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', keys.held!));
  /* Sealed twice, never the same text. */
  assert.notEqual(await seal(PASSWORD), sealed);
  /* A tampered value does not open. */
  assert.equal(await unseal(`${sealed.slice(0, -4)}AAAA`), null);
});

test('a saved password is not in storage in plain text, and comes back on the next launch', async () => {
  const raw = memoryKV();
  setKeyStore(memoryKeys());
  await hydrateProviders();
  addProvider({ kind: 'xtream', name: 'Server', url: 'http://panel.example.com:8080', username: 'demo', password: PASSWORD, enabled: true });
  addProvider({ kind: 'm3u', name: 'Playlist', url: 'http://stream.example.com/list.m3u?user=a&pass=SECRETPASS', enabled: true });
  await providersSettled();
  const dump = JSON.stringify([...raw.entries()]);
  assert.ok(!dump.includes(PASSWORD), 'password must not be stored readable');
  assert.ok(!dump.includes('SECRETPASS'), 'a link carrying credentials must not be stored readable');
  assert.ok(dump.includes('panel.example.com'), 'the non-secret address of a server stays');
  /* A new launch: nothing in memory, storage and the key only. */
  await hydrateProviders();
  const [server, playlist] = allProviders();
  assert.equal(server?.password, PASSWORD);
  assert.equal(server?.username, 'demo');
  assert.equal(playlist?.url, 'http://stream.example.com/list.m3u?user=a&pass=SECRETPASS');
  /* Removing a source takes its sealed secret with it. */
  removeProvider(server!.id);
  await providersSettled();
  assert.ok(!(raw.get('iptv.providers.secrets.v1') ?? '').includes(`"${server!.id}"`));
});

test('a plain entry from an older build is sealed on first read', async () => {
  const raw = memoryKV();
  setKeyStore(memoryKeys());
  raw.set('iptv.providers.v1', JSON.stringify([
    { id: 7, kind: 'xtream', name: 'Old', url: 'http://panel.example.com', username: 'u', password: PASSWORD, enabled: true, addedAt: 1 },
  ]));
  await hydrateProviders();
  assert.equal(allProviders()[0]?.password, PASSWORD);
  assert.ok(!JSON.stringify([...raw.entries()]).includes(PASSWORD));
  /* Idempotent: reading again changes nothing. */
  await hydrateProviders();
  assert.equal(allProviders()[0]?.password, PASSWORD);
});

test('without a place for the key, secrets stay as they were', async () => {
  const raw = memoryKV();
  setKeyStore(null);
  await hydrateProviders();
  addProvider({ kind: 'xtream', name: 'Server', url: 'http://panel.example.com', username: 'u', password: PASSWORD, enabled: true });
  await providersSettled();
  assert.ok(raw.get('iptv.providers.v1')!.includes(PASSWORD));
  assert.equal(raw.get('iptv.providers.secrets.v1') ?? null, null);
  assert.equal(kv.get('iptv.providers.v1') === raw.get('iptv.providers.v1'), true);
});

test('redaction still strips credentials from text that leaves the device', () => {
  assert.equal(redact('GET http://h/get.php?username=a&password=b&type=m3u'), 'GET http://h/get.php?username=<redacted>&password=<redacted>&type=m3u');
  assert.equal(redact('http://user:pass@host/x'), 'http://<redacted>@host/x');
});
