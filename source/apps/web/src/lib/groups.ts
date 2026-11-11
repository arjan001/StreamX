import { useEffect, useMemo } from 'react';
import { labelFor } from '@iptv/core-xtream';
import { marketKind, marketSort, type MarketKind } from './marketOrder.ts';
import { getSession } from './session.ts';
import { useQuery } from '@tanstack/react-query';
import { migrateHiddenCats, usePrefs } from './prefs.ts';
import { applyOrder } from './ordering.ts';
import {
  api, type Category, type GroupNode, type GroupsResponse, type Section,
  type Hidden,
} from './api.ts';
import { isAdultPath } from './adultFilter.ts';

/**
 * The group hierarchy, as tabs.
 *
 * A provider ships one flat list of 119 movie / 95 series / 829 live category
 * names, but the names encode a tree — "|FR| CRIME | POLICIER" is market, then
 * package, then nested group. The API derives that tree; this component walks it
 * one level at a time so browsing is three clicks instead of scrolling 829 rows.
 *
 * Everything here degrades: the tree endpoint may not exist, and the caller falls
 * back to flat category tabs when `ok` is false.
 */

export interface Market {
  id: string;
  label: string;
  count: number;
  /** Category ids in this market. Only the derived fallback fills this in. */
  categories: number[];
}

/** Where a market list came from, which decides how a selection is filtered. */
export type MarketSource = 'api' | 'tree' | 'categories';

/**
 * What each market code MEANS, in the films-and-series namespace.
 *
 * The shared table (`MARKET_LABELS` in core-xtream) was verified against live
 * CHANNEL names, and this provider does not use one namespace for both: `LA` is
 * Latvia on the live side (LV| channels) and LATINO SERIES on the VOD side, so
 * the series sidebar was labelling Latin American films "Latvia". Three more
 * were simply missing and rendered as raw letters.
 *
 * Every entry below was read off the provider's own category names, fetched
 * 2026-09-08 from `get_vod_categories` (365) and `get_series_categories` (232),
 * because guessing from the code is how `AF` becomes Afghanistan:
 *
 *   AF    AFRICAN MOVIES, SOUTH AFRICA, AFRICAN SERIES        -> Africa
 *   SCA   NORDIC FILMS 4K, NORDIC CLASSIC, NORDIC KIDS 4K     -> Scandinavia
 *   IR    PERSIAN SUB/DUB, PERSIAN MOVIES, PERSIAN CARTOONS   -> Iran
 *   LA    LATINO SERIES                                       -> Latin America
 *   SO    SOMALI MOVIES, SOMALIA TURKISH SERIES               -> Somalia
 *   ISR   HEBREW, HEBREW SERIES                               -> Israel
 *   CN    CHINESE MOVIES                                      -> China
 *   IN    MALAYALAM, TAMIL, TELEGU, HINDI SUBS                -> India
 *   DK    DANSKE 1900-2000, DENMARK 4K/UHD                    -> Denmark
 *   SE    FILM 1900-2018, BARN                                -> Sweden
 *   NO    NORWAY, NORSK SERIE                                 -> Norway
 *   PK    PAKISTANI MOVIES, QAWWALI, NAATS                    -> Pakistan
 *   MT    MALTA MOVIES                                        -> Malta
 *   EXYU  STRANI FILMOVI, DOKUMENTARNI FILMOVI                -> Ex-Yugoslavia
 *
 * `IR` is the interesting one: the shared table deliberately leaves it blank
 * because the provider reuses it for Ireland and Iran — and in the VOD lists
 * every one of its nine categories is Persian, so here it is not ambiguous.
 */
const VOD_MARKET_NAMES: Record<string, string> = {
  AF: 'Africa', SCA: 'Scandinavia', IR: 'Iran', LA: 'Latin America',
  SO: 'Somalia', ISR: 'Israel', CN: 'China', IN: 'India', DK: 'Denmark',
  SE: 'Sweden', NO: 'Norway', PK: 'Pakistan', MT: 'Malta',
  EXYU: 'Ex-Yugoslavia', JP: 'Japan', FI: 'Finland', HU: 'Hungary',
  BG: 'Bulgaria', RO: 'Romania', BR: 'Brazil', PH: 'Philippines',
};

/**
 * Names for the market codes this catalogue actually uses.
 *
 * Only the fallback needs it — the markets endpoint returns proper names — but a
 * picker that says "AR" instead of "Arabic" is not a country filter.
 */
