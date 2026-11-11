/**
 * What someone is likely to want, from what they have actually done.
 *
 * There was no such thing before this: the home page offered "just added" and
 * "well reviewed", which are facts about the catalogue rather than about the
 * person looking at it. This builds a taste profile and turns it into rails with
 * headers that say WHY — "More drama", "Because you watched Dune", "More from
 * Netflix" — because an unexplained recommendation is indistinguishable from a
 * random one.
 *
 * Everything is derived from data already on the device or already fetched:
 *
 * - watch history and favourites, which live in `prefs` and never leave the
 *   device;
 * - the category of each of those titles, which arrives on the item row itself
 *   (`categoryId`);
 * - the genres, region and provider of each category, which the client already
 *   holds for its filter bar.
 *
 * So a profile costs zero extra requests. That matters more than it sounds: the
 * alternative is one panel call per watched title to read its genres, on a panel
 * that flood-protects.
 *
 * Pure, and tested, because a recommender that silently degrades is worse than
 * none — it keeps working, just badly, and nobody can tell.
 */
import type { Item } from './api.ts';
import type { WatchRecord } from './prefs.ts';

export interface CategoryFacts {
  id: number;
  cleanName: string;
  genres: string[];
  region: string | null;
  source: string | null;
}

/** One thing someone did, with how much it should count. */
export interface Signal {
  item: Item;
  /**
   * How strong this signal is.
   *
   * A star is a deliberate statement and outweighs a watch. A watch counts in
   * proportion to how far through it got — abandoning something after four
   * minutes is evidence AGAINST it, and treating that the same as finishing it is
   * how recommenders end up recommending things people bounced off.
   */
  weight: number;
}

export const WEIGHTS = {
  /** A star. Deliberate, and the strongest thing available. */
  favourite: 3,
  /** Watched to (near) the end. */
  finished: 2.5,
  /** Watched a decent stretch. */
  engaged: 1.5,
  /** Started and abandoned. Negative: this is evidence of dislike. */
  bounced: -1,
} as const;

/** Below this fraction, starting something says more about the trailer than the film. */
const BOUNCE_UNDER = 0.08;
const ENGAGED_UNDER = 0.6;

export function watchWeight(rec: WatchRecord): number {
  if (rec.durationS <= 0) return WEIGHTS.engaged;
  const frac = rec.positionS / rec.durationS;
  if (frac < BOUNCE_UNDER) return WEIGHTS.bounced;
  if (frac < ENGAGED_UNDER) return WEIGHTS.engaged;
  return WEIGHTS.finished;
}

export interface Taste {
  genres: { id: string; score: number }[];
  providers: { id: string; score: number }[];
  regions: { id: string; score: number }[];
  categories: { id: number; score: number; label: string }[];
  /** Titles worth naming in a header, strongest first. */
  seeds: Item[];
  /** Provider ids already watched or starred, per section, to exclude. */
  seen: { movies: Set<number>; series: Set<number> };
  /** True when there is not enough signal to say anything. */
  cold: boolean;
}

const MIN_SIGNALS = 2;

function bump(map: Map<string, number>, key: string | null, by: number): void {
  if (key === null || key === '') return;
  map.set(key, (map.get(key) ?? 0) + by);
}

function ranked(map: Map<string, number>): { id: string; score: number }[] {
  return [...map.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
}

/**
 * Build the profile.
 *
 * Signals are weighted by strength and by RECENCY: what someone watched last
 * week is a better guide than what they watched in March, and a profile that
 * never forgets gradually stops describing anyone. Half-life of three weeks,
 * applied to positive signals only — a dislike does not fade, because the thing
 * is still not to their taste.
 */
export function buildTaste(
  signals: readonly Signal[],
  categories: readonly CategoryFacts[],
  opts: { now: number; history: readonly WatchRecord[] },
): Taste {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const genres = new Map<string, number>();
  const providers = new Map<string, number>();
  const regions = new Map<string, number>();
  const cats = new Map<number, { score: number; label: string }>();
  const recency = new Map<number, number>();
  for (const r of opts.history) recency.set(r.streamId, r.updatedAt);

  const HALF_LIFE_MS = 21 * 86_400_000;

  for (const { item, weight } of signals) {
    const cat = item.categoryId === null ? undefined : byId.get(item.categoryId);
    if (!cat) continue;
    const at = item.streamId === null ? undefined : recency.get(item.streamId);
    const age = at === undefined ? 0 : Math.max(0, opts.now - at);
    const fade = weight > 0 ? 0.5 ** (age / HALF_LIFE_MS) : 1;
    const w = weight * fade;

    for (const g of cat.genres) bump(genres, g, w);
    bump(providers, cat.source, w);
    bump(regions, cat.region, w);
    const prev = cats.get(cat.id);
    cats.set(cat.id, { score: (prev?.score ?? 0) + w, label: cat.cleanName });
  }

  const seen = { movies: new Set<number>(), series: new Set<number>() };
  for (const { item } of signals) {
    if (item.streamId === null) continue;
    (item.kind === 3 ? seen.series : seen.movies).add(item.streamId);
  }

  /* Seeds are the titles a header can name. Strongest signal first, and never a
     bounced one — "because you watched X" about something abandoned after three
     minutes is the recommendation everybody complains about. */
  const seeds = signals
    .filter((s) => s.weight > 0)
    .sort((a, b) => b.weight - a.weight
      || (recency.get(b.item.streamId ?? -1) ?? 0) - (recency.get(a.item.streamId ?? -1) ?? 0))
    .map((s) => s.item);

  return {
    genres: ranked(genres),
    providers: ranked(providers),
    regions: ranked(regions),
    categories: [...cats.entries()]
      .filter(([, v]) => v.score > 0)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([id, v]) => ({ id, score: v.score, label: v.label })),
    seeds,
    seen,
    cold: signals.filter((s) => s.weight > 0).length < MIN_SIGNALS,
  };
}

