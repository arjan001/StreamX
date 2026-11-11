/**
 * Channel names as the panel says them now, laid over the library's.
 *
 * "find a way to keep the sports area updated, I downloaded the library
 * yesterday, I think it's taking those from that, find an efficient way". It
 * was: a PPV or event feed keeps its stream id and its package and is renamed,
 * several times a day, to whatever it is carrying — and the device's library
 * holds the name from the day it was downloaded. The owner's Football list
 * showed yesterday's snooker and a baseball tournament on `FR: SOCCER PPV`
 * feeds.
 *
 * ── why not simply rebuild ──
 *
 * The library is one compressed blob of every channel, film and series (tens of
 * megabytes), and the catalogue is built from all of it at once. Re-reading the
 * live list into it means unpacking, re-packing and rebuilding the lot — seconds
 * of a television's main thread, for a few hundred names. `refreshLiveList` in
 * lib/localCatalogue.ts still does that, daily, for channels that are genuinely
 * new.
 *
 * This does the part that changes by the hour, cheaply: one `get_live_streams`
 * request, compared stream id by stream id with the library, and only the names
 * that DIFFER are kept — a few hundred entries, stored on their own. Every list
 * reads a channel's name through `liveName` (lib/localRead.ts), and the sport
 * index is rebuilt from the new names (lib/topicIndex.ts), so a renamed feed is
 * filed under the sport it is carrying today. Tied to the library build it was
 * compared against: a rebuild carries the fresh names itself, and this is
 * dropped.
 */
import { KIND, readText } from '@iptv/core-store';
import { blobs, canCompareLiveNames, fetchLiveListNow, localCatalogue } from './localCatalogue.ts';
import { activeProvider } from './providers/index.ts';
import { dlog } from './debugLog.ts';

interface Stored {
  /** The library build these names were compared against. */
  build: string;
  at: number;
  names: [number, string][];
}

let overlay = new Map<number, string>();
let built = '';
let comparedAt = 0;
let epoch = 0;
let loading: Promise<void> | null = null;
let running: Promise<boolean> | null = null;
const watchers = new Set<() => void>();

const keyFor = (): string => `live.names.${activeProvider()?.id ?? 0}`;

function buildOf(): string {
  const cat = localCatalogue();
  return cat === null ? '' : `${cat.generation}:${cat.builtAt}`;
}

/** A channel's name now, or the one it was built with. */
export function liveName(streamId: number | null, name: string): string {
  if (streamId === null || overlay.size === 0) return name;
  if (built !== buildOf()) return name;
  return overlay.get(streamId) ?? name;
}

/** Bumped whenever the names change, so what was built from them rebuilds. */
export function liveNamesEpoch(): number {
  return built === buildOf() ? epoch : 0;
}

export function subscribeLiveNames(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

function publish(): void {
  epoch += 1;
  for (const fn of watchers) { try { fn(); } catch { /* a watcher's problem */ } }
}

/** What was stored last time, if it belongs to this library. Called when the
    library is ready, so a renamed feed reads right before anything is fetched. */
export function loadLiveNames(): Promise<void> {
  return load();
}

function load(): Promise<void> {
  const build = buildOf();
  if (build === '' || build === built) return Promise.resolve();
  loading ??= (async () => {
    try {
      const got = await blobs().get(keyFor()) as Stored | null | undefined;
      if (got !== null && got !== undefined && got.build === build && Array.isArray(got.names)) {
        overlay = new Map(got.names);
        built = build;
        comparedAt = got.at;
        if (overlay.size > 0) publish();
      } else {
        overlay = new Map();
        built = build;
        comparedAt = 0;
      }
    } catch { /* nothing stored */ }
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Compare the panel's names with the library's, if the last comparison is older
 * than `maxAgeMs`. True when it ran. Never throws; never runs twice at once.
 */
export function refreshLiveNames(maxAgeMs: number, now = Date.now()): Promise<boolean> {
  if (running !== null) return running;
  running = (async () => {
    if (!canCompareLiveNames()) return false;
    await load();
    const build = buildOf();
    if (build === '' || (built === build && now - comparedAt < maxAgeMs)) return false;
    const cat = localCatalogue();
    if (cat === null) return false;
    let fresh: unknown[];
    try {
      fresh = await fetchLiveListNow();
    } catch (err) {
      dlog.warn('catalogue', `channel names not compared — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    /* The library may have been rebuilt while the list was on its way. */
    if (buildOf() !== build) return false;
    const rowOf = new Map<number, number>();
    const it = cat.items;
    for (let r = 0; r < it.count; r++) if (it.kind[r] === KIND.Live) rowOf.set(it.streamId[r]!, r);
    const next = new Map<number, string>();
    for (const raw of fresh) {
      if (raw === null || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const id = Number(o['stream_id']);
      const r = rowOf.get(id);
      if (r === undefined) continue;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      if (name !== '' && name !== readText(it.names, r)) next.set(id, name);
    }
    const changed = next.size !== overlay.size || [...next].some(([id, n]) => overlay.get(id) !== n);
    overlay = next;
    built = build;
    comparedAt = now;
    try {
      await blobs().put(keyFor(), { build, at: now, names: [...next] } satisfies Stored);
    } catch { /* kept in memory for this visit */ }
    dlog.info('catalogue', `channel names compared: ${next.size} renamed since the library was built`);
    if (changed) publish();
    return true;
  })().finally(() => { running = null; });
  return running;
}