const MARKET_NAMES: Record<string, string> = {
  AFG: 'Afghanistan', AFR: 'Africa', AL: 'Albania', AR: 'Arabic', ASIA: 'Asia',
  BE: 'Belgium', BR: 'Brazil', CA: 'Canada', DE: 'Germany', DK: 'Denmark',
  EN: 'English', ES: 'Spain', EX: 'Ex-Yugoslavia', FI: 'Finland', FR: 'France',
  GR: 'Greece', IN: 'India', IT: 'Italy', LAT: 'Latin America', MU: 'Music',
  MULTI: 'Multi-market', MX: 'Mexico', NL: 'Netherlands', NO: 'Norway', OTHER: 'Other',
  PK: 'Pakistan', PL: 'Poland', PT: 'Portugal', QC: 'Québec', RO: 'Romania',
  RU: 'Russia', SE: 'Sweden', SPT: 'Sports', SWEDEN: 'Sweden', TR: 'Turkey',
  UK: 'United Kingdom', US: 'United States',
};

export function marketName(code: string, section?: Section): string {
  const up = code.toUpperCase();
  /* The films-and-series meaning FIRST when the caller says which section it is
     asking about — see `VOD_MARKET_NAMES`. Without a section this behaves exactly
     as it did, which keeps every caller that has no section to give. */
  if (section === 'movies' || section === 'series') {
    const vod = VOD_MARKET_NAMES[up];
    if (vod !== undefined) return vod;
  }
  /* The shared table next — it knows the provider's codes AND the free lists'
     country namespace (`NLF` -> Netherlands), and having three copies of this
     mapping in one repo is how a market ends up named two different things on two
     screens. `labelFor` returns the code unchanged when it has no name for it,
     which is the signal to try the few extras below. */
  const shared = labelFor(up, 1);
  if (shared !== up) return shared;
  return MARKET_NAMES[up] ?? code;
}

/**
 * What KIND of thing a market code names, and `marketKind` itself.
 *
 * Moved to `lib/marketOrder.ts` — `marketSort` there needs the same
 * country/language/region/topic split this picker uses for its headings ("then
 * every non-country market after countries", rule 5), and a second copy of that
 * classification is how a market ends up sorted one way and headed another.
 * Re-exported so nothing that imported either name from here has to change; see
 * `marketOrder.ts` for the full comment, including the owner's own words on why
 * the split exists at all ("show really bad like languges and counties mixed").
 */
export { marketKind, type MarketKind };

/** Headings for each kind, in the order a picker should show them. */
export const MARKET_KINDS: { kind: MarketKind; label: string }[] = [
  { kind: 'country', label: 'Countries' },
  { kind: 'language', label: 'Languages' },
  { kind: 'region', label: 'Regions' },
  { kind: 'topic', label: 'Other' },
];

const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
/** Copies first: these arrays come out of the query cache and must not be sorted in place. */
const biggestFirst = <T extends { count: number }>(rows: T[]): T[] => [...rows].sort(byCount);

/**
 * The hidden list, as query params.
 *
 * Both are passed to every metadata request, not just to items: a genre chip that
 * says 5,453 when 2,000 of them are in markets you hid is a worse number than none.
 */
/** Stable cache-key fragment for a scope. */
export function scopeKey(scope: Hidden): string {
  return [
    (scope.markets ?? []).join('+'),
    (scope.paths ?? []).join('+'),
    (scope.genres ?? []).join('+'),
    (scope.cats ?? []).join('+'),
    scope.region ?? '',
    scope.source ?? '',
    scope.yearFrom ?? '',
    scope.yearTo ?? '',
    scope.minRating ?? '',
    scope.q ?? '',
    (scope.hidePaths ?? []).join('+'),
    (scope.hideCats ?? []).join('+'),
    (scope.hideCatRefs ?? []).join('+'),
    (scope.hideStreams ?? []).join('+'),
    /* An exclude is part of the answer: without it here, Live's sidebar was
       served the package list cached BEFORE sport was left out, and every
       sport package stayed on it. */
    scope.excludeTopic ?? '',
  ].join('|');
}

/** Hiding a parent hides everything under it — the list is a path prefix list. */
export function isHidden(id: string, hide: string[]): boolean {
  return hide.some((h) => h !== '' && (id === h || id.startsWith(`${h}/`)));
}

/** Every node in the tree, labelled with its ancestors, for a flat picker. */
export function flattenGroups(
  nodes: GroupNode[],
  trail: string[] = [],
): { id: string; label: string; count: number }[] {
  const out: { id: string; label: string; count: number }[] = [];
  for (const n of nodes) {
    const labels = [...trail, n.label];
    out.push({ id: n.id, label: labels.join(' › '), count: n.count });
    if (n.children.length > 0) out.push(...flattenGroups(n.children, labels));
  }
  return out;
}

