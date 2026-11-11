import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Clapperboard, Tv2 } from 'lucide-react';
import { Spotlight } from '../components/Spotlight';
import { Lazy, Rail, readLastRailTo, Tile } from '../components/Rail';
import { PosterCard } from '../components/PosterCard';
import { useCategories } from '../lib/groups';
import { api, type Item } from '../lib/api';
import { useScope } from '../lib/scope';
import { collectionRails, dedupeTitles, railRevealPlan, type RailDef } from '../lib/home';
import { showcaseReady } from '../lib/sections';
import { useSkin } from '../lib/skin';
import { ModernHome } from './ModernHome';
import { ContinueStrip } from '../components/ContinueStrip';
import { ForYouRails } from '../components/ForYouRails';

/* ── the menu ─────────────────────────────────────────────────────────────── */


/* ── content rails ────────────────────────────────────────────────────────── */

const to = (section: 'movies' | 'series', item: Item) =>
  `${section === 'series' ? '/series' : '/movie'}/${item.id}`;

/**
 * Poster tiles for a films/series rail. One place decides what a tile shows.
 *
 * Deduped by title, which a grid deliberately is NOT: the catalogue lists the
 * same show once per market, so "On My Block" filled two of the ten slots in this
 * rail. A rail is a sample and a wasted slot costs something; the full list
 * behind "See all" still shows every market's copy.
 */
/* How many package shelves mount before the next batch. */
const HOME_RAIL_PAGE = 5;

function PosterTiles({ rows, section }: { rows: readonly Item[]; section: 'movies' | 'series' }) {
  return (
    <>
      {dedupeTitles(rows).map((item) => (
        <Tile key={item.id}>
          <PosterCard item={item} to={to(section, item)} kind={section} favSection={section} />
        </Tile>
      ))}
    </>
  );
}

