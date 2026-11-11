/**
 * The whole library in memory, and the tags hidden in its titles.
 *
 * Two things that belong together because one is counted out of the other.
 *
 * ── the set ─────────────────────────────────────────────────────────────────
 *
 * `useTitleIndex` materialises every title in a scope, sorted the way the paged
 * list sorts it. The series rail rendered from it, for a reason that had nothing
 * to do with speed: that rail pinned blocks ABOVE its list — Continue watching,
 * then Favourites — and a pinned row that also appears in its alphabetical place
 * is the same series twice, which is two stops for one thing on a remote.
 * Removing it from the list is trivial over an array and genuinely hard over a
 * paged endpoint, where the row a pinned id occupies may be on a page nobody has
 * fetched, and subtracting it from the QUERY puts the favourite ids into the
 * cache key.
 *
 * THE RAIL IS GONE — "please no left column here" — and the grid that replaced
 * it is paged, like the films grid, with Favourites and Continue as filters
 * rather than as pinned blocks. So nothing materialises the library today. Kept
 * on the same terms as the tags below: it is the right shape, it is tested, and
 * the next screen that needs a whole section in memory should find this rather
 * than write it again.
 *
 * The trap `listAll` exists for: the catalogue is typed arrays in memory on this device, so asking
 * for every series is a scan of memory rather than a request.
 *
 * ── the tags ────────────────────────────────────────────────────────────────
 *
 * `displayName` takes the panel's routing decorations OUT of a title — the
 * quality it was transcoded to, the package it came through, the country it was
 * made in — and these helpers put the same three back as countable values, so
 * anything that wants to offer them can.
 *
 * NOTHING SURFACES THEM TODAY. They were built as a chip strip over the series
 * rail and the strip was removed on the owner's word — "why did you add filters
 * to the series, remove that" — and then the rail went too. The parsing and its
 * tests are kept because they are the right shape and cost nothing while unused;
 * putting them on a screen is a decision to be taken deliberately rather than a
 * leftover to be found.
 *
 * ── and when the catalogue is not on the device ─────────────────────────────
 *
 * `localAllItems` answers nothing when the app runs against the server
 * (`VITE_DATA` unset and the on-device copy switched off), so the index is empty
 * and any caller has to have a paged path to fall back to.
 */
import { useMemo } from 'react';
import { cmpKey, sortKey } from '@iptv/core-store';
import { titleTags } from './displayName.ts';
import { localAllItems } from './localRead.ts';
import { useInventory } from './sections.ts';
import type { Item, ItemQuery, Section } from './api.ts';

/** One pressable value, with how many titles carry it. */
export interface TagFacet {
  id: string;
  count: number;
}

/** The three axes, each already sorted by how much is behind it. */
export interface TitleFacets {
  quality: TagFacet[];
  source: TagFacet[];
  country: TagFacet[];
}

export type TagAxis = keyof TitleFacets;

/** What the viewer has pressed, per axis. */
export type TagSelection = Record<TagAxis, string[]>;

export const NO_TAGS: TagSelection = { quality: [], source: [], country: [] };

export const TAG_AXES: readonly TagAxis[] = ['quality', 'source', 'country'];

/** Is anything filtering at all? The list only changes shape when this is true. */
export function anyTag(sel: TagSelection): boolean {
  return TAG_AXES.some((axis) => sel[axis].length > 0);
}

/** Press a chip: on if it was off, off if it was on. */
export function toggleTag(sel: TagSelection, axis: TagAxis, id: string): TagSelection {
  const have = sel[axis];
  return {
    ...sel,
    [axis]: have.includes(id) ? have.filter((v) => v !== id) : [...have, id],
  };
}

/**
 * Does a title satisfy the selection?
 *
 * ANY-OF within an axis and ALL-OF across them, and both halves are forced by
 * what the tags ARE rather than by taste. A title has exactly one country, so
 * US **and** GB is a question with no answer and pressing a second country can
 * only sensibly widen. A title has a country and a quality, so 4K **and** US is
 * a question with a real answer and pressing the second must narrow.
 *
 * `core-store`'s genre chips learned the same distinction the hard way — a row
 * of chips where some combine one way and some the other reads as broken from
 * the sofa ("it doesn't filter, I see them both"). Here the axes are separate,
 * labelled rows, so the rule is visible in the layout instead of hidden in it.
 */
