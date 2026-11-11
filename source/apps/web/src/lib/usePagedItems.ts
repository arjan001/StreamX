import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Item, type Section, type SortKey } from './api';

/** Page size — a reference IPTV app uses 30; 40 is one screenful of a dense grid. */
const PAGE = 40;

/**
 * Lists survive being navigated away from.
 *
 * This hook holds its pages in component state, so every unmount threw them away:
 * Live TV → Movies → Live TV re-fetched the channel list, its total and the first
 * screenful of rows from scratch, and the viewer watched the same skeleton they
 * had already sat through a minute earlier. That is a large part of what "why is
 * it this slow" was actually about — not one slow request, but the same fast
 * request made over and over.
 *
 * Keyed by the same string that already invalidates the hook, so a cache hit is
 * exact by construction: any change of category, sort, filter or hidden list is a
 * different key and cannot collide.
 *
 * Deliberately NOT react-query. These pages are addressed by row index and merged
 * into a sparse map as the virtualiser scrolls; modelling that as a query per page
 * would be thousands of cache entries and a re-render per page.
 */
interface CachedList { total: number; rows: Map<number, Item>; at: number }

/** Distinct lists remembered across navigations. */
const MEM_MAX = 8;

/**
 * How long a remembered list may be shown before it is treated as unknown.
 *
 * Ten minutes. It is only ever the FIRST paint — page zero is re-requested every
 * time regardless, and a changed total throws the rest away — so this bounds how
 * wrong a first frame can be, not how stale the list can get.
 */
const MEM_TTL_MS = 10 * 60_000;

/**
 * Pages kept around the visible window.
 *
 * Without this, scrolling a 40k-film category grew the sparse Map to every row
 * ever seen — tens of thousands of Item objects (name + logo URL each) until the
 * WebView was killed. a reference IPTV app never materialises more than accumulated
 * pages in a VirtualGrid; we keep a fixed ring instead.
 */
const KEEP_PAGES = 3;

const MEM = new Map<string, CachedList>();

function remember(key: string, entry: CachedList): void {
  // Re-inserting moves the key to the end, so deleting the first key evicts the
  // least recently written.
  MEM.delete(key);
  MEM.set(key, entry);
  while (MEM.size > MEM_MAX) {
    const oldest = MEM.keys().next().value;
    if (oldest === undefined) break;
    MEM.delete(oldest);
  }
}

/** Drop Item rows whose page index is far from the visible range. */
function pruneRows(rows: Map<number, Item>, start: number, end: number): Map<number, Item> {
  const lo = Math.max(0, Math.floor(start / PAGE) - KEEP_PAGES) * PAGE;
  const hi = (Math.floor(end / PAGE) + KEEP_PAGES + 1) * PAGE;
  let trimmed = false;
  for (const idx of rows.keys()) {
    if (idx < lo || idx >= hi) {
      rows.delete(idx);
      trimmed = true;
    }
  }
  return trimmed ? new Map(rows) : rows;
}

/**
 * How many times the catalogue underneath these lists has changed.
 *
 * This hook is deliberately not react-query (see the note above), which means
 * `queryClient.invalidateQueries()` — the thing every other part of the app calls
 * when the data changes — does not reach it at all. On a library that downloads
 * packages ON DEMAND that is not a stale-cache nicety: opening a group fetched
 * 46 packages and 22,359 films onto the device, and the page went on saying
 * "0 titles" until it was navigated away from and back. Measured exactly that
 * way; a reload showed 22,358.
 *
 * So forgetting the lists also bumps a number, every mounted list reads it, and
 * a changed number is a changed key — which is the one mechanism this hook
 * already has for "everything you are holding is wrong".
 */
let revision = 0;
const revisionSubs = new Set<() => void>();

/** Forget every remembered list — for a re-ingest, a profile switch, or a
 *  package that has just arrived. */
