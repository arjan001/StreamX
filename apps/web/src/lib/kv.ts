/**
 * Small synchronous key/value store, with a durable backend on native.
 *
 * Everything persistent in this app is small JSON under a handful of keys, and it
 * is all read SYNCHRONOUSLY at module scope — `prefs.ts` builds its store the
 * moment it is imported, `playerCore` reads its four settings inside getters, and
 * `usePaneSize` (since removed with the splitters) read a pane width during render. That was a deliberate design: it
 * means no loading state for something that takes microseconds.
 *
 * `@capacitor/preferences` is async, so it cannot be dropped in behind those call
 * sites. The seam is therefore a synchronous mirror: `hydrate()` fills it once
 * before the first render, reads hit memory, and writes go through to the native
 * store without being awaited.
 *
 * Why bother at all, when a WebView has `localStorage`? Because it is wiped by
 * "Clear app data" and excluded from Android's auto-backup, so profiles,
 * favourites and watch history would vanish for reasons a user would never connect
 * to their action. Preferences is app-private and backed up.
 */

export interface KVBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Reads and writes `localStorage` directly. Throws are swallowed: private mode. */
const webBackend: KVBackend = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode, or quota */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* as above */
    }
  },
};

let backend: KVBackend = webBackend;

export const kv = {
  get: (key: string): string | null => backend.get(key),
  set: (key: string, value: string): void => backend.set(key, value),
  remove: (key: string): void => backend.remove(key),
};

/** Swap the backend. Called by `hydrate()`; exported for tests. */
export function setKVBackend(next: KVBackend): void {
  backend = next;
}

/**
 * Prepare storage before the first render.
 *
 * A no-op on the web — `localStorage` is already synchronous. On native it reads
 * every stored key into a mirror, and seeds that mirror from `localStorage` the
 * first time, so an existing install keeps its profiles and favourites when it
 * moves to the durable store.
 *
 * Must be awaited before `createRoot().render()`: a module that reads a pref at
 * import time would otherwise see an empty store and write a default over real
 * data.
 */
export async function hydrateKV(): Promise<void> {
  const native = (import.meta.env?.VITE_PLATFORM as string | undefined) === 'capacitor';
  if (!native) return;
  // Nothing about starting the app may depend on a promise that might not
  // settle. The plugin talks to native code over a bridge; if that bridge is
  // missing, mismatched or simply slow, the alternative to this race is a black
  // screen with no error — which is exactly what shipped once already. Losing
  // durability is recoverable; not booting is not.
  await Promise.race([hydrateNative(), sleep(HYDRATE_BUDGET_MS)]);
  overBudget = true;
}

/** How long the durable store gets to answer before the app starts without it. */
const HYDRATE_BUDGET_MS = 2000;
/**
 * Set once the app has started without the durable store.
 *
 * A late answer must not then swap the backend underneath a running app: the
 * modules that read preferences did so at import time, so they would keep
 * showing what `localStorage` held while new writes went somewhere else. One
 * store for the whole session, chosen before the first render.
 */
let overBudget = false;

const sleep = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

async function hydrateNative(): Promise<void> {
  let Preferences: {
    keys(): Promise<{ keys: string[] }>;
    get(o: { key: string }): Promise<{ value: string | null }>;
    set(o: { key: string; value: string }): Promise<void>;
    remove(o: { key: string }): Promise<void>;
  };
  try {
    ({ Preferences } = await import('@capacitor/preferences'));
  } catch {
    // Wrapper flag set but the plugin is missing: stay on localStorage rather
    // than losing writes silently.
    return;
  }

  const mirror = new Map<string, string>();
  try {
    const { keys } = await Preferences.keys();
    for (const key of keys) {
      const { value } = await Preferences.get({ key });
      if (value !== null) mirror.set(key, value);
    }

    // First native run: adopt whatever the WebView's localStorage already holds.
    if (mirror.size === 0) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === null || !key.startsWith('iptv.')) continue;
        const value = localStorage.getItem(key);
        if (value === null) continue;
        mirror.set(key, value);
        void Preferences.set({ key, value });
      }
    }
  } catch {
    return;
  }

  /*
   * Late is fine. Never is not.
   *
   * This used to `return` here when hydration missed the two-second budget, on
   * the reasoning that boot had already gone ahead without it. Boot HAD gone
   * ahead — that part was right — but returning also meant the durable backend
   * was never installed, so every write for the rest of the session went to the
   * WebView's `localStorage` and nowhere else. That store is wiped by "Clear app
   * data", excluded from Android's auto-backup, and gone on a reinstall, which
   * is the whole reason this file exists.
   *
   * The visible symptom was in the admin roster: `deviceId()` mints an id and
   * keeps it in `kv`, so a device whose kv never became durable invented a new
   * identity on every fresh install — one physical television arriving as three
   * and four rows, some signed in and some anonymous. Reported as "duplicate
   * records".
   *
   * Installing late is safe in a way returning is not: `mirror` was seeded from
   * Preferences, so a read after this point still answers with the durable value
   * rather than whatever localStorage happened to hold.
   */
  if (overBudget) {
    /* Anything written during the gap that the durable store has never heard of
       — a device id minted thirty seconds ago is the case that matters — is
       adopted and persisted. Keys Preferences already knows keep ITS value: that
       one survived a reinstall and the local copy did not. */
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key === null || !key.startsWith('iptv.') || mirror.has(key)) continue;
        const value = localStorage.getItem(key);
        if (value === null) continue;
        mirror.set(key, value);
        void Preferences.set({ key, value });
      }
    } catch { /* storage disabled: nothing to adopt */ }
  }

  setKVBackend({
    get: (key) => mirror.get(key) ?? null,
    set: (key, value) => {
      mirror.set(key, value);
      // Not awaited: callers are synchronous, and a lost write on a hard kill
      // costs one preference, not correctness.
      void Preferences.set({ key, value });
      // Dual-write for one release, so a rollback to the web build keeps state.
      webBackend.set(key, value);
    },
    remove: (key) => {
      mirror.delete(key);
      void Preferences.remove({ key });
      webBackend.remove(key);
    },
  });
}
