/**
 * Which sections this library actually has — asked once, answered everywhere.
 *
 * The rule the whole app now follows: **never offer a destination that has
 * nothing behind it.** A device holding 1,466 free channels and no films at all
 * was still showing a MOVIES tile reading "0 films", a Series tile reading
 * "0 shows", a catch-up page claiming "the provider publishes 2,062 of them"
 * (a number typed into the copy, true of a subscription nobody on that device
 * has), and a films grid whose empty state blamed the viewer — "loosen a filter,
 * or check the Hidden list" — for a section that was never going to contain
 * anything. Reported, fairly, as "in the movies I see television channels" and
 * "it's so complicated, there's so many buttons everywhere".
 *
 * `Chrome` already filtered its tabs this way. The launcher, the home page and
 * the pages themselves did not, so the same question had three answers depending
 * on which surface you asked. This module is the one answer.
 *
 * It deliberately describes **the catalogue being read**, not the catalogue on
 * the server: `api.inventory` resolves from the device's own store when the app
 * is reading locally, and only falls back to the panel when it is not. A free
 * device asking the server would be told about 63,975 films it cannot open.
 */
import { useQuery } from '@tanstack/react-query';
import { api, type Inventory } from './api.ts';
import { getSession } from './session.ts';
import { localEnabled } from './localCatalogue.ts';

/** Everything the app can navigate to that might turn out to be empty. */
export type SectionId =
  | 'live' | 'movies' | 'series' | 'guide' | 'catchup' | 'home'
  /* `sports` and `discover` are the header's two newest destinations — see
     `tabHasContent` in Chrome.tsx. Both piggyback on rules this file already
     states for `live` and `home`; they are separate ids only because a tab's
     path is not the section it answers for. */
  | 'sports' | 'discover';

/**
 * The last answer, kept across launches.
 *
 * Inventory is a request, so on the very first paint of a cold start there is no
 * answer yet — and the honest default while unknown is "show everything", since
 * flashing a tab away half a second in is worse than briefly showing one that
 * turns out to be empty. That default is wrong exactly once per launch, and it is
 * the launch that decides which page opens. So the previous answer is remembered:
 * a device that had no films a second ago almost certainly still has none.
 */
const REMEMBERED = 'iptv.inventory.v1';

function remember(inv: Inventory): void {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(inv));
  } catch {
    /* private mode: the app works, it just re-learns this each launch */
  }
}

export function lastKnownInventory(): Inventory | null {
  try {
    const raw = localStorage.getItem(REMEMBERED);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<Inventory>;
    const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    return {
      generation: typeof v.generation === 'number' ? v.generation : null,
      live: num(v.live),
      movies: num(v.movies),
      series: num(v.series),
      archive: num(v.archive),
      guide: num(v.guide),
      /* Carried, or a remembered partial library would come back looking
         complete and hide the sections it could not yet count. */
      partial: v.partial === true,
    };
  } catch {
    return null;
  }
}

/**
 * One cached read for the whole shell.
 *
 * `null` means "not answered yet", which every caller must treat as "show it" —
 * see `hasSection`.
 */
export function useInventory(): Inventory | null {
  const { data } = useQuery({
    queryKey: ['inventory'],
    queryFn: async () => {
      const inv = await api.inventory();
      remember(inv);
      return inv;
    },
    staleTime: 30 * 60_000,
    retry: false,
  });
  return data ?? null;
}

/**
 * Does this section have anything behind it?
 *
 * Unknown counts as yes, deliberately — see `useInventory`.
 */
export function hasSection(id: SectionId, inv: Inventory | null): boolean {
  if (inv === null) return true;
  /*
   * A zero you cannot trust is not a zero.
   *
   * `archive` and `guide` are counted by scanning the items a device holds, so on
   * a library whose packages have not been downloaded they are 0 because nothing
   * is here — not because the subscription lacks them. Hiding on that is what
   * took Catch-up and the Guide away from an account with 141,085 items. Live,
   * films and series are safe: their counts come from the catalogue's structure,
   * which arrives whole. See `localInventory`.
   */
  const scanned = inv.partial === true;
  switch (id) {
    case 'live': return inv.live > 0;
    case 'movies': return inv.movies > 0;
    case 'series': return inv.series > 0;
    case 'catchup': return scanned || inv.archive > 0;
    /*
     * The guide needs LISTINGS, not just channels that could carry them.
     *
     * `inv.guide` counts channels with an EPG id, which the free public lists have
     * in quantity — while nothing anywhere holds a programme for them. Listings
     * come from a panel through this box's cache, so a device with no subscription
     * reading its own catalogue has a guide with nothing in it.
     */
    case 'guide': return (scanned || inv.guide > 0) && (getSession() !== null || !localEnabled());
    /*
     * Home is the showcase: rails of artwork over a video library. With no films
     * and no series it has nothing to show and redirects to Live, so offering it
     * is offering a second button for the destination beside it.
     */
    case 'home': return inv.movies > 0 || inv.series > 0;
    /* Same channels a Live TV tab needs — sport is a filter over them, not a
       separate catalogue. See `lib/sports.ts`. */
    case 'sports': return inv.live > 0;
    /* Discover is the showcase at its own address — see `routes/Home.tsx`'s
       `Discover()`. Same content question as `home`, because it renders the
       same component under the same redirect rule. */
    case 'discover': return inv.movies > 0 || inv.series > 0;
  }
}

