/**
 * Making the app open instantly, twice over.
 *
 * Two mechanisms with one goal, kept together because they are the same decision
 * taken at two layers:
 *
 *   1. **The service worker** answers the network. It makes the shell, the code
 *      and the artwork available without a request at all. See public/sw.js.
 *   2. **The query snapshot** answers React. Even with every byte already in an
 *      HTTP cache, a fresh page starts with an EMPTY react-query cache, so the
 *      home page mounts with `isLoading` true on every rail and paints skeletons
 *      while it re-derives what it knew a second ago. Restoring the last
 *      session's answers makes the first frame the page rather than its outline.
 *
 * ── why this is written by hand ──
 *
 * `@tanstack/query-persist-client-core` does the second job and is small. It is
 * not used because every interesting decision here is policy — which queries are
 * worth keeping, how stale is too stale, how much space is fair — and policy is
 * easier to state, and to test, in thirty lines than to configure.
 *
 * ── what is kept, and what is not ──
 *
 * Only catalogue-shaped reads: rails, group trees, facets, totals, the taste
 * model's picks. Not `source`, which carries live account state including whether
 * a stream is open. Not `epg`, because a guide restored from yesterday is worse
 * than no guide. Nothing playback-adjacent, ever. None of it is personal — it is
 * the provider's catalogue, which anyone holding the line already has — but it is
 * capped and expired anyway, because a snapshot that outlives a re-ingest is a
 * page full of titles that no longer resolve.
 *
 * Stored in its own IndexedDB database rather than through `kv`: that is
 * `localStorage` on the web, whose writes are synchronous and whose quota is 5MB
 * shared with everything else the app keeps. Two megabytes of JSON written on
 * every tab-hide would be a stall the viewer can feel.
 */
import type { QueryClient } from '@tanstack/react-query';

const DB = 'streamix-warm';
const STORE = 'snapshots';
const KEY = 'queries.v2';

/** Query families worth restoring. Everything else starts empty. */
const KEEP = new Set(['home', 'groups', 'markets', 'facets', 'taste', 'inventory']);

/**
 * How old a snapshot may be and still be painted.
 *
 * Six hours: long enough to cover "I open this every evening", short enough that
 * a re-ingest is never more than one session away from being visible. Everything
 * restored is revalidated the moment it is used, so this governs only what the
 * FIRST frame is allowed to be.
 */
export const MAX_AGE_MS = 6 * 3600_000;

/**
 * Cap on the snapshot.
 *
 * A catalogue page is 100 rows of some forty fields. Two megabytes is roughly the
 * home page plus a couple of section listings — the things someone actually comes
 * back to — and refusing to grow past it is what stops this becoming a second,
 * worse copy of the on-device catalogue, which is a real feature elsewhere in the
 * app and does the job properly.
 */
export const MAX_BYTES = 750_000;

export interface Snapshot { at: number; entries: [unknown[], unknown][] }

/** What is worth writing down, in the order react-query happens to hold it. */
export function snapshotOf(qc: QueryClient, now = Date.now()): Snapshot {
  const entries: [unknown[], unknown][] = [];
  let bytes = 0;
  for (const q of qc.getQueryCache().getAll()) {
    const key = q.queryKey as unknown[];
    if (typeof key[0] !== 'string' || !KEEP.has(key[0])) continue;
    if (q.state.status !== 'success' || q.state.data === undefined) continue;
    let json: string;
    try { json = JSON.stringify([key, q.state.data]); } catch { continue; }
    /* One oversized answer is skipped rather than ending the loop: a single 800KB
       payload must not cost the twenty small ones that would have fitted after
       it. */
    if (json.length > MAX_BYTES / 4) continue;
    if (bytes + json.length > MAX_BYTES) break;
    bytes += json.length;
    entries.push([key, q.state.data]);
  }
  return { at: now, entries };
}

/** True when a snapshot is recent enough to paint from. */
export function usable(snap: Snapshot | null, now = Date.now()): boolean {
  if (snap === null || !Array.isArray(snap.entries)) return false;
  if (typeof snap.at !== 'number' || !Number.isFinite(snap.at)) return false;
  // A clock that has gone backwards produces a negative age; that is not "fresh".
  const age = now - snap.at;
  return age >= 0 && age < MAX_AGE_MS;
}