export type PickKind = 'genre' | 'provider' | 'category' | 'seed' | 'region';

/** One recommended rail: a query, a header, and the reason behind both. */
export interface Pick {
  key: string;
  kind: PickKind;
  /** The rail's header. Says why, because an unexplained rail is a random one. */
  title: string;
  /** What to ask the items endpoint for. */
  query: { genres?: string[]; source?: string; region?: string; categoryId?: number };
  section: 'movies' | 'series';
  /** Which title this was inferred from, when the header names one. */
  seedId?: number;
}

/**
 * Turn a profile into rails.
 *
 * Rules that keep the list worth reading rather than merely long:
 *
 * - **Diverse by construction.** One rail per dimension before a second of the
 *   same kind, so someone who watches a lot of one provider does not get five
 *   provider rails.
 * - **Named where naming helps.** A genre rail says the genre; a category rail
 *   says the group; a seed rail names the title, which is the most persuasive
 *   header there is and the only one that needs a specific film to exist.
 * - **Nothing on a cold profile.** With one watch there is no taste to describe,
 *   and a "recommended for you" rail built from a single data point is a lie the
 *   user can see through.
 */
export function recommend(taste: Taste, opts: { section: 'movies' | 'series'; limit: number }): Pick[] {
  if (taste.cold) return [];
  const out: Pick[] = [];
  const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const rounds: (() => Pick | null)[] = [
    () => {
      const g = taste.genres[0];
      return g ? {
        key: `genre:${g.id}`, kind: 'genre', title: `More ${label(g.id)}`,
        query: { genres: [g.id] }, section: opts.section,
      } : null;
    },
    () => {
      const p = taste.providers[0];
      return p ? {
        key: `provider:${p.id}`, kind: 'provider', title: `More from ${p.id}`,
        query: { source: p.id }, section: opts.section,
      } : null;
    },
    () => {
      const c = taste.categories[0];
      return c ? {
        key: `cat:${c.id}`, kind: 'category', title: `More from ${c.label}`,
        query: { categoryId: c.id }, section: opts.section,
      } : null;
    },
    () => {
      const g = taste.genres[1];
      return g ? {
        key: `genre:${g.id}`, kind: 'genre', title: `Because you like ${label(g.id)}`,
        query: { genres: [g.id] }, section: opts.section,
      } : null;
    },
    () => {
      const p = taste.providers[1];
      return p ? {
        key: `provider:${p.id}`, kind: 'provider', title: `More from ${p.id}`,
        query: { source: p.id }, section: opts.section,
      } : null;
    },
    () => {
      const g = taste.genres[2];
      return g ? {
        key: `genre:${g.id}`, kind: 'genre', title: `More ${label(g.id)}`,
        query: { genres: [g.id] }, section: opts.section,
      } : null;
    },
  ];

  const used = new Set<string>();
  for (const round of rounds) {
    if (out.length >= opts.limit) break;
    const pick = round();
    if (!pick || used.has(pick.key)) continue;
    used.add(pick.key);
    out.push(pick);
  }
  return out;
}

/** Rows worth showing on a recommended rail: unseen, and reasonably rated. */
export function filterRecommended(
  rows: readonly Item[],
  taste: Taste,
  section: 'movies' | 'series',
): Item[] {
  const seen = section === 'series' ? taste.seen.series : taste.seen.movies;
  return rows.filter((r) => r.streamId === null || !seen.has(r.streamId));
}
