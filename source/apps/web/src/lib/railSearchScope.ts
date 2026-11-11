/**
 * What a search does to the scope you were standing in.
 *
 * ── the report ──
 *
 * Photographed from the sofa: "vtm" typed into the rail's search box, three
 * matching packages listed under it — BE| TELENET, BE| BELGIUM VIP RAW, US| NBC
 * NETWORK — and the column beside them still showing an empty Favourites list.
 * Not one channel called VTM anywhere on the screen, on a library that plainly
 * has several.
 *
 * Nothing was broken. Favourites was what had been picked before the typing
 * started, the one search box writes the page's one query, and a search inside
 * an empty list finds nothing. Every part of that is behaving; the screen is
 * still useless.
 *
 *   "if other channals selected, show all channals as well, and if they want to
 *    filter by that category they can navigate"
 *
 * ── the rule ──
 *
 * A search is a question about the whole library, not about the corner of it you
 * happened to be looking at. So the FIRST character widens the scope to
 * everything the profile allows, and the rail goes on showing which packages
 * match — so narrowing to one of them stays a single press away, which is the
 * second half of what was asked for.
 *
 * Clearing the box puts the viewer back where they were. That matters on a
 * remote: a search is often a detour, and a detour that loses your place costs
 * more than it saved.
 *
 * The one exception is a scope the viewer picked THEMSELVES while searching.
 * That is not a detour, it is a decision — so whoever calls this drops the
 * parked scope when a pick happens, and clearing the box then leaves them where
 * they chose to be rather than dragging them back.
 *
 * Pure, and separate from the rail, because it is four cases and three of them
 * are about state that a component makes hard to see.
 *
 * Not to be confused with `lib/searchScope.ts`, which is the SEARCH SCREEN's
 * content-type row (Live / Movies / Series / Catch-up). This one is the rail's,
 * and the two never meet.
 */

/** The part of the filters this rule moves. Everything else is left alone. */
export interface RailScope {
  favs: boolean;
  markets: string[];
  paths: string[];
  path: string | null;
  categoryId: number | null;
  cats: number[];
}

/**
 * Everything the profile allows.
 *
 * The same patch the rail's "All countries" row sends — deliberately, so a
 * search lands on a scope the viewer can also reach by hand, and the heading
 * over the list says the same thing either way.
 */
export const WHOLE_LIBRARY: RailScope = {
  favs: false, markets: [], paths: [], path: null, categoryId: null, cats: [],
};

export interface ScopeMove {
  /** Merged into the filters. Always carries `q`; carries a scope only when it moves. */
  patch: Partial<RailScope> & { q: string };
  /** What to remember for the next call. `null` once it has been spent. */
  parked: RailScope | null;
}

export function railSearchScope(
  was: string,
  now: string,
  current: RailScope,
  parked: RailScope | null,
): ScopeMove {
  /* Starting a search: remember where we were, and ask the whole library. */
  if (was === '' && now !== '') return { patch: { q: now, ...WHOLE_LIBRARY }, parked: current };
  /* Ending one: go back, if there is anywhere to go back to. */
  if (now === '') {
    return parked === null
      ? { patch: { q: '' }, parked: null }
      : { patch: { q: '', ...parked }, parked: null };
  }
  /* Still typing. The scope was already moved by the first character, and moving
     it again would undo a category the viewer picked mid-search. */
  return { patch: { q: now }, parked };
}
