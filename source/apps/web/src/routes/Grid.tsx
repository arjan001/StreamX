import { useCallback, useMemo, useState } from 'react';
import { useShape } from '../lib/formFactor';
import { useSearchParams } from 'react-router-dom';
import { useKeyLayer, type Binding } from '../lib/keys';
import {
  EMPTY_FILTERS, FilterBar, filtersFromParams, paramsFromFilters, type Filters,
} from '../components/FilterBar';
import { browseSignature, TitleGrid, useBrowseQuery } from '../components/TitleGrid';
import { Nothing } from '../components/Nothing';
import { hasSection, useInventory } from '../lib/sections';
import { openAddAccount } from '../lib/addAccount';
import { localEnabled } from '../lib/localCatalogue';
import { getSession } from '../lib/session';
import { useSkin } from '../lib/skin';
import { Clapperboard, Tv2 } from 'lucide-react';
import { LiveSidebar } from '../components/LiveSidebar';
import { useScope } from '../lib/scope';
import { useGridMetrics } from '../lib/useGridMetrics';
import { toggleFav, type FavSection } from '../lib/prefs';
import type { Section } from '../lib/api';

/**
 * Poster grid for movies and series, virtualised by ROW.
 *
 * Filter state lives in the URL and nowhere else, so /movies?genre=comedy or
 * ?path=EN/NETFLIX is a real address the detail pages can link to, and the back
 * button walks filters the way people expect.
 *
 * The grid itself and the query behind it are `components/TitleGrid` — shared
 * with the series desk, which grew a grid of the same library underneath its
 * panes. See that file on why there is exactly one copy of the query.
 */
