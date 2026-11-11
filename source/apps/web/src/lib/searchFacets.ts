/**
 * People and genre chips for the search page.
 *
 * Cast is folded ("jennifer aniston courteney cox") with no commas, so a person
 * is recovered as a bigram around a word that matches the query. Genres come
 * from the categories of the hit rows — the packages those titles sit in.
 */
import {
  castText, foldText, type Catalogue,
} from '@iptv/core-store';
import type { Item } from './api.ts';
import { localCatalogue } from './localCatalogue.ts';

export interface SearchPerson {
  /** Folded key used for filtering. */
  id: string;
  /** Title-cased label for the rail. */
  label: string;
  count: number;
}

export interface SearchGenre {
  id: string;
  label: string;
  count: number;
}

/** "john travolta" → "John Travolta". */
export function titleCasePerson(folded: string): string {
  return folded
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0)!.toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Distinct people whose names match `q`, tallied across the given catalogue rows.
 *
 * Cap is kept small on purpose: every person can trigger a portrait fetch, and a
 * rail of twenty-four faces is past what a search page can show without scrolling
 * the strip twice.
 */
export function peopleFromRows(
  cat: Catalogue,
  rows: readonly number[],
  q: string,
  cap = 12,
): SearchPerson[] {
  const needle = foldText(q);
  if (needle.length < 2) return [];
  const parts = needle.split(' ').filter((w) => w.length > 0);
  const tallies = new Map<string, number>();

  for (const row of rows) {
    const cast = castText(cat.items.cast, row);
    if (cast === '') continue;
    const words = cast.split(' ').filter((w) => w.length > 0);
    if (parts.length >= 2) {
      for (let i = 0; i <= words.length - parts.length; i++) {
        let ok = true;
        for (let j = 0; j < parts.length; j++) {
          if (words[i + j] !== parts[j]) { ok = false; break; }
        }
        if (!ok) continue;
        const id = parts.join(' ');
        tallies.set(id, (tallies.get(id) ?? 0) + 1);
      }
      continue;
    }
    const token = parts[0]!;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w !== token && !w.startsWith(token)) continue;
      const id = i + 1 < words.length && (words[i + 1]?.length ?? 0) > 1
        ? `${w} ${words[i + 1]}`
        : i > 0
          ? `${words[i - 1]} ${w}`
          : w;
      tallies.set(id, (tallies.get(id) ?? 0) + 1);
    }
  }

  return [...tallies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([id, count]) => ({ id, label: titleCasePerson(id), count }));
}

/** Genres carried by the hit items' categories. */
export function genresFromItems(
  cat: Catalogue,
  items: readonly Item[],
  cap = 12,
): SearchGenre[] {
  const byId = categoryIndex(cat);
  const tallies = new Map<string, number>();
  for (const item of items) {
    if (item.categoryId === null) continue;
    const row = byId.get(item.categoryId);
    if (row === undefined) continue;
    for (const g of row.genres) {
      if (g === '') continue;
      tallies.set(g, (tallies.get(g) ?? 0) + 1);
    }
  }
  return [...tallies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([id, count]) => ({ id, label: id, count }));
}

let categoryGen: number | null = null;
let categoryById: Map<number, Catalogue['categories'][number]> | null = null;

function categoryIndex(cat: Catalogue): Map<number, Catalogue['categories'][number]> {
  if (categoryById !== null && categoryGen === cat.generation) return categoryById;
  categoryById = new Map(cat.categories.map((c) => [c.id, c]));
  categoryGen = cat.generation;
  return categoryById;
}

/** Whether this catalogue row names the person (folded id). */
export function rowHasPerson(cat: Catalogue, row: number, personId: string): boolean {
  const cast = castText(cat.items.cast, row);
  if (cast === '') return false;
  if (cast === personId || cast.startsWith(`${personId} `) || cast.endsWith(` ${personId}`)) {
    return true;
  }
  return cast.includes(` ${personId} `);
}

export function itemHasGenre(cat: Catalogue, item: Item, genreId: string): boolean {
  if (item.categoryId === null) return false;
  const row = categoryIndex(cat).get(item.categoryId);
  return row !== undefined && row.genres.includes(genreId);
}

