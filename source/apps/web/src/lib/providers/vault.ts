/**
 * Secrets at rest: AES-GCM under a key that cannot be read back out.
 *
 * A saved password, a playlist link that carries one, or a portal's device id is
 * not kept as readable text in storage. It is sealed with a Web Crypto key that
 * is generated once on this device, marked NON-extractable, and kept in
 * IndexedDB. Script on the page can ask the browser to seal or open with it, but
 * nothing can export the key itself, so a copy of the storage (a backup, a
 * synced profile, a file read off the disk) does not carry usable secrets.
 *
 * What this does not do: it does not stop script running in this very page from
 * calling `open()` — that is the same trust boundary as the app itself.
 *
 * ── fallback ──
 *
 * Where `crypto.subtle` or IndexedDB is missing (an older TV browser, a plain
 * HTTP page, a private window) there is nothing to hold a key in, and a key kept
 * beside its ciphertext would be theatre. `vaultAvailable()` then answers false
 * and `providers/store.ts` keeps the previous behaviour: secrets stay in the
 * stored list as they always were.
 */

export interface KeyStore {
  get(): Promise<CryptoKey | null>;
  put(key: CryptoKey): Promise<void>;
}

const DB_NAME = 'iptv-vault';
const STORE = 'keys';
const KEY_ID = 'providers.v1';

function idbKeyStore(): KeyStore | null {
  if (typeof indexedDB === 'undefined') return null;
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return {
    async get() {
      const db = await open();
      try {
        return await new Promise<CryptoKey | null>((resolve, reject) => {
          const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID);
          r.onsuccess = () => resolve((r.result as CryptoKey | undefined) ?? null);
          r.onerror = () => reject(r.error);
        });
      } finally { db.close(); }
    },
    async put(key) {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(key, KEY_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    },
  };
}

let override: KeyStore | null | undefined;
let keyPromise: Promise<CryptoKey | null> | null = null;

/** For tests: swap the place the key lives (null = none, i.e. the fallback). */
export function setKeyStore(next: KeyStore | null | undefined): void {
  override = next;
  keyPromise = null;
}

function subtle(): SubtleCrypto | null {
  return typeof crypto !== 'undefined' && crypto.subtle !== undefined ? crypto.subtle : null;
}

function store(): KeyStore | null {
  return override === undefined ? idbKeyStore() : override;
}

/** The key, made on first use. Null when this device has nowhere safe to keep one. */
function theKey(): Promise<CryptoKey | null> {
  keyPromise ??= (async () => {
    const s = subtle();
    const ks = store();
    if (s === null || ks === null) return null;
    try {
      const held = await ks.get();
      if (held !== null) return held;
      const made = await s.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await ks.put(made);
      return made;
    } catch { return null; }
  })();
  return keyPromise;
}

/** Can secrets be sealed on this device at all? */
export async function vaultAvailable(): Promise<boolean> {
  return (await theKey()) !== null;
}

const b64 = (u: Uint8Array): string => {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (t: string): Uint8Array<ArrayBuffer> => {
  const s = atob(t);
  const u = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};

const PREFIX = 'v1.';

/** `v1.<iv>.<ciphertext>` (base64), or null when the vault is unavailable. */
export async function seal(plain: string): Promise<string | null> {
  const s = subtle();
  const key = await theKey();
  if (s === null || key === null) return null;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
    return `${PREFIX}${b64(iv)}.${b64(ct)}`;
  } catch { return null; }
}

/** The text a `seal()` produced, or null when it cannot be opened (key lost, tampered). */
export async function unseal(sealed: string): Promise<string | null> {
  const s = subtle();
  const key = await theKey();
  if (s === null || key === null || !sealed.startsWith(PREFIX)) return null;
  const [iv, ct] = sealed.slice(PREFIX.length).split('.');
  if (iv === undefined || ct === undefined) return null;
  try {
    const plain = await s.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    return new TextDecoder().decode(plain);
  } catch { return null; }
}
