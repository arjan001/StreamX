/**
 * Getting the columns onto the device and back.
 *
 * Nine records, not 124,157 — that ratio is the entire performance story (55ms
 * versus 124 seconds, measured). Each column is one IndexedDB value: a typed
 * array goes in as a typed array, because structured clone handles those
 * natively and a JSON round-trip of an `Int32Array` would be both slower and
 * bigger than the data.
 *
 * The store interface is abstracted for one reason that matters: it makes the
 * whole persistence layer testable under plain Node, where IndexedDB does not
 * exist. The browser implementation is thirty lines at the bottom; everything
 * above it is exercised by the test suite against a Map.
 */
import { EMPTY_CAST, type Catalogue, type CastColumn, type ItemColumns, type CategoryRow } from './columns.ts';

export interface BlobStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * The pointer record.
 *
 * A generation is written under its own key prefix and this is flipped last, in
 * one write. That is the same atomic-swap discipline the SQL side uses, and it is
 * necessary for a harder reason here: IndexedDB transactions cannot stay open
 * across awaited network I/O, so there is no way to make "download and install"
 * one transaction. Instead nothing reads a generation until this pointer names
 * it, and the previous one is kept as a rollback slot.
 */
interface Pointer {
  current: number;
  previous: number | null;
  builtAt: number;
  counts: { live: number; movies: number; series: number };
}

const POINTER = 'catalogue.pointer';
const gen = (n: number, part: string) => `catalogue.g${n}.${part}`;

const PARTS = [
  'meta', 'kind', 'streamId', 'categoryId', 'rating', 'year', 'flags', 'archiveDays',
  'sortIndex', 'added', 'names', 'logos', 'compact', 'norm', 'extDict', 'ext', 'tvgIds', 'urls',
  'categories',
] as const;

/**
 * Parts a generation may lack without being broken.
 *
 * `loadCatalogue` returns null when ANY part in `PARTS` is missing, and that
 * rule is right — half a catalogue looks like a working app with content
 * missing. It is also why a new column cannot simply join that list: every
 * device already holding a generation would fail the read and re-download 58MB
 * to gain a search feature. `cast` arrived after those generations were written,
 * so it is read separately and defaults to empty, which degrades exactly as far
 * as it should — cast search finds nothing until the next rebuild, and every
 * other search is unaffected.
 */
const OPTIONAL_CAST = 'cast';

export async function saveCatalogue(store: BlobStore, cat: Catalogue): Promise<void> {
  const n = cat.generation;
  const c = cat.items;
  await store.put(gen(n, 'meta'), { count: c.count, builtAt: cat.builtAt, counts: cat.counts });
  await store.put(gen(n, 'kind'), c.kind);
  await store.put(gen(n, 'streamId'), c.streamId);
  await store.put(gen(n, 'categoryId'), c.categoryId);
  await store.put(gen(n, 'rating'), c.rating);
  await store.put(gen(n, 'year'), c.year);
  await store.put(gen(n, 'flags'), c.flags);
  await store.put(gen(n, 'archiveDays'), c.archiveDays);
  await store.put(gen(n, 'sortIndex'), c.sortIndex);
  await store.put(gen(n, 'added'), c.added);
  await store.put(gen(n, 'names'), c.names);
  await store.put(gen(n, 'logos'), c.logos);
  await store.put(gen(n, 'compact'), c.compact);
  await store.put(gen(n, 'norm'), c.norm);
  await store.put(gen(n, 'extDict'), c.extDict);
  await store.put(gen(n, 'ext'), c.ext);
  await store.put(gen(n, 'tvgIds'), c.tvgIds);
  await store.put(gen(n, 'urls'), c.urls);
  await store.put(gen(n, OPTIONAL_CAST), c.cast);
  await store.put(gen(n, 'categories'), cat.categories);

  const before = (await store.get(POINTER)) as Pointer | undefined;
  // The pointer moves LAST. Until this line a reader still sees the old
  // catalogue, and a crash mid-write leaves a complete one behind.
  await store.put(POINTER, {
    current: n,
    previous: before?.current ?? null,
    builtAt: cat.builtAt,
    counts: cat.counts,
  } satisfies Pointer);

  // Keep one generation back as a rollback slot; drop anything older.
  const keep = new Set([n, before?.current].filter((x): x is number => typeof x === 'number'));
  for (const key of await store.keys()) {
    const m = /^catalogue\.g(\d+)\./.exec(key);
    if (m && !keep.has(Number(m[1]))) await store.delete(key);
  }
}