/** Facets for the current search hits, or empty when the device has no catalogue. */
export function searchFacets(
  q: string,
  live: readonly Item[],
  movies: readonly Item[],
  series: readonly Item[],
  selected?: { people?: readonly string[]; genres?: readonly string[] },
): { people: SearchPerson[]; genres: SearchGenre[] } {
  const cat = localCatalogue();
  if (cat === null || q.trim().length < 2) return { people: [], genres: [] };
  const vod = [...movies, ...series];
  const peopleIds = selected?.people ?? [];
  const genreIds = selected?.genres ?? [];

  const basePeople = peopleFromRows(cat, vod.map((i) => i.id), q);
  const baseGenres = genresFromItems(cat, vod);

  /* People chips: scoped by selected genres (AND), not by selected people.
     Genre chips: scoped by selected people AND the current genre set, so
     Comedy+Anime only leaves co-occurring chips. An empty harvest stays empty
     — falling back to the unscoped list showed comedy on a person whose titles
     carry no comedy, and pressing it wiped the results. */
  const forPeople = genreIds.length > 0 ? filterByGenres(vod, genreIds) : vod;
  let forGenres = peopleIds.length > 0 ? filterByPeople(vod, peopleIds) : vod;
  if (genreIds.length > 0) forGenres = filterByGenres(forGenres, genreIds);

  const people = genreIds.length > 0
    ? narrowPeople(cat, basePeople, forPeople, q)
    : basePeople;
  const genres = (peopleIds.length > 0 || genreIds.length > 0)
    ? narrowGenres(cat, forGenres)
    : baseGenres;

  return {
    people: keepSelectedPeople(people, peopleIds),
    genres: keepSelectedGenres(genres, genreIds),
  };
}

/** People who appear in `scope`. Empty scope or empty cast → empty rail. */
function narrowPeople(
  cat: Catalogue,
  base: SearchPerson[],
  scope: readonly Item[],
  q: string,
): SearchPerson[] {
  if (scope.length === 0) return [];
  const harvested = peopleFromRows(cat, scope.map((i) => i.id), q);
  if (harvested.length > 0) return harvested;
  const out: SearchPerson[] = [];
  for (const p of base) {
    let count = 0;
    for (const item of scope) {
      if (rowHasPerson(cat, item.id, p.id)) count++;
    }
    if (count > 0) out.push({ id: p.id, label: p.label, count });
  }
  return out;
}

function narrowGenres(
  cat: Catalogue,
  scope: readonly Item[],
): SearchGenre[] {
  if (scope.length === 0) return [];
  return genresFromItems(cat, scope);
}

function keepSelectedPeople(
  list: SearchPerson[],
  selected: readonly string[],
): SearchPerson[] {
  if (selected.length === 0) return list;
  const byId = new Map(list.map((p) => [p.id, p]));
  const head: SearchPerson[] = [];
  for (const id of selected) {
    head.push(byId.get(id) ?? { id, label: titleCasePerson(id), count: 0 });
    byId.delete(id);
  }
  return [...head, ...byId.values()];
}

function keepSelectedGenres(
  list: SearchGenre[],
  selected: readonly string[],
): SearchGenre[] {
  if (selected.length === 0) return list;
  const byId = new Map(list.map((g) => [g.id, g]));
  const head: SearchGenre[] = [];
  for (const id of selected) {
    head.push(byId.get(id) ?? { id, label: id, count: 0 });
    byId.delete(id);
  }
  return [...head, ...byId.values()];
}

export function filterByPerson(items: readonly Item[], personId: string): Item[] {
  return filterByPeople(items, [personId]);
}

export function filterByPeople(items: readonly Item[], personIds: readonly string[]): Item[] {
  if (personIds.length === 0) return [...items];
  const cat = localCatalogue();
  if (cat === null) return [...items];
  /* EVERY selected person, same rule as the genre chips. */
  return items.filter((i) => personIds.every((id) => rowHasPerson(cat, i.id, id)));
}

export function filterByGenre(items: readonly Item[], genreId: string): Item[] {
  return filterByGenres(items, [genreId]);
}

export function filterByGenres(items: readonly Item[], genreIds: readonly string[]): Item[] {
  if (genreIds.length === 0) return [...items];
  const cat = localCatalogue();
  if (cat === null) return [...items];
  /* Comedy AND Anime — both must be on the title's category, not either. */
  return items.filter((i) => genreIds.every((id) => itemHasGenre(cat, i, id)));
}

/** Category label for a search row. */
export function itemCategoryLabel(item: Item): string | null {
  const cat = localCatalogue();
  if (cat === null || item.categoryId === null) return null;
  const row = categoryIndex(cat).get(item.categoryId);
  if (row === undefined) return null;
  const label = row.cleanName !== '' ? row.cleanName : row.name;
  return label === '' ? null : label;
}

/**
 * Second text block under title/year/cat — genres, else a short cast line.
 *
 * List rows do not carry a plot (films need a per-title fetch; series plot was
 * never ingested), so this is the honest filler that is already on the device.
 */
export function itemSearchBlurb(item: Item): string | null {
  const cat = localCatalogue();
  if (cat === null) return null;
  if (item.categoryId !== null) {
    const row = categoryIndex(cat).get(item.categoryId);
    if (row !== undefined && row.genres.length > 0) {
      return row.genres.slice(0, 4).join(' · ');
    }
  }
  const cast = castText(cat.items.cast, item.id);
  if (cast === '') return null;
  const words = cast.split(' ').filter((w) => w.length > 0).slice(0, 8);
  if (words.length === 0) return null;
  return titleCasePerson(words.join(' '));
}
