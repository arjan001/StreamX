/**
 * The read model, over columns.
 *
 * This is the same contract `services/api/src/catalogue.ts` implements against
 * Postgres, and that is the whole point: one read model, two implementations, so
 * the app does not care whether the catalogue is on a server or on the device.
 * The conformance suite exists to keep them from drifting, because two
 * implementations of one contract always drift unless something forbids it.
 *
 * The Postgres-specific mechanisms have direct equivalents, and each one had to
 * be chosen rather than translated:
 *
 * - **Path prefix matching.** SQL uses array-slice equality on `path text[]`, so
 *   "EN" matches "EN/NETFLIX" and never "ENGLISH". Here paths compare
 *   SEGMENT-WISE for the same reason: a string `startsWith` would make "EN" match
 *   "ENGLISH", quietly widening every country filter.
 * - **Trigram search.** SQL uses a `pg_trgm` GIN index on `compact_name`; here it
 *   is `indexOf` over one big lowercase blob, measured at 2.1ms across 124,157
 *   rows — fast enough that no index is worth its build time or its bytes.
 * - **`DISTINCT ON` family collapse.** SQL collapses FHD/HD/HEVC variants of one
 *   channel with `DISTINCT ON (normalised name)`; here it is a grouped pass.
 *
 * Counts are recomputed from rows on every call, exactly as the SQL does, so a
 * facet chip and the page it produces can never disagree. Measured: a full
 * filter-and-sort pass over 82,666 live rows is 23ms, which is affordable, and
 * the divergence that precomputation invites is not.
 */
import { labelFor, normName, REFINING, type Genre } from '@iptv/core-xtream';
import { adultCategoryIds, rowIsAdult } from './adult.ts';
import { FLAG, readText, viewItem, type Catalogue, type CategoryRow, type ItemView } from './columns.ts';

export const KIND = { Live: 1, Movie: 2, Series: 3 } as const;

export interface Query {
  kind: number;
  offset?: number;
  limit?: number;
  categoryId?: number | null;
  /** Every selected genre must match (AND), same as the film/series grids. */
  genres?: readonly string[];
  region?: string | null;
  source?: string | null;
  /** Group-path prefixes, any-of. A market is a depth-1 path. */
  paths?: readonly string[];
  cats?: readonly number[];
  hidePaths?: readonly string[];
  hideCats?: readonly number[];
  /**
   * Keep packages that have no items on this device.
   *
   * For a COMPLETE catalogue an empty package is noise and is dropped — that is
   * the default and what the server does. For an on-demand one it means "not
   * downloaded yet", and dropping it hides the very thing somebody has to press
   * to download it. See `libraryMode` in the app's localCatalogue.
   */
  includeEmpty?: boolean;
  archiveOnly?: boolean;
  q?: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  minRating?: number | null;
  /** Only titles the panel added at or after this instant (unix seconds). */
  addedSince?: number | null;
  streamIds?: readonly number[];
  /** Provider ids to leave out — the per-channel hidden list. */
  hideStreams?: readonly number[];
  /**
   * Provider ids to leave out that are NOT the viewer's choice — a Set, because
   * it can be thousands long (every sport channel, left out of Live TV so it is
   * not listed twice) and is built once per catalogue, not once per query.
   */
  excludeStreams?: ReadonlySet<number>;
  sort?: 'default' | 'name' | 'year' | 'rating' | 'added' | 'epg';
  dir?: 'asc' | 'desc';
  /**
   * One row per title — films and series only.
   *
   * A provider files one film once per country package: "ES - 4 Blocks Zero",
   * "NL - 4 Blocks Zero (2026)". In a list that is ABOUT titles — Top rated,
   * Trending — that reads as the same poster twice, three, four times in a row
   * ("Youth" four times on one screen of Trending), and the screen looks
   * disorganised rather than generous. Folded after sorting, so the copy kept
   * is the first in the chosen order: the best-rated under a rating sort. See
   * `titleCopyKey` for what "the same title" means.
   */
  oneCopy?: boolean;
  /**
   * Stop excluding adult rows. Used when the caller is the /adult section.
   * When `adultOnly` is true, only adult rows are returned. When `includeAdult`
   * is true (without `adultOnly`), adult rows are included alongside normal ones.
   */
  includeAdult?: boolean;
  /** Show ONLY adult-flagged items. Implies `includeAdult`. */
  adultOnly?: boolean;
}

