/**
 * What the home page shows, and in what order.
 *
 * Kept free of React and of the network so the composition rules — which titles
 * are featured, how continue-watching is ordered, how wide a rail tile is — are
 * unit-testable. The route does the fetching; this file decides the shape.
 */
import { displayName, groupLabel } from './displayName.ts';
import { linkId, type Category, type Item } from './api.ts';
import type { FormFactor } from './formFactor.ts';
import type { WatchRecord } from './prefs.ts';

/**
 * Which local day it is.
 *
 * The spotlight rotates once a day rather than once per visit, and this is the
 * clock it turns on. `tzOffsetMin` is `Date.prototype.getTimezoneOffset()`:
 * minutes to ADD to local time to get UTC, so it is subtracted here.
 */
export function dayNumber(nowMs: number, tzOffsetMin: number): number {
  return Math.floor((nowMs - tzOffsetMin * 60_000) / 86_400_000);
}

/**
 * A stable window into a pool, advanced once per day.
 *
 * Deliberately not random. Each spotlight slide needs that title's artwork,
 * which comes from a `get_vod_info` call the device caches — so a set that
 * changes on every render would miss that cache every time and put one panel
 * request per slide on every home page load. Panel flood protection firewalls
 * an IP for minutes with no `Retry-After`. A day-stable set warms the cache once
 * and then costs nothing.
 *
 * Wraps rather than clamps, so a pool of 7 with a window of 6 still shows a
 * different lead title tomorrow.
 */
export function rotate<T>(pool: readonly T[], count: number, day: number): T[] {
  if (pool.length === 0 || count <= 0) return [];
  if (pool.length <= count) return [...pool];
  const start = ((day * count) % pool.length + pool.length) % pool.length;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(pool[(start + i) % pool.length]!);
  return out;
}

