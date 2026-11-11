import { useEffect, useMemo, useRef, useState } from 'react';
import { RailToggle } from './RailToggle';
import { REFINING, type Genre } from '@iptv/core-xtream';
import { useQueries, useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  ChevronDown, Eye, EyeOff, RotateCcw, SlidersHorizontal, Star, X,
} from 'lucide-react';
import { useFilterStrip } from '../lib/filterStrip';
import { api, type FacetCount, type Facets, type Section, type SortKey } from '../lib/api';
import {effectiveMarkets, setPrefs, toggleHiddenPath, usePrefs} from '../lib/prefs';
import {
  flattenGroups, marketName, scopeKey, useCategories, useGroupTree, useMarkets,
} from '../lib/groups';
import { useScope } from '../lib/scope';
import { groupLabel } from '../lib/displayName';
import { categoryHeading } from '../lib/home';
import { crossScope } from '../lib/crossFilter';
import { useShape } from '../lib/formFactor';
import { focusFirst } from '../lib/spatialNav';
import { Select } from './ui';
import { Sheet } from './Sheet';
import { useTally } from '../lib/tally';

/**
 * Everything that narrows the grid, in one strip.
 *
 * Two tiers on purpose: what people reach for constantly (a market, a genre, a
 * title, an order) is always on screen, and the long tail (year windows, minimum
 * rating, region, source) folds away. The whole set lives in the URL, so any
 * state this bar can reach is a link someone can send.
 */

export interface Filters {
  /** Single category — the common case, and the one the API has always taken. */
  categoryId: number | null;
  /** Several categories, any-of. */
  cats: number[];
  /** Drilled-into group path, e.g. "EN/NETFLIX". Matches that node and below. */
  path: string | null;
  /** Several group paths, any-of. */
  paths: string[];
  /** Market/country codes, any-of. */
  markets: string[];
  sort: SortKey;
  dir: 'asc' | 'desc';
  q: string;
  yearFrom: number | null;
  yearTo: number | null;
  minRating: number | null;
  /** Genres, all-of (AND) — see `categoryMatchesGenres`. Films and series browse by these. */
  genres: string[];
  region: string | null;
  source: string | null;
  /** Starred items in this section. Only when the URL has favs=1. */
  favs: boolean;
  /** Sports TV: which sport's channels (a topic id, see `lib/topics.ts`). */
  sport: string | null;
  /** Films and series: one of the quick filters beside All — see QUICK. */
  quick: QuickFilter | null;
}

/**
 * The few filters worth a button of their own, between All and Genres.
 *
 * "things and filters like trending, completed and what not … put them in the
 * filters menu, not exposed, or between All and genres add the most important
 * ones but few". Two, each from something the panel itself says:
 *
 *   - Just added — the panel stamps every title with when it was added
 *     (`added`): the last thirty days of films, the last fourteen of series,
 *     whose stamp moves when an episode arrives.
 *   - Top rated — the panel's own rating, 7.5 and up.
 *
 * There was a third, Trending — this week's trending titles at TMDB, found in
 * this library. TMDB's key lives on our box, and on 2026-10-01 the box stopped
 * answering anything but logs, updates, config and captions, so it went. A
 * `?quick=trending` link from before then opens the unfiltered grid.
 *
 * Not "Completed": a panel's series list carries no status, and asking per
 * series is thousands of requests.
 */
export type QuickFilter = 'new' | 'top';
export const QUICK: readonly { id: QuickFilter; label: string }[] = [
  { id: 'new', label: 'Just added' },
  { id: 'top', label: 'Top rated' },
];
const QUICK_IDS = QUICK.map((q) => q.id) as string[];

export const EMPTY_FILTERS: Filters = {
  categoryId: null, cats: [], path: null, paths: [], markets: [],
  sort: 'default', dir: 'asc', q: '',
  yearFrom: null, yearTo: null, minRating: null,
  genres: [], region: null, source: null, favs: false, sport: null, quick: null,
};

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'default', label: 'Provider' },
  { id: 'name', label: 'A–Z' },
  { id: 'year', label: 'Year' },
  { id: 'rating', label: 'Rating' },
  { id: 'added', label: 'Newest' },
];
const SORT_IDS = SORTS.map((s) => s.id);

/** The always-on decade/rating pill row. Off — see the note where it renders. */
const DECADE_STRIP = false;
const DECADES = [2020, 2010, 2000, 1990, 1980];
const RATINGS = [9, 8, 7, 6];
const THIS_YEAR = new Date().getFullYear();
const SECTIONS: Section[] = ['live', 'movies', 'series'];

/** Sorts default to highest-first where that is what the word means. */
export function defaultDir(k: SortKey): 'asc' | 'desc' {
  return k === 'rating' || k === 'year' || k === 'added' ? 'desc' : 'asc';
}

/* ── URL <-> Filters ─────────────────────────────────────────────────────────
   The URL is the state, not a copy of it: the detail pages link straight to
   /movies?genre=comedy and ?path=EN/NETFLIX, so a filter the URL cannot express
   is a filter that breaks those links. */

const list = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : [];
const nums = (v: string | null): number[] =>
  list(v).map(Number).filter((n) => Number.isFinite(n));