function prune(nodes: GroupNode[], hide: string[]): GroupNode[] {
  if (hide.length === 0) return nodes;
  return nodes
    .filter((n) => !isHidden(n.id, hide))
    .map((n) => ({ ...n, children: prune(n.children, hide) }));
}

/** Shares react-query's cache key with the filter bar, so this costs no extra request. */
export function useCategories(section: Section, scope: Hidden = {}): Category[] {
  const [prefs] = usePrefs();
  const { data } = useQuery({
    queryKey: ['categories', section, scopeKey(scope)],
    queryFn: () => api.categories(section, scope),
    staleTime: 5 * 60_000,
  });
  const rows = data?.categories;

  /**
   * Convert a legacy hidden list off row ids, at the first opportunity.
   *
   * `hideCats` held per-generation Postgres ids, which every re-ingest reassigns —
   * so a curated hidden list silently began hiding DIFFERENT packages after a
   * refresh. The conversion is exact only while the generation that wrote those
   * ids is still live, which is why it happens the moment any category list is
   * loaded rather than behind a settings screen somebody may never open.
   *
   * It needs its OWN request, unscoped, and that is not an optimisation detail:
   * the list above is fetched WITH the hidden ids applied, so the very categories
   * being migrated are the ones missing from it. Translating against that map
   * finds nothing and drops the lot — which the probe caught by asserting the
   * refs afterwards rather than trusting that the code had run.
   *
   * One request, only for a profile that still carries ids, and never again after:
   * `migrateHiddenCats` clears them.
   */
  const legacy = prefs.hideCats.length > 0;
  const { data: everything } = useQuery({
    queryKey: ['categories', section, 'unscoped-for-migration'],
    queryFn: () => api.categories(section, {}),
    enabled: legacy,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!legacy) return;
    const all = everything?.categories;
    if (!all || all.length === 0) return;
    migrateHiddenCats(new Map(all.map((c) => [c.id, c.ref] as const)));
  }, [legacy, everything]);

  /*
   * The viewer's own order, applied at the one place every category list comes
   * from — the filter bar, the live sidebar, the grid's package picker and the
   * manager itself. Applying it here rather than at four call sites is what makes
   * "drag these to the top" mean the same thing everywhere in the app.
   */
  const order = prefs.catOrder[section] ?? [];
  /* The same two namespaces the country list drops — see `offered` below. A
     package belongs to a market, so a free package under a signed-in line is
     the same duplicate a free country was, and an adult package is never offered. */
  const paid = getSession() !== null;
  return useMemo(
    () => applyOrder(
      (rows ?? []).filter((c) => {
        const region = (c.region ?? '').toUpperCase();
        if (region === '') return true;
        if (isAdultPath(region)) return false;
        if (paid && /^[A-Z]{2}F$/.test(region)) return false;
        return true;
      }),
      order,
    ),
    [rows, order.join('|'), paid],
  );
}

export interface GroupTree {
  tree: GroupNode[];
  total: number;
  ungrouped: number;
  /** False when the endpoint is missing or empty — the caller must fall back. */
  ok: boolean;
  loading: boolean;
}


/**
 * Two whole namespaces that do not belong in a country list.
 *
 * **Adult is never a place.** The `18` market is dropped from every filter, count
 * and group tree; there is no switch that brings it back.
 *
 * **Free is redundant once a line is attached.** "when paid is active no need to
 * show free stuff, bcs paid has it all". Measured on this line: 79 paid markets
 * against 178 free ones, carrying the same broadcasters — so a signed-in device
 * listed "Netherlands" and "Netherlands (free)" as two countries, twice as many
 * rows to travel for one country. The free lists are what a device watches
 * BEFORE it signs in and they stay on it; they are simply not offered beside a
 * subscription that covers them.
 *
 * `XXF` is the free namespace — `NLF` is the Dutch free list — two letters plus
 * F by construction, from `labelFor` in core-xtream.
 */
const FREE_MARKET = /^[A-Z]{2}F$/;

function offered<T extends { id: string }>(rows: T[]): T[] {
  const paid = getSession() !== null;
  return rows.filter((r) => {
    if (isAdultPath(r.id)) return false;
    if (paid && FREE_MARKET.test(r.id.toUpperCase())) return false;
    return true;
  });
}