export interface Page<T> {
  rows: T[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Segment-wise prefix test.
 *
 * "EN" is a prefix of "EN/NETFLIX" and is NOT a prefix of "ENGLISH". Getting
 * this wrong is invisible in testing with tidy data and catastrophic with real
 * market codes, where "EN", "ENG" and "ENGLISH" can all exist.
 */
export function pathHasPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
  return true;
}

export function splitPath(id: string): string[] {
  return id.split('/').map((s) => s.trim()).filter((s) => s !== '');
}

export interface CategoryScope {
  /**
   * Categories a row MUST be in, or null when nothing includes.
   *
   * A row with no category fails an include and survives an exclude. That
   * asymmetry is not an accident, it mirrors the SQL exactly: includes are
   * `category_id IN (…)`, which NULL never satisfies, and excludes are
   * `NOT EXISTS (…)`, which NULL always satisfies. Getting it backwards silently
   * drops every uncategorised row from the whole app — 194 films here, which is
   * small enough to look like a rounding error and large enough to be wrong.
   */
  include: Set<number> | null;
  /** Categories a row must NOT be in. */
  exclude: Set<number>;
}

/**
 * Whether a category's derived genres satisfy a chip selection.
 *
 * One rule: EVERY chip must match. Crime+Thriller+4K reads crime AND thriller
 * AND 4K, and there is no second kind of chip with a second kind of behaviour.
 *
 * ── why this used to be two rules, and why the premise was wrong ──
 *
 * Story genres were any-of on the reasoning that "a film sits in one category,
 * that category's name derives one story genre, so ANDing two of them asks for
 * something no row can be and empties the grid". That is a statement about the
 * catalogue, and it is false for this one. `deriveFacets` collects EVERY rule
 * that matches a category's name, and this provider names categories in
 * compounds — measured on the live catalogue, 26 of 365 movie categories carry
 * two or more story genres, covering 11,946 titles:
 *
 *     horror + thriller   2,424    |EN| HORROR/THRILLER
 *     comedy + drama      2,117    |EN| DRAMA/COMEDY
 *     drama + romance     1,496    |EN| DRAMA/ROMANCE
 *     action + thriller   1,358    |EN| ACTION/THRILLER
 *     crime + thriller      937    |FR| THRILLER/CRIME
 *     crime + drama         470    |EN| DRAMA/CRIME
 *
 * So ANDing two story genres asks a real question with a real answer, and
 * any-of was answering a different one. Measured on the same catalogue before
 * this change: Thriller alone put 4,761 titles in the grid, and adding Horror
 * took it to 5,093 — the union. Reported twice, the second time with the
 * receipt: "it doesn't filter, the shown movies don't have both family and
 * crime, but I see them both". A filter that returns MORE than you had is not a
 * filter, and no amount of labelling makes it read as one.
 *
 * ── and when the answer is nothing, nothing is the answer ──
 *
 * Kids & Family AND Crime is 0 titles in this catalogue, and an empty grid is
 * the honest reply — those two words describe no film here. That is only
 * defensible because the chip says 0 BEFORE it is pressed: `listFacets` counts
 * every chip against the full current selection, so a combination that leads
 * nowhere is visible as a dead chip rather than discovered as an empty screen.
 */
export function categoryMatchesGenres(
  have: readonly string[],
  want: ReadonlySet<string>,
): boolean {
  for (const g of want) if (!have.includes(g)) return false;
  return true;
}

/** Split the scope into what it includes and what it removes. */
export function categoryScope(cat: Catalogue, q: Query): CategoryScope {
  const paths = (q.paths ?? []).map(splitPath).filter((p) => p.length > 0);
  const hidePaths = (q.hidePaths ?? []).map(splitPath).filter((p) => p.length > 0);
  const cats = q.cats && q.cats.length > 0 ? new Set(q.cats) : null;
  const hideCats = q.hideCats && q.hideCats.length > 0 ? new Set(q.hideCats) : null;
  const genres = q.genres && q.genres.length > 0 ? new Set(q.genres) : null;
  const hasInclude = paths.length > 0 || cats !== null || genres !== null
    || (q.region != null && q.region !== '') || (q.source != null && q.source !== '');
  /* Adult categories are always excluded; there is no query that turns this off. */
  const adultIds = adultCategoryIds(cat);

  const include = hasInclude ? new Set<number>() : null;
  const exclude = new Set<number>();

  for (const c of cat.categories) {
    if (c.kind !== q.kind) continue;
    if (hidePaths.some((p) => pathHasPrefix(c.path, p))
      || (hideCats !== null && hideCats.has(c.id))
      || adultIds.has(c.id)) {
      exclude.add(c.id);
      continue;
    }
    if (include === null) continue;
    if (cats !== null && !cats.has(c.id)) continue;
    if (paths.length > 0 && !paths.some((p) => pathHasPrefix(c.path, p))) continue;
    /* Every chip has to match, refinements included — see `categoryMatchesGenres`. */
    if (genres !== null && !categoryMatchesGenres(c.genres, genres)) continue;
    if (q.region != null && q.region !== '' && c.region !== q.region) continue;
    if (q.source != null && q.source !== '' && c.source !== q.source) continue;
    include.add(c.id);
  }
  return { include, exclude };
}

/**
 * The include side, with the excludes already removed.
 *
 * A convenience over `categoryScope` for callers that only need "which categories
 * may I show" — note it collapses the include/exclude asymmetry, so it is NOT
 * what `matchRows` uses: a row with no category has to survive an exclude, and
 * that distinction is lost once the two sets are merged.
 */
export function allowedCategories(cat: Catalogue, q: Query): Set<number> | null {
  const scope = categoryScope(cat, q);
  if (scope.include === null) return null;
  return new Set([...scope.include].filter((id) => !scope.exclude.has(id)));
}

/** Punctuation-free, lowercase — the same shape the compact column holds. */
export function compactQuery(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Compare two sort keys the way Postgres compares two strings.
 *
 * Byte-ish order, not locale order: once punctuation is gone the remaining
 * question is only which code point comes first, and `<` answers it identically
 * in both languages. `localeCompare` does NOT — it applies script and case
 * weighting that no SQL comparison here matches.
 */
export function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The key an alphabetical list actually sorts on.
 *
 * Postgres and `localeCompare` disagree about punctuation — glibc's en_US
 * collation ignores it at the first pass, JavaScript does not — so "104.9 STYL
 * FM" and "- NO EVENT STREAMING -" came out in a different order on the server
 * and on the device. Rather than trying to imitate one collation in the other
 * language, both sides sort on THIS: letters and digits, uppercased. It is
 * deterministic, it is identical in SQL and in JS, and it happens to be what
 * people expect — a channel whose name starts with a dash sorts under its first
 * letter rather than above everything.
 */
export function sortKey(name: string): string {
  /*
   * Letters and numbers in ANY script, not just Latin.
   *
   * `[^A-Z0-9]` reduced every Arabic title to an empty string, so a thousand
   * channels tied and came out in whatever order the tie-break happened to give
   * — which is how an alphabetical list of Arabic channels ended up unsorted on
   * one side and differently unsorted on the other. `\p{L}\p{N}` is the same set
   * Postgres's `[[:alnum:]]` matches under a UTF-8 locale.
   */
  return name.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Every row a query matches, as indices.
 *
 * One pass over the columns, no allocation per row. The order is the row order,
 * which is the provider's own; sorting happens after, on the matched subset,
 * because sorting 124,157 rows to return 60 of them is the mistake this layout
 * exists to avoid.
 */
export function matchRows(cat: Catalogue, q: Query): number[] {
  const cols = cat.items;
  const { include, exclude } = categoryScope(cat, q);
  const hideStreams = q.hideStreams === undefined || q.hideStreams.length === 0
    ? null
    : new Set(q.hideStreams);
  const streamIds = q.streamIds === undefined
    ? null
    : new Set(q.streamIds);
  const needle = q.q !== undefined && compactQuery(q.q).length >= 2 ? compactQuery(q.q) : null;
  const minRating = q.minRating == null ? null : Math.round(q.minRating * 100);
  const out: number[] = [];

  for (let i = 0; i < cols.count; i++) {
    if (cols.kind[i] !== q.kind) continue;
    if (q.categoryId != null && cols.categoryId[i] !== q.categoryId) continue;
    const cid = cols.categoryId[i] ?? 0;
    // Include: a row with no category cannot satisfy `IN (…)`.
    if (include !== null && (cid === 0 || !include.has(cid))) continue;
    // Exclude: a row with no category satisfies `NOT EXISTS (…)` and survives.
    if (cid !== 0 && exclude.has(cid)) continue;
    if (hideStreams !== null && hideStreams.has(cols.streamId[i] ?? 0)) continue;
    if (q.excludeStreams !== undefined && q.excludeStreams.has(cols.streamId[i] ?? 0)) continue;
    if (streamIds !== null) {
      // An empty list means nothing, not everything — the favourites case.
      if (streamIds.size === 0) return [];
      if (!streamIds.has(cols.streamId[i] ?? 0)) continue;
    }
    if (q.archiveOnly === true && ((cols.flags[i] ?? 0) & FLAG.archive) === 0) continue;
    const isAdult = ((cols.flags[i] ?? 0) & FLAG.adult) !== 0;
    if (q.adultOnly === true && !isAdult) continue;
    if (!q.includeAdult && isAdult) continue;
    const year = cols.year[i] ?? 0;
    if (q.yearFrom != null && (year === 0 || year < q.yearFrom)) continue;
    if (q.yearTo != null && (year === 0 || year > q.yearTo)) continue;
    if (minRating !== null && (cols.rating[i] ?? 0) < minRating) continue;
    if (q.addedSince != null && (cols.added[i] ?? 0) < q.addedSince) continue;
    if (needle !== null && !readText(cols.compact, i).includes(needle)) continue;
    out.push(i);
  }
  return q.kind === KIND.Live ? collapseFamilies(cat, out) : out;
}

/* ── the live family collapse ──────────────────────────────────────────────── */

/** Market prefix, as the server's regex reads it: 2-6 alphanumerics before a pipe. */
const MARKET_RE = /^\s*([A-Za-z0-9-]{2,6})\s*\|/;

/**
 * Which feed of a channel people want, and what to call it.
 *
 * Lowest rank first, because the collapse picks the minimum: 4K, then FHD, then
 * HEVC, then HD, then RAW, then VIP, then SD, then anything unlabelled.
 *
 * The ladder and the label used to be two functions in two packages — the rank
 * here for the collapse, and `qualityOf` in `services/api/src/variants.ts` for
 * the label on the quality switch — held in step by a comment saying they must
 * agree. That comment was doing a type's job, and the SQL twin that could have
 * caught a disagreement is gone. One function now, and `qualityRank` is defined
 * in terms of it so they cannot part company.
 */
const RANK: [RegExp, string, number][] = [
  [/\b(4k|uhd|2160p?)\b/i, '4K', 0],
  [/\b(fhd|1080p?)\b/i, 'FHD', 1],
  [/hevc|h\.?265/i, 'HEVC', 2],
  [/\b(hd|720p?)\b/i, 'HD', 3],
  [/\u1D34\u1D30/, 'HD', 3],
  [/\b(sd|480p?|360p?)\b/i, 'SD', 6],
];
const RAW_RE = /\u1D3F\u1D2C\u1D42|\braw\b/i;
const VIP_RE = /\u2C7D\u1D35\u1D3E|\bvip\b/i;

export function qualityOf(name: string): { label: string; rank: number } {
  for (const [re, label, rank] of RANK) {
    if (re.test(name)) {
      /* RAW is an unremuxed feed: the same picture with fewer provider-side
         problems, so it qualifies a quality rather than being one. */
      return { label: RAW_RE.test(name) ? `${label} RAW` : label, rank };
    }
  }
  if (RAW_RE.test(name)) return { label: 'RAW', rank: 4 };
  if (VIP_RE.test(name)) return { label: 'VIP', rank: 5 };
  return { label: 'SOURCE', rank: 7 };
}

export function qualityRank(name: string): number {
  return qualityOf(name).rank;
}

/** The market prefix a family key is built from, or '' when there is none. */
export function marketOf(name: string): string {
  return MARKET_RE.exec(name)?.[1]?.toUpperCase() ?? '';
}

/**
 * The key that makes FHD, HD and HEVC feeds of one channel one row.
 *
 * Market prefix plus normalised name, and a row with neither gets a key of its
 * own so it is never merged with anything. Identical to `LIVE_FAMILY_SQL`, which
 * is why the two implementations agree on 49,343 channels out of 54,928 rows —
 * the difference being 5,585 alternative feeds that belong behind a quality
 * switch rather than in a channel list.
 */
export function familyKey(cat: Catalogue, row: number): string {
  const name = readText(cat.items.names, row);
  const norm = readText(cat.items.norm, row);
  const market = MARKET_RE.exec(name)?.[1];
  if (norm === '' || market === undefined) return `id:${row}`;
  return `${market.toUpperCase()}\n${norm}`;
}

/**
 * One row per channel family, the best feed winning.
 *
 * Ties break on row order, which is the provider's own — the same `item.id`
 * tie-break the SQL uses, and the reason two runs pick the same feed.
 */
export function collapseFamilies(cat: Catalogue, rows: readonly number[]): number[] {
  const best = new Map<string, number>();
  for (const row of rows) {
    const key = familyKey(cat, row);
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, row);
      continue;
    }
    const a = qualityRank(readText(cat.items.names, row));
    const b = qualityRank(readText(cat.items.names, held));
    if (a < b || (a === b && row < held)) best.set(key, row);
  }
  // Row order out, so the default ordering is still the provider's.
  return [...best.values()].sort((a, b) => a - b);
}

/**
 * Order a matched set.
 *
 * The comparators mirror the SQL's `ORDER BY` clauses exactly, including where
 * NULLs go: `year DESC NULLS LAST` and `rating DESC NULLS LAST` mean a row with
 * no year must not lead a descending list, which is what a naive numeric sort
 * would do with a 0 sentinel.
 */
export function sortRows(cat: Catalogue, rows: number[], q: Query): number[] {
  const cols = cat.items;
  /*
   * An absent sort IS the default sort.
   *
   * Reading `q.sort` directly made `undefined` fall through to the descending
   * branch, so a plain unsorted request came back in reverse provider order —
   * which put the last channel of the catalogue at the top of the list and was
   * invisible until the conformance check compared the first row with the
   * server's.
   */
  const sort = q.sort ?? 'default';
  /* `epg` is a positional order like `default`, not a magnitude like rating, so
     its natural direction is ascending. */
  const dir = q.dir ?? (sort === 'name' || sort === 'default' || sort === 'epg' ? 'asc' : 'desc');
  const sign = dir === 'asc' ? 1 : -1;
  /*
   * The sort key, computed once per ROW rather than twice per COMPARISON.
   *
   * `sortKey` is an uppercase plus a unicode-property regex replace — two
   * allocations per call — and calling it from inside the comparator calls it
   * 2·N·log2(N) times: 1.2 million times for a 40,000-row list. Measured on
   * this device's own catalogue, walking /series with the wheel for 9.3s,
   * `sortKey` was 54.2% of the whole scroll (5,017ms of 9,263ms) and the top
   * entry in the profile by a factor of ten. Memoised it is called at most N
   * times, and every comparison after the first is a Map hit — ~40ns against
   * the ~1.5µs the call costs.
   *
   * Lazy rather than precomputed for the whole set: `default` and `epg` only
   * reach for a name on a tie, so a live list of 11,000 channels sorted by
   * provider order should pay for the handful it actually compares.
   */
  const keys = new Map<number, string>();
  const name = (i: number) => {
    const held = keys.get(i);
    if (held !== undefined) return held;
    const k = sortKey(readText(cols.names, i));
    keys.set(i, k);
    return k;
  };

  /*
   * The last word in every comparison.
   *
   * Two titles differing only in punctuation produce the same sort key — "A
   * Storybook Ending  (2020)" and "A Storybook Ending (2020)" — and without a
   * final tie-break their order is whatever the sort algorithm happens to do.
   * Row order is the provider's order, and it is the same tie-break the SQL uses.
   */
  const tie = (a: number, b: number) => a - b;

  const cmp: (a: number, b: number) => number = (() => {
    switch (sort) {
      case 'name':
        return (a, b) => sign * cmpKey(name(a), name(b)) || tie(a, b);
      case 'year':
        return (a, b) => {
          const ya = cols.year[a] ?? 0;
          const yb = cols.year[b] ?? 0;
          if (ya === 0 || yb === 0) {
            return ya === yb ? cmpKey(name(a), name(b)) || tie(a, b) : ya === 0 ? 1 : -1;
          }
          return ya === yb ? cmpKey(name(a), name(b)) || tie(a, b) : sign * (ya - yb);
        };
      case 'rating':
        return (a, b) => {
          const ra = cols.rating[a] ?? 0;
          const rb = cols.rating[b] ?? 0;
          if (ra === 0 || rb === 0) {
            return ra === rb ? cmpKey(name(a), name(b)) || tie(a, b) : ra === 0 ? 1 : -1;
          }
          /* Equal ratings, newest first: a screen of 10.0s in alphabetical order
             reads as a jumble; the newest of them is what somebody looks for. */
          return ra === rb
            ? ((cols.year[b] ?? 0) - (cols.year[a] ?? 0)) || cmpKey(name(a), name(b)) || tie(a, b)
            : sign * (ra - rb);
        };
      case 'added':
        return (a, b) => {
          const aa = cols.added[a] ?? 0;
          const ab = cols.added[b] ?? 0;
          if (aa === 0 || ab === 0) {
            return aa === ab ? cmpKey(name(a), name(b)) || tie(a, b) : aa === 0 ? 1 : -1;
          }
          return aa === ab ? cmpKey(name(a), name(b)) || tie(a, b) : sign * (aa - ab);
        };
      case 'epg':
        // Channels likely to HAVE a schedule first, then provider order — the
        // same rule the SQL uses, and for the same reason.
        return (a, b) => {
          const ta = cols.tvgIds[a] === undefined ? 1 : 0;
          const tb = cols.tvgIds[b] === undefined ? 1 : 0;
          if (ta !== tb) return ta - tb;
          return sign * ((cols.sortIndex[a] ?? 0) - (cols.sortIndex[b] ?? 0))
            || cmpKey(name(a), name(b)) || tie(a, b);
        };
      default:
        /*
         * Every section is in the provider's own order, series included.
         *
         * This branch used to send `KIND.Series` down an alphabetical path, and
         * the reason was server parity: the `series` table had no `sort_index`
         * column, so the SQL's default ordering for that section was by name, and
         * a client that ordered by insertion order agreed with it only by
         * accident. That reason is gone — there is no server catalogue any more
         * (see `scripts/conformance.mts`), and the device builds its own from the
         * panel's reply.
         *
         * So the exception had stopped protecting anything and had started
         * costing something. Reported: "they all come in the selected order from
         * the provider itself, I mean from the panel." A panel operator arranges
         * a section deliberately — new arrivals first, the box sets and the
         * seasonal rows where they want them — and Films and Live TV honoured
         * that while Series silently re-alphabetised it. `build.ts` has always
         * stamped series with the panel's position (`sortIndex: i++`), so the
         * order was carried all the way here and then thrown away one line
         * before it was used.
         *
         * A–Z is still one press away in the sort menu, where it is now a choice
         * rather than a default nobody asked for.
         */
        return (a, b) => sign * ((cols.sortIndex[a] ?? 0) - (cols.sortIndex[b] ?? 0)) || tie(a, b);
    }
  })();

  return [...rows].sort(cmp);
}

/* ── the ordered row list, remembered between pages ───────────────────────── */

/**
 * One query's matched-and-ordered rows, kept so the NEXT page is free.
 *
 * A page is one screenful; a scroll is thirty of them, and every one of those
 * was a full scan of 210,000 rows plus a full sort of everything the filter
 * matched, to hand back forty rows. Measured on this device's own catalogue —
 * a 9.3s wheel scroll of /series — matching and ordering was 60% of all script
 * time, and the shape of the cost was the giveaway: it did not grow with how
 * far you scrolled, it was paid again per page, identically, forever.
 *
 * Keyed on the query with `offset` and `limit` removed, which is exactly the
 * set of fields that changes WHICH rows and in WHAT order. Built by walking
 * `Object.keys` rather than naming the fields, deliberately: a hand-written
 * signature that forgets a clause serves one filter's page to another filter's
 * list, and this codebase has already been bitten twice by exactly that (see
 * `usePagedItems`'s key, and `toQuery`'s note on `adultOnly`). A field that
 * exists on the object is in the key; there is no list to fall out of date.
 *
 * A WeakMap on the catalogue is the invalidation. `lib/localCatalogue.ts`
 * REPLACES the catalogue object on every rebuild — a package arriving, a
 * re-ingest, a profile switch — so a new generation cannot see an old
 * generation's row indices, and the old entries are collected with it.
 *
 * Four lists, as `Int32Array`s: 4 bytes a row, so the whole cache for this
 * catalogue's largest section is ~600KB. Holding the SORT KEYS instead would
 * have been ~12MB of strings, which on a 1GB TV box is not a trade worth making.
 */
const ORDERED = new WeakMap<Catalogue, Map<string, Int32Array>>();

/** How many distinct lists are remembered per catalogue. */
const ORDERED_MAX = 4;

function orderKey(q: Query): string {
  const fields = Object.keys(q).filter((k) => k !== 'offset' && k !== 'limit').sort();
  let out = '';
  for (const k of fields) {
    out += `${k}=${JSON.stringify((q as unknown as Record<string, unknown>)[k])}`;
  }
  return out;
}

function orderedRows(cat: Catalogue, q: Query): Int32Array {
  let per = ORDERED.get(cat);
  if (per === undefined) {
    per = new Map();
    ORDERED.set(cat, per);
  }
  const key = orderKey(q);
  const held = per.get(key);
  if (held !== undefined) {
    /* Re-inserting moves the key to the end, so deleting the first key evicts
       the least recently used — the same trick `usePagedItems` uses. */
    per.delete(key);
    per.set(key, held);
    return held;
  }
  const sorted = sortRows(cat, matchRows(cat, q), q);
  const rows = Int32Array.from(q.oneCopy === true && q.kind !== KIND.Live ? oneCopyEach(cat, sorted) : sorted);
  per.set(key, rows);
  while (per.size > ORDERED_MAX) {
    const oldest = per.keys().next().value;
    if (oldest === undefined) break;
    per.delete(oldest);
  }
  return rows;
}

/**
 * The same title, whichever package it is filed in.
 *
 * `norm` already has the market prefix and the quality words off it; a year in
 * the name ("(2026)") is taken off too and compared as the year instead, from
 * the year column when the panel gives one. Two copies with no year anywhere
 * are still the same title; a year on one side only keeps them apart — two
 * films called "Dune" forty years apart are not copies of each other, and
 * showing a copy twice is the lesser mistake.
 */
export function titleCopyKey(cat: Catalogue, row: number): { title: string; year: string } {
  const norm = readText(cat.items.norm, row);
  if (norm === '') return { title: `id:${row}`, year: '' };
  const col = cat.items.year[row] ?? 0;
  /*
   * The year in brackets is where a panel's title ENDS. What follows it is
   * the uploader's: "EN - Mutiny (2026) JASON STATHAM", "EN - Toy Story 5
   * (2026) TOM HANKS" beside "NL - MUTINY (2026)" — measured on the fixture's
   * Trending, where each stayed twice because the actor made it another title.
   */
  const raw = readText(cat.items.names, row);
  const dated = /[([]((?:19|20)\d\d)[)\]]/.exec(raw);
  if (dated !== null) {
    const title = normName(raw.slice(0, dated.index)) || norm;
    return { title, year: col !== 0 ? String(col) : dated[1]! };
  }
  const words = norm.split(' ');
  const title = words.filter((w) => !/^(19|20)\d\d$/.test(w)).join(' ') || norm;
  const named = words.find((w) => /^(19|20)\d\d$/.test(w)) ?? '';
  return { title, year: col !== 0 ? String(col) : named };
}

/**
 * The first row of each title, in the order given.
 *
 * A copy with no year is the same title as one with a year — measured on the
 * fixture's Trending: "Toy Story 5" and "Mutiny" each twice, one copy dated and
 * one not. Only two DIFFERENT known years keep a title apart.
 */
function oneCopyEach(cat: Catalogue, rows: readonly number[]): number[] {
  const years = new Map<string, Set<string>>();
  const out: number[] = [];
  for (const r of rows) {
    const { title, year } = titleCopyKey(cat, r);
    const known = years.get(title);
    if (known === undefined) {
      years.set(title, new Set([year]));
      out.push(r);
      continue;
    }
    if (year === '' || known.has(year)) continue;
    /* The copy already shown had no year: this is that title, now dated. */
    if (known.size === 1 && known.has('')) { known.add(year); continue; }
    known.add(year);
    out.push(r);
  }
  return out;
}

export function listItems(cat: Catalogue, q: Query): Page<ItemView> {
  const ordered = orderedRows(cat, q);
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 200);
  const end = Math.min(ordered.length, offset + limit);
  const rows: ItemView[] = [];
  for (let n = offset; n < end; n++) rows.push(viewItem(cat.items, ordered[n]!));
  return {
    rows,
    total: ordered.length,
    offset,
    limit,
  };
}