/**
 * Throw away every built generation and the pointer to them.
 *
 * Needed because the catalogue is DERIVED state that outlives the thing it was
 * derived from. Switching subscription, or deleting one, used to leave the
 * previous account's rows on screen and on disk — the provider list changed and
 * nothing rebuilt, so the viewer saw somebody else's library under their own
 * account's name. Clearing is the honest answer: an empty library rebuilds in
 * seconds, a wrong one looks correct forever.
 *
 * The pointer goes FIRST here, the mirror image of `saveCatalogue`: until it is
 * gone a reader would still find a generation whose parts are being deleted
 * underneath it.
 */
export async function clearCatalogue(store: BlobStore): Promise<void> {
  await store.delete(POINTER);
  for (const key of await store.keys()) {
    if (/^catalogue\.g\d+\./.test(key)) await store.delete(key);
  }
}

/**
 * Read the catalogue back.
 *
 * Returns null rather than throwing when anything is missing, because "the store
 * was evicted" is a normal event on the web — `navigator.storage.persist()` was
 * DENIED in testing — and the only correct response is to re-ingest. A partial
 * read is treated as no read at all: half a catalogue is worse than none,
 * because it looks like a working app with content missing.
 */
export async function loadCatalogue(store: BlobStore): Promise<Catalogue | null> {
  const pointer = (await store.get(POINTER)) as Pointer | undefined;
  if (!pointer || typeof pointer.current !== 'number') return null;
  const n = pointer.current;

  /*
   * All nineteen parts at once, not one after another.
   *
   * These reads are independent — nothing in the loop decided which key to ask
   * for next — but awaiting each one in turn made them nineteen serial round
   * trips through IndexedDB, and with the store below opening a fresh connection
   * per `get`, nineteen database opens and closes as well. IndexedDB runs
   * read-only transactions concurrently, so asking for all of them together
   * costs one round trip instead of nineteen. Measured on this device's own
   * catalogue at a 4x-throttled CPU, reading the catalogue back was the largest
   * single entry in a cold start's profile — 922ms of 9.2s.
   *
   * `cast` joins them: it is optional, so its value is checked rather than
   * required (see `OPTIONAL_CAST`), but there is no reason to wait for the others
   * before asking for it.
   */
  const wanted = [...PARTS, OPTIONAL_CAST] as const;
  const values = await Promise.all(wanted.map((part) => store.get(gen(n, part))));
  const parts = new Map<string, unknown>();
  for (let i = 0; i < PARTS.length; i++) {
    const value = values[i];
    if (value === undefined || value === null) return null;
    parts.set(PARTS[i]!, value);
  }
  const meta = parts.get('meta') as { count: number; builtAt: number; counts: Catalogue['counts'] };
  const items: ItemColumns = {
    count: meta.count,
    kind: parts.get('kind') as Uint8Array,
    streamId: parts.get('streamId') as Int32Array,
    categoryId: parts.get('categoryId') as Int32Array,
    rating: parts.get('rating') as Uint16Array,
    year: parts.get('year') as Uint16Array,
    flags: parts.get('flags') as Uint8Array,
    archiveDays: parts.get('archiveDays') as Uint8Array,
    sortIndex: parts.get('sortIndex') as Int32Array,
    added: parts.get('added') as Int32Array,
    names: parts.get('names') as ItemColumns['names'],
    logos: parts.get('logos') as ItemColumns['logos'],
    compact: parts.get('compact') as ItemColumns['compact'],
    norm: parts.get('norm') as ItemColumns['norm'],
    extDict: parts.get('extDict') as string[],
    ext: parts.get('ext') as Uint8Array,
    tvgIds: parts.get('tvgIds') as Record<number, string>,
    urls: parts.get('urls') as Record<number, string>,
    cast: castOrEmpty(values[PARTS.length]),
  };
  // A column that lost rows would silently misalign every field after it.
  if (items.kind.length !== meta.count) return null;

  return {
    generation: n,
    builtAt: meta.builtAt,
    items,
    categories: parts.get('categories') as CategoryRow[],
    counts: meta.counts,
  };
}

/**
 * A stored cast column, or an empty one.
 *
 * Shape-checked rather than cast, because the thing being read may have been
 * written by a build that predates the column: `undefined` is the ordinary case
 * on an existing device, and anything else means the record was written by a
 * version this one does not understand. Both answer the same way — no cast —
 * and neither is allowed to throw halfway through a catalogue load.
 */
function castOrEmpty(raw: unknown): CastColumn {
  if (raw === null || typeof raw !== 'object') return EMPTY_CAST;
  const c = raw as Partial<CastColumn>;
  if (!(c.rows instanceof Int32Array) || typeof c.text?.blob !== 'string') return EMPTY_CAST;
  // A rows array longer than the offsets it indexes would read past the blob.
  if (!(c.text.offsets instanceof Int32Array) || c.text.offsets.length !== c.rows.length + 1) {
    return EMPTY_CAST;
  }
  return { rows: c.rows, text: { blob: c.text.blob, offsets: c.text.offsets } };
}

