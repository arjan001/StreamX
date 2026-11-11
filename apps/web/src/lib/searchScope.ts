/**
 * The content-type row above the search results, decided away from the page.
 *
 * Asked for in these words, by a partner testing the app: "the search function
 * should really have labels at the top that match the different types of
 * content: Live, Movies, Series or Catchup — and depending on what you were
 * doing when you clicked search, that category should be selected first. In
 * theory you can search across all channels, which is apparently how it is done
 * now, but it is not user-friendly."
 *
 * Half of that was already built, and invisible. The origin has travelled in the
 * URL as `?from=` since `searchHref` was written, and the page has ranked its
 * result blocks by it ever since — press SEARCH on Movies and films already came
 * first. A preference the app holds and never admits to is a preference nobody
 * can see, trust, or overrule. This module is the part that can be seen and
 * pressed.
 *
 * ── why catch-up is a chip and not a catalogue ──
 *
 * There are three kinds in this app — live, movies, series — and catch-up is
 * none of them. It is live television that keeps what it played, which the
 * catch-up page states as a query rather than a section:
 * `api.items('live', { archiveOnly: true })`, one flag on the item row. That
 * same flag is already on every search hit and costs nothing to read: the store
 * builds an `ItemView` from the whole row, `toItem` carries `archive` through to
 * the client `Item`, and `archiveOnly` in `core-store` tests the identical bit.
 * So the fourth chip is a boolean per hit, not a second request — which is the
 * only reason it is here at all. Its rows go to `/catchup?ch=`, because somebody
 * who asked for recordings and got the live stream was not answered.
 *
 * ── why the row hides its own chips ──
 *
 * `sections.ts` already wrote the rule this file obeys: **never offer a
 * destination that has nothing behind it.** A scope with no hits is exactly
 * that, and on a remote it is worse than a wasted tile — it is another stop on
 * the way along the row. So the row carries All, whatever actually matched, and
 * the selected chip whether or not it matched (an explicit choice is not
 * overruled behind somebody's back; see `scopeChips`).
 *
 * That rule is also what keeps this row and the people/genre rows underneath it
 * from contradicting each other. Picking an actor empties the live block — a
 * cast list is a statement about titles, and channels that merely share a word
 * with the query are noise under it. Before this row existed that was invisible
 * too; now Live and Catch-up simply leave the row while a face is lit, instead
 * of sitting there promising channels and delivering an empty page.
 *
 * Pure, and tested on its own, for the reason `guide.ts` is: this is the part
 * that is wrong in ways a screenshot cannot show — a count that disagrees with
 * the list under it, a chip that opens nothing, an arrival that lands on the
 * wrong word.
 */
import { sectionForPath } from './sections.ts';

export type Scope = 'all' | 'live' | 'ontv' | 'movies' | 'series' | 'catchup';

/**
 * Row order, left to right. `all` leads because it is the way back out; `ontv`
 * sits right after `live` — a partner's own pairing ("in Live you might want to
 * search for the name of a channel, but at another moment for a specific
 * programme that is broadcast on TV") for two ways of asking about the same
 * screen.
 */
export const SCOPES: readonly Scope[] = ['all', 'live', 'ontv', 'movies', 'series', 'catchup'];

export function scopeLabel(s: Scope): string {
  switch (s) {
    case 'all': return 'All';
    case 'live': return 'Live';
    case 'ontv': return 'On TV';
    case 'movies': return 'Movies';
    case 'series': return 'Series';
    case 'catchup': return 'Catch-up';
  }
}

/**
 * A search hit, as far as this row is concerned.
 *
 * Structural on purpose: the page's own `Hit` carries an href and a whole `Item`
 * that none of this needs, and naming the two fields it does need is what keeps
 * the tests free of catalogue fixtures.
 *
 * `ontv` is a fourth kind here, not a filter derived from another one the way
 * `catchup` is: a programme hit is not a catalogue row at all, it is a title
 * found in the on-device guide (`lib/epgSearch.ts`), and its `item` carries no
 * honest `archive` bit of its own — hence that field being optional rather than
 * every `ontv` hit inventing one. `inScope`'s `catchup` case never reads it for
 * this kind, because that case is guarded on `kind === 'live'` first.
 */
export interface ScopedHit {
  kind: 'live' | 'ontv' | 'movies' | 'series';
  item: { archive?: boolean };
}

export interface ScopeChip {
  id: Scope;
  label: string;
  count: number;
}

/**
 * Whether the cast and category chips mean anything in this scope.
 *
 * They are harvested from films and series only — `searchFacets` folds movies
 * and series into one `vod` array and never looks at a channel — so under Live,
 * Catch-up or On TV they are chips describing rows that are not on screen. The
 * page hides them there and drops the picks when one of those chips is pressed;
 * this is the one place that decides it, so the hiding and the dropping cannot
 * disagree. On TV is a guide of programme titles, with no cast or category of
 * its own any more than a channel has one.
 */