/**
 * Where `itemId` sits in the ordered list for `q`, or -1.
 *
 * Row ids ARE the catalogue indices `orderedRows` holds, so this is an indexOf
 * on the same array the pager pages through — O(n) on the filtered list, not a
 * second catalogue scan. Exact id wins; `familyIds` is only for a playing feed
 * that is not itself a list row (variant group).
 */
export function indexOfItem(
  cat: Catalogue,
  q: Query,
  itemId: number,
  familyIds?: ReadonlySet<number>,
): number {
  const ordered = orderedRows(cat, q);
  const exact = ordered.indexOf(itemId);
  if (exact >= 0) return exact;
  if (familyIds === undefined || familyIds.size === 0) return -1;
  for (let i = 0; i < ordered.length; i++) {
    if (familyIds.has(ordered[i]!)) return i;
  }
  return -1;
}

/**
 * Every matching row, as names — no page, no clamp, no `ItemView`.
 *
 * `listItems` caps a page at 200 and that cap is right: it protects the UI from
 * materialising a view object per row for a list nobody can scroll. It is also
 * the wrong tool for a FACET, and using it as one is a specific, quiet failure —
 * asking for 14,839 adult films to count their studios returns 200 of them and
 * produces counts that look plausible and are wrong by two orders of magnitude.
 * "Emily Willis · 2 films" beside a library holding 156 of them is not a smaller
 * truth; the viewer finds out by pressing it.
 *
 * So the bulk read is a separate function rather than a flag on the paged one,
 * and the separation is the safety: `listItems` keeps its cap for every screen
 * that scrolls, and a caller that genuinely wants the whole set has to say so by
 * name. The rows are ordinary `ItemView`s, because the things that need all of
 * them also need to RENDER some of them, and a projection would have meant a
 * second lookup per visible tile.
 *
 * Ordering is match order — the store's own — because a facet count does not
 * depend on it and sorting 47,056 indices to throw the order away is work for
 * nothing. Anything that wants an ordered PAGE still calls `listItems`.
 */