export function Grid({ section }: { section: Section }) {
  const [params, setParams] = useSearchParams();
  const { shell } = useSkin();
  const modern = shell === 'modern';
  /*
   * Newest first, unless the viewer chose an order.
   *
   * "show latest movies and stuff on top, because right now it never changes,
   * and it's always the same". It was the provider's own order, which is the
   * order the panel was filled in and moves only when the panel does. The panel
   * stamps every title with when it was added, so the grid opens on that, and
   * Provider is still one choice in Sort — written into the address when it is
   * picked, because it is no longer what an address without a sort means.
   */
  const filters = useMemo(() => {
    const f = filtersFromParams(params);
    if (section === 'live' || params.has('sort')) return f;
    return { ...f, sort: 'added' as const, dir: params.get('dir') === 'asc' ? 'asc' as const : 'desc' as const };
  }, [params, section]);
  const setFilters = useCallback(
    // replace: a filter is a change of view, not twenty entries of history.
    (f: Filters) => {
      const p = paramsFromFilters(f);
      if (section !== 'live' && f.sort === 'default') p.set('sort', 'default');
      setParams(p, { replace: true });
    },
    [setParams, section],
  );

  /**
   * The star and the sort, on two coloured buttons.
   *
   * RED reads the id off whichever tile has focus (`data-stream-id`, set by
   * `PosterCard`) rather than tracking a "selected" index — the focused element IS
   * the selection on a D-pad, and any second copy of that fact would drift from
   * it. YELLOW flips the sort, which is the one filter worth a single press: on a
   * list of 50,343 films, "newest first" and "oldest first" are two different
   * pages.
   */
  const bindings = useMemo((): Binding[] => {
    const fav = () => {
      const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-stream-id]');
      const raw = el?.dataset['streamId'];
      const kindHere = el?.dataset['favSection'];
      if (raw === undefined || raw === '' || kindHere === undefined) return;
      toggleFav(kindHere as FavSection, Number(raw));
    };
    return [
      { intent: 'red', label: 'Favourite', act: fav },
      { intent: 'favourite', label: 'Favourite', act: fav },
      {
        intent: 'yellow',
        label: filters.dir === 'desc' ? 'Sort ascending' : 'Sort descending',
        act: () => setFilters({ ...filters, dir: filters.dir === 'desc' ? 'asc' : 'desc' }),
      },
    ];
  }, [filters, setFilters]);
  useKeyLayer(bindings);

  const { query, offered } = useBrowseQuery(section, filters);

  /**
   * Five posters across — asked for explicitly. Fitting by min width was giving
   * seven or eight tiny tiles on the same screens.
   */
  /* Six on a phone held sideways, where the grid has the whole width (the rail
     is a drawer there) and five would make every poster taller than half the
     screen. */
  const { touchScreen } = useShape();
  const [gridRef, metrics] = useGridMetrics(168, 230, touchScreen === 'phone' ? 6 : 5);

  const [stats, setStats] = useState<{ total: number; loading: boolean; error: string | null }>({
    total: 0, loading: true, error: null,
  });
  const onStats = useCallback(
    (s: { total: number; loading: boolean; error: string | null }) =>
      setStats((p) =>
        p.total === s.total && p.loading === s.loading && p.error === s.error ? p : s,
      ),
    [],
  );

  /*
   * Countries and groups, on the page rather than behind a button.
   *
   * The films page had no package picker at all: the group tree existed, but only
   * inside the Filters popover, so a subscription whose contents are downloaded
   * ON DEMAND opened Movies, found nothing downloaded, and said "0 titles — no
   * films match these filters. Clear filters." There were no filters to clear and
   * 66,709 films to fetch. Live never had that problem because its countries are
   * a permanent sidebar, and picking one is what fetches the package. This is the
   * same sidebar, on the same terms — `LiveSidebar` has taken a `section` since
   * it was written, and this is the caller that was missing.
   */
  const local = localEnabled() && getSession() === null;
  /* Live first, because it is the thing this device can actually do. The second
     is the thing that would change the answer, and only when it would. */
  const liveFirst = [
    { to: '/live', label: 'Go to Live TV', primary: true },
    ...(local ? [{ act: openAddAccount, label: 'Add a source' }] : []),
  ];

  /*
   * A section the library does not have is a statement, not a grid.
   *
   * This is the difference `Nothing` exists to keep straight. A live-only source
   * has no films AT ALL, and what it used to show was the complete
   * films apparatus — favourites, country, sort, year, rating, filters, hidden —
   * over the words "nothing here. loosen a filter, or check the Hidden list".
   * There is no filter to loosen. The toolbar is nine controls for operating on
   * nothing, and the advice cannot work.
   *
   * Note this asks the INVENTORY, not `stats.total`: a total of zero is also what
   * a filter that excludes everything produces, and those two need opposite
   * answers. Only when the library itself has none does the page become a
   * statement; a filter that matches nothing keeps its toolbar, because undoing
   * it is exactly what the reader needs to do next.
   */
  const inventory = useInventory();
  if (!hasSection(section, inventory)) {
    const film = section === 'movies';
    return film ? (
      <Nothing
        Icon={Clapperboard}
        title="No films in this library"
        body={
          local
            ? 'The source on this device is live TV only. Add a source that has films.'
            : 'This source does not include films. Live TV and anything else it carries are still here.'
        }
        actions={liveFirst}
      />
    ) : (
      <Nothing
        Icon={Tv2}
        title="No series in this library"
        body={
          local
            ? 'The source on this device is live TV only. Add a source that has series.'
            : 'This source does not include series. Live TV and anything else it carries are still here.'
        }
        actions={liveFirst}
      />
    );
  }

  const sidebar = (
    <LiveSidebar
      section={section}
      value={filters}
      onChange={(patch) => setFilters({ ...filters, ...patch })}
    />
  );

  /* Whether this view is asking a narrower question than "everything". */
  /* An order is not a filter: newest-first must not make the page look narrowed. */
  const filtered = paramsFromFilters({ ...filters, sort: 'default', dir: 'asc' }).toString() !== '';

  const column = (
    <>
      {/*
        All + Filters on the left; genre chips scroll beside them, scoped to the
        sidebar country/package, and a field that searches inside whatever the
        grid is currently showing. Countries and groups stay in the sidebar.

        ── series carries this too ──

        It did not, for a while: "why did you add filters to the series, remove
        that" took the whole strip off this section, on the reasoning that the
        desk at `/series/:id` carries a strip of its own. That reversed — "that
        filter and genres in series, genres missing" — so both libraries browse
        the same way again, from one component, with the desk's strip unchanged.
      */}
      <FilterBar
        section={section}
        value={filters}
        onChange={setFilters}
        total={stats.total}
        loading={stats.loading}
        genres
        groups={false}
        defaultSort={section === 'live' ? 'default' : 'added'}
      />
      {stats.error && (
        <p className="shrink-0 px-3 py-2 font-mono text-xs text-alert">{stats.error}</p>
      )}
      {/* Absolute fill: a flex child that grows with VirtualList content makes
          scrollHeight === clientHeight, traps the wheel (overscroll contain), and
          mounts every poster — OOM on Movies. Bound the pane to the viewport. */}
      <div ref={gridRef} className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <TitleGrid
            key={browseSignature(query)}
            section={section}
            query={query}
            metrics={metrics}
            onStats={onStats}
            onClear={() => setFilters({
              ...EMPTY_FILTERS, ...(section !== 'live' ? { sort: 'added' as const, dir: 'desc' as const } : {}),
            })}
            offered={offered}
            filtered={filtered}
          />
        </div>
      </div>
    </>
  );

  return (
    <div
      className={`vod-page flex h-full min-h-0 min-w-0 ${modern ? 'gap-3 p-3 tv:gap-4 tv:p-4' : ''}`}
    >
      {/* The same share the Live rail takes, so the two browse screens line up. */}
      <div
        /* A section, like Live's rail: two full-height columns beside each other
           with nothing declared between them is one flat search, and DOWN at the
           bottom of this list used to fall sideways into the posters. */
        data-nav-scope
        /* Modern: exactly Live's rail now, which the note above always claimed
           and was not true — this was 18%/14rem/17rem, 13px narrower on the box.
           Measured in the list shape at 960x540, after the padding came out:
           184 of 364 film categories and 134 of 232 series categories still
           truncated at 182px, and 135 and 85 at Live's 195px. Most rows cut off
           is the case for widening; one width for both rails is the condition. */
        className={`pane-fill h-full shrink-0 overflow-hidden ${
          modern
            ? 'vod-sidebar glass-float w-[20%] min-w-[15rem] max-w-[20rem]'
            : 'w-[20%] min-w-[14rem] max-w-[24rem]'
        }`}
      >
        {sidebar}
      </div>
      <div
        data-nav-scope
        className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          modern ? 'vod-grid glass-float' : ''
        }`}
      >
        {column}
      </div>
    </div>
  );
}