/** An in-memory store. Used by the tests, and as a fallback with no IndexedDB. */
export function memoryStore(): BlobStore {
  const map = new Map<string, unknown>();
  return {
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

/**
 * IndexedDB, in one object store.
 *
 * No indexes and no key ranges: every read is by exact key, so an index would
 * cost build time and bytes for nothing. One store, one transaction per
 * operation, which is all the columnar layout needs.
 */
/* Renamed with the app on 2026-09-08, and frozen again now.
   IndexedDB has no rename: a new name is a new, EMPTY database, so changing this
   silently throws away a catalogue of 200,000+ rows and makes every box fetch it
   all again. It was safe to do only because the `applicationId` change in the
   same release gives every device an empty sandbox regardless — see the note in
   android/app/build.gradle. */
export function indexedDbStore(dbName = 'streamix', storeName = 'catalogue'): BlobStore {
  /*
   * ONE connection, held — a database open is not free and there are twenty
   * reads on every cold start.
   *
   * Every operation used to call `indexedDB.open`, run its transaction, and
   * close the handle again on `oncomplete`, so loading the catalogue opened and
   * closed the database twenty times and the parallel read above would have
   * opened it twenty times AT ONCE. Reusing the handle makes those twenty
   * concurrent read-only transactions on one connection, which is what IndexedDB
   * is built to do.
   *
   * `onversionchange` is the reason this is safe to keep open: another tab
   * upgrading the schema would otherwise be blocked forever by this handle, so
   * the handle steps aside and the next call opens a fresh one. `onclose` covers
   * the same thing arriving from the browser's side (storage eviction).
   */
  let held: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (held !== null) return held;
    held = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const db = req.result;
        const forget = () => { if (held !== null) held = null; };
        db.onversionchange = () => { forget(); db.close(); };
        db.onclose = forget;
        resolve(db);
      };
      req.onerror = () => { held = null; reject(req.error); };
    });
    return held;
  };

  /**
   * One transaction, and EVERY way it can end.
   *
   * ── the bug this exists for ──
   *
   * A catalogue that never appeared, on a website, with no error anywhere: the
   * screen sat on "Saving what was downloaded" for as long as anyone was
   * willing to watch, the main thread stayed responsive, and the heap stayed
   * low. A promise that is neither resolved nor rejected looks exactly like
   * that, and nothing in a console or a heap graph will ever mention it.
   *
   * This listened for `req.onsuccess` and `req.onerror` and nothing else. But a
   * write that exceeds the origin's quota does not fail the REQUEST — it aborts
   * the TRANSACTION, and with no `onabort` handler the promise simply never
   * settled.
   *
   * That case is not exotic here. The site is served over plain HTTP from an
   * IP, so it is not a secure context; `navigator.storage` therefore does not
   * exist at all (measured: `estimate`, `persisted` and `persist` all absent),
   * the origin cannot ask for persistent storage, and IndexedDB runs on a small
   * best-effort quota. The owner's line needs ~159MB of raw payloads. It does
   * not fit, and the honest answer — "the browser would not store this" — was
   * being swallowed by a missing event handler.
   *
   * `oncomplete` rather than `onsuccess` decides a WRITE, too: a request can
   * succeed and the transaction still abort afterwards, and resolving on the
   * request means reporting a save that did not happen.
   */
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let out: T | undefined;
      let settled = false;
      const done = (v: T) => { if (!settled) { settled = true; resolve(v); } };
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        const err = e instanceof Error ? e : null;
        /* Quota is the one a caller can act on — it means "not on this origin",
           not "try again". Named, because the generic DOMException message is
           `null` in some engines and an empty failure teaches nobody. */
        reject(err ?? new Error('the browser would not store this (no space for it here)'));
      };
      tx.onabort = () => fail(tx.error);
      tx.onerror = () => fail(tx.error);
      const req = fn(tx.objectStore(storeName));
      req.onerror = () => fail(req.error);
      req.onsuccess = () => {
        out = req.result as T;
        /* A read is finished when the request is; a write is only finished when
           the transaction commits. */
        if (mode === 'readonly') done(out);
      };
      tx.oncomplete = () => done(out as T);
    });
  };

  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    put: async (k, v) => {
      await run('readwrite', (s) => s.put(v, k));
    },
    delete: async (k) => {
      await run('readwrite', (s) => s.delete(k));
    },
    keys: async () => {
      const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
      return keys.map(String);
    },
  };
}