/**
 * Where the app should open.
 *
 * A library of nothing but channels has exactly one place worth opening, and
 * asked for in those words: "for the free version directly open the live TV area
 * where they can navigate through channels". This is not a free-tier check
 * though — it is the same content question as everything else in this module, so
 * a subscription that happens to sell only live TV lands the same way, and a free
 * device that later downloads films stops landing here without anything being
 * reconfigured.
 *
 * Answered from the REMEMBERED inventory because it has to be answered
 * synchronously, before the first navigation. Landing on the showcase and
 * bouncing to Live a beat later is the flash this avoids.
 */
export function channelsOnly(inv: Inventory | null = lastKnownInventory()): boolean {
  return inv !== null && inv.live > 0 && inv.movies === 0 && inv.series === 0;
}

/**
 * Has the showcase anything to draw yet?
 *
 * A separate question from `hasSection('home')`, and the difference is the whole
 * bug. `hasSection` asks whether the SUBSCRIPTION has films — a question about
 * navigation, answered from the catalogue's structure, true before a single byte
 * is downloaded. This asks whether there is artwork ON THE DEVICE, which on an
 * on-demand library is false until somebody opens a group.
 *
 * Answering the second with the first is what filled the home page with live
 * television: every film rail came back empty, the hero fell through to its
 * channels-only fallback, and a subscription with 66,709 films opened on a
 * carousel of channel logos and a countries strip. Reported as "sections leak to
 * the home page".
 *
 * `undefined` means the catalogue is not the device's own — the server has the
 * whole thing in front of it, so there is nothing to wait for.
 */
export function showcaseReady(inv: Inventory | null): boolean {
  if (inv === null) return true;
  const held = inv.onDevice;
  if (held === undefined) return true;
  return held.movies > 0 || held.series > 0;
}

/**
 * Which of the three catalogues a path is looking at, or null.
 *
 * The search page ranks its blocks by this: press SEARCH on Movies and the film
 * results come first, on Live and the channels do. Every other reading of the
 * request is a guess — nothing in a query string says whether "star" means a
 * channel, a film or a series, and the one honest signal available is the page
 * the viewer was standing on when they reached for search.
 *
 * The satellites travel with their catalogue: the guide and catch-up
 * are views onto live television, and a film's own page is Movies. Null
 * is a real answer — from the home page or from settings there is no section to
 * put first, and the default order stands.
 */
export function sectionForPath(pathname: string): 'live' | 'movies' | 'series' | null {
  if (pathname.startsWith('/movies') || pathname.startsWith('/movie/')) return 'movies';
  if (pathname.startsWith('/series')) return 'series';
  if (/^\/(live|guide|catchup|favourites)\b/.test(pathname)) return 'live';
  return null;
}

/**
 * The address of the search page, carrying where it was opened from.
 *
 * In the URL rather than in router state or a module variable, for the same
 * reason the filters are: state that only exists in memory is state a reload, a
 * bookmark or a shared link silently loses, and this one changes what the page
 * shows. `/search?q=star&from=movies` is a real address.
 */
export function searchHref(pathname: string, q?: string): string {
  const p = new URLSearchParams();
  const trimmed = (q ?? '').trim();
  if (trimmed.length >= 2) p.set('q', trimmed);
  const from = tabForPath(pathname) ?? sectionForPath(pathname);
  if (from !== null) p.set('from', from);
  const qs = p.toString();
  return qs === '' ? '/search' : `/search?${qs}`;
}

/**
 * The nav tab a path belongs to, by its bare name, or null.
 *
 * The same `from` value answers two questions, which is why it is a TAB name and
 * not a section: the search page ranks its blocks by
 * `sectionForPath('/' + from)`, and the header keeps that tab lit while you are
 * on `/search`. Without the second one the whole strip goes dim the moment
 * search opens — six destinations, none of them current, which reads as the app
 * having lost its place. You did not leave Movies to search; you searched from
 * inside it.
 *
 * Falling back to the section is what covers the pages that have no tab of their
 * own, such as `/favourites`, which travels as `live` and lights the tab it
 * belongs under.
 */
export function tabForPath(pathname: string): string | null {
  if (pathname.startsWith('/movies') || pathname.startsWith('/movie/')) return 'movies';
  if (pathname.startsWith('/series')) return 'series';
  if (/^\/(live|favourites)\b/.test(pathname)) return 'live';
  if (/^\/(guide|catchup|home)\b/.test(pathname)) return pathname.slice(1).split(/[/?#]/)[0] ?? null;
  return null;
}