/** Starred films or series. Live gets its own rail, because a channel is not a poster. */
function FavRail({ section }: { section: 'movies' | 'series' }) {
  const { prefs, scope } = useScope();
  const ids = prefs.favs[section];
  const q = useQuery({
    queryKey: ['home', 'favs', section, ids, scope],
    queryFn: () => api.items(section, { streamIds: ids, limit: 40, ...scope }),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
  if (ids.length === 0) return null;
  return (
    <Rail
      enter
      title={section === 'movies' ? 'Your films' : 'Your series'}
      to={`/${section}?favs=1`}
      loading={q.isLoading}
    >
      <PosterTiles rows={q.data?.rows ?? []} section={section} />
    </Rail>
  );
}

/*
 * Four things used to live here and every one of them was live television:
 * `ChannelTiles`, "You watch these", "Your channels" and the catch-up rail.
 *
 * "in home page only show movies and series no tv please" — and the page is
 * better for it. Live TV is a destination in the header with a screen built
 * around it: a sidebar of countries, a list, a picture and a guide. A home page
 * that also carries channel rows is a home page competing with that screen
 * using a worse version of it.
 */


/** A films/series rail defined purely by its query — the workhorse of this page. */
function QueryRail({
  title, section, params, to: link, note,
}: {
  title: string;
  section: 'movies' | 'series';
  params: Record<string, unknown>;
  to: string;
  note?: string;
}) {
  const { scope } = useScope();
  const q = useQuery({
    queryKey: ['home', 'rail', section, params, scope],
    queryFn: () => api.items(section, { limit: 24, ...params, ...scope }),
    staleTime: 300_000,
  });
  if (!q.isLoading && (q.data?.rows.length ?? 0) === 0) return null;
  return (
    <Rail enter title={title} to={link} loading={q.isLoading} note={note}>
      <PosterTiles rows={q.data?.rows ?? []} section={section} />
    </Rail>
  );
}

/* ── browse strips ────────────────────────────────────────────────────────── */

/*
 * And three strips of boxes used to close the page: streaming services, genres
 * and countries, with `StripTile`, `genreLabel` and `BrowseStrips` to draw them.
 *
 * "no genres and so on". They were a directory rather than a shelf — a name and
 * a count in a box, on a page whose entire job is showing people what a thing
 * looks like. What they were genuinely useful for now has better homes: a
 * package is a rail of real posters further down this page, a country belongs
 * to the live screen's sidebar and to Organise, and a genre on this catalogue is
 * a label the panel guesses at.
 */


/**
 * The inventory question every home page starts from.
 *
 * One `queryKey`, so `Home` and `Discover` share the same cache entry rather
 * than firing the request twice when both are mounted across a route change.
 *
 * While the answer is unknown, nothing is rendered by either caller. A flash of
 * the empty page before a redirect decides itself is exactly the thing this
 * avoids.
 */
function useHomeInventory() {
  return useQuery({
    queryKey: ['inventory'],
    queryFn: api.inventory,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Home.
 *
 * Composed of independent, self-fetching sections, every one of them carrying the
 * active profile's scope. Sections below the fold do not mount until they are
 * nearly on screen, so the first paint costs the hero and nothing else.
 */
export function Home() {
  /* Which of the two home pages this television wants. See `Shell` in
     lib/skin.ts — device-wide, like the theme. */
  const { shell } = useSkin();
  const { data: inv, isLoading } = useHomeInventory();
  if (isLoading) return null;
  const hasVod = (inv?.movies ?? 0) > 0 || (inv?.series ?? 0) > 0;
  /*
   * The modern shell answers this differently, and can.
   *
   * The redirect below exists because an empty SHOWCASE looks broken — a hero
   * with nothing in it over rails of cropped channel logos. A launcher does not
   * have that failure mode: its tiles are filtered to what exists, so a device
   * with only free channels shows a Live TV tile and a clock, which is a small
   * page rather than a wrong one.
   *
   * It still redirects when there is only ONE tile, because a launcher with a
   * single destination is a button pretending to be a screen. Counted from
   * live/movies/series only — Sports TV rides on the same channels as Live TV,
   * so it is never the tile that tips a device from one destination to two.
   */
  if (shell === 'modern') {
    const tiles = [(inv?.live ?? 0) > 0, (inv?.movies ?? 0) > 0, (inv?.series ?? 0) > 0]
      .filter(Boolean).length;
    if (inv !== undefined && tiles < 2) return <Navigate to="/live" replace />;
    return <ModernHome inv={inv ?? null} />;
  }
  /*
   * A showcase needs something to show.
   *
   * Reported with a screenshot: a device holding twenty-two free channels and no
   * films opened on a hero with nothing in it, a "Just added — films" rail of
   * channel logos cropped to poster shape, and a countries row with one chip in
   * it reading "OTHER". Every one of those is a section doing its best with
   * nothing, and together they are a page that makes the app look empty when it
   * is not — the channels were all there, one tab away.
   *
   * "When there are no movies or anything, you just directly open the live area."
   * So: a catalogue with no films and no series has no showcase, and `/home` is
   * the live screen. `replace` on purpose — BACK from Live must leave the app,
   * not bounce through a redirect nobody saw.
   */
  if (inv !== undefined && !hasVod) return <Navigate to="/live" replace />;
  /*
   * Offered is not the same as here.
   *
   * `inv.movies` counts what the SUBSCRIPTION has, which is the right number for
   * deciding whether a Movies tab exists and the wrong one for deciding whether
   * this page has anything to draw. On an on-demand library the two differ by
   * everything: 66,709 films offered, none downloaded — so every rail below
   * returned nothing, the hero fell through to live channels, and the showcase
   * became a page of television channels with a countries strip under it. Which
   * is what "sections leak to the home page" was pointing at.
   */
  return <Showcase pending={!showcaseReady(inv ?? null)} />;
}

/**
 * The classic showcase, at its own address.
 *
 * "The logo will become the current home page: when you click on it you will
 * see those five cards … below it … continue watching … And then we show like
 * live TV like a home — a home icon only … we had a home page of a classical
 * view with the hero section and below it all the movies and series and
 * trending stuff." This is that classical view — `/discover` rather than
 * `/home`, so the modern launcher's Home tile, the header's icon-only Home tab
 * and classic `/home` can all point at the same screen without either shell
 * losing its own front door.
 *
 * Same rule as `Home()`'s classic branch, because it is the same page: a
 * catalogue with nothing on demand has no showcase to show, so this redirects
 * to Live exactly as `/home` always has for a channels-only subscription.
 */
export function Discover() {
  const { data: inv, isLoading } = useHomeInventory();
  if (isLoading) return null;
  const hasVod = (inv?.movies ?? 0) > 0 || (inv?.series ?? 0) > 0;
  if (inv !== undefined && !hasVod) return <Navigate to="/live" replace />;
  return <Showcase pending={!showcaseReady(inv ?? null)} />;
}

/**
 * The showcase, before its library has arrived.
 *
 * Not an error and not an empty state: everything is there, on the panel, one
 * group at a time. So this says the true thing and points at the door that
 * fetches some — which is the films page, where the group list now lives.
 */
function LibraryPending() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-16 text-center">
      <Clapperboard className="h-9 w-9 text-ink-3" strokeWidth={1.2} aria-hidden />
      <p className="font-mono text-[length:var(--t-xs)] text-ink-3">
        Open a group to download it onto this device.
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Link to="/movies" className="dest btn pill gap-1.5 px-4 py-2">
          <Clapperboard className="h-3.5 w-3.5" />
          <span className="dest-label">Films</span>
        </Link>
        <Link to="/series" className="dest btn pill gap-1.5 px-4 py-2">
          <Tv2 className="h-3.5 w-3.5" />
          <span className="dest-label">Series</span>
        </Link>
      </div>
    </div>
  );
}

/**
 * Switch between the two home pages, in one click, from either one.
 *
 * It is also a setting, under Display — but a preference nobody can find is a
 * preference nobody has. Both homes are legitimate front doors, so the door
 * itself carries the handle.
 */
/*
  HomeStyleSwitch is gone with the classic launcher it toggled to. Its own
  comment records the verdict that killed the earlier version of it - "nobody
  understood it" - and a switch between two homes stops meaning anything when
  there is one home.
*/

/**
 * Films and series, and nothing else.
 *
 * What was here and is not any more, all of it live television: "You watch
 * these" and "Your channels", the catch-up rail, and the three strips of boxes
 * at the bottom — streaming services, genres and countries. Asked for as "in
 * home page only show movies and series no tv please, no genres and so on", and
 * it is the right shape for this page: Live TV is a destination in the header
 * with a screen built for it, and a home page that also carries channel rows is
 * a home page competing with it.
 *
 * The countries strip is the one worth naming, because it was doing real work
 * for the wrong page — it was how somebody jumped to a market. That belongs to
 * the live screen's own sidebar and to Organise, both of which do it better.
 */
function Showcase({ pending }: { pending: boolean }) {
  const { prefs, scope } = useScope();
  const hasHistory = prefs.history.length > 0;
  const movieCats = useCategories('movies', scope);
  const seriesCats = useCategories('series', scope);

  /*
   * The endless part, and why it is a plan rather than a fetch.
   *
   * Each rail below fetches its own row when it comes near the screen (`Lazy`),
   * so the cost of a hundred rails is not a hundred requests — it is however
   * many the viewer scrolls past. What has to be bounded is the DOM: mounting
   * 214 rail frames on a television box is 214 horizontal scrollers competing
   * So the list grows in steps of five as the bottom comes into view.
   *
   * Films and series are interleaved rather than concatenated: 119 film
   * packages followed by 95 series ones is a page that changes subject once,
   * halfway down, and nobody scrolls that far to find out.
   */
  const rails = useMemo(
    (): RailDef[] => collectionRails(movieCats, seriesCats),
    [movieCats, seriesCats],
  );

  const [shown, setShown] = useState(HOME_RAIL_PAGE);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (el === null || shown >= rails.length) return undefined;
    /* No IntersectionObserver on an old WebView means show everything rather
       than a page that silently stops growing — the same choice `Lazy` makes. */
    if (typeof IntersectionObserver === 'undefined') {
      setShown(rails.length);
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + HOME_RAIL_PAGE);
    }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rails.length]);

  /*
   * ── returning to a package rail deep enough that it needed scrolling ────
   *
   * `railTarget` is a read-only peek at what `Rail`'s own header link left
   * behind — see `readLastRailTo` in components/Rail.tsx — taken once, at
   * mount, same as `Rail` takes its own. Peeking does not consume it: the
   * rail that actually matches (fixed or package) still clears it itself,
   * on ITS OWN mount, exactly as it always has — this effect only ever
   * raises `shown` and scrolls, never sessionStorage.
   */
  const [railTarget] = useState(readLastRailTo);
  const revealedTarget = useRef(false);
  useEffect(() => {
    if (revealedTarget.current || railTarget === null) return;
    const plan = railRevealPlan(rails, railTarget, shown);
    // Not a package rail at all — a fixed rail's own link, or a category the
    // catalogue no longer has. Either way, ignored: nothing here to raise or
    // scroll to, and `Rail`'s own mechanism already does the right thing for
    // whichever fixed rail it might be.
    if (plan === null) return;
    if (plan.shown > shown) { setShown(plan.shown); return; }
    /*
     * `shown` now covers it, so its `Lazy` placeholder exists — but `Lazy`
     * itself will not paint the rail until that placeholder is near the
     * viewport, and this page always opens scrolled to the top. Bringing the
     * placeholder into view is what wakes it: the same `nearest` rule
     * `spatialNav.ts`'s own arrival scroll uses, not the keyline — there is
     * no previous position here to hold still, only somewhere off-screen to
     * reach. Once the real rail mounts and stamps `data-nav-first`, Chrome's
     * existing focus ladder finds and focuses it exactly as it already does
     * for a rail that was in the DOM from the start.
     */
    const el = document.querySelector<HTMLElement>(`[data-rail-to="${railTarget}"]`);
    if (el === null) return; // this commit has not painted it yet — the next one retries.
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    revealedTarget.current = true;
  }, [rails, shown, railTarget]);

  if (pending) {
    return (
      <div data-hero-scroll className="h-full overflow-y-auto pb-6">
        <LibraryPending />
      </div>
    );
  }

  return (
    <div data-hero-scroll className="h-full overflow-y-auto pb-6">
      <Spotlight />

      {/* First shelf rides up onto the hero — same lean-back stack as a TV home. */}
      <div className="relative z-10 -mt-[min(22vh,10rem)] space-y-1 bg-gradient-to-t from-ground via-ground/95 to-transparent pt-2">
        {hasHistory && <Lazy minHeight="14rem"><ContinueStrip /></Lazy>}
        <Lazy minHeight="0rem"><ForYouRails section="movies" /></Lazy>
        <Lazy minHeight="0rem"><ForYouRails section="series" /></Lazy>
        <Lazy minHeight="0rem"><FavRail section="movies" /></Lazy>
        <Lazy minHeight="0rem"><FavRail section="series" /></Lazy>
        <Lazy minHeight="16rem">
          <QueryRail title="Just added — films" section="movies" to="/movies?sort=added"
                     params={{ sort: 'added', dir: 'desc' }} />
        </Lazy>
        <Lazy minHeight="16rem">
          <QueryRail title="New episodes" section="series" to="/series?sort=added"
                     params={{ sort: 'added', dir: 'desc' }} />
        </Lazy>
      </div>

      {/* Package shelves, five at a time. */}
      {rails.slice(0, shown).map((r) => (
        <Lazy key={r.key} minHeight="16rem" anchor={r.to}>
          <QueryRail
            title={r.title}
            section={r.section}
            to={r.to}
            params={r.params}
          />
        </Lazy>
      ))}
      <div ref={more} className="h-16" aria-hidden />
    </div>
  );
}