export function forgetPagedLists(): void {
  MEM.clear();
  revision += 1;
  for (const fn of revisionSubs) fn();
}

function useListRevision(): number {
  const [r, setR] = useState(revision);
  useEffect(() => {
    const fn = (): void => setR(revision);
    revisionSubs.add(fn);
    /* Between the first render and this effect the catalogue may already have
       moved — a package download finishing is exactly that fast. */
    fn();
    return () => {
      revisionSubs.delete(fn);
    };
  }, []);
  return r;
}

export interface PagedQuery {
  categoryId: number | null;
  sort: SortKey;
  dir: 'asc' | 'desc';
  q: string;
  yearFrom?: number | null;
  yearTo?: number | null;
  minRating?: number | null;
  /** "Just added": unix seconds; see `ItemQuery.addedSince`. */
  addedSince?: number | null;
  /** See `ItemQuery.oneCopy`. */
  oneCopy?: boolean;
  archiveOnly?: boolean;
  genre?: string | null;
  region?: string | null;
  source?: string | null;
  path?: string | null;
  paths?: string[];
  cats?: number[];
  markets?: string[];
  genres?: string[];
  hidePaths?: string[];
  hideCats?: number[];
  hideCatRefs?: string[];
  hideStreams?: number[];
  streamIds?: number[];
  /** A whole topic left out — Live TV without its sport; see `ItemQuery`. */
  excludeTopic?: string;
}

/**
 * Sparse page cache addressed by row index.
 *
 * The virtualiser asks for arbitrary windows as the user scrolls, so pages are
 * fetched on demand and held in a sparse map rather than a growing array. A
 * category of 40,000 rows costs ~20KB of transfer per screenful.
 *
 * Any change to the query (category, sort, filter) invalidates everything,
 * including requests already in flight — otherwise a slow response for the old
 * query lands in the new list.
 */