export function useGroupTree(section: Section, scope: Hidden = {}): GroupTree {
  const hidePaths = scope.hidePaths ?? [];
  /* Depth 1 of this tree IS the country list — it is what the live sidebar
     draws — so it takes the same order as `useMarkets`, or the sidebar and the
     filter bar disagree about where a country belongs. */
  const [prefs] = usePrefs();
  const order = prefs.marketOrder;
  const q = useQuery({
    // The scope is part of the key: changing it has to refetch the counts.
    queryKey: ['groups', section, scopeKey(scope)],
    queryFn: () => api.groups(section, scope),
    // A missing endpoint must fail once and fall back, not retry three times.
    retry: false,
    staleTime: 5 * 60_000,
  });
  const tree = useMemo(
    () => marketSort(offered(prune(q.data?.tree ?? [], hidePaths)), order, section),
    [q.data, hidePaths, order, section],
  );
  return {
    tree,
    total: q.data?.total ?? 0,
    ungrouped: q.data?.ungrouped ?? 0,
    ok: tree.length > 0,
    loading: q.isLoading,
  };
}

/**
 * api.ts has no markets() yet; this is the only place that names the endpoint.
 *
 * Note the endpoint's own `categories` field is a COUNT, not a list, so it is
 * ignored here — a market selection filters by path, and only the derived
 * fallback ever needs category ids.
 */
async function fetchMarkets(section: Section, scope: Hidden): Promise<Market[]> {
  const body = await api.markets(section, scope);
  return body.markets.flatMap((m) => {
    if (typeof m.id !== 'string' || m.id === '') return [];
    return [
      {
        id: m.id,
        label: typeof m.label === 'string' && m.label !== '' ? m.label : marketName(m.id),
        count: typeof m.count === 'number' ? m.count : 0,
        /**
         * Deliberately empty.
         *
         * `api.Market.categories` is a COUNT; this `Market.categories` is a list of
         * ids, and only the category-prefix fallback can populate it. Filtering by
         * a market from this source goes through the path, not through ids — see
         * `MarketSource`.
         */
        categories: [],
      },
    ];
  });
}

/**
 * Countries/markets as a first-class list.
 *
 * Same axis as depth-1 of the tree, but the endpoint labels it properly. Three
 * sources in descending fidelity, because the endpoint and the tree may both be
 * absent: the category name prefix carries the same signal and is always there.
 */
export function useMarkets(
  section: Section,
  scope: Hidden,
  tree: GroupNode[],
  categories: Category[],
): { markets: Market[]; source: MarketSource } {
  const hidePaths = scope.hidePaths ?? [];
  /*
    The country order is the viewer's, and it belongs HERE rather than in each
    screen that draws a country list.

    There are three of those — the live sidebar, the filter bar and the organise
    screen — and a sort applied in one of them is a country list that reads
    differently depending on where you look at it. See `lib/marketOrder.ts` for
    the rules: the United Kingdom first, then the rest of Europe (the owner's
    own defaults in the owner's order, then whatever Europe is left by size),
    then every other country by size.
  */
  const [prefs] = usePrefs();
  const order = prefs.marketOrder;
  const q = useQuery({
    queryKey: ['markets', section, scopeKey(scope)],
    queryFn: () => fetchMarkets(section, scope),
    retry: false,
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    const live = offered((q.data ?? []).filter((m) => !isHidden(m.id, hidePaths)));
    if (live.length > 0) {
      return { markets: marketSort(live, order, section), source: 'api' as const };
    }

    if (tree.length > 0) {
      return {
        markets: marketSort(
          offered(tree.filter((n) => !isHidden(n.id, hidePaths)))
            .map((n) => ({
              id: n.id,
              label: n.label !== '' ? n.label : marketName(n.id),
              count: n.count,
              categories: [],
            })),
          order,
          section,
        ),
        source: 'tree' as const,
      };
    }

    const acc = new Map<string, Market>();
    for (const c of categories) {
      const id = c.region ?? '';
      if (id === '' || isHidden(id, hidePaths)) continue;
      const cur = acc.get(id) ?? { id, label: marketName(id), count: 0, categories: [] };
      cur.count += c.count;
      cur.categories.push(c.id);
      acc.set(id, cur);
    }
    return {
      markets: marketSort(offered([...acc.values()]), order, section),
      source: 'categories' as const,
    };
  }, [q.data, tree, categories, hidePaths, order, section]);
}

/** Nodes from the root down to `path`, for the breadcrumb and the strips. */
export function pathCrumbs(tree: GroupNode[], path: string | null): GroupNode[] {
  if (!path) return [];
  const segs = path.split('/');
  const out: GroupNode[] = [];
  let level = tree;
  for (let i = 0; i < segs.length; i++) {
    const id = segs.slice(0, i + 1).join('/');
    const hit = level.find((n) => n.id === id);
    if (!hit) break;
    out.push(hit);
    level = hit.children;
  }
  return out;
}