export function facetsApply(scope: Scope): boolean {
  return scope !== 'live' && scope !== 'catchup' && scope !== 'ontv';
}

/**
 * Which chip is lit when the page opens.
 *
 * Two sources, in this order: an explicit `?scope=`, which somebody pressed and
 * which a reload or a BACK must therefore return them to, and otherwise the
 * `?from=` the search page was opened with. No origin means no claim — "All",
 * the behaviour that was there before this row was.
 *
 * `from` is a nav TAB and not a section, which is exactly what makes the fourth
 * chip possible: `sectionForPath` deliberately folds the guide and catch-up
 * into `live`, because they are all views onto live television and
 * should all rank channels first. Catch-up is the one case where the tab knows
 * something the section has thrown away — you were standing in the recordings —
 * so it is answered here, before the fold, and everything else is delegated
 * rather than restated, so the two cannot drift apart.
 */
export function scopeOnArrival(scope: string | null, from: string | null): Scope {
  if (scope !== null && (SCOPES as readonly string[]).includes(scope)) return scope as Scope;
  if (from === null || from === '') return 'all';
  if (from === 'catchup') return 'catchup';
  return sectionForPath(`/${from}`) ?? 'all';
}

/** Does this hit belong under that chip? */
export function inScope(hit: ScopedHit, scope: Scope): boolean {
  switch (scope) {
    case 'all': return true;
    case 'live': return hit.kind === 'live';
    case 'ontv': return hit.kind === 'ontv';
    case 'movies': return hit.kind === 'movies';
    case 'series': return hit.kind === 'series';
    /* Not a kind of its own — a channel that kept what it played. */
    case 'catchup': return hit.kind === 'live' && hit.item.archive === true;
  }
}

/** The hits a scope shows, in the order they were already ranked. */
export function hitsInScope<T extends ScopedHit>(hits: readonly T[], scope: Scope): T[] {
  return scope === 'all' ? [...hits] : hits.filter((h) => inScope(h, scope));
}

/**
 * How many each chip would show, counted off the same array the list renders.
 *
 * Never a separate query. A count that comes from anywhere but the rows it
 * labels is a count that will eventually be right about a different list —
 * a facet pick and the per-section cap all narrow these rows, and
 * a second read would have to remember every one of them.
 *
 * Catch-up therefore overlaps Live rather than partitioning it, and the numbers
 * do not add up to All. That is the truth about the content, not an error: a
 * channel with an archive is both.
 */
export function scopeCounts(hits: readonly ScopedHit[]): Record<Scope, number> {
  const out: Record<Scope, number> = { all: 0, live: 0, ontv: 0, movies: 0, series: 0, catchup: 0 };
  for (const s of SCOPES) {
    for (const h of hits) if (inScope(h, s)) out[s] += 1;
  }
  return out;
}

/**
 * The chips to draw: All, whatever matched, and the one that is lit.
 *
 * The selected chip survives an empty count so that a deliberate choice is never
 * quietly swapped for another one while somebody is typing — the results arrive
 * letter by letter, and a row that reshuffles under the cursor is a row you
 * cannot aim at. The page says "nothing here, N elsewhere" instead.
 */
export function scopeChips(hits: readonly ScopedHit[], selected: Scope): ScopeChip[] {
  const counts = scopeCounts(hits);
  return SCOPES
    .filter((s) => s === 'all' || s === selected || counts[s] > 0)
    .map((s) => ({ id: s, label: scopeLabel(s), count: counts[s] }));
}

/**
 * Is the row worth a stop on the remote?
 *
 * "All · Movies" is not a choice, it is the same list named twice, and it costs
 * a press to get past on the way down to the results. Two real destinations or
 * none.
 */
export function scopeRowWorthShowing(chips: readonly ScopeChip[]): boolean {
  return chips.length >= 3;
}

/**
 * The scope to actually show, once the results are in.
 *
 * An arrival scope is the app's guess, not the viewer's instruction: pressing
 * SEARCH inside Movies says where they were standing, not what they want. Guess
 * wrong on a television and the screen is empty with a sentence on it — measured
 * by `search-probe`, which arrives `?from=movies`, types "sky news" and lands on
 * `Movies 0` with three live channels one press away it cannot see.
 *
 * So an UNPRESSED scope stands aside when it holds nothing and something else
 * does. A PRESSED one never does — `chosen` is the whole distinction, and it is
 * the same rule `scopeChips` keeps when it shows a lit chip reading zero: a
 * choice somebody made is not overruled behind their back, and a choice nobody
 * made is not defended at their expense.
 */
export function effectiveScope<T extends ScopedHit>(
  hits: readonly T[],
  scope: Scope,
  /** True when `?scope=` was in the address — i.e. somebody pressed a chip. */
  chosen: boolean,
): Scope {
  if (chosen || scope === 'all') return scope;
  if (hits.length === 0) return scope;
  return hitsInScope(hits, scope).length === 0 ? 'all' : scope;
}
