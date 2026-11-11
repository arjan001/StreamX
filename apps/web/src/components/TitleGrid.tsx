import { useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Star } from 'lucide-react';
import { PosterCard } from './PosterCard';
import { VirtualList } from './VirtualList';
import { NothingMatched } from './Nothing';
import { Button } from './ui';
import type { Filters } from './FilterBar';
import { useCategories, useGroupTree, useMarkets } from '../lib/groups';
import { usePagedItems, type PagedQuery } from '../lib/usePagedItems';
import { listPhase, useLibraryBuilding } from '../lib/useLibraryBuilding';
import { GRID_GAP, GRID_LIFT, GRID_PAD, type GridMetrics } from '../lib/useGridMetrics';
import { effectiveMarkets, usePrefs } from '../lib/prefs';
import { useScope } from '../lib/scope';
import { linkId, type Item, type Section } from '../lib/api';
import { useEnsurePackages } from '../lib/packages';

/**
 * The poster grid, and the question it is asking — shared by both screens that
 * browse a library.
 *
 * This was the whole of `routes/Grid`, and it moved here when the series desk
 * grew a grid of its own: "below the player will be the list of all the titles,
 * and when you open a series it will still be two columns". Two grids over one
 * catalogue is only safe if they build the SAME query, and the comments below
 * record why — every one of them is a bug that came from a call site asking a
 * narrower or wider question than the page it was drawing. A second hand-rolled
 * copy of this would drift from it silently, because a dropped filter clause
 * returns MORE rows and never errors.
 */

/** The paged query plus the any-of and hidden params the API also accepts. */
export type BrowseQuery = PagedQuery & {
  paths: string[];
  cats: number[];
  hidePaths: string[];
  hideCats: number[];
  adultOnly?: boolean;
};

/** Everything that changes the result set, as one string. See the note on `key`. */
export function browseSignature(q: BrowseQuery): string {
  return [
    q.categoryId ?? '', q.cats.join('.'), q.path ?? '', q.paths.join('.'),
    q.sort, q.dir, q.q, q.yearFrom ?? '', q.yearTo ?? '', q.minRating ?? '', q.addedSince ?? '',
    q.oneCopy ? 1 : '',
    q.genre ?? '', (q.genres ?? []).join('+'), q.region ?? '', q.source ?? '',
    q.hidePaths.join('.'), q.hideCats.join('.'),
    (q.streamIds ?? []).join(','),
    q.adultOnly ? '1' : '',
  ].join('|');
}

/**
 * The filters on screen, as the query the API is actually asked.
 *
 * `pick` is an explicit list of stream ids to show INSTEAD of a filtered page —
 * Continue watching on the series desk. It takes the same branch favourites
 * take, because they are the same shape of question: not "what matches" but
 * "these, in this order".
 */
