/**
 * One filter narrowing the others.
 *
 * Every control on a browse page reads the same catalogue, so the values it
 * offers have to be the values that survive everything ELSE that is already set.
 * Pick Comedy and the group tree should hold the groups that carry comedy, the
 * country list should hold the countries that have it, and the language list
 * should hold the languages it exists in. Anything else offers a press that
 * lands on an empty grid — which is what the films page did: a genre chip
 * narrowed the posters and left the sidebar listing all 79 countries and every
 * package in the library, most of them with nothing comedy in them at all.
 *
 * The listing endpoints have taken all of these dimensions from the start
 * (`/api/:kind/{groups,markets,categories,facets}` share `ScopeQuery` with the
 * items route). The narrowing was missing on this side, not on the server's.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * A list is scoped by every axis EXCEPT its own. The group tree is not scoped by
 * the selected group, or picking a group would collapse the tree to the group
 * you are standing in and there would be no way to reach its neighbour. Same for
 * the country list, the language and the source.
 *
 * Genres are the one axis this function does not hold back, and the reason is
 * simpler than it used to be. Every genre chip ANDs now, so a chip's count means
 * "what the grid would hold with this one on as well" — which is measured WITH
 * the current selection applied rather than without it, in a single pass in
 * `listFacets`. So `genres` rides on every scope here, its own included, and
 * there is no exception to remember. Back when genres were any-of, a chip was
 * something you ADDED and its count had to be taken with the genre selection
 * dropped; that carve-out is gone with the rule that needed it.
 *
 * Year, rating and free-text are not pickers of their own list — they narrow
 * every other list the same way a package does, so they ride on every scope.
 */
import type { Hidden } from './api.ts';

/** The axes a browse page filters on. Structurally a subset of `Filters`. */
export interface CrossFilters {
  markets: string[];
  path: string | null;
  paths: string[];
  categoryId: number | null;
  cats: number[];
  genres: string[];
  region: string | null;
  source: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  minRating: number | null;
  q: string;
}

/**
 * Which list is being built — the axis to leave out of its own scope.
 *
 * `groups` covers the country list and the group tree together: a market IS
 * depth-1 of that tree, so they are one axis wearing two names, and scoping
 * either by the other's selection is the collapse described above.
 *
 * `year` / `rating` leave the decade and star pills free to switch without the
 * list collapsing to the one value already chosen.
 */
export type Axis = 'groups' | 'genres' | 'region' | 'source' | 'cats' | 'year' | 'rating';

export function crossScope(
  base: Hidden,
  f: CrossFilters,
  own: Axis,
  /** Countries the profile allows, already resolved (`effectiveMarkets`). */
  markets: string[] = f.markets,
): Hidden {
  /* Paths win over markets where both are set: a group is inside a country, so
     the narrower of the two is the whole answer. Both is not narrower — the
     routes UNION `paths`, `market` and `markets` into one prefix list, so
     sending a country beside a group inside it widens the result back to the
     country. Hence the delete: the profile's own countries ride in on `base`,
     and a spread that only ADDS `paths` leaves them there. */
  const paths = [...new Set([...(f.path ? [f.path] : []), ...f.paths])];
  const cats = [...new Set([...(f.categoryId !== null ? [f.categoryId] : []), ...f.cats])];

  const out: Hidden = { ...base };
  if (own !== 'groups') {
    if (paths.length > 0) {
      out.paths = paths;
      delete out.markets;
    } else if (markets.length > 0) {
      out.markets = markets;
    }
  }
  if (own !== 'cats' && cats.length > 0) out.cats = cats;
  if (f.genres.length > 0) out.genres = f.genres;
  if (own !== 'region' && f.region) out.region = f.region;
  if (own !== 'source' && f.source) out.source = f.source;
  if (own !== 'year') {
    if (f.yearFrom != null) out.yearFrom = f.yearFrom;
    if (f.yearTo != null) out.yearTo = f.yearTo;
  }
  if (own !== 'rating' && f.minRating != null) out.minRating = f.minRating;
  const needle = f.q.trim();
  if (needle !== '') out.q = needle;
  return out;
}