export function listAll(cat: Catalogue, q: Query): ItemView[] {
  const matched = matchRows(cat, q);
  const out: ItemView[] = new Array(matched.length);
  for (let n = 0; n < matched.length; n++) out[n] = viewItem(cat.items, matched[n]!);
  return out;
}

/**
 * Every matching row, in the order the query asks for.
 *
 * `listAll` is match order on purpose, and it takes the same `Query` — so a
 * `sort` or `oneCopy` handed to it is accepted and silently ignored. The adult
 * section did exactly that for its newest-first default: it asked `listAll` for
 * `sort: 'added'` and showed the provider's own order, which put a 1974 film
 * added in 2023 above the films added that week ("I see still the old ones on
 * top"). A caller that needs the whole set IN ORDER says so by name here and
 * gets `listItems`' ordering — the same sort, the same one-copy fold, the same
 * per-query cache — without its page cap.
 */
export function listAllSorted(cat: Catalogue, q: Query): ItemView[] {
  const rows = orderedRows(cat, q);
  const out: ItemView[] = new Array(rows.length);
  for (let n = 0; n < rows.length; n++) out[n] = viewItem(cat.items, rows[n]!);
  return out;
}

export function getItem(cat: Catalogue, id: number): ItemView | null {
  if (!Number.isInteger(id) || id < 0 || id >= cat.items.count) return null;
  if (rowIsAdult(cat, id)) return null;
  return viewItem(cat.items, id);
}