const num = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function filtersFromParams(p: URLSearchParams): Filters {
  const raw = p.get('sort');
  const sort = SORT_IDS.includes(raw as SortKey) ? (raw as SortKey) : 'default';
  const dirRaw = p.get('dir');
  const markets = list(p.get('markets'));
  const path = p.get('path') || null;
  const paths = list(p.get('paths'));
  const genres = [...new Set([...list(p.get('genres')), ...(p.get('genre') ? [p.get('genre')!] : [])])];
  const cats = nums(p.get('cats'));
  const categoryId = num(p.get('category'));
  const q = p.get('q') ?? '';
  const yearFrom = num(p.get('yearFrom'));
  const yearTo = num(p.get('yearTo'));
  const minRating = num(p.get('minRating'));
  const region = p.get('region') || null;
  const source = p.get('source') || null;
  return {
    categoryId, cats, path, paths, markets, sort,
    dir: dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : defaultDir(sort),
    q, yearFrom, yearTo, minRating, genres, region, source,
    favs: p.get('favs') === '1',
    sport: p.get('sport') || null,
    quick: QUICK_IDS.includes(p.get('quick') ?? '') ? (p.get('quick') as QuickFilter) : null,
  };
}

export function paramsFromFilters(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.favs) p.set('favs', '1');
  if (f.sport) p.set('sport', f.sport);
  if (f.q.trim() !== '') p.set('q', f.q.trim());
  if (f.categoryId !== null) p.set('category', String(f.categoryId));
  if (f.cats.length) p.set('cats', f.cats.join(','));
  if (f.path) p.set('path', f.path);
  if (f.paths.length) p.set('paths', f.paths.join(','));
  if (f.markets.length) p.set('markets', f.markets.join(','));
  if (f.genres.length) p.set('genres', f.genres.join(','));
  if (f.region) p.set('region', f.region);
  if (f.source) p.set('source', f.source);
  if (f.yearFrom !== null) p.set('yearFrom', String(f.yearFrom));
  if (f.yearTo !== null) p.set('yearTo', String(f.yearTo));
  if (f.minRating !== null) p.set('minRating', String(f.minRating));
  if (f.quick !== null) p.set('quick', f.quick);
  if (f.sort !== 'default') {
    p.set('sort', f.sort);
    if (f.dir !== defaultDir(f.sort)) p.set('dir', f.dir);
  }
  return p;
}

/** The API's facet label is the raw slug; only a few of them read badly. */
const GENRE_DISPLAY: Record<string, string> = {
  fourk: '4K', scifi: 'Sci-Fi', standup: 'Stand-up', tvshow: 'TV show',
};
function facetLabel(f: FacetCount): string {
  return GENRE_DISPLAY[f.id] ?? f.label.charAt(0).toUpperCase() + f.label.slice(1);
}

/**
 * A chosen value that the rest of the scope has counted down to nothing, kept on
 * its own list at zero.
 *
 * Every list on this page is now narrowed by the others, and narrowing can empty
 * one: a language that exists only outside the selected package drops out of the
 * language list the moment that package is picked. A select whose current value
 * is not among its options renders BLANK, which reads as "no language set" over
 * a page that is filtered by one — and there is then nothing to press to undo it.
 */
function withChosen(rows: FacetCount[], chosen: string | null): FacetCount[] {
  if (chosen === null || chosen === '' || rows.some((r) => r.id === chosen)) return rows;
  return [...rows, { id: chosen, label: chosen, count: 0 }];
}

function Pill({
  active, onClick, children, title, tone,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  tone?: 'alert';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`shrink-0 whitespace-nowrap border px-2 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
        touch:px-2.5 touch:py-1.5 touch:text-[length:var(--t-xs)]
        ${active
          ? tone === 'alert'
            ? 'border-alert bg-alert/10 text-alert'
            : 'border-tally bg-tally/10 text-tally'
          : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
      {children}
    </span>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

/*
 * `CategorySearch` and its draft hook were here.
 *
 * They drew the strip's own free-text field, which the rail's field replaced —
 * see the note on the heading below. Deleted rather than left unused: a second
 * implementation of "type, wait, write the query" is exactly the kind of thing
 * that gets wired back up later and then disagrees with the one in use, and the
 * debounce that mattered now lives in one place (`lib/typingDelay.ts`).
 */

/* ── hidden list ─────────────────────────────────────────────────────────────
   A preference, not a filter: it never enters the URL. Include filters are for
   sharing, the hidden list is personal and survives a reload. */

function useCatLabels(enabled: boolean): Map<number, string> {
  const results = useQueries({
    queries: SECTIONS.map((s) => ({
      queryKey: ['categories', s],
      queryFn: () => api.categories(s),
      staleTime: 5 * 60_000,
      enabled,
    })),
  });
  const sig = results.map((r) => r.data?.categories.length ?? 0).join(',');
  return useMemo(() => {
    const m = new Map<number, string>();
    /*
     * `groupLabel`, like every other place a package is named — this map was the
     * one that printed the panel's own string.
     *
     * Both readers are labels a person reads: the "Hidden everywhere" list and
     * the scope word over a grid. Counted over the 480 categories in
     * `fixtures/catalogue.json`: 46 of the 223 live ones reach a screen entirely
     * unprocessed this way — "EU| LUXEMBOURG", "IR| CLUBBER PPV", "BR| CULTURA" —
     * because `cleanName` is only computed for the VOD lists at ingest.
     */
    for (const r of results) {
      for (const c of r.data?.categories ?? []) {
        m.set(c.id, groupLabel(c.cleanName !== '' ? c.cleanName : c.name));
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

/** Exported so the shell can offer the same panel from outside a grid route. */
export function HiddenPanel({ onClose }: { onClose?: () => void }) {
  const [prefs] = usePrefs();
  // The profile's own scope, shared by every listing call in this bar.

  const labels = useCatLabels(true);
  const nothing = prefs.hidePaths.length === 0 && prefs.hideCats.length === 0;

  return (
    <div className="glass-float sheet-panel w-72 border border-rule bg-panel shadow-2xl anim-rise">
      <div className="flex items-center justify-between border-b border-rule px-2.5 py-1.5">
        <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
          Hidden everywhere
        </span>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="max-h-64 overflow-y-auto">
        {nothing && (
          <p className="px-2.5 py-2 text-[length:var(--t-xs)] leading-snug text-ink-3">
            Nothing hidden. Right-click a group, country or category tab — or use its
            eye button — to drop it out of every list.
          </p>
        )}
        {prefs.hidePaths.map((p) => (
          <div key={p} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-panel-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-2" title={p}>
              {p.split('/').map((s, i) => (i === 0 ? marketName(s) : s)).join(' / ')}
            </span>
            <button
              type="button"
              onClick={() => toggleHiddenPath(p)}
              title="Unhide"
              className="flex items-center gap-1 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-live"
            >
              <Eye className="h-3 w-3" /> unhide
            </button>
          </div>
        ))}
        {prefs.hideCats.map((id) => (
          <div key={id} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-panel-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink-2">
              {labels.get(id) ?? `category #${id}`}
            </span>
            <button
              type="button"
              onClick={() => setPrefs({ hideCats: prefs.hideCats.filter((c) => c !== id) })}
              title="Unhide"
              className="flex items-center gap-1 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-live"
            >
              <Eye className="h-3 w-3" /> unhide
            </button>
          </div>
        ))}
      </div>
      {!nothing && (
        <button
          type="button"
          onClick={() => setPrefs({ hidePaths: [], hideCats: [] })}
          className="flex w-full items-center gap-1 border-t border-rule px-2.5 py-1.5
                     font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-live"
        >
          <Eye className="h-3 w-3" /> unhide all (
          {prefs.hidePaths.length + prefs.hideCats.length})
        </button>
      )}
    </div>
  );
}

