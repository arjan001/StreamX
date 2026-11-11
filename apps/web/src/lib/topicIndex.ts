import { KIND, readText, type Catalogue } from '@iptv/core-store';
import { eventCore, normalise, SPORTS_TOPIC, topicsOfNormal } from './topics.ts';
import { localCatalogue } from './localCatalogue.ts';
import { liveName, liveNamesEpoch } from './liveNames.ts';

/**
 * Which channels belong to each topic, for the catalogue on this device.
 *
 * Built once per catalogue generation and kept: the library changes when it is
 * rebuilt and not otherwise. A package's name is normalised once and reused for
 * every channel in it, because a real line has ~56,000 channels in ~800
 * packages. See `lib/topics.ts` for what decides a topic.
 */
export interface TopicIndex {
  generation: number;
  /** The renamed-feeds epoch it was built with — see lib/liveNames.ts. */
  names?: number;
  /** Topic id → stream ids, in catalogue order. */
  byTopic: Map<string, number[]>;
}

/**
 * Sport that is none of the fifteen — `BT SPORT 1`, `EUROSPORT 2`, handball.
 *
 * Live TV leaves every sport channel out, because Sports TV lists them; a
 * channel that is sport but not any named sport would then be on neither
 * screen. So it gets a topic of its own, and Sports TV a row for it.
 */
export const OTHER_SPORT = 'othersport';

function topicsWithOther(name: string, pkg: string): string[] {
  const topics = topicsOfNormal(name, pkg);
  return topics.length === 1 && topics[0] === SPORTS_TOPIC.id ? [...topics, OTHER_SPORT] : topics;
}

function file(byTopic: Map<string, number[]>, streamId: number, topics: readonly string[]): void {
  for (const t of topics) {
    let list = byTopic.get(t);
    if (list === undefined) byTopic.set(t, (list = []));
    list.push(streamId);
  }
}

export function buildTopicIndex(cat: Catalogue): TopicIndex {
  const packageName = new Map<number, string>();
  for (const c of cat.categories) if (c.kind === KIND.Live) packageName.set(c.id, ` ${normalise(c.name)} `);
  const byTopic = new Map<string, number[]>();
  const it = cat.items;
  for (let r = 0; r < it.count; r++) {
    if (it.kind[r] !== KIND.Live) continue;
    file(byTopic, it.streamId[r]!,
      topicsWithOther(` ${normalise(eventCore(readText(it.names, r)))} `, packageName.get(it.categoryId[r]!) ?? '  '));
  }
  return { generation: cat.generation, byTopic };
}

let cached: TopicIndex | null = null;
let building: Promise<TopicIndex | null> | null = null;
const watchers = new Set<() => void>();

/** The index if it is ready for the catalogue on this device; null otherwise. */
export function topicIndex(): TopicIndex | null {
  const cat = localCatalogue();
  if (cat === null || cached === null || cached.generation !== cat.generation) return null;
  /* Renamed feeds (lib/liveNames.ts) rebuild it; the one in hand serves until
     the new one is ready, so no sport's list empties while it is. */
  if (cached.names !== liveNamesEpoch()) void ensureTopicIndex();
  return cached;
}

/**
 * Build the index in slices, between frames.
 *
 * ~57,000 channels classify in about 0.3s on this server, which is a second or
 * more on a television — too long to hold a remote's key press for. So it is
 * done a few thousand rows at a time, yielding in between, and whoever is
 * waiting is told when it is ready. Never twice at once.
 */
export function ensureTopicIndex(): Promise<TopicIndex | null> {
  const cat = localCatalogue();
  if (cat === null) return Promise.resolve(null);
  const names = liveNamesEpoch();
  if (cached !== null && cached.generation === cat.generation && cached.names === names) return Promise.resolve(cached);
  if (building !== null) return building;
  building = (async () => {
    const packageName = new Map<number, string>();
    for (const c of cat.categories) if (c.kind === KIND.Live) packageName.set(c.id, ` ${normalise(c.name)} `);
    const byTopic = new Map<string, number[]>();
    const it = cat.items;
    const SLICE = 4_000;
    for (let start = 0; start < it.count; start += SLICE) {
      const end = Math.min(it.count, start + SLICE);
      for (let r = start; r < end; r++) {
        if (it.kind[r] !== KIND.Live) continue;
        const sid = it.streamId[r]!;
        file(byTopic, sid,
          topicsWithOther(` ${normalise(eventCore(liveName(sid, readText(it.names, r))))} `,
            packageName.get(it.categoryId[r]!) ?? '  '));
      }
      await new Promise<void>((done) => setTimeout(done, 0));
    }
    cached = { generation: cat.generation, names, byTopic };
    for (const fn of watchers) { try { fn(); } catch { /* a watcher's problem */ } }
    return cached;
  })().finally(() => { building = null; });
  return building;
}

export function subscribeTopicIndex(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/** The channels of one topic; empty until the index is ready. */
export function topicStreams(id: string): number[] {
  return topicIndex()?.byTopic.get(id) ?? [];
}

/**
 * One topic's channels as a Set, for leaving them out of a list.
 *
 * Built once per catalogue generation and handed to every query that asks —
 * Live TV leaves every sport channel out, and it asks on every page it reads.
 * Null until the index is ready: nothing is left out of a list before anyone
 * knows what to leave out.
 */
let sets: { index: TopicIndex; byTopic: Map<string, ReadonlySet<number>> } | null = null;
export function topicSet(id: string): ReadonlySet<number> | null {
  const idx = topicIndex();
  if (idx === null) return null;
  if (sets === null || sets.index !== idx) sets = { index: idx, byTopic: new Map() };
  let set = sets.byTopic.get(id);
  if (set === undefined) sets.byTopic.set(id, (set = new Set(idx.byTopic.get(id) ?? [])));
  return set;
}