/**
 * Like `getItem`, but does not filter out adult rows.
 *
 * Used by the /adult section and by the Movie detail page when `?from=adult`
 * is present, so an adult title can be looked up by id the same way a normal
 * title is.
 */
export function getItemWithAdult(cat: Catalogue, id: number): ItemView | null {
  if (!Number.isInteger(id) || id < 0 || id >= cat.items.count) return null;
  return viewItem(cat.items, id);
}

/**
 * Find a row by the PROVIDER identity a stable ref carries.
 *
 * The server names rows `<kind>.<stream_id>` so that links survive a re-ingest;
 * this store's own ids are dense array offsets that mean nothing outside it. So
 * when a ref arrives — from a bookmark, a shared link, a restored tab — this is
 * what turns it back into a row here. Linear, because it is one lookup on a
 * navigation and an index would cost memory on every build for that.
 */
export function findByStream(cat: Catalogue, kind: number, streamId: number): ItemView | null {
  const { count } = cat.items;
  for (let i = 0; i < count; i++) {
    if (cat.items.streamId[i] === streamId && cat.items.kind[i] === kind) {
      if (rowIsAdult(cat, i)) return null;
      return viewItem(cat.items, i);
    }
  }
  return null;
}

export interface CategoryView extends CategoryRow {
  /** Recomputed for the scope in force, never the stored total. */
  count: number;
}