/** The trigger + panel as one unit, so the shell can drop it anywhere. */
export function HiddenChip() {
  const [open, setOpen] = useState(false);
  const [prefs] = usePrefs();
  // The profile's own scope, shared by every listing call in this bar.

  const n = prefs.hidePaths.length + prefs.hideCats.length;

  /*
   * Nothing hidden, nothing to say.
   *
   * This chip sat on every browse screen at all times, and with an empty list the
   * only thing behind it was a panel explaining that the list was empty — a
   * permanent button whose whole content was its own absence. It earns its place
   * the moment something IS hidden, where it is both the reminder that a filter is
   * in force and the way to undo it. Until then the hidden list lives in Settings,
   * which is where a control used once belongs.
   */
  if (n === 0) return null;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Groups, countries and categories you have hidden"
        className={`flex items-center gap-1 border px-2 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
          ${n > 0 ? 'border-alert/70 text-alert' : 'border-rule text-ink-3 hover:text-ink'}`}
      >
        <EyeOff className="h-3 w-3" /> Hidden{n > 0 ? ` (${n})` : ''}
      </button>
      {open && (
        <>
          <div data-nav-skip className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div data-nav-contain className="absolute right-0 top-7 z-50">
            <HiddenPanel onClose={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}

/* ── the bar ─────────────────────────────────────────────────────────────── */

/**
 * The bar.
 *
 * Left: All + Filters (+ Reset when dirty). Right: horizontal genre chips scoped
 * to the current country/package (cross-filtered counts). Filters stay reachable
 * even when a package empties the genre list — that was the old "strip vanished"
 * failure. Live TV does not use this at all: countries and groups are the sidebar.
 */
export function FilterBar({
  section, value, onChange, total, loading, genres = false, groups = true,
  toolbar = false, defaultSort = 'default',
}: {
  section: Section;
  /** The order this screen opens in — Movies and Series open newest first. An
      order is only "set" when it is a different one. */
  defaultSort?: SortKey;
  value: Filters;
  onChange: (f: Filters) => void;
  /** The count the API returned for exactly these filters. */
  total: number;
  loading?: boolean;
  /** Show the genre controls. Movies and series browse by genre; live does not. */
  genres?: boolean;
  /** Offer country and group pickers. False where a sidebar owns them. */
  groups?: boolean;
  /** Legacy: open the Filters popover path even without genres. */
  toolbar?: boolean;
}) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();
  const { scope } = useScope();
  const [open, setOpen] = useState(false);
  /* Whether the genre chips are on screen. See `lib/filterStrip`. */
  const [chipsOpen, setChipsOpen] = useFilterStrip(section);

  const set = (p: Partial<Filters>) => onChange({ ...value, ...p });

  const selectedMarkets = useMemo(
    () => effectiveMarkets(value.markets, prefs),
    [value.markets, prefs],
  );
  const genresKey = value.genres.join(',');
  const debouncedGenresKey = useDebouncedValue(genresKey, 80);
  const debouncedGenres = useMemo(
    () => (debouncedGenresKey ? debouncedGenresKey.split(',') : []),
    [debouncedGenresKey],
  );
  /* Debounced, because two chips pressed in quick succession are two whole
     re-scopings of every list on the page otherwise. */
  const settled = useMemo(
    () => ({ ...value, genres: debouncedGenres }),
    [value, debouncedGenres],
  );

  /**
   * The scope behind the genre chips: everything else that is set.
   *
   * Package, group, country, language and source are all in here for the reason
   * this file changed: a chip offering 2,270 thrillers over a page filtered to
   * one English comedy package is a count about a different page, and pressing it
   * lands on a grid that has nothing like that many.
   *
   * The genre selection travels too, and the genre counts are taken WITH it
   * applied: every chip ANDs, so a chip's count means "what the grid would hold
   * with this one on as well", which is the current selection plus that chip.
   * Language and source counts, being single-select, are narrowed by it too.
   */
  const facetScope = useMemo(
    () => crossScope(scope, settled, 'genres', selectedMarkets),
    [scope, settled, selectedMarkets],
  );

  const { data: facets } = useQuery<Facets>({
    queryKey: ['facets', section, scopeKey(facetScope)],
    queryFn: () => api.facets(section, facetScope),
    retry: false,
    staleTime: 5 * 60_000,
    /*
     * Keep the chips on screen while the new counts are fetched.
     *
     * This is the whole of "on select it scrolls to the beginning". Pressing a
     * chip changes the scope, which changes the query key, which made `data`
     * undefined until the refetch landed — so all twenty-two chips unmounted,
     * the strip's content collapsed to the one selected chip, and the browser
     * clamped a 320px scroll offset to zero because there was no longer anything
     * to scroll. The chips came back a moment later at the start of the strip,
     * with whatever you had walked along the row to reach now off-screen.
     *
     * Measured, not guessed: the strip's own DOM node survived the press
     * (`sameNode: true`) while 21 of its 22 children were replaced, and the
     * scroll listener recorded exactly one jump, 320 -> 0.
     */
    placeholderData: keepPreviousData,
  });
  /*
   * The group tree that fed the ALL chip's count is gone with the count.
   *
   * It walked every category path on every render of this bar to produce one
   * number, and that number was the source of the confusion above. The readout
   * beside All now comes from the grid itself, which already knew.
   */

  /*
   * This category's own name, for the strip row below.
   *
   * `useCategories(section, scope)` — the plain profile scope, not `groupScope`
   * or any of the cross-filtered ones above — shares its react-query cache key
   * with `TitleGrid`'s own `useBrowseQuery`, so on the page that actually mounts
   * both of these this costs no second request.
   */
  const categories = useCategories(section, scope);
  const heading = useMemo(
    () => categoryHeading(categories, value),
    [categories, value.categoryId, value.path, value.paths],
  );

  const facetsGenres = facets?.genres ?? [];
  /**
   * The strip carries what is worth pressing. Everything else lives in Filters.
   *
   * Two things came off this row, both on the same instruction — "remove 4K and
   * those 2 more, move them into the filters popover, I want that area clean".
   *
   * FORMAT, ERA AND SEASON. 4K, Classics and Christmas used to pin to the front
   * of the strip. They earned that place when every chip was any-of and they
   * were the only three that narrowed; now that all chips narrow they are just
   * three more, and they were occupying the most valuable real estate on the
   * screen — the part you reach without scrolling — to say `4K 0`. They are in
   * the popover, which is where a thing you set once and forget belongs.
   *
   * AND EVERY CHIP THAT LEADS NOWHERE. Under AND most genres go to zero the
   * moment one is picked: after Thriller, of twenty-two chips exactly two could
   * still narrow anything. A row of twenty zeros is not information, it is a
   * wall to scroll past to reach the two that work. What survives is what you
   * can actually press — after Thriller the row reads Thriller, Horror, Action —
   * and the complete list, zeros included, is one press away in Filters.
   *
   * A CHOSEN chip always stays, even at zero. It is the only way back out of a
   * combination that emptied the grid, and `listFacets` sorts it to the front.
   */
  const visibleGenres = useMemo(() => {
    const chosen = new Set(value.genres);
    const m = new Map(
      facetsGenres
        .filter((g) => !REFINING.has(g.id as Genre))
        .filter((g) => g.count > 0 || chosen.has(g.id))
        .map((g) => [g.id, g]),
    );
    /* A chosen genre the facets never mention still has to be here to be undone. */
    for (const id of value.genres) {
      if (REFINING.has(id as Genre) || m.has(id)) continue;
      m.set(id, { id, label: id, count: 0 });
    }
    return [...m.values()];
  }, [facetsGenres, value.genres]);
  /*
   * Is this page narrowed by something other than a genre?
   *
   * One question, asked in three places below: whether ALL is really all, what to
   * name the thing doing the narrowing, and what pressing it should clear.
   */
  const scoped = value.categoryId !== null || value.cats.length > 0
    || value.path !== null || value.paths.length > 0 || value.markets.length > 0;
  /* Only when something is actually filtered by a package id: three category
     lists is three requests, and the common case needs none of them. */
  const catNames = useCatLabels(value.categoryId !== null || value.cats.length > 0);
  const scopeLabel = (() => {
    if (value.categoryId !== null) return catNames.get(value.categoryId) ?? 'this package';
    if (value.cats.length > 0) return `${value.cats.length} packages`;
    const p = value.path ?? value.paths[0] ?? null;
    if (p !== null) {
      const segs = p.split('/');
      if (segs.length === 1) return marketName(segs[0]!);
      const leaf = segs[segs.length - 1]!;
      return leaf
        .split(/[\s_+-]+/)
        .filter((w) => w !== '')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }
    if (value.markets.length === 1) return marketName(value.markets[0]!);
    if (value.markets.length > 1) return `${value.markets.length} countries`;
    return 'filtered';
  })();

  const advancedCount =
    (value.yearFrom !== null ? 1 : 0) +
    (value.yearTo !== null ? 1 : 0) +
    (value.minRating !== null ? 1 : 0) +
    (value.region ? 1 : 0) +
    (value.source ? 1 : 0) +
    (groups ? value.markets.length + value.paths.length + (value.path ? 1 : 0) : 0) +
    /* A category is the sidebar's too now — its list shape writes one — so it
       counts here on the same terms as a country: only when this bar owns the
       axis. Otherwise a row picked in the rail lit Filters and summoned Reset,
       the rail's choice echoed in the strip (gotcha #122). */
    (groups ? value.cats.length + (value.categoryId !== null ? 1 : 0) : 0) +
    (value.sort !== defaultSort ? 1 : 0) +
    /* Format, era and season live in the popover now, so the button that opens
       it has to account for them — otherwise setting 4K there leaves no mark
       anywhere on the strip and the page is narrowed by something invisible. */
    value.genres.filter((g) => REFINING.has(g as Genre)).length;
  const dirty =
    advancedCount > 0 || value.q !== '' || value.genres.length > 0 || value.favs || value.quick !== null;

  /*
   * Nothing to show is nothing to draw.
   *
   * Live asks for neither row, and a band with no controls in it is still a
   * bordered 3px strip with a background — an empty box above the channel list,
   * which is precisely what it looked like once the toolbar came out.
   */
  if (!genres && !toolbar) return null;

  const destBtn = (active: boolean) =>
    `dest tap flex shrink-0 items-center gap-1.5 border px-2 py-1 font-mono
     text-[length:var(--t-2xs)] tracking-wider transition-colors touch:py-2
     ${active
       ? 'border-tally text-tally'
       : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:border-focus focus-visible:text-focus'}`;

  const toggleGenre = (id: string) => {
    const on = value.genres.includes(id);
    set({
      favs: false,
      genres: on
        ? value.genres.filter((x) => x !== id)
        : [...value.genres, id],
    });
  };

  return (
    /* A band: the filter strip spans the full width of the page and its bottom
       rule is the separator between it and the grid. Square by declaration. */
    <div className="no-round relative border-b border-rule bg-panel/60">
      {/* Above the Filters dismiss scrim so All/Filters/genres stay reachable. */}
      {/* 4px, in px, and only because a chip's own border would otherwise lie on
          the pane's edge and on this strip's rule — two 1px lines that read as
          one. The same number as `GRID_PAD`, so the first chip and the first
          poster share a left edge at every root size. The ring is inward, so no
          halo needs room here any more. */}
      <div className="relative z-[60] flex items-center gap-2 p-[4px]">
        {/* A phone's category rail is a drawer, opened from here. Null on a TV. */}
        {genres && <RailToggle />}
        <div className="flex shrink-0 items-center gap-1.5">
          {/*
            The glyph alone, and FIRST — left of All.

            Asked for in one line: "the filters button only icon no text, and on
            the left of all". Both halves are the same argument. A word costs
            about seventy pixels of a strip whose whole job is to show genres,
            and the sliders glyph is the one control here nobody has to be taught.
            Putting it before All also puts the two ways of changing the whole
            page — open everything, or clear everything — next to each other,
            instead of separated by a count that changes width as you browse.

            It still SAYS Filters, to a screen reader and on hover; what it stops
            doing is spending the strip on saying it. How many advanced filters
            are set is carried by the colour, the way every other active control
            here carries it.
          */}
          <button
            type="button"
            aria-label={advancedCount > 0 ? `Filters (${advancedCount} set)` : 'Filters'}
            title={advancedCount > 0 ? `Filters (${advancedCount} set)` : 'Filters'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={`${destBtn(open || advancedCount > 0)} px-1.5`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>

          {genres && (
            <Pill
              active={!value.favs && value.genres.length === 0 && !scoped && value.quick === null
                && value.yearFrom === null && value.yearTo === null && value.minRating === null}
              onClick={() => set({
                favs: false, genres: [], categoryId: null, cats: [], path: null, paths: [], markets: [],
                yearFrom: null, yearTo: null, minRating: null, region: null, source: null, quick: null,
              })}
            >
              All
            </Pill>
          )}
          {/* One at a time: each is a way of looking at the whole section, and
              two at once ("trending AND just added") is a list nobody asked for. */}
          {genres && section !== 'live' && QUICK.map((qf) => (
            <Pill
              key={qf.id}
              active={value.quick === qf.id}
              onClick={() => set({ quick: value.quick === qf.id ? null : qf.id })}
            >
              {qf.id === 'new' && section === 'series' ? 'New episodes' : qf.label}
            </Pill>
          ))}

          {genres && (
            /*
             * How many titles are on screen — the number that was missing.
             *
             * The count used to live on the All pill and meant something else:
             * what PRESSING All would give. So choosing England left it reading
             * 31,600 (press All, get the whole library) while the posters
             * underneath became twenty thousand English ones, and picking a
             * genre on top of a country showed 2,300 over a grid holding 2,271.
             * Every one of those numbers was defensible and none of them was the
             * one anybody was reading it as.
             *
             * Measured: `?markets=NL&genres=thriller` put 30 films in the grid
             * under a heading that said 2,300. "Nothing changes" was the number
             * not changing, not the filter not filtering — the filter was right
             * the whole time.
             */
            <span
              aria-live="polite"
              className="shrink-0 whitespace-nowrap font-mono text-[length:var(--t-2xs)] text-ink-2"
            >
              {/*
                No sentence naming the selection.

                There used to be one — "Family + Anime + Animation" — and it sat
                two centimetres from three lit chips reading Family, Anime and
                Animation. It was written when the chips combined by two
                different rules and the row could not be read literally; now
                every chip ANDs, so the lit chips ARE the sentence, and printing
                it again is a caption under a photograph of itself. It also
                grew with the selection, pushing the chips it was describing off
                the side of a television.
              */}
              {loading ? '…'
                : tallyOf(total) === null ? ''
                  : `${tallyOf(total)} ${total === 1 ? 'title' : 'titles'}`}
            </span>
          )}

          {dirty && (
            <button
              type="button"
              aria-label="Reset filters"
              title="Reset filters"
              onClick={() => onChange({ ...EMPTY_FILTERS, sort: defaultSort, dir: defaultDir(defaultSort) })}
              className={destBtn(false)}
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          )}

          {genres && (
            /*
             * Open and close the genres: "the tab filters make it toggleable and in
             * a top so you open and close it".
             *
             * Shut, it still says how many genres are picked, and lights up the way
             * every active control on this band does — a closed strip must never be
             * the reason somebody cannot work out why the grid is short.
             */
            <button
              type="button"
              aria-expanded={chipsOpen}
              aria-label={chipsOpen ? 'Hide genres' : 'Show genres'}
              onClick={() => setChipsOpen(!chipsOpen)}
              className={destBtn(chipsOpen || value.genres.length > 0)}
            >
              <span>Genres{value.genres.length > 0 ? ` · ${value.genres.length}` : ''}</span>
              <ChevronDown className={`h-3 w-3 transition-transform ${chipsOpen ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>

        {/*
          The category page's own name, and NOTHING ELSE on this half of the row.

          There was a search field here. It was added because the strip had none
          on "All titles" — "in movies search filter is missing" — and then the
          rail's own field started writing the same query, which made the two of
          them the same box twice, side by side, both showing what had been
          typed: "look, remove that duplicate search on top now", photographed
          with "1883" in each. The rail's is the one that survives: it is the
          field a D-pad reaches first, and it filters the rail AND this grid.

          The name stays, because that is not duplicated anywhere — it is how a
          viewer knows which package they are inside.
        */}
        {heading !== null && (
          <span
            title={heading}
            className="max-w-[10rem] shrink-0 truncate font-mono text-[length:var(--t-2xs)]
                       uppercase tracking-wider text-ink sm:max-w-[16rem]"
          >
            {heading}
          </span>
        )}

        {genres && chipsOpen && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {visibleGenres.map((g) => {
              const on = value.genres.includes(g.id);
              /* The hairline that used to separate the pinned refinements from
                 the kinds went with them: there is only one kind of chip on this
                 row now, so a rule across it would be marking nothing — and with
                 it goes the Fragment that existed only to carry it. */
              return (
                  <Pill
                    key={g.id}
                    active={on}
                    onClick={() => toggleGenre(g.id)}
                    title={g.count === 0
                      ? `Nothing is both ${facetLabel(g)} and what is already picked`
                      : `${g.count.toLocaleString()} titles — ${on ? 'remove' : 'add'}`}
                  >
                    {facetLabel(g)}
                    {/* Off unless the viewer asked for counts — `useTally`. */}
                    {tallyOf(g.count) !== null && (
                      <span className="ml-1 text-ink-3">{tallyOf(g.count)}</span>
                    )}
                  </Pill>
              );
            })}
            {visibleGenres.length === 0 && (
              <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">
                No genres in {scopeLabel}
              </span>
            )}
          </div>
        )}

        {loading && (
          <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">…</span>
        )}
      </div>

      {/*
        The decade + rating strip is HIDDEN for now, on the owner's word: "the
        like of years of movie, just hide for now, we can fix this later".
        Flip `DECADE_STRIP` to bring the row back.
      */}
      {DECADE_STRIP && genres && section !== 'live' && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-t border-rule/50 px-3 py-1.5">
          {DECADES.map((d) => {
            const on = value.yearFrom === d && value.yearTo === d + 9;
            return (
              <Pill
                key={d}
                active={on}
                onClick={() =>
                  set(on ? { yearFrom: null, yearTo: null } : { yearFrom: d, yearTo: d + 9 })
                }
              >
                {d}s
              </Pill>
            );
          })}
          <span className="mx-0.5 h-4 w-px shrink-0 bg-rule" aria-hidden />
          {RATINGS.map((r) => {
            const on = value.minRating === r;
            return (
              <Pill
                key={r}
                active={on}
                onClick={() => set({ minRating: on ? null : r })}
              >
                <Star className="mr-0.5 inline h-2.5 w-2.5" />{r}+
              </Pill>
            );
          })}
        </div>
      )}

      {open && (
        <FiltersPopover
          section={section}
          value={value}
          onChange={onChange}
          facets={facets}
          groups={groups}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** One dropdown for the long tail. Nothing here is on screen until asked for. */
function FiltersPopover({
  section, value, onChange, facets, groups, onClose,
}: {
  section: Section;
  value: Filters;
  onChange: (f: Filters) => void;
  facets: Facets | undefined;
  groups: boolean;
  onClose: () => void;
}) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();
  const shape = useShape();
  const { scope } = useScope();
  const set = (p: Partial<Filters>) => onChange({ ...value, ...p });
  const [hidden, setHidden] = useState(false);

  const selectedMarkets = useMemo(
    () => effectiveMarkets(value.markets, prefs),
    [value.markets, prefs],
  );
  /*
   * Country and group: every axis but their own, plus the package.
   *
   * `listing` is the country list's scope, so it carries no country of its own —
   * ticking France must not be what removes Germany from the list it was ticked
   * in. `groupScope` is one level down and DOES take the ticked countries,
   * because a group is inside a country: that is the same axis narrowing itself,
   * which is a drill-down rather than a collapse.
   */
  const listing = useMemo(
    () => crossScope(scope, value, 'groups'),
    [scope, value],
  );
  const groupScope = useMemo(() => ({
    ...listing,
    ...(selectedMarkets.length > 0 ? { markets: selectedMarkets } : {}),
  }), [listing, selectedMarkets]);

  /*
   * Language and source, each blind to itself.
   *
   * One request serves all three facet lists, so a single scope cannot be right
   * for all of them — the genre chips want the chosen language applied, the
   * language select must not have it applied or it would offer exactly the one
   * value already chosen. Two more queries, and when neither is set (the usual
   * case) all three collapse to the same react-query key and cost nothing.
   */
  const regionScope = useMemo(
    () => crossScope(scope, value, 'region', selectedMarkets),
    [scope, value, selectedMarkets],
  );
  const sourceScope = useMemo(
    () => crossScope(scope, value, 'source', selectedMarkets),
    [scope, value, selectedMarkets],
  );
  const axisFacets = useQueries({
    queries: [regionScope, sourceScope].map((sc) => ({
      queryKey: ['facets', section, scopeKey(sc)],
      queryFn: () => api.facets(section, sc),
      retry: false,
      staleTime: 5 * 60_000,
    })),
  });
  /* The chosen value is kept on its own list even when the rest of the scope
     leaves it counting zero — a select whose current value is not among its
     options renders blank, and the filter becomes impossible to clear. */
  const regions = withChosen(axisFacets[0]?.data?.regions ?? facets?.regions ?? [], value.region);
  const sources = withChosen(axisFacets[1]?.data?.sources ?? facets?.sources ?? [], value.source);

  const tree = useGroupTree(section, groupScope);
  const { markets } = useMarkets(section, listing, tree.tree, useCategories(section, groupScope));
  const groupOptions = useMemo(() => flattenGroups(tree.tree), [tree.tree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleMarket = (id: string) =>
    set({
      favs: false,
      path: null,
      paths: [],
      markets: value.markets.includes(id)
        ? value.markets.filter((m) => m !== id)
        : [...value.markets, id],
    });

  /*
   * Format, era and season — the three that came off the strip.
   *
   * "Remove that 4K and those 2 more, and move them in the filters popover, I
   * want that area clean." They belong here on their own merits: they are set
   * once and left alone, unlike a genre, which is what browsing IS. Kept as
   * chips rather than another Select because there are exactly three of them and
   * any of the three can be on at once.
   *
   * Counted the same way as everything else — what the grid would hold with this
   * one also on — so a zero here means the same thing it means anywhere: these
   * words describe nothing in what you are already looking at.
   */
  const refine = useMemo(() => {
    const found = new Map((facets?.genres ?? []).map((g) => [g.id, g]));
    return [...REFINING].map((id) => found.get(id) ?? { id, label: id, count: 0 });
  }, [facets]);

  const toggleRefine = (id: string) => onChange({
    ...value,
    genres: value.genres.includes(id)
      ? value.genres.filter((g) => g !== id)
      : [...value.genres, id],
  });

  const body = <div className="space-y-2 p-2">
          <div>
            <Label>Format</Label>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {refine.map((g) => {
                const on = value.genres.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleRefine(g.id)}
                    aria-pressed={on}
                    title={g.count === 0
                      ? `Nothing is both ${facetLabel(g)} and what is already picked`
                      : `${g.count.toLocaleString()} titles — ${on ? 'remove' : 'add'}`}
                    className={`tap border px-2 py-1 font-mono text-[length:var(--t-2xs)] touch:py-2
                      ${on
                        ? 'border-tally text-tally'
                        : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink'}`}
                  >
                    {facetLabel(g)}
                    {tallyOf(g.count) !== null && (
                      <span className="ml-1 text-ink-3">{tallyOf(g.count)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Label>Sort</Label>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Select
                label="Sort"
                value={value.sort}
                onChange={(k) => {
                  const sort = k as SortKey;
                  set({ sort, dir: defaultDir(sort) });
                }}
                className="touch:[&_button]:py-2"
                options={SORTS.map((o) => ({ value: o.id, label: o.label }))}
              />
              {value.sort !== 'default' && (
                <button
                  type="button"
                  onClick={() => set({ dir: value.dir === 'asc' ? 'desc' : 'asc' })}
                  title="Reverse order"
                  className="tap border border-rule px-2 py-1 font-mono text-[length:var(--t-2xs)] text-ink-2
                             hover:border-tally hover:text-tally touch:py-2"
                >
                  {value.dir === 'asc' ? '↑' : '↓'}
                </button>
              )}
            </div>
          </div>

          {/*
            No country list on a television.
            
            "Remove all countries filter from tv." It is a long list of two-letter
            markets in a popover that a remote walks one row at a time, and it
            answers a question the sidebar and the group tree already answer on
            the screens where it matters: Live TV organises BY country, and a
            film's package name carries its market. On a desk it stays — a cursor
            can flick down 79 rows and a mouse user asked for it — which is why
            this is a layout rule rather than a deletion.
          */}
          {groups && !shape.remote && (
            <div>
              <Label>Country</Label>
              <div className="mt-0.5 max-h-28 space-y-px overflow-y-auto rounded-[var(--r-md)] border border-rule/60">
                {markets.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleMarket(m.id)}
                    className={`flex w-full items-center gap-2 px-2 py-0.5 text-left text-[length:var(--t-xs)]
                      ${value.markets.includes(m.id) ? 'bg-tally/10 text-tally' : 'text-ink-2 hover:bg-panel-2'}`}
                  >
                    <span className={`h-2 w-2 shrink-0 border ${
                      value.markets.includes(m.id) ? 'border-tally bg-tally' : 'border-rule'
                    }`} />
                    <span className="min-w-0 flex-1 truncate">{m.label || marketName(m.id)}</span>
                    <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">{tallyOf(m.count)}</span>
                  </button>
                ))}
                {markets.length === 0 && (
                  <p className="px-2 py-1 font-mono text-[length:var(--t-2xs)] text-ink-3">no countries</p>
                )}
              </div>
            </div>
          )}

          {groups && tree.ok && (
            <div>
              <Label>Group</Label>
              <Select
                label="Group"
                fullWidth
                className="mt-1"
                value={value.path ?? ''}
                onChange={(v) => set({ path: v || null, paths: [] })}
                options={[
                  { value: '', label: 'any group' },
                  ...groupOptions.map((g) => ({
                    value: g.id,
                    label: g.label,
                    hint: tallyOf(g.count) ?? '',
                  })),
                ]}
              />
            </div>
          )}

          {(regions.length > 0 || sources.length > 0) && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Language</Label>
                <Select
                  label="Language"
                  fullWidth
                  className="mt-1"
                  value={value.region ?? ''}
                  onChange={(v) => set({ region: v || null })}
                  options={[
                    { value: '', label: 'any' },
                    ...regions.map((r) => ({
                      value: r.id,
                      label: r.label,
                      hint: tallyOf(r.count) ?? '',
                    })),
                  ]}
                />
              </div>
              <div>
                <Label>Source</Label>
                <Select
                  label="Source"
                  fullWidth
                  className="mt-1"
                  value={value.source ?? ''}
                  onChange={(v) => set({ source: v || null })}
                  options={[
                    { value: '', label: 'any' },
                    ...sources.map((r) => ({
                      value: r.id,
                      label: r.label,
                      hint: tallyOf(r.count) ?? '',
                    })),
                  ]}
                />
              </div>
            </div>
          )}

          {section !== 'live' && (
            <>
              <div>
                <Label>Decade</Label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {DECADES.map((d) => (
                    <Pill
                      key={d}
                      active={value.yearFrom === d && value.yearTo === d + 9}
                      onClick={() =>
                        set(
                          value.yearFrom === d && value.yearTo === d + 9
                            ? { yearFrom: null, yearTo: null }
                            : { yearFrom: d, yearTo: d + 9 },
                        )
                      }
                    >
                      {d}s
                    </Pill>
                  ))}
                  <input
                    type="number" min={1900} max={THIS_YEAR + 1} placeholder="from"
                    value={value.yearFrom ?? ''}
                    onChange={(e) => set({ yearFrom: e.target.value ? Number(e.target.value) : null })}
                    className="w-16 border border-rule bg-ground px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)]
                               text-ink placeholder:text-ink-3 focus:border-focus outline-none"
                  />
                  <input
                    type="number" min={1900} max={THIS_YEAR + 1} placeholder="to"
                    value={value.yearTo ?? ''}
                    onChange={(e) => set({ yearTo: e.target.value ? Number(e.target.value) : null })}
                    className="w-16 border border-rule bg-ground px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)]
                               text-ink placeholder:text-ink-3 focus:border-focus outline-none"
                  />
                </div>
              </div>

              <div>
                <Label>Minimum rating</Label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {RATINGS.map((r) => (
                    <Pill
                      key={r}
                      active={value.minRating === r}
                      onClick={() => set({ minRating: value.minRating === r ? null : r })}
                    >
                      <Star className="mr-0.5 inline h-2.5 w-2.5" />{r}+
                    </Pill>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="border-t border-rule/60 pt-2">
            <button
              type="button"
              onClick={() => setHidden((h) => !h)}
              className="flex items-center gap-1 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:text-tally"
            >
              <EyeOff className="h-3 w-3" /> Hidden groups
              <ChevronDown className={`h-3 w-3 transition-transform ${hidden ? 'rotate-180' : ''}`} />
            </button>
            {hidden && (
              <div className="mt-1.5">
                <HiddenPanel />
              </div>
            )}
          </div>
  </div>;

  /**
   * Where the long tail lives — in two containers.
   *
   * Beside a cursor it is a popover anchored under the button that opened it, which
   * is right when the page behind is worth keeping in view. On glass that same
   * popover is a 34rem box asked to fit a 24rem screen, so it becomes a sheet:
   * bottom on a phone, where the thumb is, and a side drawer on a tablet, which is
   * wide enough that a full-width bottom sheet would just be a lot of empty row.
   * The contents are the same JSX either way.
   */
  /* Never on a television: the filters are a panel, not a sheet. */
  if (false) {
    return (
      <Sheet title="Filters" onClose={onClose} side={shape.ff === 'phone' ? 'bottom' : 'right'}>
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </Sheet>
    );
  }

  return (
    <>
      <button data-nav-skip className="fixed inset-0 z-40 cursor-default" aria-label="Close filters" onClick={onClose} />
      <div
        data-nav-contain
        className="glass-float sheet-panel absolute left-3 right-3 top-full z-50 max-h-[70vh] overflow-y-auto border border-rule
                   bg-panel shadow-2xl anim-rise md:right-auto md:w-[34rem]"
      >
        <div className="flex items-center justify-between border-b border-rule px-3 py-1.5">
          <span className="font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">FILTERS</span>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {body}
      </div>
    </>
  );
}