export function tagsMatch(name: string, sel: TagSelection): boolean {
  if (!anyTag(sel)) return true;
  const tags = titleTags(name);
  for (const axis of TAG_AXES) {
    const want = sel[axis];
    if (want.length === 0) continue;
    const have = tags[axis];
    if (have === null || !want.includes(have)) return false;
  }
  return true;
}

/** Count every tag in a set of names, most-carried first. */
export function facetTitles(names: readonly string[]): TitleFacets {
  const tally: Record<TagAxis, Map<string, number>> = {
    quality: new Map(), source: new Map(), country: new Map(),
  };
  for (const name of names) {
    const tags = titleTags(name);
    for (const axis of TAG_AXES) {
      const value = tags[axis];
      if (value === null) continue;
      tally[axis].set(value, (tally[axis].get(value) ?? 0) + 1);
    }
  }
  const rank = (m: Map<string, number>): TagFacet[] => [...m.entries()]
    .map(([id, count]) => ({ id, count }))
    /* By weight, then alphabetically — a chip row a viewer can learn. Ties
       ordered by name rather than by insertion, or the row reshuffles itself
       between two catalogue refreshes that hold the same titles. */
    .sort((a, b) => (b.count - a.count) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { quality: rank(tally.quality), source: rank(tally.source), country: rank(tally.country) };
}

/** The rows that satisfy a selection, in the order they were given. */
export function filterByTags(rows: readonly Item[], sel: TagSelection): Item[] {
  if (!anyTag(sel)) return rows as Item[];
  return rows.filter((row) => tagsMatch(row.name, sel));
}

/**
 * The materialised set, held across mounts and thrown away when it goes stale.
 *
 * One entry, not a map: two scopes are never read at once — a screen reads one
 * section — and holding the previous one would keep a second copy of the library
 * alive for nothing.
 */
interface Index {
  key: string;
  rows: Item[];
}

let held: Index | null = null;

/** Drop the materialised rows — for a re-ingest, or leaving the screen. */
export function releaseTitleIndex(): void {
  held = null;
}

function build(section: Section, query: ItemQuery, key: string): Index {
  const rows = localAllItems(section, query);
  /*
   * Sorted here, because `listAll` deliberately does not sort.
   *
   * It returns MATCH order — the store's own row order — since a facet count
   * does not depend on order and sorting a whole library to throw the order away
   * is work for nothing. A rail is read down looking for a name, so this list
   * has to be alphabetical, and it has to be alphabetical the SAME WAY the paged
   * list it stands in for is, or the rail visibly reorders itself between the
   * first paint and the second. `sortKey`/`cmpKey` are the store's own
   * comparator — letters and digits, uppercased, compared by code point in both
   * SQL and JS — and `id` is its own row index, which is the tie-break
   * `sortRows` applies to two names that differ only in punctuation.
   */
  const sorted = [...rows].sort(
    (a, b) => cmpKey(sortKey(a.name), sortKey(b.name)) || (a.id - b.id),
  );
  return { key, rows: sorted };
}

/**
 * Every title in this scope, in the order a rail reads them.
 *
 * Empty — and cheap — until `size` says the paged list has answered. Two
 * reasons, and the second is the load-bearing one:
 *
 *   The first paint belongs to the paged list, which is a 40-row request the
 *   viewer is already waiting on. Scanning the whole library before that would
 *   put a synchronous pass in front of it for no visible gain.
 *
 *   `size` is the invalidation. A library that downloads packages on demand
 *   grows underneath this — `useEnsurePackages` pulls one when somebody opens a
 *   group — and the total the paged list reports is the cheapest honest signal
 *   that it did. Without it the rail would go on rendering a set from before the
 *   download, which is the "it still says 0 titles" bug `forgetPagedLists` was
 *   written for, arriving through a different door.
 */
export function useTitleIndex(section: Section, query: ItemQuery, size: number): {
  rows: Item[];
} {
  const inv = useInventory();
  const gen = inv?.generation ?? 0;
  const key = `${section}|${gen}|${size}|${JSON.stringify(query)}`;
  return useMemo(() => {
    if (size <= 0) return { rows: EMPTY_ROWS };
    if (held === null || held.key !== key) held = build(section, query, key);
    return { rows: held.rows };
    // `key` is every input that changes the answer, spelled out above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);
}

/** A stable empty array, so a caller memoising on `rows` does not churn. */
const EMPTY_ROWS: Item[] = [];