/**
 * Categories with counts that match the pages they produce.
 *
 * The stored `itemCount` is deliberately ignored: it is the count for the whole
 * catalogue, and every caller here has a scope. Using it is what made a genre
 * chip on the server advertise more titles than its own page returned.
 */
export function listCategories(cat: Catalogue, q: Query): CategoryView[] {
  const counts = new Map<number, number>();
  for (const row of matchRows(cat, { ...q, categoryId: null })) {
    const c = cat.items.categoryId[row] ?? 0;
    if (c !== 0) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const allowed = allowedCategories(cat, q);
  const adultIds = adultCategoryIds(cat);
  return cat.categories
    .filter((c) => c.kind === q.kind && !adultIds.has(c.id) && (allowed === null || allowed.has(c.id)))
    /* Same rule as the tree: what is here, or what there is to download. A
       package with neither is not shown at all. */
    .map((c) => ({
      ...c,
      count: counts.get(c.id) ?? (q.includeEmpty === true ? c.itemCount ?? 0 : 0),
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}

export interface FacetCount { id: string; label: string; count: number }

/**
 * Facet counts: what the grid would hold if you pressed this chip.
 *
 * That sentence is the whole specification, and now that every genre chip ANDs
 * (see `categoryMatchesGenres`) it has exactly one implementation. A row that
 * survives the CURRENT selection contributes to chip `g` if its category carries
 * `g` — and pressing `g` keeps precisely those rows. So one pass over the
 * surviving rows, tallying each category's genres, counts every chip correctly.
 *
 * A chip already chosen therefore reports the grid's own total, because every
 * surviving row has it. That is right, not a bug: with Horror and Thriller both
 * on, "Thriller 2,424" and a grid of 2,424 agree with each other.
 *
 * ── what this replaces, and why it needed replacing ──
 *
 * Under any-of a chip was something you ADD, so its count had to be measured
 * with the genre selection removed — and because the two kinds of chip combined
 * differently, that meant two scoped passes plus a third for regions and
 * sources. The story counts were then conditioned on the refinements but not on
 * each other, which was correct for any-of and is a lie under AND: measured on
 * the live catalogue, Thriller selected, the strip read "Horror 2,756" and
 * pressing it gave 2,424. Every story chip was quoting a page nobody was
 * looking at.
 *
 * Regions and sources still drop nothing, because they were never
 * self-conditioned to begin with.
 */
export function listFacets(cat: Catalogue, q: Query): {
  genres: FacetCount[];
  regions: FacetCount[];
  sources: FacetCount[];
} {
  const byId = new Map(cat.categories.map((c) => [c.id, c]));
  const tally = (rows: readonly number[], pick: (c: CategoryRow) => string[]) => {
    const m = new Map<string, number>();
    for (const row of rows) {
      const c = byId.get(cat.items.categoryId[row] ?? 0);
      if (!c) continue;
      for (const key of pick(c)) {
        if (key === '') continue;
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: id, count }));
  };

  /* One scope, everything applied — see the note above. */
  const rows = matchRows(cat, { ...q, categoryId: null });

  const split = (want: boolean) =>
    tally(rows, (c) => c.genres.filter((g) => REFINING.has(g as Genre) === want));
  /* Declaration order, not size order. Three pinned chips that swap places
     whenever their counts cross are three chips you cannot learn the position
     of, and learning positions is how anyone uses a remote. */
  const ORDER = [...REFINING];

  /*
    A chip that leads nowhere still has to be ON the strip.

    `tally` only ever sees genres that some surviving row carries, so a
    combination with no answer — Kids & Family AND Crime is 0 in this catalogue —
    would simply drop the chip out of the row. Chips that vanish when you press
    a neighbour are how a strip becomes unlearnable, and the zero is the most
    useful number on the screen: it is what tells you not to press. So every
    genre the unfiltered catalogue knows about is carried through at 0.
  */
  const zeros = (want: boolean): FacetCount[] => {
    const seen = new Set<string>();
    const adultIds = adultCategoryIds(cat);
    for (const c of cat.categories) {
      if (c.kind !== q.kind || adultIds.has(c.id)) continue;
      for (const g of c.genres) {
        if (REFINING.has(g as Genre) === want) seen.add(g);
      }
    }
    return [...seen].map((id) => ({ id, label: id, count: 0 }));
  };
  const pad = (found: FacetCount[], want: boolean): FacetCount[] => {
    const have = new Set(found.map((f) => f.id));
    /* Alphabetical, so a row of zeros has a stable order rather than whatever
       order the categories happen to be stored in. */
    const rest = zeros(want).filter((z) => !have.has(z.id)).sort((a, b) => a.id.localeCompare(b.id));
    return [...found, ...rest];
  };

  /*
    What is already chosen sorts to the front.

    Press a chip that leads nowhere and every count on the strip goes to zero,
    including the chips holding the selection — so the only way back was to find
    two dead chips among twenty identical dead ones, on a television, with a
    remote. The selection is the one thing that must never be hard to find,
    because it is the only thing you can undo.

    It also beats count order on its own terms. Counts reshuffle the row on every
    press anyway; "what I have picked, at the left, always" is a position you can
    learn, which is the whole argument the pinned refinements were making.
  */
  const picked = new Set(q.genres ?? []);
  const chosenFirst = (list: FacetCount[]): FacetCount[] => {
    const mine = list.filter((g) => picked.has(g.id));
    return mine.length === 0 ? list : [...mine, ...list.filter((g) => !picked.has(g.id))];
  };

  return {
    /* Refinements first and in a fixed order: three chips that modify whatever
       else is picked belong within reach, not two thousand pixels along a strip
       sorted by a count that moves. `tally` sorts the story chips by size. */
    genres: [
      ...pad(split(true), true)
        .sort((a, b) => ORDER.indexOf(a.id as Genre) - ORDER.indexOf(b.id as Genre)),
      ...chosenFirst(pad(split(false), false)),
    ],
    regions: tally(rows, (c) => (c.region === null ? [] : [c.region])),
    sources: tally(rows, (c) => (c.source === null ? [] : [c.source])),
  };
}

export interface GroupNode {
  id: string;
  label: string;
  count: number;
  depth: number;
  children: GroupNode[];
}

/**
 * The market / package / group tree, counted from rows.
 *
 * Built from the category paths that survive the scope, with each node's count
 * being the number of ITEMS beneath it — so a parent is the sum of its children
 * plus anything filed directly against it, and the numbers add up on screen.
 */
export function listGroups(cat: Catalogue, q: Query): { tree: GroupNode[]; total: number; ungrouped: number } {
  const byId = new Map(cat.categories.map((c) => [c.id, c]));
  const rows = matchRows(cat, { ...q, categoryId: null });
  const counts = new Map<string, number>();
  let ungrouped = 0;

  /*
   * The ancestor keys of a path, built once per CATEGORY instead of once per ROW.
   *
   * A row's contribution is one increment per ancestor, and the ancestor key was
   * being rebuilt for every row — `path.slice(0, d).join('/')` is an array copy
   * and a string allocation, and this catalogue has 148,604 films across 2,490
   * groups at depth two to three. That is ~400,000 slice-and-join pairs to
   * produce 2,490 distinct strings. Measured opening /live on a 4x-throttled CPU,
   * `listGroups` was 636ms of a 1.6s route change — the second largest entry in
   * the profile after reading the catalogue out of IndexedDB.
   *
   * Per category rather than per path so the memo is keyed on a number.
   */
  const ancestors = new Map<number, string[]>();
  const keysFor = (c: CategoryRow): string[] => {
    const held = ancestors.get(c.id);
    if (held !== undefined) return held;
    const made: string[] = [];
    for (let d = 1; d <= c.path.length; d++) made.push(c.path.slice(0, d).join('/'));
    ancestors.set(c.id, made);
    return made;
  };

  /*
   * An on-demand library's structure is real even where its contents are not here
   * yet — but a node that says 0 is worse than no node at all. So an undownloaded
   * package contributes the count it WILL have (`itemCount`, filled from the
   * catalogue the server holds), and a package with no items anywhere contributes
   * nothing and does not appear.
   *
   * Counted in the SAME pass as the tree below. It used to walk every matched row
   * a second time to build this, which on a films page is a second walk of
   * 148,604 rows to produce a map of 2,490 numbers.
   */
  const here = q.includeEmpty === true ? new Map<number, number>() : null;

  for (const row of rows) {
    const id = cat.items.categoryId[row] ?? 0;
    if (here !== null && id !== 0) here.set(id, (here.get(id) ?? 0) + 1);
    const c = byId.get(id);
    if (!c || c.path.length === 0) {
      ungrouped++;
      continue;
    }
    // Every ancestor gets the row, which is what makes a parent's number the sum
    // of what is under it.
    for (const key of keysFor(c)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (here !== null) {
    const adultIds = adultCategoryIds(cat);
    for (const c of cat.categories) {
      if (c.kind !== q.kind || c.path.length === 0 || adultIds.has(c.id)) continue;
      const extra = Math.max(0, (c.itemCount ?? 0) - (here.get(c.id) ?? 0));
      if (extra === 0) continue;
      for (const key of keysFor(c)) counts.set(key, (counts.get(key) ?? 0) + extra);
    }
  }

  const nodes = new Map<string, GroupNode>();
  for (const [id, count] of counts) {
    const segs = id.split('/');
    nodes.set(id, {
      id,
      /* The same expansion the SQL side does — a market code is not a label. It
         was the raw segment here, so the on-device catalogue showed `NL` and
         `NLF` where the server showed `Netherlands`: the same catalogue reading
         differently depending on where it was answered from. */
      label: labelFor(segs[segs.length - 1] ?? id, segs.length),
      count,
      depth: segs.length,
      children: [],
    });
  }
  const roots: GroupNode[] = [];
  for (const node of nodes.values()) {
    const segs = node.id.split('/');
    if (segs.length === 1) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(segs.slice(0, -1).join('/'));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byCount = (a: GroupNode, b: GroupNode) => b.count - a.count;
  const deepSort = (list: GroupNode[]): GroupNode[] => {
    list.sort(byCount);
    for (const n of list) deepSort(n.children);
    return list;
  };
  return { tree: deepSort(roots), total: rows.length, ungrouped };
}

export interface MarketView { id: string; label: string; count: number; categories: number[] }

/** Depth-1 of the tree, which is what a country picker is. */
export function listMarkets(cat: Catalogue, q: Query): MarketView[] {
  const { tree } = listGroups(cat, q);
  const catsByMarket = new Map<string, number[]>();
  const adultIds = adultCategoryIds(cat);
  for (const c of cat.categories) {
    if (c.kind !== q.kind || c.path.length === 0 || adultIds.has(c.id)) continue;
    const key = c.path[0]!;
    const list = catsByMarket.get(key) ?? [];
    list.push(c.id);
    catsByMarket.set(key, list);
  }
  return tree.map((n) => ({
    id: n.id,
    label: n.label,
    count: n.count,
    categories: catsByMarket.get(n.id) ?? [],
  }));
}

/* Cross-section search moved to `search.ts` on 2026-09-07 and is re-exported
   from the package index, so every existing `import { search } from
   '@iptv/core-store'` is unchanged. It left because it stopped being a thin
   wrapper over `matchRows`: tokenising, ranking, correcting a typo and reading
   the cast column are a read model of their own, and leaving them here would
   have meant this file importing the thing that imports it. */