/**
 * Put the last session's answers back, before the first render.
 *
 * Planted with their ORIGINAL timestamp rather than as if freshly fetched, so
 * react-query treats each one as exactly as stale as it really is and revalidates
 * on mount according to that query's own `staleTime`. Painting instantly and
 * refetching immediately are not in tension — that is the entire pattern.
 */
export function hydrateQueries(qc: QueryClient, snap: Snapshot | null, now = Date.now()): number {
  if (!usable(snap, now)) return 0;
  const s = snap as Snapshot;
  let n = 0;
  for (const [key, data] of s.entries) {
    try {
      qc.setQueryData(key as never, data as never, { updatedAt: s.at });
      n += 1;
    } catch { /* a key shape this build no longer understands is simply skipped */ }
  }
  return n;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  const db = await open();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as Snapshot | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function saveSnapshot(qc: QueryClient): Promise<void> {
  const db = await open();
  if (db === null) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(snapshotOf(qc), KEY);
  } catch { /* quota, or a store being upgraded elsewhere */ }
}

/**
 * Write the snapshot when the page goes away — and periodically, because it
 * often does not go away cleanly.
 *
 * `visibilitychange` to hidden is the only event a mobile browser reliably
 * delivers before killing a tab: `beforeunload` and `unload` are not fired at all
 * on iOS, and a phone switching apps fires them nowhere. The interval is the belt
 * to that pair of braces, so a session that is force-quit still leaves something
 * behind.
 */
export function persistQueries(qc: QueryClient): () => void {
  if (typeof document === 'undefined') return () => {};
  const onHide = () => { if (document.visibilityState === 'hidden') void saveSnapshot(qc); };
  document.addEventListener('visibilitychange', onHide);
  /* One early write, so a first-ever visit that is closed by killing the tab —
     which fires nothing on any mobile browser — still leaves the next open with
     something to paint. Ten seconds is past the point where the first screen's
     queries have settled. */
  const first = window.setTimeout(() => { void saveSnapshot(qc); }, 10_000);
  const timer = window.setInterval(() => { void saveSnapshot(qc); }, 120_000);
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    window.clearTimeout(first);
    window.clearInterval(timer);
  };
}

/**
 * Throw away everything this device has cached, on purpose.
 *
 * The manual "refresh the library" path. Everything else here is designed to
 * avoid asking the network; this is the one control that says "ignore all of
 * that and go and look again", and it exists because no automatic policy is ever
 * going to be right for the case where someone KNOWS the catalogue changed and is
 * looking at yesterday's.
 *
 * Deliberately manual. An expiry short enough to catch every change would throw
 * away good data constantly, and nothing here removes a cache on its own — the
 * service worker's own version bump is the only other thing that clears anything.
 *
 * Everything it clears is reconstructible: HTTP responses, artwork, and the query
 * snapshot. It does not touch preferences, favourites, watch history, the session,
 * or the on-device catalogue, all of which are the viewer's rather than ours —
 * the catalogue is re-downloaded by `refreshLocal()`, which the same button calls.
 */
export async function clearCaches(): Promise<{ caches: number; snapshot: boolean }> {
  let cleared = 0;
  try {
    for (const name of await caches.keys()) {
      if (await caches.delete(name)) cleared += 1;
    }
  } catch { /* no Cache API, nothing to clear */ }

  let snapshot = false;
  const db = await open();
  if (db !== null) {
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY);
      snapshot = true;
    } catch { /* nothing written yet */ }
  }
  return { caches: cleared, snapshot };
}

/**
 * Install the service worker.
 *
 * After the first paint, never before it: registering competes for the network
 * with the very requests it exists to make unnecessary, and a worker installed
 * 300ms late costs this session nothing while saving every session after it.
 *
 * Skipped under `file:`, where there is no origin to scope a worker to, and
 * wherever the page is not a secure context — a plain-HTTP LAN address is not
 * one, and `navigator.serviceWorker` is simply absent there rather than throwing.
 */
export function registerWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    /* A worker waiting behind the running one would take a second visit to apply,
       which is how "I updated it and it still shows the old thing" happens. The
       page is already running the new code by this point — the document that
       loaded it is `no-cache` — so adopting straight away is safe. */
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller !== null) {
          next.postMessage('SKIP_WAITING');
        }
      });
    });
  }).catch(() => { /* a browser that refuses one still has the HTTP cache */ });
}