export function useBrowseQuery(
  section: Section,
  filters: Filters,
  pick?: readonly number[] | null,
  adultOnly?: boolean,
): { query: BrowseQuery; offered: number } {
  const [prefs] = usePrefs();
  const { scope } = useScope();
  /* Both hooks share react-query keys with FilterBar, so this reads the same
     cache entry rather than issuing a second request. */
  const categories = useCategories(section, scope);
  const tree = useGroupTree(section, scope);
  const { markets, source: marketSource } = useMarkets(section, scope, tree.tree, categories);

  const ids = pick ?? (filters.favs ? prefs.favs[section] : null);
  /* "Just added": a day-aligned instant, so the query — and its page cache — do
     not change with every render. Series count an arriving episode, which moves
     their stamp, so their window is shorter. */
  const today = Math.floor(Date.now() / 86_400_000) * 86_400;
  const addedSince = filters.quick === 'new' ? today - (section === 'series' ? 14 : 30) * 86_400 : null;
  const minRating = filters.quick === 'top' ? Math.max(filters.minRating ?? 0, 7.5) : filters.minRating;
  /*
   * Top rated is ORDERED by rating, highest first — "the top rated should show
   * the stars which are high". It used to filter to 7.5 and up and then list
   * in the grid's own sort (newest added, by default), so a 10.0 sat after a
   * screen of 8.0s. The chip means the order, so it sets it. It folds the same title filed in
   * several country packages into one poster (`oneCopy`): "Youth" four times on
   * one screen of Top rated is not four suggestions.
   */
  const top = section !== 'live' && filters.quick === 'top';
  const byRating = top;
  const sort = byRating ? 'rating' as const : filters.sort;
  const dir = byRating ? 'desc' as const : filters.dir;
  const oneCopy = top;

  const query = useMemo<BrowseQuery>(() => {
    // A market IS depth-1 of the group tree, so it filters by path — except in
    // the last-resort fallback, where markets were derived from category name
    // prefixes and the only handle on them is the category ids.
    // The profile is a ceiling, not a default: a country picked in the bar can
    // only ever narrow it, never widen it back out.
    const chosen = effectiveMarkets(filters.markets, prefs);
    /**
     * A market IS depth-1 of the group tree, so it always travels as a path.
     *
     * This used to be gated on `marketSource`, which is derived from an async
     * request — so the FIRST items request of a page went out before the market
     * list resolved, with the profile's countries silently dropped. A profile
     * limited to two countries briefly listed all 79, and those rows landed in the
     * page cache. Category ids are added on top only in the last-resort fallback,
     * where markets were reconstructed from category name prefixes.
     */
    const marketPaths = chosen;
    const marketCats =
      marketSource === 'categories'
        ? markets.filter((m) => chosen.includes(m.id)).flatMap((m) => m.categories)
        : [];
    const groupPaths = [...new Set([...(filters.path ? [filters.path] : []), ...filters.paths])];
    const paths = groupPaths.length > 0 ? groupPaths : marketPaths;
    // Movies/series category selection lives in `filters.genres`.
    // Keep category ids only for the last-resort market-derived fallback.
    const cats = [...new Set(marketCats)];
    // One selection goes through the singular params: those are the ones the API
    // has always understood, so the common case works whatever the server supports.
    if (ids !== null) {
      return {
        categoryId: null,
        cats: [],
        path: null,
        paths: [],
        sort,
        dir,
        oneCopy,
        q: filters.q,
        yearFrom: filters.yearFrom,
        yearTo: filters.yearTo,
        minRating,
        addedSince,
        genres: [],
        region: filters.region,
        source: filters.source,
        hidePaths: prefs.hidePaths,
        hideCats: prefs.hideCats,
        /* The REF list and the hidden channels, which were missing here.
           `hideCats` alone is the legacy row-id list — usually empty — so hiding a
           package took it out of the sidebar and left every one of its channels in
           the list and in the total. The scope has to be whole at every call site
           or the numbers on screen disagree with the rows under them. */
        hideCatRefs: prefs.hideCatRefs,
        hideStreams: prefs.hideStreams,
        streamIds: [...ids],
        adultOnly,
      };
    }
    /*
     * A category picked from the sidebar's list shape.
     *
     * `filters.categoryId` was never read here, because nothing on these screens
     * wrote one: films browse by genre, and the sidebar wrote paths. The list
     * shape writes the provider's category now ("no need to filter the names at
     * all"), and a pick that did nothing to the grid is the dropped-clause bug the
     * note at the top of this file is about. It goes through `categoryId`, which
     * is an AND on the row — so it narrows inside the profile's countries and,
     * in the category-derived fallback, inside the market's own category list,
     * rather than being unioned into it and widening the page.
     */
    const picked = filters.categoryId;
    return {
      categoryId: picked ?? (cats.length === 1 ? cats[0]! : null),
      cats: picked !== null ? cats : cats.length > 1 ? cats : [],
      path: paths.length === 1 ? paths[0]! : null,
      paths: paths.length > 1 ? paths : [],
      sort,
      dir,
      oneCopy,
      q: filters.q,
      yearFrom: filters.yearFrom,
      yearTo: filters.yearTo,
      minRating,
      addedSince,
      genres: filters.genres,
      region: filters.region,
      source: filters.source,
      hidePaths: prefs.hidePaths,
      hideCats: prefs.hideCats,
      hideCatRefs: prefs.hideCatRefs,
      hideStreams: prefs.hideStreams,
      adultOnly,
    };
  }, [filters, ids, markets, marketSource, prefs, minRating, addedSince, sort, dir, oneCopy, adultOnly]);

  /* What the LIBRARY holds, from the catalogue's structure — a real number on a
     device that has downloaded nothing at all. Against `stats.total`, it is what
     tells an empty grid apart from an empty filter. */
  const offered = markets.reduce((n, m) => n + m.count, 0);

  return { query, offered };
}