/** Comparison form of a title: case, punctuation and market prefix all removed. */
export function titleKey(name: string): string {
  return displayName(name, { dropYear: true }).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * One row per title.
 *
 * The catalogue carries the same film once per market — "EN - On My Block" and
 * "NF - On My Block" are two rows for one show — which is invisible in a 200-row
 * grid and glaring in a six-slide hero. First occurrence wins, so the caller's
 * ordering still decides which market is featured.
 */
export function dedupeTitles<T extends { name: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = titleKey(r.name);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export interface Slide {
  item: Item;
  /**
   * Live is here for the catalogue that has no films at all.
   *
   * A device with only a channel playlist holds channels and almost nothing else, and
   * the ones it does hold carry no rating — so the hero, which asks for films and
   * series above a rating floor, came back empty and the home page opened with a
   * blank space where its best-looking element goes. A channel with artwork is a
   * perfectly good thing to feature; it is what that device actually has.
   */
  section: 'movies' | 'series' | 'live';
}

/**
 * The featured set: films and series interleaved, deduped, rotated by day.
 *
 * Interleaved rather than concatenated because a hero that shows four films
 * before its first series reads as a films-only carousel to anyone who does not
 * sit through it.
 */
export function spotlight(
  movies: readonly Item[],
  series: readonly Item[],
  opts: { count: number; day: number; live?: readonly Item[] },
): Slide[] {
  // Artwork is the whole point of a hero, so a title with none cannot be in it.
  const art = (rows: readonly Item[]) =>
    dedupeTitles(rows.filter((i) => i.logo !== null && i.logo !== ''));
  const m = art(movies);
  const s = art(series);
  const pool: Slide[] = [];
  for (let i = 0; i < Math.max(m.length, s.length); i++) {
    const mi = m[i];
    const si = s[i];
    if (mi) pool.push({ item: mi, section: 'movies' });
    if (si) pool.push({ item: si, section: 'series' });
  }
  /* Only as a fallback, and never mixed in: a catalogue with films leads with
     them, and one without leads with what it has rather than with nothing. */
  if (pool.length === 0) {
    for (const item of art(opts.live ?? [])) pool.push({ item, section: 'live' });
  }
  return rotate(pool, opts.count, opts.day);
}

export interface ContinueRow {
  item: Item;
  section: 'movies' | 'series';
  rec: WatchRecord;
  to: string;
}

/**
 * Continue-watching, most recent first.
 *
 * Two things it has to get right. Records key on the PROVIDER id because row ids
 * are renumbered by every re-ingest, so the lookup is by `streamId` and not by
 * `id`. And the API returns the rows it was asked for in ITS order (sort_index),
 * not in the order they were requested — so the result has to be re-sorted by
 * `updatedAt` here, or "continue watching" lists the oldest thing first.
 *
 * `resumable` is injected rather than imported: the rule lives in `watch.ts`,
 * which pulls in the player engine, and this module stays importable under plain
 * Node so it can be tested.
 */
export function continueRows(
  history: readonly WatchRecord[],
  found: { movies: readonly Item[]; series: readonly Item[] },
  resumable: (rec: WatchRecord) => boolean,
  limit = 20,
): ContinueRow[] {
  const index = {
    movies: new Map(found.movies.map((i) => [i.streamId, i] as const)),
    series: new Map(found.series.map((i) => [i.streamId, i] as const)),
  };
  /*
    One row per TITLE, at the newest place in it.

    History is keyed per EPISODE now — it had to be, or starting episode 2 wiped
    episode 1's position and a series could only remember one place ("if I go
    next, it's lost"). But this strip answers a different question: "what was I
    watching", which is a list of shows, not of episodes. Without the dedupe a
    season watched over a week puts the same series on the strip five times, five
    rows deep, every one of them linking to the same place.

    Sorted newest-first BEFORE the dedupe, so the entry that survives is the
    episode the viewer actually stopped on — which is the one resuming should take
    them to. Films are unaffected: they have one record each either way.
  */
  const seen = new Set<string>();
  return [...history]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(resumable)
    .flatMap((rec) => {
      const key = `${rec.section}:${rec.streamId}`;
      if (seen.has(key)) return [];
      const item = index[rec.section].get(rec.streamId);
      if (!item) return [];
      seen.add(key);
      return [{
        item,
        section: rec.section,
        rec,
        to: `${rec.section === 'series' ? '/series' : '/movie'}/${linkId(item)}`,
      }];
    })
    .slice(0, limit);
}

/** Provider ids to resolve for a section, deduped and bounded. */
export function idsFor(
  history: readonly WatchRecord[],
  section: 'movies' | 'series',
  limit = 40,
): number[] {
  const ids = [...history]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((r) => r.section === section)
    .map((r) => r.streamId);
  return [...new Set(ids)].slice(0, limit);
}

/**
 * Rail tile width, in rem — fallback before the strip has been measured.
 *
 * The live size is `(scroller width − gaps) / visible count` in `Rail.tsx`, so
 * about five posters fill the row on desktop/TV (three on a phone). These rem
 * values only seed the first paint and feed rails that are not yet measured.
 */
export function tileRem(ff: FormFactor): number {
  switch (ff) {
    case 'phone': return 9;
    case 'tablet': return 11;
    case 'tv': return 16;
    default: return 13.5;
  }
}

/**
 * The tallest a poster rail may be, in pixels — the TV cap.
 *
 * Width alone decided tile size, and on a television that is half a decision.
 * The boxes report 960x540 CSS pixels, so a rail measured to fit five posters
 * across gives a 174x261 poster and a band 300px tall on a canvas 487px tall:
 * one rail, and the page under it is gone. `RelatedRail` was worse — it never
 * measured at all, took the 16rem fallback, and painted 256px tiles four across
 * ("grid items in some areas are not consistant or too big", with a photograph
 * of exactly four).
 *
 * So a rail on a television is also capped by the SCREEN: 38% of the viewport
 * height for the artwork, which at 540 is a 205px poster 137px wide — six
 * across with the label under it, and the rail below still on screen. The share
 * is what makes it consistent rather than the pixel count: at 1080 CSS px it
 * resolves to 273px tiles, the same picture from the same distance.
 *
 * `Infinity` off television, where the width measurement was never wrong.
 */
export function tileCapPx(ff: FormFactor, viewportH: number): number {
  if (ff !== 'tv') return Infinity;
  return Math.max(96, Math.floor((viewportH * 0.38) / 1.5));
}

/** How many posters should fill one viewport of a rail. */
export function railVisibleCount(ff: FormFactor): number {
  switch (ff) {
    case 'phone': return 3;
    case 'tablet': return 4;
    default: return 5;
  }
}

/* ── the endless part of the page ─────────────────────────────────────────── */

/** One rail, described rather than rendered. */
export interface RailDef {
  key: string;
  title: string;
  section: 'movies' | 'series';
  /** Where "see all" goes. */
  to: string;
  /** The item query this rail fetches. */
  params: { categoryId: number; sort: 'added'; dir: 'desc' };
  note: string;
}

/**
 * A rail per package, films and series interleaved.
 *
 * The more you scroll the more you see, so the page does not end after the
 * curated rails. Everything after them is the provider's own packages,
 * biggest first: measured on this line, 119 for films and 95 for series, each
 * one a shelf of real posters rather than a box with a name in it.
 *
 * Three decisions, and each of them was a bug first:
 *
 *   **Packages, not genres.** The honest axis: a genre on a catalogue is a
 *   label the panel guesses at, while a package is what the provider sells and what somebody
 *   recognises by name — "4K MOVIES", "NETFLIX", "KIDS".
 *
 *   **Empty packages are dropped.** A rail with a title and nothing under it is
 *   the one state a lazily-mounted rail cannot recover from: it has already
 *   reserved its height by the time it knows.
 *
 *   **Interleaved, not concatenated.** 119 film packages followed by 95 series
 *   ones is a page that changes subject once, halfway down, and nobody scrolls
 *   that far to discover it.
 *
 * Hidden packages never arrive here: the caller reads categories through the
 * same scope every other list uses, so hiding one in Organise removes its rail.
 */
export function collectionRails(
  movies: readonly Category[],
  series: readonly Category[],
): RailDef[] {
  const one = (c: Category, section: 'movies' | 'series'): RailDef => ({
    key: `${section}:${c.ref}`,
    /*
     * `groupLabel`, not `displayName`: a package is not a title.
     *
     * `cleanName` is the ingest-time answer and it is one rule short — 26 of the
     * 257 VOD categories in `fixtures/catalogue.json` still carry a transcode
     * through it ("4K MOVIES", "NETFLIX SERIES 4K", "4K/UHD SERIES"), which is a
     * rail HEADING reading "4K MOVIES" over a shelf of posters. Its own note says
     * why the fix has to be here: a stored value changes only after the next full
     * re-ingest, and this has to be right on the copy already on the device.
     */
    title: groupLabel(c.cleanName !== '' ? c.cleanName : c.name),
    section,
    /*
     * `category`, not `cat` — and the fix belongs at this end.
     *
     * "See all" on a package rail landed on the WHOLE of Movies or Series. The
     * grid reads its state through `filtersFromParams`, which has never known the
     * word `cat`: it takes `category` for one package and `cats` for several.
     * A link naming a parameter nobody parses is not a filtered link, it is an
     * unfiltered one with decoration on it, and it fails in the quietest possible
     * way — the right page, the right heading, and 63,975 films where the
     * viewer asked for NETFLIX.
     *
     * Teaching the bar a third spelling would have worked and would have been
     * the wrong repair. `paramsFromFilters` WRITES `category`, so the bar reads
     * exactly what it writes and the address stays canonical — one filter, one
     * name, and a URL you can compare with another URL. Two aliases already
     * exist for the two genuinely different shapes (one package, many); a third
     * that only ever appears in links this function builds would mean the app
     * had two vocabularies for the same idea, and the next person to add a rail
     * would have to guess which dialect their surface spoke. Every other rail in
     * the app was already saying `category` — `ForYouRails` and `RelatedRail`
     * both do. This was the one outlier, so this is the end that was wrong.
     *
     * `home.test.ts` now reads the parser's own source and refuses any parameter
     * it does not handle, so the two ends cannot drift apart again in silence.
     */
    to: `/${section}?category=${c.id}`,
    params: { categoryId: c.id, sort: 'added', dir: 'desc' },
    note: `${c.count.toLocaleString()} ${section === 'movies' ? 'films' : 'series'}`,
  });
  const films = movies.filter((c) => c.count > 0).map((c) => one(c, 'movies'));
  const shows = series.filter((c) => c.count > 0).map((c) => one(c, 'series'));
  const out: RailDef[] = [];
  for (let i = 0; i < Math.max(films.length, shows.length); i += 1) {
    if (films[i] !== undefined) out.push(films[i]!);
    if (shows[i] !== undefined) out.push(shows[i]!);
  }
  return out;
}

/* ── returning to a package rail deep enough that it needed scrolling ──────
 *
 * `Showcase` mounts package rails five at a time (`shown` in routes/Home.tsx)
 * and even a mounted one waits for `Lazy` to paint it — see the note on
 * `LAST_RAIL_KEY` in components/Rail.tsx. A rail past `shown` has no
 * placeholder in the DOM at all, so a "See all" opened from deep in the list
 * left nothing for `data-nav-first` to land on and BACK opened at the top of
 * Home instead of the row it came from.
 */

/**
 * How many package rails Home must render so a remembered "See all" target
 * has at least a placeholder in the DOM, and which one it is.
 *
 * The index comes off `rails` — the same array `Showcase` maps over — rather
 * than off the page, so raising `shown` is a plain data lookup with no DOM
 * and no loop over rendered rows. `null` covers everything that is not this
 * function's problem, and each is a `rememberedTo` this function simply never
 * matches: nothing remembered, a fixed rail above the endless list (its `to`
 * is never in `rails`), and a package the catalogue no longer has.
 */
export function railRevealPlan(
  rails: readonly { to: string }[],
  rememberedTo: string | null,
  shown: number,
): { index: number; shown: number } | null {
  if (rememberedTo === null) return null;
  const index = rails.findIndex((r) => r.to === rememberedTo);
  if (index === -1) return null;
  return { index, shown: Math.max(shown, index + 1) };
}

/* ── the category page a rail's "See all" opens ──────────────────────────── */

/**
 * The category page's own heading — raw, the way the sidebar's list rows
 * already show it.
 *
 * Not `groupLabel`, which is what THIS file's own `collectionRails` puts on the
 * rail above ("4K MOVIES" caught by its transcode rule). That cleaning is right
 * for a shelf heading; it is wrong here, because the list-mode sidebar
 * (`lib/liveRows.ts`'s `listRows`) hands every row `c.name` untouched — "no need
 * to filter the names at all" — and a category page reached by pressing one of
 * those rows has to say what the row said, or the same package reads as two
 * different things ten pixels apart.
 *
 * `null` when nothing actually narrows the view to one thing: an unfiltered
 * browse has no single name to put in a heading, so both of this function's
 * callers (the films strip, the series page's own row) take `null` as "draw
 * nothing here".
 */
export function categoryHeading(
  categories: readonly { id: number; name: string }[],
  filters: { categoryId: number | null; path: string | null; paths: readonly string[] },
): string | null {
  if (filters.categoryId !== null) {
    return categories.find((c) => c.id === filters.categoryId)?.name ?? null;
  }
  /* A group-tree pick carries no single provider string — a path is built from
     one ("UK| SKY SPORT+ VIP" becomes "UK/SKY/SPORT+ VIP") but is not one — so
     this reads the leaf the sidebar drilled into and titles it the way
     `FilterBar`'s own `scopeLabel` already does for the same shape of value. */
  const p = filters.path ?? filters.paths[0] ?? null;
  if (p === null) return null;
  /* Indexed, not `.at(-1)`. `Array.prototype.at` is Chrome 92 and this app runs
     in whatever WebView the television shipped with — Fire OS boxes sit around
     83. It is not a polyfillable nicety at the call site: the method is simply
     missing, so the line throws and takes the Home screen with it, which is the
     FIRST screen. `lib/nativePlayer` and `CaptionOverlay` both carry the same
     note; this one slipped past because `scripts/bundle-floor.mjs` was reading
     the top of `dist` and never the `assets/` directory the app lives in. */
  const parts = p.split('/');
  const leaf = parts[parts.length - 1] ?? p;
  return leaf
    .split(/[\s_+-]+/)
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