export function usePagedItems(section: Section, query: PagedQuery) {
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Map<number, Item>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(new Map<number, Promise<void>>());
  /**
   * The rows, readable without waiting for a re-render.
   *
   * `rows` is state, so anything holding a callback sees whatever was current when
   * that callback was created. Zapping to the next channel needs the row that
   * ARRIVED, not the one that was cached when the button was wired up — which is
   * precisely the bug that made next/previous silently do nothing at a page
   * boundary. A ref alongside the state is the smallest honest fix.
   */
  const latest = useRef<Map<number, Item>>(new Map());
  const token = useRef(0);
  const revisionNow = useListRevision();
  // Every field that changes the result set must be in the key, or a stale
  // response for the previous filter lands in the new list.
  const key = [
    section, query.categoryId ?? '', query.sort, query.dir, query.q,
    query.yearFrom ?? '', query.yearTo ?? '', query.minRating ?? '', query.addedSince ?? '',
    query.oneCopy ? 1 : '',
    query.archiveOnly ? 1 : '',
    query.genre ?? '', query.region ?? '', query.source ?? '', query.path ?? '',
    // These were reaching api.items at runtime but were invisible to the key, so a
    // change to any of them silently reused the previous filter's pages.
    (query.paths ?? []).join('+'),
    (query.markets ?? []).join('+'),
    (query.genres ?? []).join('+'),
    (query.cats ?? []).join('+'),
    (query.hidePaths ?? []).join('+'),
    (query.hideCats ?? []).join('+'),
    (query.hideCatRefs ?? []).join('+'),
    (query.hideStreams ?? []).join('+'),
    (query.streamIds ?? []).join(','),
    /* An EXCLUDE, and the dangerous direction to forget: a page read before
       Live left sport out would be served back after it did. */
    query.excludeTopic ?? '',
    /* Not a filter — the library itself. See `forgetPagedLists`. */
    revisionNow,
  ].join('|');

  useEffect(() => {
    token.current++;
    inflight.current.clear();
    setError(null);

    /* Paint what this list looked like last time, if it was recent. The request
       below still goes out; this only decides whether the viewer looks at rows or
       at a skeleton while it does. */
    const seed = MEM.get(key);
    const warm = seed !== undefined && Date.now() - seed.at < MEM_TTL_MS;
    /* Only the first screenfuls — a remembered full scroll would rehydrate tens
       of thousands of Item objects on mount. */
    latest.current = warm ? pruneRows(new Map(seed.rows), 0, PAGE * 2) : new Map();
    setRows(latest.current);
    setTotal(warm ? seed.total : 0);
    setLoading(!warm);

    const mine = token.current;
    api
      .items(section, { ...query, offset: 0, limit: PAGE })
      .then((p) => {
        if (token.current !== mine) return;
        setTotal(p.total);
        /*
          A changed total means the catalogue moved under us — a re-ingest, or a
          package hidden on another device — and every remembered row beyond this
          page is now at the wrong index. Keeping them would interleave two
          generations of the list, which is worse than a moment of loading.
        */
        const keep = warm && seed.total === p.total ? new Map(latest.current) : new Map<number, Item>();
        p.rows.forEach((r, i) => keep.set(i, r));
        latest.current = keep;
        setRows(keep);
        remember(key, { total: p.total, rows: keep, at: Date.now() });
      })
      .catch((e: Error) => {
        // A warm list that fails to refresh stays on screen. Showing an error over
        // rows that are perfectly usable is the wrong trade on a flaky connection.
        if (token.current === mine && !warm) setError(e.message);
      })
      .finally(() => token.current === mine && setLoading(false));
    // key captures every field of query that affects the result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /**
   * Fetch the pages covering a row range.
   *
   * Returns a promise now, and that is the point: it used to be fire-and-forget,
   * so a caller that needed a row could only ask for it and then read a cache
   * that had not been filled yet. Every existing caller (the virtualiser's scroll
   * handler) can keep ignoring the promise.
   */
  const ensureRange = useCallback(
    (start: number, end: number): Promise<void> => {
      const mine = token.current;
      const waits: Promise<void>[] = [];
      for (let p = Math.floor(Math.max(0, start) / PAGE); p <= Math.floor(Math.max(0, end) / PAGE); p++) {
        const running = inflight.current.get(p);
        if (running) { waits.push(running); continue; }
        const offset = p * PAGE;
        if (latest.current.has(offset)) continue;
        const job = api
          .items(section, { ...query, offset, limit: PAGE })
          .then((page) => {
            if (token.current !== mine) return;
            const next = pruneRows(new Map(latest.current), start, end);
            page.rows.forEach((r, i) => next.set(offset + i, r));
            latest.current = next;
            setRows(next);
            /* Scrolled-to pages are remembered too, so coming back to a list lands
               where it was rather than at the top of a fresh fetch. The timestamp
               is NOT refreshed here: freshness belongs to page zero, which is what
               gets revalidated on mount. */
            const held = MEM.get(key);
            remember(key, { total: held?.total ?? 0, rows: next, at: held?.at ?? Date.now() });
          })
          .catch(() => {})
          .finally(() => inflight.current.delete(p));
        inflight.current.set(p, job);
        waits.push(job);
      }
      return waits.length === 0 ? Promise.resolve() : Promise.all(waits).then(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  /**
   * One row, fetching its page first if necessary.
   *
   * The API zapping actually wants. `ensureRange` followed by a synchronous read
   * of the cache is the shape that looks right and is wrong.
   */
  const fetchRow = useCallback(
    async (index: number): Promise<Item | null> => {
      if (index < 0) return null;
      const have = latest.current.get(index);
      if (have) return have;
      await ensureRange(index, index);
      return latest.current.get(index) ?? null;
    },
    [ensureRange],
  );

  /** The row cache as it stands right now, for callbacks that cannot re-render. */
  const rowsNow = useCallback(() => latest.current, []);

  return { total, rows, loading, error, ensureRange, fetchRow, rowsNow };
}