/**
 * Split out and keyed by the query signature on purpose.
 *
 * usePagedItems holds a sparse page cache keyed on the fields it knows about,
 * which is not all of them any more (any-of selections, the hidden list). A
 * remount is the invalidation: new result set, empty cache, scrolled back to the
 * top — which is also what you want visually when a filter changes.
 */
export function TitleGrid({
  section, query, metrics, onStats, onClear, offered, filtered, href, replace, onPreview,
  idListEmpty, waiting = false,
}: {
  section: Section;
  query: BrowseQuery;
  metrics: GridMetrics;
  onStats: (s: { total: number; loading: boolean; error: string | null }) => void;
  onClear: () => void;
  /** How many titles the LIBRARY offers, from its structure. */
  offered: number;
  /** Whether this view is asking a narrower question than "everything". */
  filtered: boolean;
  /**
   * Where a tile goes. The default is the title's own page; the series desk
   * overrides it with an address on the SAME path, so picking a title loads it
   * into the panes above without remounting the screen or stopping the picture.
   */
  href?: (item: Item) => string;
  /** Replace rather than push: walking a grid is one screen, not a trail. */
  replace?: boolean;
  /** Focus or the pointer landed on a tile — used to name it before it loads. */
  onPreview?: (item: Item) => void;
  /** What an empty explicit id list says. Defaults to the favourites wording. */
  idListEmpty?: { title: string; hint: string };
  /** The list itself is still being worked out (Trending): draw it loading, never empty. */
  waiting?: boolean;
}) {
  useEnsurePackages(section, query);
  const { total, rows, loading, error, ensureRange } = usePagedItems(section, query);
  const building = useLibraryBuilding();
  const { cols, rowHeight } = metrics;

  useEffect(() => {
    onStats({ total, loading: loading || waiting, error });
  }, [total, loading, waiting, error, onStats]);

  const rowCount = Math.ceil(total / cols);
  const onRange = useCallback(
    (s: number, e: number) => ensureRange(s * cols, e * cols + cols - 1),
    [ensureRange, cols],
  );

  const kind = section === 'live' ? undefined : section;
  const to = href
    ?? ((it: Item) => (section === 'series' ? `/series/${linkId(it)}` : `/movie/${linkId(it)}`));

  // Pixel gaps, not Tailwind's rem spacing: these are the same numbers the row
  // pitch was computed from, and a rem that moves would put rows on top of each other.
  // The gutter is split around the card rather than all below it: the lift's
  // room sits ABOVE (the row clips at its own top — see GRID_LIFT) and the rest
  // below, so the pitch is still card + GRID_GAP.
  const rowStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`,
    columnGap: GRID_GAP,
    paddingLeft: GRID_PAD,
    paddingRight: GRID_PAD,
    paddingTop: GRID_LIFT,
    paddingBottom: GRID_GAP - GRID_LIFT,
    alignItems: 'start',
  };

  /* `building` as well: a catalogue that is mid-build answers honestly and
     emptily, so the query settles with total 0 and the grid would claim the
     library holds no films. See `useLibraryBuilding`. */
  if (waiting || listPhase(loading, building, total) === 'skeleton') {
    return (
      <div style={{ ...rowStyle, rowGap: GRID_GAP }}>
        {Array.from({ length: cols * 3 }, (_, i) => (
          <div key={i} className="skeleton aspect-[2/3] self-start" />
        ))}
      </div>
    );
  }

  /* The library HAS these — this filter does not. The page above has already
     handled the other case, so anything reaching here is undoable, and the only
     useful thing to offer is undoing it. */
  if (total === 0) {
    /*
     * Offered, but not here yet.
     *
     * On an on-demand library nothing is downloaded until somebody opens a group,
     * so an unfiltered films page is legitimately empty on a subscription with
     * 66,709 films in it. "No films match these filters" is false — there are no
     * filters — and "Clear filters" does nothing, which is how this read as the
     * app being broken. The honest thing to say is where the films are and how to
     * get one group of them, and the sidebar beside this is the how.
     */
    if (!filtered && offered > 0) {
      return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <Globe className="h-8 w-8 text-ink-3" strokeWidth={1.3} aria-hidden />
          <p className="text-[length:var(--t-md)] text-ink-2">
            {offered.toLocaleString()} {section === 'series' ? 'series' : 'films'} in this library.
          </p>
          <p className="max-w-sm font-mono text-[length:var(--t-xs)] leading-relaxed text-ink-3">
            They are downloaded a group at a time, so nothing is on this device yet.
            Pick a group to open it.
          </p>
        </div>
      );
    }
    return query.streamIds !== undefined ? (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Star className="h-8 w-8 text-ink-3" strokeWidth={1.3} aria-hidden />
        <p className="text-[length:var(--t-md)] text-ink-2">
          {idListEmpty?.title ?? 'Nothing starred yet.'}
        </p>
        <p className="font-mono text-[length:var(--t-xs)] text-ink-3">
          {idListEmpty?.hint ?? 'Tap the star on any title to keep it here.'}
        </p>
      </div>
    ) : (
      <>
        <NothingMatched
          what={section === 'series' ? 'series' : 'films'}
          query={query.q}
          hiddenCount={query.hidePaths.length + (query.hideCatRefs?.length ?? 0)}
          onClear={onClear}
        />
        {/*
          The category's own search found nothing here — the other half of what
          the product ask itself named: "of course it must be possible to
          keyword-search inside that category, and across the whole catalogue".
          `search` already reads `from` to keep this section's own tab lit, so a
          press that finds nothing in one library still offers everywhere else.
          `Nothing.tsx` is outside this change's file list, so this sits beside
          `NothingMatched` rather than growing a prop onto it.
        */}
        {query.q !== '' && (
          <div className="flex justify-center pb-8">
            <Button
              as={Link}
              to={`/search?q=${encodeURIComponent(query.q)}&from=${section}`}
              variant="primary"
              className="px-4 py-2 text-[length:var(--t-sm)]"
            >
              Search everything for “{query.q}”
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <VirtualList
      key={rowHeight}
      count={rowCount}
      rowHeight={rowHeight}
      onRangeChange={onRange}
      /* Remembered, like the channel list: on the series desk this grid is a
         screen BELOW the title it opens, so a viewer who walks down to row four,
         goes up to look at something and comes back must land on row four
         rather than on the top of the library. Vertical arrivals only — a
         sideways press is level by construction, so memory never overrules it
         (`land` in lib/spatialNav.ts). */
      navGroup="titles"
      className="h-full overflow-y-auto"
      render={(rowIndex) => (
        <div className="stagger" style={rowStyle}>
          {Array.from({ length: cols }, (_, c) => {
            const index = rowIndex * cols + c;
            if (index >= total) return <div key={c} />;
            const item = rows.get(index);
            if (!item) return <div key={c} className="skeleton aspect-[2/3] self-start" />;
            return (
              <PosterCard
                key={linkId(item)}
                item={item}
                to={to(item)}
                {...(replace === true ? { replace: true } : {})}
                {...(onPreview === undefined ? {} : { onPreview })}
                kind={kind}
                favSection={kind}
                artWidth={metrics.cardWidth}
              />
            );
          })}
        </div>
      )}
    />
  );
}
