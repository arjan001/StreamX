import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RailToggle } from '../components/RailToggle';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VirtualList } from '../components/VirtualList';
import { useLongPress } from '../lib/longPress';
import { HoldMenu, type HoldAction } from '../components/HoldMenu';
import { moveTo } from '../lib/ordering';
import {
  EMPTY_FILTERS, FilterBar, filtersFromParams, paramsFromFilters, type Filters,
} from '../components/FilterBar';
import { LiveSidebar } from '../components/LiveSidebar';
import {
  ArrowUpDown, CalendarClock, Check, ChevronDown, Clock, EyeOff, Globe, Heart, History, List, ListFilter,
  ListOrdered, Play, Radio, Star,
} from 'lucide-react';
import { useKeyLayer, type Binding } from '../lib/keys';
import { VideoPlayer } from '../components/VideoPlayer';
import { DetailSheet } from '../components/DetailSheet';
import { NowNext } from '../components/NowNext';
import { Poster } from '../components/Poster';
import { usePagedItems, type PagedQuery } from '../lib/usePagedItems';
import { listPhase, useLibraryBuilding } from '../lib/useLibraryBuilding';
import { ensureTopicIndex, subscribeTopicIndex, topicIndex, topicSet, topicStreams } from '../lib/topicIndex';
import {
  arrangeSports, channelStatus, guideDonors, guideRequestIds, hasProgrammeInWindow, liveKind, onNowRank, orderByOnNow, pickSport,
  RAIL_SPORTS, sportsNowNext, type ChannelStatus, type OnNowRank,
} from '../lib/sports';
import {
  setSportsListOrder, setSportsMarkets, setSportsShow, sportCounts, useSportArrangement, useSportsListOrder,
  useSportsMarkets, useSportsShow, type SportsShow,
} from '../lib/sportsRail';
import { FacetPicker, type FacetOption } from '../components/FacetPicker';
import { refreshLiveNames } from '../lib/liveNames';
import { subscribeLocal } from '../lib/localCatalogue';
import { useScope } from '../lib/scope';
import { SportsRail } from '../components/SportsRail';
import { isAdultPath } from '../lib/adultFilter';
import {
  AUTO_OPEN_MS, effectiveMarkets, moveFav, setFavOrder, setStreamOrder, toggleFav,
  toggleHiddenStream, usePrefs,
} from '../lib/prefs';
import { useShape } from '../lib/formFactor';
import { useSkin } from '../lib/skin';
import { marketName, useCategories } from '../lib/groups';
import { epgBlock, hasSecondLine, rowStep, secondLine, standingLabel } from '../lib/liveRows';
import { installMarquee } from '../lib/marquee';
import { clockOf, slotAt, type Slot as GuideSlot } from '../lib/guide';
import { eventWhen, parseEvent, type ChannelEvent } from '../lib/eventName';
import { Kind } from '@iptv/core-xtream';
import { api, linkId, type EpgResponse, type Item } from '../lib/api';
import { noteLastPlayed } from '../lib/resume';
import { noteShellHide } from '../lib/shellState';
import { assetUrl } from '../lib/assetUrl';
import { BRAND } from '../brand';
import { displayName } from '../lib/displayName';
import { downlinkMbps, pickVariant as chooseFeed } from '../lib/liveQuality';
import { localAllItems, localItems, localMarkets, localIndexOfItem } from '../lib/localRead';
import {
  player, getLiveMode, setLiveMode, resolveLiveMode, rememberNeedsCompatible,
  warmPlaybackEngines,
  type LiveMode, type PlayerSnapshot,
} from '../lib/playerCore';
import { expiredHint, resolveLiveTarget } from '../lib/liveOpen';
import { playFailureHint } from '../lib/playUnavailable';
import { useEnsurePackages } from '../lib/packages';
import { subscription } from '../lib/providers';
import { openingScope } from '../lib/liveOpening';
import { useTally } from '../lib/tally';
import { wantsChannel, type ChannelClaims } from '../lib/liveRestore';

/**
 * Transport picker.
 *
 * Worth exposing rather than hiding: the two paths differ by ~30 seconds of
 * latency on this provider, and which one a given channel tolerates varies by
 * codec. Persisted so a reload keeps the choice.
 */
/**
 * The longest list this screen will hold whole in order to arrange it.
 *
 * Arranging means reading every row, which is cheap on a device that holds the
 * catalogue (2.1 ms to search 124,157 items) but is not free. A thousand is well
 * past any list somebody carries a row through with a remote, and it keeps "All
 * channels" on a 55,000-channel subscription out of this path entirely.
 */
const ARRANGE_MAX = 1000;

/**
 * Live TV — and Sports TV, which is this same screen.
 *
 * "use the same concept and components and layouts and settings … the first
 * sidebar for sports categories stays". So `sports` changes three things and
 * nothing else: the first column is the sports (`SportsRail`) instead of the
 * countries, the list is that sport's channels, and each row carries NEXT under
 * NOW. The player, the hold menu, favourites, hide, move, search, sort, the
 * transport and buffer settings and zapping are the one implementation.
 *
 * And the other half of the same request: Live TV leaves every sport channel
 * out ("filter them out from live tv area so no duplications"), counts and
 * packages included — see `excludeTopic` in lib/localRead.ts.
 *
 */
/**
 * Sports TV's photograph of the sport, behind the panes.
 *
 * "We don't see any background images when we switch the categories in Sports
 * TV." On a television the channel usually plays on libVLC's surface, BEHIND the
 * page, and a photograph across the whole screen covers it — so `.nv-cover` took
 * the photograph away for as long as that surface had the picture. Which, on the
 * box, is nearly always once a channel is on: every sport showed the same plain
 * ground, and switching sport changed nothing.
 *
 * Now it stays, with the picture's rectangle cut out of it (`.nv-holed` in
 * index.css). The rectangle is the one VideoPlayer already publishes for the
 * surface (`--nv-x` … `--nv-h`, viewport pixels); this layer only adds where it
 * sits itself (`--at-x`, `--at-y`), because a clip-path is drawn in the layer's
 * own coordinates. Re-measured when the page resizes, and when the layer does —
 * the header coming or going moves it and changes its height together.
 */
function SportShot({ sport }: { sport: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const place = () => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--at-x', `${r.left}px`);
      el.style.setProperty('--at-y', `${r.top}px`);
    };
    place();
    addEventListener('resize', place);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(el);
    return () => { removeEventListener('resize', place); ro?.disconnect(); };
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      className="sport-shot nv-cover nv-holed anim-fade pointer-events-none absolute inset-0"
      style={{ '--shot': `url(${assetUrl(`sports/${sport}.jpg?v=${BRAND.rev}`)})` } as React.CSSProperties}
    />
  );
}

/** The Info panel, following the player only while it is on screen. */
function LiveDetail({ item, epg }: { item: Item; epg: EpgResponse | undefined }) {
  const [snap, setSnap] = useState<PlayerSnapshot>(player.state);
  useEffect(() => player.subscribe(setSnap), []);
  return <DetailSheet item={item} epg={epg} snapshot={snap} />;
}

export function Live({ sports = false }: { sports?: boolean } = {}) {
  const tallyOf = useTally();
  /**
   * The same filter bar the grid uses.
   *
   * Live had a flat category rail and no country filter at all, which on 829
   * groups across 79 countries is unusable — the whole point of the group tree is
   * that it is the only way to find anything in this section.
   */
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [prefs, setPrefs] = usePrefs();
  /*
   * Hold a row to favourite it.
   *
   * One set of handlers for the whole list rather than one per row: only a
   * single row can be under the pointer at a time, so the row being pressed is a
   * ref the handler reads when the hold completes. See lib/longPress.ts for why
   * the star stopped being a button.
   */
  const pressed = useRef<Item | null>(null);
  /*
   * A hold opens the row's own menu.
   *
   * It used to toggle the star and nothing else, which is one action hidden
   * behind a gesture nobody can see. Asked for as "make a hold action on hold in
   * TV live lists you can hide unhide stuff fav and so on, reorder them and what
   * not" — so the gesture now names everything it can do to the row it is on,
   * and the star keeps its one-press shortcut on the remote's RED/STAR key.
   */
  const [rowMenu, setRowMenu] = useState<Item | null>(null);
  const holdFav = useLongPress(() => {
    const it = pressed.current;
    if (it !== null) setRowMenu(it);
  });
  const openGen = useRef(0);
  /** The REF of the channel currently open, so it compares with `?ch=` directly. */
  const openedId = useRef<string | null>(null);
  /**
   * Channel we asked to open before `?ch=` caught up.
   *
   * `setCurrent` can re-render while the search params still hold the PREVIOUS
   * channel. The restore effect then saw cached data for the old `?ch=` and
   * called `open` again — which cancelled the new load (gen bump) and put the
   * old channel back. One click looked like a no-op; the second stuck.
   */
  const pendingCh = useRef<string | null>(null);
  /**
   * Channel we asked to CLOSE before `?ch=` dropped it — the mirror of the above,
   * and the same race running the other way.
   *
   * `close()` clears `openedId` on the line that runs it and drops `?ch=` a
   * commit later. In that gap the restore effect sees an address naming a channel
   * nobody has claimed, decides it is a deep link, and re-opens the channel BACK
   * just closed. Measured with `scripts/back-probe.mjs`: the first BACK restarted
   * the stream, re-armed the country healing below so the list re-filtered to
   * another country, and left the highlight on a different channel — "when you go
   * back instead of going back it goes to another channel". The second BACK, with
   * the address finally agreeing, closed it properly.
   *
   * See `lib/liveRestore.ts` for the rule the three refs make together.
   */
  const closedCh = useRef<string | null>(null);
  const filters = useMemo(() => filtersFromParams(params), [params]);
  /* Which channels are sport, for both screens: Sports lists them, Live leaves
     them out. Nothing is listed until the index can say, so neither screen
     shows a list that then loses or gains rows under the highlight. */
  const [topicTick, setTopicTick] = useState(0);
  useEffect(() => subscribeTopicIndex(() => setTopicTick((n) => n + 1)), []);
  useEffect(() => { void ensureTopicIndex(); }, []);
  const topicsReady = topicIndex() !== null;
  /* Demuxers are lazy-loaded; pull them in while the list paints so the first
     channel press is not paying for ~700KB of import. */
  useEffect(() => { warmPlaybackEngines(); }, []);
  /* Channel names that are cut off slide to their end on the focused row — see
     lib/marquee. Idempotent; the sidebar asks too. */
  useEffect(() => { installMarquee(); }, []);
  /*
   * Leaving this screen stops the stream.
   *
   * The player is a SINGLETON and the picture is not: on Android the frames go to
   * a libVLC SurfaceView behind the page, and the only thing tying it to this
   * route is the rectangle this route draws. So when the route unmounted nothing
   * stopped the engine — the surface went with the page and the audio kept
   * going. Reported twice, and they are the same fault: "when they navigate a bit
   * faster suddenly the video goes away and I will only hear audio", and coming
   * back to a remounted screen whose state is empty while the sound continues —
   * "it suddenly just says pick a channel but we hear the audio".
   *
   * `Catchup` has had this line since it was written; this screen never did.
   * Teardown is idempotent, so it costs nothing on the paths that already tear
   * down before navigating.
   */
  useEffect(() => () => player.teardown(), []);
  const onFilters = useCallback(
    (f: Filters) => {
      const p = paramsFromFilters(f);
      const ch = params.get('ch');
      if (ch) p.set('ch', ch);
      setParams(p, { replace: true });
    },
    [params, setParams],
  );
  const [current, setCurrent] = useState<Item | null>(null);
  /* Read by `open()`, which must not depend on the channel it is replacing: it
     is rebuilt on every filter change as it is, and a dependency on `current`
     would rebuild it on every channel as well. */
  const currentRef = useRef<Item | null>(null);
  useEffect(() => { currentRef.current = current; });
  /**
   * The channel before this one — LAST CHANNEL, which every broadcast remote has
   * had for thirty years.
   *
   * `lastChannel` is in the shortcuts sheet and on the keycode table
   * (`lib/remoteKeys.ts`, KEYCODE 229) and had no handler anywhere in the app: a
   * button the legend promised and nothing answered. State rather than a ref
   * because the binding is only published once there is somewhere to go back to
   * — a legend that lists a key which does nothing is worse than one that does
   * not mention it.
   */
  const [previous, setPrevious] = useState<Item | null>(null);

  /*
   * Resting the highlight on a channel opens it — see `Prefs.autoOpen`.
   *
   * A ref rather than state: this timer is set and cleared on every focus
   * change, and re-rendering the whole list to store a timeout id would make
   * scrolling the list the most expensive thing on the screen.
   */
  const restTimer = useRef(0);
  const cancelRest = useCallback(() => {
    if (restTimer.current !== 0) {
      window.clearTimeout(restTimer.current);
      restTimer.current = 0;
    }
  }, []);
  /* Leaving the screen with a timer armed would open a channel onto a page that
     is gone — and on a one-connection line, hold it there. */
  useEffect(() => cancelRest, [cancelRest]);
  const [familyIds, setFamilyIds] = useState<number[]>([]);
  const [mode, setMode] = useState<LiveMode>(getLiveMode);
  /*
   * No copy of the player's state here.
   *
   * There was one — `useState(player.state)` fed by `player.subscribe` — and
   * the player reports several times a second while a channel plays (its
   * stats tick every half second, libVLC's clock more often), so the whole
   * screen — three columns, the channel list, the guide lines — rendered again
   * on every one of them. Measured on the TV emulator with a channel on: three
   * renders a second and 15% of the processor, and presses on the list slowed
   * from 40 ms to 700-900 ms. Nothing on this screen needs more than the
   * phase at the moment a row is pressed, which `player.state` answers, and
   * the Info panel keeps its own copy while it is open (`LiveDetail`).
   *
   * What those renders did do by accident is keep the clocks moving — the
   * how-far-through bar on every row, "Started 47 min ago" under the picture —
   * so the screen gets its own tick for that: once a minute, which is the
   * finest thing any of them shows.
   */
  const [, setMinute] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  /*
    Three panes, three shares of the screen — and nothing to drag.

    These were resizable, with widths persisted per viewer, and the defaults gave
    the picture 55% of a television and the country rail 168px: "player area
    big, country and channel small", verbatim. On a set nobody resizes anything,
    a 1px handle is a focus ring that vanishes, and a width stored on one box was
    wrong on the next. So the split is fixed, as shares: a fifth for countries,
    a little under two-fifths for the picture, and the channel list takes what is
    left — which on 1080p is the widest of the three, because the list is what
    a viewer is reading while the picture plays.
  */
  const [theatre, setTheatre] = useState(false);
  const shape = useShape();
  const { shell } = useSkin();
  const modern = shell === 'modern';


  /* Theatre is Live's "fullscreen" — hide the shell nav so the picture reaches
     the top of the glass. */
  useEffect(() => {
    noteShellHide('live-theatre', theatre);
    return () => noteShellHide('live-theatre', false);
  }, [theatre]);

  /*
   * Take the remote with it.
   *
   * The press that opens theatre comes from a channel row, and that row is
   * inside the column theatre hides. Focus on a hidden element falls to
   * `<body>`, where a D-pad has no candidate to move to and no control to
   * press — the picture fills the screen and the remote is dead. Reported as
   * "and no contorls".
   *
   * The picture is the landing place rather than a button: `.stage` is a
   * doorway that wakes its own chrome and hands focus straight on to the first
   * control (see the note on its `onFocus`), so this is one hop from the bar
   * without this file needing to know what is in it. Deliberately not a
   * `useLayoutEffect` — the column has to be painted before it can take focus.
   */
  useEffect(() => {
    if (!theatre) return;
    const id = window.setTimeout(() => {
      document.querySelector<HTMLElement>('.live-stage .stage[tabindex]')?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [theatre]);

  /**
   * What this screen opens ON, when the address does not say.
   *
   * Live opened on "All countries" over a rail of every country in the library:
   * a wall, on the screen a viewer arrives at most often, holding a remote. The
   * shorter list is usually already known — starred channels, or a profile
   * narrowed to one country — and `lib/liveOpening` is the whole rule and the
   * reasoning. The tree is not hidden: it is the second row of the same sidebar,
   * one press away, and a profile that has said nothing opens exactly as before.
   *
   * Written into the ADDRESS rather than held as state, because the address is
   * what the sidebar, the heading, `onFilters` and a reload all read: a second
   * source of truth for what the list is showing is how a highlighted country
   * ends up over somebody else's list of channels.
   *
   * Once, on arrival, and only when nothing is in the address. `?ch=` is a deep
   * link from search, a home rail or a resume banner and it brings its own
   * country with it (see the healing effect below); a country in the address is
   * a choice made before a reload or a BACK. Both of those are somebody's, and a
   * default that overwrites a choice is not a default.
   */
  /*
   * Sports TV keeps its channels' names current while it is open: a PPV feed is
   * renamed to the event it carries, several times a day, and the library on the
   * device is from the day it was downloaded. Names only, one request, nothing
   * rebuilt — see lib/liveNames.ts. On arrival when the last look is half an
   * hour old, and again every ten minutes while the screen stays open.
   */
  useEffect(() => {
    if (!sports) return;
    const look = () => { void refreshLiveNames(30 * 60_000); };
    look();
    const id = window.setInterval(look, 10 * 60_000);
    /* Opened straight onto Sports at launch, the library is still loading and
       the first look is turned away — so look again the moment it is ready. */
    const off = subscribeLocal((st) => { if (st.state === 'ready') look(); });
    return () => { window.clearInterval(id); off(); };
  }, [sports]);

  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    /* Sports opens on its first sport; countries are not its opening question. */
    if (sports) return;
    if (params.toString() !== '') return;
    const favs = prefs.favs.live;
    const opening = openingScope(
      favs.length === 0 ? 0 : localItems('live', { streamIds: favs, limit: 1 })?.total ?? 0,
      prefs.markets,
      localMarkets('live', {})?.markets ?? null,
    );
    if (opening === null) return;
    setParams(paramsFromFilters({ ...EMPTY_FILTERS, ...opening }), { replace: true });
    /* Mount only. Every input is read at the moment of arrival, and re-running
       this on a changed profile would put the opening list back over whatever
       the viewer had moved to. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    /* An adult market in the address (a stale link) is stripped, never listed. */
    const dirty =
      filters.markets.some(isAdultPath) ||
      filters.paths.some(isAdultPath) ||
      (filters.path !== null && isAdultPath(filters.path));
    if (!dirty) return;
    onFilters({
      ...filters,
      markets: filters.markets.filter((m) => !isAdultPath(m)),
      paths: filters.paths.filter((p) => !isAdultPath(p)),
      path: filters.path !== null && isAdultPath(filters.path) ? null : filters.path,
    });
  }, [filters, onFilters]);

  /*
   * Favourites: channels chosen by who starred them rather than by where they
   * sit in the country tree — a set of stream ids, answered the same way the
   * scope and hidden-channel rules already answer everything else.
   */
  /* Sports: the sport picked in the rail (or the first one there is), all
     sport while searching — a search inside Football that cannot find Sky
     Sports Golf is a search that looks broken — and Favourites means the
     starred channels that are sport. */
  const { scope: profileScope } = useScope();
  const arrangement = useSportArrangement();
  const sportRail = useMemo(
    () => (sports ? arrangeSports(sportCounts(profileScope), arrangement.order, arrangement.hidden) : []),
    // `topicTick` re-reads once the index is built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sports, topicTick, profileScope, arrangement],
  );
  const sport = sports ? pickSport(sportRail, filters.sport) : null;
  const idList = useMemo((): number[] | null => {
    if (sports) {
      const all = topicSet('sports');
      if (all === null) return [];
      if (filters.favs) return prefs.favs.live.filter((id) => all.has(id));
      if (filters.q.trim() !== '') return [...all];
      return sport === null ? [] : topicStreams(sport);
    }
    if (filters.favs) return prefs.favs.live;
    return null;
    // `topicTick`: the sport lists only exist once the index is built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sports, sport, filters.favs, filters.q, prefs.favs.live, topicTick]);
  /* Sports' countries: one picked under the sport in the countries layout,
     else the Show menu's Country choice, kept for every sport. */
  const storedSportMarkets = useSportsMarkets();
  const sportMarkets = !sports ? [] : filters.markets.length > 0 ? filters.markets : storedSportMarkets;
  /* What Live leaves out, once it is known. A string, so it is part of every
     query key — a page read before the index was ready is never mistaken for
     one read after. */
  const exclude = !sports && topicsReady ? { excludeTopic: 'sports' } : {};

  const query = useMemo((): PagedQuery => {
    if (idList !== null) {
      return {
        categoryId: null as number | null,
        cats: [] as number[],
        path: null as string | null,
        paths: [] as string[],
        sort: filters.sort,
        dir: filters.dir,
        q: filters.q,
        genres: [] as string[],
        region: null as string | null,
        source: null as string | null,
        hidePaths: prefs.hidePaths,
        hideCats: prefs.hideCats,
        /* The REF list and the hidden channels, which were missing here.
           `hideCats` alone is the legacy row-id list — usually empty — so hiding a
           package took it out of the sidebar and left every one of its channels in
           the list and in the total. The scope has to be whole at every call site
           or the numbers on screen disagree with the rows under them. */
        hideCatRefs: prefs.hideCatRefs,
        hideStreams: prefs.hideStreams,
        streamIds: idList,
        /* Sports in the countries layout: a country picked under the sport. */
        ...(sports && sportMarkets.length > 0 ? { markets: [...sportMarkets] } : {}),
        ...exclude,
      };
    }
    // A country picked in the sidebar narrows the profile's scope; it cannot widen it.
    const chosen = effectiveMarkets(filters.markets, prefs);
    // Groups are already under the selected country. Including the country path
    // as well would OR-match the whole country and make the group pick a no-op.
    const groupPaths = [...new Set([...(filters.path ? [filters.path] : []), ...filters.paths])];
    const paths = groupPaths.length > 0 ? groupPaths : chosen;
    return {
      // Live TV is scoped by market/country, group path — and category, which
      // is what a row of the sidebar's list shape picks: the provider's own
      // category, under its own name. It narrows inside the profile's countries
      // exactly as a group does (a category is ANDed with the rows the paths
      // allow). Genres still do not apply to channels.
      categoryId: filters.categoryId,
      cats: filters.cats,
      path: paths.length === 1 ? paths[0]! : null,
      paths: paths.length > 1 ? paths : [],
      sort: filters.sort,
      dir: filters.dir,
      q: filters.q,
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
      ...exclude,
    };
    // `exclude` is derived from `sports` and `topicsReady`, both listed.
  }, [filters, prefs, idList, sports, topicsReady, sportMarkets]);
  /* On-demand libraries download a package when somebody opens it. No-op when
     the whole catalogue is here, which is the other mode. */
  useEnsurePackages('live', query);
  const { total, rows, loading, error, ensureRange, fetchRow, rowsNow } = usePagedItems('live', query);
  /* Declared here rather than beside the guide read below because the
     what's-on order needs it too, and that order is part of which row is where. */
  const donors = useMemo(
    () => guideDonors([...rows.values()].map((r) => ({ id: r.id, name: r.name, tvgId: r.tvgId }))),
    [rows],
  );
  /**
   * The Favourites view, in the viewer's OWN order.
   *
   * `query.streamIds` is a SET filter (`packages/core-store/src/query.ts`
   * `matchRows`) — it answers "which of these", in the catalogue's own row
   * order, and there is no sort key there for "the order I starred them in".
   * `routes/Guide.tsx` already carries this exact fix for its own bouquet, on
   * the same reasoning quoted here: a profile's favourites are few enough
   * that reading all of them and ordering by hand is cheap, so — only when
   * `filters.favs` is on — the whole (bounded) set is pulled into the page
   * cache below and laid out here rather than paged through in catalogue
   * order.
   *
   * `null` until every row up to `total` has actually arrived, so a
   * still-loading list falls back to the raw (catalogue-order) page rather
   * than a table full of holes — for the common case (a favourites list under
   * the 40-row first page) that is immediate, since nothing further has to
   * be fetched.
   */
  const favOrder = useMemo(
    () => new Map(prefs.favs.live.map((id, i) => [id, i])),
    [prefs.favs.live],
  );
  const favBouquet = useMemo((): Item[] | null => {
    if (!filters.favs || total === 0) return null;
    for (let i = 0; i < total; i++) if (!rows.has(i)) return null;
    return [...rows.values()].sort((a, b) =>
      (favOrder.get(a.streamId ?? -1) ?? 0) - (favOrder.get(b.streamId ?? -1) ?? 0));
  }, [filters.favs, rows, total, favOrder]);
  /* The whole bouquet, not just the window `onRange` has asked for so far —
     `usePagedItems` only fetches the first PAGE (40) on mount, and a 63rd
     favourite has to be in hand before it can be placed ahead of the 40 that
     happened to load first. A no-op once everything is already cached. */
  useEffect(() => {
    if (!filters.favs || total === 0) return;
    void ensureRange(0, total - 1);
  }, [filters.favs, total, ensureRange]);
  /**
   * The same trick as the favourites bouquet, for a list somebody has ARRANGED.
   *
   * "That hard thing and move it up and down should be for both channels as well
   * as categories". A channel order is stored the way a package order is — a
   * partial list of provider ids, everything named first — and applying it means
   * having the rows in hand, which a paged, virtualised list does not.
   *
   * So the same bargain `favBouquet` makes above: when this list is short enough
   * to hold whole (`ARRANGE_MAX`) and somebody has actually arranged something in
   * it, every row is read and the order applied here. Above that the list is left
   * exactly as it was — a thousand channels is not a list anybody is carrying a
   * row through, and silently reading 50,000 rows to honour three of them is the
   * kind of trade that makes a television feel slow.
   */
  /**
   * The channel being carried, by provider id, and how to put it back.
   *
   * `undoOrder` remembers which list is being rewritten as well as what it held:
   * inside My channels a move rewrites the favourites order, everywhere else it
   * rewrites `streamOrder`, and BACK has to restore the right one.
   */
  const [moving, setMoving] = useState<number | null>(null);
  const undoOrder = useRef<{ kind: 'fav' | 'stream'; ids: number[] } | null>(null);

  const orderIndex = useMemo(
    () => new Map(prefs.streamOrder.map((id, i) => [id, i])),
    [prefs.streamOrder],
  );
  const arrangeable = !filters.favs && total > 0 && total <= ARRANGE_MAX;
  const arrangedHere = useMemo(
    () => arrangeable && [...rows.values()].some((r) => r.streamId !== null && orderIndex.has(r.streamId)),
    [arrangeable, rows, orderIndex],
  );
  /*
   * Hold the whole list when there is an arrangement to apply — or when somebody
   * is about to make one. The second half matters: the FIRST move has nothing
   * stored yet, so without it `carry` would be handed an empty list and the row
   * would refuse to move at all, which is exactly what the first run of the
   * probe showed.
   */
  /*
   * Sports TV lists a sport by what is on — see `orderByOnNow` in lib/sports.ts
   * for the rule and the counts behind it — unless the viewer has arranged that
   * sport by hand, which is an order somebody chose and outranks any the guide
   * could suggest. The section's favourites lead its list for the same reason
   * they have a rail row everywhere else: they are the short list.
   */
  const listOrder = useSportsListOrder();
  /* And which of them: all, or only what is live, next or ended — the list
     header's Show menu, one choice for every sport. */
  const sportsShowing = useSportsShow();
  const byOnNow = listOrder === 'onnow' && !arrangedHere;
  const wantGuideView = sports && !filters.favs && arrangeable && (byOnNow || sportsShowing !== 'all');
  const holdWhole = arrangeable && (arrangedHere || moving !== null || wantGuideView);
  useEffect(() => {
    if (!holdWhole) return;
    void ensureRange(0, total - 1);
  }, [holdWhole, total, ensureRange]);
  const wholeList = useMemo((): Item[] | null => {
    if (!holdWhole) return null;
    const out: Item[] = [];
    for (let i = 0; i < total; i++) {
      const row = rows.get(i);
      if (row === undefined) return null;
      out.push(row);
    }
    return out;
  }, [holdWhole, rows, total]);
  const arranged = useMemo((): Item[] | null => {
    if (!arrangedHere || wholeList === null) return null;
    const rank = (it: Item): number => {
      const at = it.streamId === null ? undefined : orderIndex.get(it.streamId);
      return at === undefined ? Number.MAX_SAFE_INTEGER : at;
    };
    /* Stable for everything unranked, which keeps the provider's order behind
       the arrangement — `lib/ordering.ts` states the same contract for packages. */
    return wholeList
      .map((item, i) => ({ item, i }))
      .sort((a, b) => (rank(a.item) - rank(b.item)) || (a.i - b.i))
      .map((x) => x.item);
  }, [arrangedHere, wholeList, orderIndex]);

  /** What every index-addressed read below shows: the reordered bouquet
      while it is ready, the raw (catalogue-order) page otherwise — which is
      also everything this screen showed before favourites had an order of
      their own. */
  /*
   * The whole sport's guide, for the order — read once per ten minutes, and
   * without asking the panel for anything: this is the device's own store (the
   * bulk guide), and a per-channel top-up for every channel of a sport is the
   * request storm lib/localEpg.ts exists to prevent. Its own key, so the polls
   * that re-read the visible rows while their answers land never re-sort the
   * list under the highlight; main.tsx re-reads it when a new guide lands.
   */
  const orderBucket = Math.floor(Date.now() / 600_000);
  const orderIds = useMemo(() => {
    if (!wantGuideView || wholeList === null) return [] as number[];
    return guideRequestIds(wholeList.map((r) => r.id), donors);
  }, [wantGuideView, wholeList, donors]);
  const { data: orderGuide } = useQuery({
    queryKey: ['live', 'orderGuide', orderIds, orderBucket],
    queryFn: () => api.epgGrid(orderIds, Math.floor(Date.now() / 1000), 4),
    enabled: orderIds.length > 0,
    staleTime: 600_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
  /*
   * The sport as the guide sees it: what each channel is doing (`channelStatus`)
   * and where it ranks (`onNowRank`), both from the guide first and from an
   * event channel's name only when it has no guide — the playlist those names
   * come from is often days old, the guide never is.
   */
  const sportView = useMemo((): { list: Item[]; counts: Record<SportsShow, number> } | null => {
    if (!wantGuideView || moving !== null || wholeList === null || orderGuide === undefined) return null;
    const slots = new Map<number, GuideSlot[]>();
    for (const c of orderGuide.channels) {
      const got = c.slots
        .filter((x) => x.startTs !== null)
        .map((x) => ({ title: x.title, description: x.description, startTs: x.startTs as number, stopTs: x.stopTs }));
      if (got.length > 0) slots.set(c.id, got);
    }
    const slotsOf = (id: number): GuideSlot[] => {
      const own = slots.get(id);
      if (own !== undefined) return own;
      for (const d of donors.get(id) ?? []) {
        const got = slots.get(d);
        if (got !== undefined) return got;
      }
      return [];
    };
    const nowS = Math.floor(Date.now() / 1000);
    const base = arranged ?? wholeList;
    const status = new Map<number, ChannelStatus | null>();
    const rank = new Map<number, OnNowRank>();
    const counts: Record<SportsShow, number> = { all: base.length, live: 0, next: 0, ended: 0, today: 0, tomorrow: 0 };
    for (const it of base) {
      const own = slotsOf(it.id);
      const nn = sportsNowNext(own, nowS);
      const ev = own.length > 0 ? null : parseEvent(it.name);
      const st = channelStatus(nn, own.length > 0, ev);
      status.set(it.id, st);
      if (st !== null) counts[st] += 1;
      // Count today/tomorrow programmes
      if (hasProgrammeInWindow(own, nowS, 'today')) counts.today += 1;
      if (hasProgrammeInWindow(own, nowS, 'tomorrow')) counts.tomorrow += 1;
      rank.set(it.id, onNowRank(nn, nowS, ev === null ? null : {
        state: ev.state,
        at: ev.at === null ? null : Math.floor(ev.at.getTime() / 1000),
      }));
    }
    let list = byOnNow ? orderByOnNow(base, (it) => rank.get(it.id)!) : base;
    if (sportsShowing === 'today') {
      list = list.filter((it) => hasProgrammeInWindow(slotsOf(it.id), nowS, 'today'));
    } else if (sportsShowing === 'tomorrow') {
      list = list.filter((it) => hasProgrammeInWindow(slotsOf(it.id), nowS, 'tomorrow'));
    } else if (sportsShowing !== 'all') {
      list = list.filter((it) => status.get(it.id) === sportsShowing);
    }
    return { list, counts };
  }, [wantGuideView, moving, wholeList, orderGuide, donors, arranged, byOnNow, sportsShowing]);
  /* The list in the order, and at the length, it is drawn — what the rows,
     their count, channel up/down and "put the playing channel on screen" all
     walk. Null while the list is simply the catalogue's own pages. */
  const inOrder = favBouquet ?? sportView?.list ?? arranged;
  const shownTotal = inOrder?.length ?? total;
  const displayRows = useMemo(
    () => {
      const list = inOrder;
      return list === null ? rows : new Map(list.map((item, i) => [i, item]));
    },
    [inOrder, rows],
  );

  /**
   * The channels you hid, at the bottom of the list you hid them from.
   *
   * The rail beside this one already works this way, on the same instruction:
   * "can u not say hide from this list and put in bottom in like hidden list,
   * they find settings to complicated". A hidden channel used to leave the
   * screen with no way back that did not go through Settings → Organise.
   *
   * Asked as the SAME query with the hidden list turned into the selection, so
   * the tail is "the channels you hid THAT BELONG HERE" rather than every hidden
   * channel you own — the country, the group and the search box all still apply.
   * Bounded by `hideStreams` itself, which the API caps at 500.
   *
   * Not in the favourites view: `streamIds` is already the bouquet there, and a
   * hidden favourite is a contradiction nobody has asked for.
   */
  const hiddenIds = prefs.hideStreams;
  const { data: hiddenHere } = useQuery({
    queryKey: ['live', 'hiddenTail', query, hiddenIds],
    queryFn: () => api.items('live', {
      ...query,
      /* Inside Sports the tail is the hidden channels OF THIS SPORT, not every
         channel this profile ever hid. */
      streamIds: idList !== null && sports ? hiddenIds.filter((id) => idList.includes(id)) : hiddenIds,
      hideStreams: [], offset: 0, limit: 500,
    }),
    enabled: !filters.favs && hiddenIds.length > 0,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const hiddenRows = useMemo(
    () => (filters.favs ? [] : (hiddenHere?.rows ?? [])),
    [filters.favs, hiddenHere],
  );
  /**
   * One divider row, then the hidden ones.
   *
   * The divider is a ROW rather than a heading inside one, because the list is
   * virtualised at a fixed pitch: anything that made one row taller than
   * `--row-step` would put every row after it at the wrong offset, which is the
   * bug `liveRows.test.ts` exists to prevent.
   */
  const tailCount = hiddenRows.length > 0 ? hiddenRows.length + 1 : 0;
  const rowAt = useCallback(
    (i: number): Item | 'divider' | undefined => {
      if (i < shownTotal) return displayRows.get(i);
      if (i === shownTotal) return 'divider';
      return hiddenRows[i - shownTotal - 1];
    },
    [shownTotal, displayRows, hiddenRows],
  );
  /**
   * The block of rows the stored guide is read for.
   *
   * The virtualiser reports a new window on every frame of a scroll, and a guide
   * read keyed on that window directly is a fresh pass over the device's
   * IndexedDB per frame. Quantised to a block of forty (`epgBlock`), a flick
   * through two hundred channels is three reads and standing still is none.
   */
  const [block, setBlock] = useState(() => epgBlock(0, 0));
  const onRange = useCallback((s: number, e: number) => {
    /* Clamped: everything past `total` is the hidden tail, which is already in
       hand — asking the pager for it would be a request per empty page. */
    ensureRange(s, Math.min(e, Math.max(0, shownTotal - 1)));
    const next = epgBlock(s, e);
    setBlock((b) => (b.from === next.from && b.to === next.to ? b : next));
  }, [ensureRange, shownTotal]);

  const open = useCallback(
    async (item: Item) => {
      const gen = ++openGen.current;
      const id = linkId(item);
      pendingCh.current = id;
      openedId.current = id;
      /* Resolved per channel, not read from a global switch: under `auto` a
         channel already known to need HLS gets HLS and everything else gets the
         fast path. See `resolveLiveMode`. */
      const ext = resolveLiveMode(item.id) === 'lowLatency' ? 'ts' : 'm3u8';
      /**
       * Stop the outgoing channel BEFORE resolving the next one.
       *
       * A resolve that fails must not leave the previous stream armed to
       * reconnect itself. Tearing down first also releases the panel's single
       * allowed connection while we build the next URL.
       */
      player.teardown();
      player.opening(displayName(item.name), true);
      try {
        /* Variants → chosen feed → playback URL → HEVC name hint: written once
           in `lib/liveOpen.ts` and shared with every other screen that plays a
           live channel, so the choices in it cannot drift between them. */
        const { target, chosen, feeds } = await resolveLiveTarget(item, ext);
        if (gen !== openGen.current) return;
        const chosenId = linkId(chosen);

        /* Start the demuxer before React re-renders from setParams/setCurrent —
           those used to run first and insert a paint of idle UI between teardown
           and attach. */
        const loading = player.load(target, displayName(chosen.name), {
          live: true,
          key: chosen.ref ?? `1.${chosen.id}`,
        });

        setFamilyIds(feeds.length > 0 ? feeds.map((v) => v.id) : [item.id]);
        /* Where LAST CHANNEL goes back to. Recorded here rather than on the way
           in, so a load that was cancelled or failed never rewrites it — and
           only when the channel actually changed: re-opening the same feed is
           what a retry and a transport change do, and either one would turn the
           button into "the channel I am already watching". */
        const leaving = currentRef.current;
        if (leaving !== null && linkId(leaving) !== chosenId) setPrevious(leaving);
        setCurrent({ ...item, id: chosen.id, name: chosen.name });
        const p = paramsFromFilters(filters);
        /* The sport the list is on, even when it was the default and the
           address never named it — so a reload or a resume lands on it. */
        if (sports && sport !== null && !filters.favs) p.set('sport', sport);
        p.set('ch', id);
        setParams(p, { replace: true });
        noteLastPlayed({
          route: sports
            ? `/sports?${new URLSearchParams([
              ...(sport !== null && !filters.favs ? [['sport', sport]] : []),
              ...(filters.favs ? [['favs', '1']] : []),
              ['ch', id],
            ]).toString()}`
            : `/live?ch=${encodeURIComponent(id)}`,
          label: displayName(item.name),
          logo: item.logo,
          kind: 'live',
          key: item.ref ?? `1.${item.id}`,
        });

        await loading;
      } catch (err) {
        if (gen !== openGen.current) return;
        player.fail(
          'this channel could not be opened',
          expiredHint()
            ?? playFailureHint(err, 'The panel did not answer with a playable URL. Try again, or pick another feed.'),
        );
      }
    },
    [filters, setParams, sports, sport],
  );

  /**
   * `?ch=` is a stable ref now, so it is a string and stays one.
   *
   * It used to be parsed with `Number()` and compared against `item.id`, which
   * tied a restored tab to a row id that the next re-ingest renumbered. The
   * comparison below is against the ref for the same reason.
   */
  const urlCh = params.get('ch') ?? '';
  /** What the three refs say about `?ch=` right now — see `lib/liveRestore.ts`.
      Empty deps because refs are the only thing it reads: it must never be a
      render-old snapshot, which is the entire point of asking a ref. */
  const claims = useCallback((): ChannelClaims => ({
    opened: openedId.current, pending: pendingCh.current, closed: closedCh.current,
  }), []);
  useEffect(() => {
    if (urlCh !== '' && urlCh === pendingCh.current) pendingCh.current = null;
    /* The address has moved off the channel that was closed — to nothing, or to
       another channel — so the close has landed and a `?ch=` from here on is a
       real request again. Cleared rather than left standing: someone who backs
       out of a channel and then presses that same row in the list, or follows a
       resume banner to it, must get it opened. */
    if (closedCh.current !== null && urlCh !== closedCh.current) closedCh.current = null;
  }, [urlCh]);

  const { data: restored } = useQuery({
    queryKey: ['item', urlCh],
    queryFn: () => api.item(urlCh),
    enabled: wantsChannel(urlCh, claims()),
    retry: false,
    staleTime: 60_000,
  });
  /**
   * A channel opened from somewhere else brings its country with it.
   *
   * `/live?ch=…` is the address a search result, a home rail and a resume banner
   * all use, and following one used to drop you into Live TV with the sidebar
   * reading ALL COUNTRIES and a list of every channel in the subscription: the
   * thing playing was somewhere in it, and nothing on screen said where. The
   * channel's own package knows its country, so selecting it is what makes the
   * rest of the page agree with the picture.
   *
   * Only when nothing is filtered. Someone who has picked a country and is
   * paging through it must not have that thrown away because they pressed a
   * channel — this is for arriving from outside, which is the case where there
   * is nothing to overwrite.
   */
  /* Read through a ref so selecting the country does not re-run the effect that
     selected it — the filters it writes would otherwise be in its own dependency
     list, and it would fire again on its own result. */
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; });

  const liveCategories = useCategories('live', {
    hidePaths: prefs.hidePaths,
    hideCats: prefs.hideCats,
    hideCatRefs: prefs.hideCatRefs,
  });
  /**
   * Held, not applied here — `open()` writes the address too.
   *
   * Both effects run in the same commit, `open()` is declared second, and it
   * rebuilds the query string from the params of the render it closed over. So
   * writing the country beside it was writing it and having it overwritten a
   * microsecond later, which looks exactly like the code not running at all.
   * Applying it one commit later, once the channel is actually open, puts it on
   * top of the address `open()` just wrote.
   */
  const pendingMarket = useRef<string | null>(null);
  useEffect(() => {
    /* Sports keeps the sport it is on; a channel's country is not its address. */
    if (sports) return;
    if (!restored || restored.kind !== Kind.Live) return;
    if (filters.favs || filters.markets.length > 0 || filters.paths.length > 0 || filters.path
      || filters.categoryId !== null) return;
    const home = liveCategories.find((c) => c.id === restored.categoryId);
    /* Depth 1 of the group path IS the country the sidebar lists. `region` is
       only a fallback: it is derived from the category NAME and is null across
       most of this catalogue — matching on it alone selected nothing at all,
       while the path for the same channel reads ["PKF", "NEWS"]. */
    const market = home?.path?.[0] ?? home?.region ?? null;
    if (market === null || market === '') return;
    pendingMarket.current = market;
  }, [restored, liveCategories, filters.favs, filters.markets.length, filters.paths.length, filters.path,
    filters.categoryId, sports]);

  useEffect(() => {
    const market = pendingMarket.current;
    if (market === null || current === null) return;
    pendingMarket.current = null;
    const now = filtersRef.current;
    /* Checked again rather than trusted: a commit passed, and the viewer may
       have picked a country in it. Theirs wins. */
    if (now.favs || now.markets.length > 0 || now.paths.length > 0 || now.path
      || now.categoryId !== null) return;
    /* Written here rather than through `onFilters`, which carries `?ch=` over
       from the params it closed over — by now that is the id the LINK used, and
       `open()` has since replaced it with the canonical ref. Going through it
       would put the old id back and undo the healing that is the whole reason
       the ref is rewritten on open. */
    const p = paramsFromFilters({ ...now, markets: [market] });
    p.set('ch', linkId(current));
    setParams(p, { replace: true });
  }, [current, setParams]);

  useEffect(() => {
    if (!restored || restored.kind !== Kind.Live) return;
    /* Mid-open or mid-close: a ref has moved and `?ch=` has not caught up, so the
       address is describing what this page is already doing rather than asking
       for anything. `wantsChannel` is the whole rule and it is tested. */
    if (!wantsChannel(urlCh, claims())) return;
    if (openedId.current === linkId(restored)) return;
    /**
     * Deep link / back / resume — URL wants a channel we have not claimed yet.
     * Opening rewrites `?ch=` to the canonical ref when the link was a stale id.
     */
    void open(restored);
  }, [restored, open, urlCh, claims]);

  /**
   * The other half of `auto`.
   *
   * The core sees the raw feed fail to demux and says so; this remembers that the
   * channel needs HLS and re-opens it. Only under `auto` — an explicit choice is
   * an instruction, and quietly overriding it would make the switch a lie.
   */
  useEffect(() => {
    player.onNeedCompatible = (reason) => {
      // Returning false is how the core learns it must show its own error rather
      // than wait for a re-open that is never coming.
      if (getLiveMode() !== 'auto' || !current) return false;
      rememberNeedsCompatible(current.id);
      // eslint-disable-next-line no-console
      console.info(`[live] ${current.id} dropped to the compatible transport: ${reason}`);
      void open({ ...current });
      return true;
    };
    return () => { player.onNeedCompatible = null; };
  }, [current, open]);

  const changeMode = useCallback(
    (m: LiveMode) => {
      setMode(m);
      setLiveMode(m);
      if (current) void open({ ...current });
    },
    [current, open],
  );

  // Alternative feeds of the selected channel: FHD/HD/HEVC/RAW are published as
  // separate channels here, so this is what a quality switch actually is.
  const { data: variants } = useQuery({
    queryKey: ['variants', current?.id],
    queryFn: () => api.variants(linkId(current!)),
    enabled: Boolean(current),
    staleTime: 300_000,
    retry: false,
  });

  const familySet = useMemo(() => {
    const ids = new Set(familyIds);
    if (current) ids.add(current.id);
    for (const v of variants?.variants ?? []) ids.add(v.id);
    return ids;
  }, [current, familyIds, variants]);

  const pickVariant = useCallback(
    async (id: number) => {
      const gen = ++openGen.current;
      const picked = variants?.variants.find((v) => v.id === id);
      if (!picked) return;
      setPrefs({ liveQuality: picked.quality });
      player.teardown();
      player.opening(displayName(picked.name), true);
      try {
        const target = await api.play(linkId(picked), resolveLiveMode(id) === 'lowLatency' ? 'ts' : 'm3u8');
        if (gen !== openGen.current) return;
        setCurrent((c) => (c ? { ...c, id, name: picked.name } : c));
        await player.load(target, displayName(picked.name), { live: true, key: picked.ref ?? `1.${picked.id}` });
      } catch (err) {
        if (gen !== openGen.current) return;
        player.fail('this feed could not be opened',
          playFailureHint(err, 'The panel did not answer with a playable URL for this feed.'));
      }
    },
    [variants, setPrefs],
  );

  const pickAuto = useCallback(async () => {
    setPrefs({ liveQuality: 'auto' });
    const feeds = variants?.variants;
    if (!feeds || feeds.length === 0 || !current) return;
    const chosen = chooseFeed(feeds, 'auto', downlinkMbps());
    if (chosen.id === current.id) return;
    const gen = ++openGen.current;
    player.teardown();
    player.opening(displayName(chosen.name), true);
    try {
      const target = await api.play(linkId(chosen), resolveLiveMode(chosen.id) === 'lowLatency' ? 'ts' : 'm3u8');
      if (gen !== openGen.current) return;
      setCurrent((c) => (c ? { ...c, id: chosen.id, name: chosen.name } : c));
      await player.load(target, displayName(chosen.name), { live: true, key: chosen.ref ?? `1.${chosen.id}` });
    } catch (err) {
      if (gen !== openGen.current) return;
      player.fail('this feed could not be opened',
        playFailureHint(err, 'The panel did not answer with a playable URL for this feed.'));
    }
  }, [current, variants, setPrefs]);

  /**
   * What is on now on the rows that are on screen — from the guide already here.
   *
   * "if any channal has any catchups show it below its name", beside photographs
   * of a competitor whose every channel row carries a second line. The archive
   * half of that line needs nothing at all: `archive` and `archiveDays` are
   * columns on the item row. The programme half needs the guide, and the guide is
   * the one thing on this screen that must NOT be fetched to draw a list.
   *
   * `api.epgGrid` reads the device's own store and never asks the panel — that
   * invariant is written on `localEpgGrid` and it is not a nicety: a client that
   * asks per channel gets the household's address flood-blocked, which is the
   * entire reason `lib/localEpg.ts` has a scheduler. On-screen channels the store
   * does not know yet get one `epgTopup` (below), same shape as Guide, so the
   * second line can fill without per-row panel asks.
   */
  /*
   * Sports: "make sure everything has its EPG". A panel publishes one channel
   * several times (SD/HD/FHD/HEVC) and often only one copy carries a guide, so a
   * row with none borrows its sibling's — same tvg-id, or the same name once the
   * quality words are gone (`guideDonors`, lib/sports.ts). Donors are found among
   * the rows in hand, and asked for alongside the rows on screen.
   */
  /* Live too, since both screens draw the same rows: "do the same for EPGs and
     live TV as well … that way both Live TV and Sports TV will look the same". */
  const guideIds = useMemo(() => {
    const out: number[] = [];
    for (let i = block.from; i <= block.to; i += 1) {
      const item = displayRows.get(i);
      /* A playlist channel has no panel to ask, but may have a stored guide. */
      if (item !== undefined) out.push(item.id);
    }
    return guideRequestIds(out, donors);
  }, [displayRows, block, donors]);

  /* Re-read every two minutes rather than every frame. The window asked for is
     three hours wide, so the slots in hand stay enough to answer "what is on
     now" long after the read — see `nowTitle` below, which asks that question
     against the clock rather than against the moment of the read. */
  const guideBucket = Math.floor(Date.now() / 120_000);
  const { data: listGuide } = useQuery({
    queryKey: ['live', 'listGuide', guideIds, guideBucket],
    queryFn: () => api.epgGrid(guideIds, Math.floor(Date.now() / 1000), 3),
    enabled: guideIds.length > 0,
    staleTime: 120_000,
    retry: false,
    /* The rows must not lose their second line while the next read lands: a
       list whose rows change height under the highlight is the thing all of
       this was meant to stop. */
    placeholderData: (prev) => prev,
  });
  /**
   * Channels on screen that the device has no guide for, asked for once.
   *
   * A ref, not state, for the reason the Guide's copy of this says: the queue is
   * polite but asking it the same question forty times while React settles is
   * still forty questions.
   */
  const qc = useQueryClient();
  const askedGuide = useRef(new Set<number>());
  useEffect(() => {
    const missing = (listGuide?.channels ?? [])
      .filter((c) => !c.known && !askedGuide.current.has(c.id))
      .map((c) => c.id);
    if (missing.length === 0) return;
    for (const id of missing) askedGuide.current.add(id);
    void api.epgTopup(missing).catch(() => {});
  }, [listGuide]);

  /**
   * Re-read while the queue is still working, then stop.
   *
   * The list's own read is on a two-minute bucket, which is right for a guide
   * that only ages — but a channel whose listings have just been fetched would
   * otherwise sit blank for up to two minutes after the answer arrived. Bounded
   * at a dozen polls so channels the panel simply has no guide for cannot make
   * this run forever. Same shape, same reasoning, as `routes/Guide.tsx`.
   */
  const guideWaiting = (listGuide?.channels ?? []).filter((c) => !c.known).length;
  /* Which rows have their answer — per row, so one channel still being asked
     for does not leave every guideless row beside it on "…". */
  const guideKnown = useMemo(
    () => new Set((listGuide?.channels ?? []).filter((c) => c.known).map((c) => c.id)),
    [listGuide],
  );
  const guidePolls = useRef(0);
  useEffect(() => {
    if (guideWaiting === 0) {
      guidePolls.current = 0;
      return;
    }
    if (guidePolls.current > 24) return;
    const t = window.setTimeout(() => {
      guidePolls.current += 1;
      void qc.invalidateQueries({ queryKey: ['live', 'listGuide'] });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [guideWaiting, listGuide, qc]);

  const guideSlots = useMemo(() => {
    const m = new Map<number, GuideSlot[]>();
    for (const c of listGuide?.channels ?? []) {
      const slots = c.slots
        .filter((x) => x.startTs !== null)
        .map((x) => ({
          title: x.title, description: x.description,
          startTs: x.startTs as number, stopTs: x.stopTs,
        }));
      if (slots.length > 0) m.set(c.id, slots);
    }
    return m;
  }, [listGuide]);
  /** A row's guide, or the first sibling's that has one. */
  const slotsFor = useCallback((id: number): GuideSlot[] => {
    const own = guideSlots.get(id);
    if (own !== undefined) return own;
    for (const d of donors.get(id) ?? []) {
      const got = guideSlots.get(d);
      if (got !== undefined) return got;
    }
    return [];
  }, [guideSlots, donors]);

  const { data: epg } = useQuery({
    queryKey: ['epg', current?.id],
    queryFn: () => api.epg(current!.id),
    enabled: Boolean(current),
    staleTime: 120_000,
    retry: false,
  });

  /**
   * Mounted exactly once, and never conditionally.
   *
   * playerCore owns one media element for the whole app and `load()` returns early
   * when no <video> is attached — so unmounting the surface between channels would
   * silently swallow the next play. When nothing is playing the stacked layout
   * hides it with display:none, which keeps the element (and the attachment) alive.
   */
  /**
   * Zapping between channels in the filtered list on screen. BACK no longer
   * stops the picture — see `leaveTheatre` and `resolveBack('/live')`.
   */
  /**
   * The index of the channel on screen, when it is known exactly.
   *
   * Set when a row is clicked, because at that moment the index is in hand and no
   * searching is needed. Null after a deep link or a resume, where the channel is
   * known but its position in the current list is not.
   */
  const atIndex = useRef<number | null>(null);
  /** Scroll the channel list to this index when it changes (deep link / filter). */
  const [reveal, setReveal] = useState<{ index: number; token: number } | null>(null);
  const revealToken = useRef(0);
  const lastReveal = useRef<{ id: number; index: number; q: string } | null>(null);

  /**
   * Where the current channel sits in the list, or -1.
   *
   * The old version walked the row cache and stopped at the first row whose id was
   * in `familySet` — which is the set of the current channel AND its alternative
   * feeds. So on any channel published as FHD/HD/HEVC variants it found the wrong
   * variant's index, and stepping from there landed back on a feed of the SAME
   * channel: the button worked perfectly and appeared to do nothing.
   *
   * Now an exact id match wins outright, and the family is only a fallback for the
   * case it exists for — the open channel being a variant that is not itself a row.
   * Deep links (Guide, search, resume) never set `atIndex`, so we resolve against
   * the ordered catalogue list rather than only the sparse page cache.
   *
   * The favourites bouquet is its OWN branch, first, rather than falling through
   * to any of that: `localIndexOfItem` answers in catalogue order, which is
   * exactly the order `favBouquet` exists to override, so a cache hit there
   * would be a correct answer to the wrong question. `favBouquet` is small and
   * already in memory, so scanning it fresh is cheap enough to skip the
   * `atIndex` cache entirely.
   */
  const indexOfCurrent = useCallback((): number => {
    if (!current) return -1;
    if (inOrder !== null) {
      let family = -1;
      for (let i = 0; i < inOrder.length; i++) {
        const row = inOrder[i]!;
        if (row.id === current.id) return i;
        if (family < 0 && familySet.has(row.id)) family = i;
      }
      return family;
    }
    if (atIndex.current !== null) {
      const there = rowsNow().get(atIndex.current);
      if (there && (there.id === current.id || familySet.has(there.id))) return atIndex.current;
    }
    const found = localIndexOfItem('live', query, current.id, familySet);
    if (found >= 0) {
      atIndex.current = found;
      return found;
    }
    let family = -1;
    for (const [i, row] of rowsNow()) {
      if (row.id === current.id) return i;
      if (family < 0 && familySet.has(row.id)) family = i;
    }
    return family;
  }, [current, familySet, rowsNow, query, inOrder]);

  /* After Guide / search / resume open a channel, put that row on screen and keep
     `atIndex` honest when the country filter lands a commit later.

     Favourites branch first, same reason as `indexOfCurrent`: `localIndexOfItem`
     answers in catalogue order, and the row this screen shows at that index is a
     different channel once the bouquet has been reordered. */
  useEffect(() => {
    if (!current || shownTotal === 0) return;
    const index = inOrder !== null
      ? inOrder.findIndex((row) => row.id === current.id || familySet.has(row.id))
      : localIndexOfItem('live', query, current.id, familySet);
    if (index < 0) return;
    const qKey = [
      query.path ?? '', (query.paths ?? []).join('+'), query.q, query.sort, query.dir,
      (query.streamIds ?? []).join(','), inOrder === null ? '' : 'o',
    ].join('|');
    const prev = lastReveal.current;
    if (prev && prev.id === current.id && prev.index === index && prev.q === qKey) return;
    lastReveal.current = { id: current.id, index, q: qKey };
    atIndex.current = index;
    void ensureRange(Math.max(0, index - 5), Math.min(total - 1, index + 15));
    setReveal({ index, token: ++revealToken.current });
  }, [current, familySet, total, shownTotal, query, ensureRange, inOrder]);

  /**
   * Zapping.
   *
   * Two things it has to do that the first version did not.
   *
   * WAIT FOR THE PAGE. It called `ensureRange` and then read the row cache on the
   * very next line — a fire-and-forget fetch followed by a synchronous read, so at
   * every hundred-row page boundary next and previous silently did nothing.
   * `fetchRow` awaits.
   *
   * SKIP THE FAMILY. The next row is often another feed of the same channel
   * (FHD/HD/HEVC are separate rows here), and stepping onto one of those looks
   * exactly like the button not working. So it walks until it finds a channel that
   * is genuinely different, with a bound on how far — twelve rows is more than any
   * real variant group and stops a filtered list of one family from becoming a
   * hundred requests.
   *
   * The favourites branch skips `fetchRow`/`ensureRange` entirely and walks
   * `favBouquet` directly — the whole bouquet is already in memory by the time
   * anything is playing from it, so there is no page left to wait for, and
   * indexing it keeps next/previous walking the SAME order the list on screen
   * is drawn in rather than the catalogue's.
   */
  const step = useCallback(async (delta: number) => {
    if (!current) return;
    if (inOrder !== null) {
      const from = indexOfCurrent();
      if (from < 0) return;
      for (let hop = 1; hop <= 12; hop++) {
        const want = from + delta * hop;
        if (want < 0 || want >= inOrder.length) return;
        const row = inOrder[want]!;
        if (row.id === current.id || familySet.has(row.id)) continue;
        atIndex.current = want;
        void open(row);
        return;
      }
      return;
    }
    const from = indexOfCurrent();
    if (from < 0) return;
    for (let hop = 1; hop <= 12; hop++) {
      const want = from + delta * hop;
      if (want < 0 || want >= total) return;
      // Prefetch a little in the direction of travel, so holding the button down
      // does not stall on every page edge.
      void ensureRange(Math.max(0, want - 2), want + 8 * (delta > 0 ? 1 : 0));
      const row = await fetchRow(want);
      if (!row) return;
      if (row.id === current.id || familySet.has(row.id)) continue;
      atIndex.current = want;
      void open(row);
      return;
    }
  }, [current, familySet, indexOfCurrent, open, total, ensureRange, fetchRow, inOrder]);

  /*
   * Typing a channel number on the remote keypad is gone.
   *
   * It read digits into a large "127 OF 12,890" overlay across the middle of the
   * screen and tuned on a 1.4s timer. Every set-top box does do this, and on a
   * box with a number pad it is the fastest way through a long list — but this is
   * a six-key app by decision: D-pad, OK, Back, because Samsung guarantees
   * nothing more and Fire TV has no number pad at all. A feature only some
   * remotes can reach is a feature that has to be tested and explained twice, and
   * the channel list already answers the same question with the keys everybody
   * has.
   */


  /**
   * The star button, and what it stars.
   *
   * "Favourite" needs an object, and on a channel list there are two candidates:
   * the channel playing and the row focus is on. The row wins when there is one —
   * that is what a remote's STAR button means everywhere else — and the playing
   * channel is the fallback, which is also the only answer when the list is not
   * where focus is. `data-stream-id` on the row is how the answer is found without
   * threading focus state through the whole page.
   */
  const favHere = useCallback(() => {
    const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-stream-id]');
    const fromRow = el?.dataset['streamId'];
    const id = fromRow !== undefined && fromRow !== '' ? Number(fromRow) : current?.streamId ?? null;
    if (id === null || !Number.isFinite(id)) return;
    toggleFav('live', id);
  }, [current]);


  const bindings = useMemo((): Binding[] => [
    { intent: 'red', label: 'Favourite', act: favHere },
    { intent: 'favourite', label: 'Favourite', act: favHere },
    {
      intent: 'yellow',
      label: filters.favs ? 'All channels' : 'Favourites only',
      act: () => onFilters({ ...filters, favs: !filters.favs }),
    },
    /* Only once there is a channel to go back to — see `previous`. The label is
       the same three words the shortcuts sheet has always printed for this key,
       because the legend is read at a glance from three metres and a channel
       name there would be a different width on every press. */
    ...(previous === null ? [] : [{
      intent: 'lastChannel' as const,
      label: 'Last channel',
      act: () => { void open(previous); },
    }]),
  ], [favHere, filters, onFilters, open, previous]);
  useKeyLayer(bindings);

  /* Theatre only. BACK must not stop the picture — the channel stays on until
     another is picked or the route unmounts. With no onClose, VideoPlayer's
     exit declines and `nativeBack` counts the three-press leave-the-app gesture. */
  const leaveTheatre = useCallback(() => { setTheatre(false); }, []);

  /**
   * Restart: play the programme that is on RIGHT NOW again, from its start.
   *
   * Only offered when both halves are true — the channel actually keeps an
   * archive, and a "now" is known to ask it for — which is the same
   * `archive && archiveDays > 0` the row's own catch-up badge is gated on
   * (see `NowNext`), plus `epg.now` having a start and stop the archive
   * endpoint can be asked for.
   */
  const canRestart = current !== null && current.archive && current.archiveDays > 0
    && epg?.now?.startTs != null && epg.now.stopTs != null;
  const [restarted, setRestarted] = useState(false);
  /* A different channel — zapped to, picked in the list, or opened by a deep
     link — is never still showing the recording restarted from a previous
     one. `linkId` rather than `current.id`: a quality swap (`pickVariant`,
     `pickAuto`) already reloads the picture LIVE by itself, so treating a
     variant as "a different channel" here still lands on the true answer. */
  const currentKey = current ? linkId(current) : null;
  useEffect(() => { setRestarted(false); }, [currentKey]);
  const restartProgramme = useCallback(async () => {
    if (!current || !epg?.now || epg.now.startTs == null || epg.now.stopTs == null) return;
    const { startTs, stopTs, title } = epg.now;
    const label = title ?? displayName(current.name);
    const channelId = linkId(current);
    const gen = ++openGen.current;
    /*
     * Same order `open()` uses, for the same reason: the line allows ONE
     * connection, so the panel refuses the archive probe/play call while the
     * live stream above still holds it. Release it first.
     */
    player.teardown();
    player.opening(label);
    try {
      const target = await api.archivePlay(channelId, startTs, stopTs);
      if (gen !== openGen.current) return;
      // live: false — a recording has a duration and a seek bar; see
      // routes/Catchup.tsx `play()`, which this mirrors exactly.
      await player.load(target, label, {
        live: false,
        durationS: target.minutes * 60,
        key: `${channelId}:${startTs}`,
      });
      if (gen === openGen.current) setRestarted(true);
    } catch (err) {
      if (gen !== openGen.current) return;
      // The same shape `open()` fails in, so RETRY (already wired to
      // `onRetry` below) is a live one-press way back — never a dead picture.
      player.fail(
        'this programme could not be restarted',
        err instanceof Error && /404/.test(err.message)
          ? 'That recording is no longer available from the archive. Retry to go back to the live channel.'
          : 'The panel did not answer with a playable recording. Retry to go back to the live channel.',
      );
    }
  }, [current, epg]);
  const goLive = useCallback(() => {
    setRestarted(false);
    if (current) void open(current);
  }, [current, open]);

  const surface = (
    <VideoPlayer
      forceCover={sports}
      onRetry={current ? () => void open(current) : undefined}
      onBufferChange={current ? () => void open(current) : undefined}
      streamKey={current ? (current.ref ?? `1.${current.id}`) : null}
      variants={variants?.variants}
      qualityMode={prefs.liveQuality}
      onQualityMode={() => void pickAuto()}
      onPickVariant={(id) => void pickVariant(id)}
      {...(theatre ? { onClose: leaveTheatre } : {})}
      {...(current ? { onPrev: () => step(-1), onNext: () => step(1) } : {})}
      {...(current
        ? { info: <LiveDetail item={current} epg={epg} /> }
        : {})}
      {...(current ? { onGuide: () => nav(`/guide?ch=${linkId(current)}`) } : {})}
      {...(canRestart ? { onRestart: () => void restartProgramme() } : {})}
      {...(epg?.now && epg.now.startTs !== null
        ? {
          nowPlaying: {
            title: epg.now.title ?? 'Unnamed programme',
            startTs: epg.now.startTs,
            stopTs: epg.now.stopTs,
          },
        }
        : {})}
      restarted={restarted}
      onGoLive={goLive}
      theatre={{ on: theatre, toggle: () => setTheatre((v) => !v) }}
      idleHint="Pick a channel."
      liveMode={mode}
      onLiveMode={changeMode}
    />
  );

  /*
    Under the picture: what is on, and only that.

    The details — stream id, guide id, transport, resolution, bitrate, container
    — were behind an info button right here, which meant the player had a menu
    and the page underneath it had a second one holding the other half of "what
    am I watching". They are a section of the player's own menu now, passed in as
    `info`, and this is the programme.
  */
  const detail = current ? (
    /* The guide is offered ONCE. The modern action row above already carries
       EPG, and NowNext's own FULL GUIDE beside the title went to the same place
       — two doors side by side, one of them indented. Classic has no action
       row, so there the title keeps its link. */
    <NowNext item={current} epg={epg} guideLink={!modern} />
  ) : (
    <p className="font-mono text-[length:var(--t-sm)] leading-relaxed text-ink-3">
      Pick a channel.
    </p>
  );

  /*
    No action row under the picture. It held Full Screen, EPG and Add to
    Favourites, and each was already one press away: the player's own bar has
    full screen and the guide, and a held row (or the remote's red key) stars a
    channel. "all those 3 buttons are entirely useless bcs they are already in
    the player or in sidebar".
  */

  /*
    What the list IS, above the list.

    The channel pane had no heading: with the filter strip gone (search lives in
    the header) the first thing in it was row one, and from across a room a list
    of channels with nothing over it does not say which country it is. One line
    — the chosen country or group, and how many channels are under it.
  */
  /* A category picked from the list shape is headed by its own raw name, the
     same words as the row that picked it. */
  const pickedCategory = filters.categoryId === null
    ? null
    : liveCategories.find((c) => c.id === filters.categoryId)?.name ?? null;
  /* When NOTHING is picked, this has to say exactly what `LiveSidebar`'s own
     standing row says — `standingLabel` (lib/liveRows.ts), not a literal.
     This was 'All countries' outright, correct only in tree mode: list mode
     became the default in 1.18.0 and the sidebar's standing row said "All
     channels" underneath a heading that never looked at `browseStyle` at all. */
  const sportLabel = RAIL_SPORTS.find((t) => t.id === sport)?.label ?? 'Sports';
  const heading = sports
    ? (filters.favs
      ? 'Favourite sport'
      : filters.q.trim() !== ''
        ? `Sport matching “${filters.q.trim()}”`
        : `${sportLabel}${filters.markets[0] ? ` · ${marketName(filters.markets[0])}` : ''}`)
    : filters.favs
    ? 'Favourites'
    : pickedCategory
      ?? filters.paths[0]?.split('/').pop()
      ?? (filters.markets[0] ? marketName(filters.markets[0]) : standingLabel(prefs.browseStyle === 'list', true));
  /*
    What the sport's list shows and in which order, in one menu at the head of
    the list — named in a word on the button ("Show: Live"), because an icon
    alone does not say what it is for from three metres. All by default; the
    choice is kept and is the same for every sport. The counts come from the
    guide read the list itself was ordered by.
  */
  const [showMenu, setShowMenu] = useState(false);
  /*
    Countries, for the sport on screen: counted over the sport's channels with
    no country applied, so every country the sport has is offered and not only
    the ones already picked. Read when the picker opens, not on every render —
    it is a pass over every channel of the sport.
  */
  const [countryPicker, setCountryPicker] = useState(false);
  const countryOptions = useMemo((): FacetOption[] => {
    if (!countryPicker || idList === null) return [];
    const { markets: _drop, offset: _o, limit: _l, ...unscoped } = query as PagedQuery & {
      markets?: string[]; offset?: number; limit?: number;
    };
    const home = new Map(liveCategories.map((c) => [c.id, c.path?.[0] ?? c.region ?? null]));
    const counts = new Map<string, number>();
    for (const r of localAllItems('live', unscoped)) {
      const m = r.categoryId === null ? null : home.get(r.categoryId) ?? null;
      if (m !== null && m !== '') counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, label: marketName(id), count }));
  }, [countryPicker, idList, query, liveCategories]);
  const showActions = useMemo((): HoldAction[] => {
    const c = sportView?.counts;
    const count = (k: SportsShow) => (c === undefined ? '' : ` · ${c[k].toLocaleString()}`);
    const pick = (k: SportsShow, Icon: HoldAction['Icon'], hint: string): HoldAction => ({
      id: `show-${k}`,
      label: `${SHOW_WORD[k]}${count(k)}`,
      hint,
      Icon: sportsShowing === k ? Check : Icon,
      primary: sportsShowing === k,
      act: () => setSportsShow(k),
    });
    return [
      pick('all', List, 'Every channel in this sport'),
      pick('live', Radio, 'On air now, by the guide'),
      pick('next', Clock, 'Nothing on yet, something coming up'),
      pick('ended', History, 'The guide or the event says it is over'),
      pick('today', CalendarClock, 'Programmes on today'),
      pick('tomorrow', CalendarClock, 'Programmes on tomorrow'),
      {
        id: 'country',
        label: `Country: ${sportMarkets.length === 0 ? 'All'
          : sportMarkets.length === 1 ? marketName(sportMarkets[0]!) : `${sportMarkets.length} countries`}`,
        hint: 'OK: choose which countries\' channels to list',
        Icon: Globe,
        primary: sportMarkets.length > 0,
        act: () => setCountryPicker(true),
      },
      {
        id: 'order',
        label: arrangedHere ? 'Order: your own' : listOrder === 'onnow' ? 'Order: on now first' : 'Order: channel order',
        hint: arrangedHere ? 'You moved channels in this sport, so they stay where you put them'
          : listOrder === 'onnow' ? 'OK: switch to the provider\'s channel order' : 'OK: switch to live matches first',
        Icon: ListOrdered,
        act: () => { if (!arrangedHere) setSportsListOrder(listOrder === 'onnow' ? 'channel' : 'onnow'); },
      },
    ];
  }, [sportView, sportsShowing, arrangedHere, listOrder, sportMarkets]);
  const showButton = sports && !filters.favs ? (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => setShowMenu(true)}
      className={`dest tap flex shrink-0 items-center gap-1.5 self-center border px-2 py-1 font-mono
                  text-[length:var(--t-2xs)] uppercase tracking-wider transition-colors ${
        sportsShowing !== 'all' || sportMarkets.length > 0
          ? 'border-tally text-tally'
          : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:border-focus focus-visible:text-focus'
      }`}
    >
      <ListFilter className="h-3 w-3" />
      <span>
        Show: {SHOW_WORD[sportsShowing]}
        {sportMarkets.length === 0 ? '' : sportMarkets.length === 1 ? ` · ${sportMarkets[0]}` : ` · ${sportMarkets.length}`}
      </span>
      <ChevronDown className="h-3 w-3" />
    </button>
  ) : null;

  const listHead = (
    <div className="flex shrink-0 items-baseline gap-3 border-b border-rule px-4 py-2.5">
      {/* A phone's rail is a drawer, opened from here — nothing on a TV. */}
      <RailToggle />
      <h2 className="min-w-0 truncate text-[length:var(--t-md)] font-medium text-ink">{heading}</h2>
      <span className="ml-auto shrink-0 font-mono text-[length:var(--t-xs)] tabular-nums text-ink-3">
        {/* Nothing rather than "0 channels": the list underneath already says
            it is empty, and in better words than a zero does. */}
        {loading && total === 0 ? '…' : (tallyOf(shownTotal) === null ? '' : `${tallyOf(shownTotal)} channels`)}
      </span>
      {/* On the right, away from the name: "space between". */}
      {showButton}
    </div>
  );

  const building = useLibraryBuilding() || !topicsReady;

  /* The channel list itself: identical in both layouts, so it is written once. */
  const listBody = (
    <>
      {error && <p className="p-3 font-mono text-xs text-alert">{error}</p>}
      {/* `building` as well as `loading`: the query has settled, the catalogue
          has not. See `useLibraryBuilding` for the measured 2.3s window where
          this list called itself empty under a bar reading "Building the
          catalogue". */}
      {listPhase(loading, building, shownTotal) === 'skeleton' ? (
        <div className="space-y-px p-3">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="skeleton h-11" />
          ))}
        </div>
      ) : listPhase(loading, building, shownTotal) === 'empty' ? (
        <p className="p-6 font-mono text-xs leading-relaxed text-ink-3">
          {sports && sportsShowing !== 'all' && total > 0
            ? `No ${SHOW_WORD[sportsShowing].toLowerCase()} channels in ${sportLabel} right now. Show › All lists every one.`
            : filters.favs
            ? 'Star a channel to keep it here.'
            : `nothing here${filters.q ? ` matching \u201c${filters.q}\u201d` : ''}${
                prefs.hidePaths.length > 0 ? ' — some groups are hidden in display settings' : ''
              }.`}
        </p>
      ) : (
        <VirtualList
          count={shownTotal + tailCount}
          /* A 48px row is a comfortable click and a marginal tap. On glass and on a
             remote the rows grow to clear the 44pt target both platform guidelines
             ask for — and the number has to reach the virtualiser, not just the CSS,
             or every row lands at the wrong offset.
             It is the SIDEBAR's pitch too now, from the same three numbers and the
             same function: two lists side by side at different rhythms is what
             "they are not the same size both lists" was about. See
             `lib/liveRows.ts`, and the test that stops `--row-step` drifting from
             this. */
          /* Sports rows carry NEXT under NOW: one more line, at the same pitch
             for every row so the virtualiser's offsets stay exact. */
          /* One row for both screens: name, NOW with how far through, NEXT. */
          rowHeight={Math.round(rowStep(shape.ff, shape.touch) * 1.5)}
          navGroup="channels"
          column
          onRangeChange={onRange}
          scrollToIndex={reveal?.index ?? null}
          scrollToken={reveal?.token ?? 0}
          className="h-full overflow-y-auto"
          render={(i) => {
            const row = rowAt(i);
            if (row === 'divider') {
              return (
                <div
                  className="flex h-full items-center gap-2 border-b border-rule/40 bg-ground/40 px-3
                             font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3"
                >
                  <EyeOff className="h-3 w-3" />
                  <span>Hidden — press OK to bring one back</span>
                </div>
              );
            }
            const item = row;
            if (!item) return <div className="h-full px-3 py-2.5"><div className="skeleton h-full" /></div>;
            const isHidden = i > shownTotal;
            const isMoving = moving !== null && item.streamId === moving;
            const active = familySet.has(item.id);
            const label = displayName(item.name);
            /*
              The line under the name, decided in one place for all three cases.

              `slotAt` against the clock rather than the `nowPlaying` flag the
              read stamped: the read is up to two minutes old and the slots in
              hand cover three hours, so asking now is both cheaper and more
              correct than reading again. A channel with no stored guide and no
              archive gets `{ now: null, catchUpDays: null }` and the second line
              is not drawn at all — and the row is the same height either way,
              because the height is `--row-step` and not the content.
            */
            const nowS = Math.floor(Date.now() / 1000);
            const onNow = slotAt(slotsFor(item.id), nowS);
            const nn = sportsNowNext(slotsFor(item.id), nowS);
            /* An event channel's own name says what is on and when — see
               lib/eventName.ts. Drawn where a guide would be, when there is none. */
            const ev = parseEvent(item.name);
            const guideless = nn.now === null && nn.next === null;
            const line = secondLine({
              now: onNow?.title ?? null,
              archive: item.archive,
              archiveDays: item.archiveDays,
            });
            return (
              <button
                {...holdFav}
                data-stream-move={isMoving ? 'on' : undefined}
                onPointerDown={(e) => { pressed.current = item; holdFav.onPointerDown(e); }}
                onKeyDown={(e) => {
                  pressed.current = item;
                  /* While this row is being carried the arrows move it rather
                     than the highlight, and BACK undoes the whole carry. The
                     same contract the rail beside this list uses. */
                  if (isMoving) {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      e.stopPropagation();
                      carry(e.key === 'ArrowUp' ? -1 : 1);
                      return;
                    }
                    if (e.key === 'Escape' || e.key === 'Backspace') {
                      e.preventDefault();
                      e.stopPropagation();
                      const undo = undoOrder.current;
                      if (undo?.kind === 'stream') setStreamOrder(undo.ids);
                      else if (undo?.kind === 'fav') setFavOrder('live', undo.ids);
                      undoOrder.current = null;
                      setMoving(null);
                      return;
                    }
                  }
                  holdFav.onKeyDown(e);
                }}
                onClick={() => {
                  /* An explicit press wins and the pending rest is dropped —
                     otherwise OK opens the channel and the timer opens it again
                     a second later, which is two requests for one intention. */
                  cancelRest();
                  /* A row being carried is put down by OK, and nothing else
                     happens: this press is the end of the move, not the start of
                     a channel change. */
                  if (isMoving) { setMoving(null); undoOrder.current = null; return; }
                  /* In the hidden tail, OK is "bring it back" — the row you are
                     looking at is one you put down there, and the only thing
                     anybody wants from it is out. */
                  if (isHidden) {
                    if (item.streamId !== null) toggleHiddenStream(item.streamId);
                    return;
                  }
                  atIndex.current = i;
                  /* Already the channel on screen → OK makes it fullscreen, the way
                     a television does, instead of reopening the same feed. A fresh
                     channel opens into the preview pane as before. */
                  /*
                    `loading` counts, and that is what makes a DOUBLE PRESS work.
                    This tested `playing || paused`, which is a state the channel
                    reaches seconds after the first press — so two presses at the
                    speed a person actually double-taps found the row active and
                    the player still opening, fell through to the else, and
                    RESTARTED the stream. One gesture, and it read as nothing
                    happening. A channel on its way up is the channel on screen;
                    filling the screen while it opens is what was asked for.
                    `error` is deliberately not here — a second press on a channel
                    that failed means try again.
                  */
                  const phase = player.state.phase;
                  if (active && (phase === 'playing' || phase === 'paused' || phase === 'loading')) {
                    setTheatre(true);
                  } else {
                    void open(item);
                  }
                }}
                /*
                  Resting here opens it, if the viewer asked for that.
                  `onFocus` rather than hover: a remote has no hover, and a mouse
                  moving diagonally across a list of two hundred rows would arm
                  and disarm this on every one of them. Focus moves only when
                  somebody means it to.
                */
                onFocus={() => {
                  cancelRest();
                  if (isHidden) return;
                  const mode = prefs.autoOpen;
                  if (mode === 'off') return;
                  /* Already on screen: nothing to open, and re-opening the feed
                     that is playing is the one request guaranteed to be wasted. */
                  if (active) return;
                  atIndex.current = i;
                  restTimer.current = window.setTimeout(() => {
                    restTimer.current = 0;
                    void open(item);
                  }, AUTO_OPEN_MS[mode]);
                }}
                /* Moving on cancels it. Every press restarts the wait, so walking
                   a list at one row per second opens nothing at all — which is
                   the whole reason the default delay is two seconds. */
                onBlur={cancelRest}
                /* Which channel the STAR button on the remote means: whichever row
                   focus is on. Read by the RED/STAR binding below — the alternative
                   is a favourite button that only ever works on what is playing. */
                data-stream-id={item.streamId ?? undefined}
                className={`pick pick-row row-hover border-b border-rule/40 px-3 ${
                  modern ? 'tally-glow' : ''
                } ${active ? 'is-on' : ''} ${isHidden ? 'opacity-45' : ev?.state === 'ended' && guideless ? 'opacity-60' : ''}${
                  isMoving ? ' is-on ring-1 ring-inset ring-tally' : ''
                }`}
              >
                {/* The row number used to sit here, taking 40px from the name
                    on every row. It counted position in a filtered list, so it
                    was not a channel number and matched nothing on the remote -
                    a number that looked like it meant something and did not. */}
                {/* `contain`, like every other channel logo in the app (the
                    guide, catch-up and the resume banner all pass it). Without
                    it a 36px square crops a wide wordmark down to its first
                    letter and a hundred rows read as the same channel. */}
                <Poster src={item.logo} alt={label} ratio="logo" fit="contain" />
                {/* 1.2 and no gap between the lines: at the 44px step two lines
                    are 28px of a 44px row on the box, and 42.5 of it under a 20px
                    root, where the old 1.25 plus a 2px gap was 46.7 and spilled.
                    Measured per root size — see `ROW_STEP`. */}
                <span className="min-w-0 flex-1 leading-[1.2]">
                  {/* The inner span is what lib/marquee slides when this name is
                      cut off and the row is the one the remote is on. */}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span dir="auto" className="pick-title block min-w-0 truncate text-ink">
                      <span data-marquee>{label}</span>
                    </span>
                    {/* Catch-up rides on the name line now that the lines under
                        it are NOW and NEXT — still the short fact scanned for. */}
                    {line.catchUpDays !== null && (
                      <span className="shrink-0 border border-rule px-1 font-mono
                                       text-[length:var(--t-2xs)] uppercase tracking-wide text-ink-2">
                        Catch-up {line.catchUpDays}d
                      </span>
                    )}
                  </span>
                  {/*
                    The second line, and it is a LINE — one row of text that
                    truncates, never two that push the logo out of the row. The
                    mark comes first because it is the short fact and it is the
                    one being scanned for; the programme takes whatever is left.
                  */}
                  {/* Sports: what is on now, how far through, and what is next —
                      "it will show two things what's playing currently and
                      what's next". A channel with no guide anywhere says so
                      once the read has answered, not while it is still asked. */}
                  {!guideless ? (
                    <>
                      {nn.now !== null && (
                        <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--t-xs)] text-ink-2">
                          {/* LIVE only when the guide itself says so — a match at
                              3 a.m. may be a replay, and the row never guesses. */}
                          {liveKind(nn.now.title) === 'live' ? (
                            <span className="shrink-0 font-mono text-[length:var(--t-2xs)] font-semibold uppercase
                                             tracking-wider text-alert">Live</span>
                          ) : (
                            <span className="shrink-0 font-mono text-[length:var(--t-2xs)] font-semibold uppercase
                                             tracking-wider text-tally">Now</span>
                          )}
                          <span className="min-w-0 truncate">{nn.now.title}</span>
                        </span>
                      )}
                      {nn.progressPct !== null && (
                        <span className="meter my-0.5 block h-[2px] w-full overflow-hidden bg-rule" aria-hidden>
                          <span className="block h-full bg-tally" style={{ width: `${nn.progressPct}%` }} />
                        </span>
                      )}
                      {nn.next !== null && (
                        <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--t-xs)] text-ink-3">
                          <span className="shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider">Next</span>
                          <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums">
                            {clockOf(nn.next.startTs)}
                          </span>
                          <span className="min-w-0 truncate">{nn.next.title}</span>
                        </span>
                      )}
                    </>
                  ) : ev !== null ? <EventLine ev={ev} /> : (
                    <span className="block text-[length:var(--t-xs)] text-ink-3">
                      {!guideKnown.has(item.id) && guidePolls.current <= 24 ? '…' : 'No guide for this channel'}
                    </span>
                  )}
                </span>
                {/* A MARK, not a button. The interactive star used to live here,
                    nested inside this row's own button — see lib/longPress.ts.
                    Hold the row (or press the remote's STAR key) to toggle it. */}
                {/* Only on a favourite, in both shells. Modern drew an OUTLINE
                    heart on every row that was not one — a hundred identical
                    marks down the list saying "no", which is the width of the
                    name spent on nothing ("too much spaces are wasted
                    everywhere"). Classic's star already worked this way. */}
                {item.streamId !== null && prefs.favs.live.includes(item.streamId) && (
                  modern ? (
                    <Heart aria-hidden className="h-3.5 w-3.5 shrink-0 fill-current text-tally" />
                  ) : (
                    <Star aria-hidden className="h-3.5 w-3.5 shrink-0 fill-current text-tally" />
                  )
                )}
                {/*
                  The "3d" chip that used to sit here has moved UNDER the name.

                  Asked for that way — "if any channal has any catchups show it
                  below its name" — and it is the better place for two reasons
                  beyond being what was asked: a bare "3d" at the end of a row
                  names nothing, and the chip was taking width from the one thing
                  on the row that has to be readable at three metres. It also
                  stops the list disagreeing with the picture: `NowNext` refuses
                  to offer catch-up on a zero-day archive and this chip printed
                  "0d" for exactly those channels. See `secondLine`.
                */}
              </button>
            );
          }}
        />
      )}
    </>
  );

  const sidebar = sports ? (
    <SportsRail
      value={filters}
      sport={sport}
      onChange={(patch) => onFilters({ ...filters, ...patch })}
    />
  ) : (
    <LiveSidebar
      value={filters}
      /* Sport lives on Sports TV — its packages and counts are not listed here. */
      {...(topicsReady ? { excludeTopic: 'sports' } : {})}
      onChange={(patch) => onFilters({ ...filters, ...patch })}
    />
  );

  /*
    Theatre is Live's fullscreen: cover like a film opened "Play it" —
    `fixed inset-0 z-50`, no shell nav, no Now/Next. Widening the column under
    the header left the Streamix bar on the picture.
  */
  /*
   * ── theatre happens IN PLACE, and that is the whole fix ──────────────────
   *
   * This used to be an early `return createPortal(<div class="fixed inset-0">…)`.
   * Read as a picture it is obviously right — a black sheet with the player on
   * it — and as a TREE it is a different tree: the three columns go, a portal
   * arrives, and `surface` is at a position React has never seen. So React
   * unmounts the old branch, and VideoPlayer's own cleanup runs on the way out:
   *
   *     useEffect(() => () => { captions.stop(); player.teardown(); }, []);
   *
   * `teardown()` resets the snapshot to EMPTY, which is `phase: 'idle'`, which is
   * the state whose entire job is to render `idleHint`. Pressing FULL SCREEN
   * therefore stopped the channel and wrote "Pick a channel." across a black
   * screen — photographed and sent, twice, and it is also why pressing OK a
   * second time on the playing row (the double-press below, which has been here
   * all along) looked like it did nothing.
   *
   * So nothing moves now. The two other columns are hidden, this one is promoted
   * to `fixed inset-0`, and `surface` keeps its position in the tree — same
   * component, same element, same stream. `cloneElement` only changes a prop,
   * which is an update rather than a remount.
   *
   * `position: fixed` here is safe for the reason the portal was reaching for:
   * `scripts/fullscreen-probe.mjs` walks every ancestor of `.stage` — this
   * section among them — for a containing block and asserts the fullscreen
   * rectangle is the whole viewport at the origin.
   */
  /*
   * What a held row can do to itself.
   *
   * Play first because it is what the row is for; the star next because it is
   * the one people reach for; moving only where an order exists to move within
   * (the favourites list is the bouquet Live, zapping and the guide all follow);
   * the guide because a channel's schedule belongs to the channel; hiding last,
   * and it says where the way back is — a row that vanishes with no route back
   * would be a trap.
   */
  /**
   * The highlight follows the row being carried.
   *
   * The virtualiser renders rows BY INDEX, so after a move the element that had
   * focus is still at the same offset — now drawing a different channel, which
   * is not the one being carried. Measured: the first arrow moved the row and
   * the next two did nothing at all, because they were landing on its old
   * neighbour. The rail beside this list needs the same effect for the same
   * reason.
   */
  useEffect(() => {
    if (moving === null) return;
    const el = document.querySelector<HTMLElement>('[data-stream-move="on"]');
    if (el !== null && document.activeElement !== el) el.focus();
  });

  /**
   * Carry the held row one place, and leave the list saying so.
   *
   * The displayed order is materialised into the stored one — the same thing
   * `reorderFrom` does for packages, and for the same reason: a partial order
   * cannot express "here, between these two", so a row dropped at position
   * twelve has to be stored with the eleven above it or it springs back.
   */
  const carry = useCallback((dir: -1 | 1) => {
    const sid = moving;
    if (sid === null) return;
    const list: Item[] = favBouquet ?? arranged ?? wholeList ?? [];
    const from = list.findIndex((r) => r.streamId === sid);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    if (favBouquet !== null) {
      /* My channels already has an order of its own, and one function that
         writes it. Nothing here needs a second copy. */
      moveFav('live', sid, from + dir);
      return;
    }
    const ids = list.map((r) => r.streamId).filter((id): id is number => id !== null);
    const at = ids.indexOf(sid);
    if (at < 0) return;
    setStreamOrder(moveTo(ids, at, at + dir));
  }, [moving, favBouquet, arranged, wholeList]);

  const rowActions = useMemo((): HoldAction[] => {
    const it = rowMenu;
    if (it === null) return [];
    const sid = it.streamId;
    const starred = sid !== null && prefs.favs.live.includes(sid);
    const seat = favBouquet === null || sid === null
      ? -1
      : favBouquet.findIndex((r) => r.streamId === sid);
    const out: HoldAction[] = [
      {
        id: 'play',
        label: 'Play',
        Icon: Play,
        primary: true,
        act: () => { setRowMenu(null); void open(it); },
      },
    ];
    if (sid !== null) {
      out.push({
        id: 'fav',
        label: starred ? 'Remove from My channels' : 'Add to My channels',
        hint: starred ? undefined : 'Live, channel up/down and the guide follow this list',
        Icon: starred ? Heart : Star,
        act: () => { toggleFav('live', sid); setRowMenu(null); },
      });
    }
    /*
     * Move is a MODE here too, exactly as it is on the rail beside this list.
     *
     * "if they choose move up/down they can select and move it up in left side …
     * so its like when they select the option to move it they can move it
     * anywhere" — and then, about this list: "That hard thing and move it up and
     * down should be for both channels as well as categories". Two menu entries
     * moved a row one place per visit to the menu; this hands the row to the
     * arrows until OK puts it down.
     *
     * Offered wherever there is an order to write: the favourites bouquet, which
     * has had one since it existed, and any list short enough to arrange
     * (`ARRANGE_MAX`) — which is every country and every package, and not "All
     * channels" on a 55,000-channel subscription.
     */
    if (sid !== null && seat < 0 && sportView !== null) {
      /* A list the guide is ordering or filtering cannot also be carried by
         hand — the row would jump back to its channel-order seat the moment it
         was picked up. Said, with the way round it, rather than offered and
         then refused. */
      out.push({
        id: 'move-onnow',
        label: 'Listed by the guide',
        hint: 'Show › All and Channel order (top of the list) let you move channels',
        Icon: ArrowUpDown,
        act: () => setRowMenu(null),
      });
    } else if (sid !== null && (seat >= 0 || arrangeable)) {
      out.push({
        id: 'move',
        label: 'Move this',
        hint: 'Up and down carry it · OK puts it down · BACK cancels',
        Icon: ArrowUpDown,
        act: () => {
          undoOrder.current = seat >= 0
            ? { kind: 'fav', ids: [...prefs.favs.live] }
            : { kind: 'stream', ids: [...prefs.streamOrder] };
          /* Start reading the list now rather than when the first arrow lands:
             a carry needs every row in hand, and the press that arrives while
             they are still being read is a press that does nothing. */
          if (seat < 0) void ensureRange(0, total - 1);
          setMoving(sid);
          setRowMenu(null);
        },
      });
    }
    /*
     * And when it is too long to carry a row through, SAY so.
     *
     *     And long click in live tv to order/hide doesn't work anymore
     *
     * Hide was there; Move simply was not, because `arrangeable` caps at
     * `ARRANGE_MAX` — and the owner's line is 9,481 channels, so on "All" the
     * option vanished with no explanation at all. The cap itself is a
     * deliberate trade and stays (see `arrangedHere` above: applying an order
     * means holding every row, and reading tens of thousands of them to honour
     * three is what makes a television feel slow).
     *
     * What does not stay is the silence. A row that explains itself and names
     * the way forward is the difference between a limit and a broken feature.
     */
    if (sid !== null && seat < 0 && !arrangeable && !filters.favs) {
      out.push({
        id: 'move-too-many',
        label: 'Too many channels here to rearrange',
        hint: `Open a group first — this list has ${total.toLocaleString()}, and ${ARRANGE_MAX.toLocaleString()} is the most that can be carried`,
        Icon: ArrowUpDown,
        act: () => setRowMenu(null),
      });
    }
    out.push({
      id: 'guide',
      label: 'Open the guide here',
      Icon: CalendarClock,
      act: () => { setRowMenu(null); nav(`/guide?ch=${linkId(it)}`); },
    });
    if (sid !== null) {
      out.push({
        id: 'hide',
        label: 'Hide this channel',
        hint: 'It moves to the bottom of this list — OK there brings it back',
        Icon: EyeOff,
        act: () => { toggleHiddenStream(sid); setRowMenu(null); },
      });
    }
    return out;
  }, [rowMenu, prefs.favs.live, prefs.streamOrder, favBouquet, sportView, arrangeable, total, ensureRange,
    open, nav]);

  return (
    <div
      className={`live-page relative flex h-full min-h-0 min-w-0 overflow-hidden ${
        modern ? 'gap-3 p-3 tv:gap-4 tv:p-4' : ''
      }`}
    >
      {/*
        Sports TV: the sport's own photograph behind the panes (public/sports/,
        licences in CREDITS.md there). A sibling of the panes rather than a
        background on this element, because while libVLC owns the picture the
        page must be see-through over it and `nv-clear` only clears ancestors;
        `nv-cover` takes this layer away for exactly that long. The panes are
        positioned (see `.live-sidebar`, `.live-list`, `.live-stage`) so they
        paint above it. While libVLC has the picture it stays, with the
        picture's rectangle cut out — see `SportShot`.
      */}
      {sports && sport !== null && sport !== 'othersport' && !filters.favs && (
        <SportShot key={sport} sport={sport} />
      )}
      <div
        /*
           A section, so a press cannot fall out of it sideways.

           Three full-height columns stand beside each other on this screen and
           none of them declared a boundary, so the whole page was one flat
           search: DOWN from the last country moved 224px RIGHT into the channel
           list, and UP from the first channel moved 224px LEFT back into the
           rail. See `clearsSection` — a move that leaves a section has to land
           beyond it, and there is nothing above or below a full-height column.
        */
        data-nav-scope
        hidden={theatre}
        className={`live-sidebar pane-fill relative h-full shrink-0 overflow-hidden ${
          modern
            /* Wider, because "the country area is not big enough". At 14rem a
               country name plus a flag plus its count plus a chevron leaves
               about six characters for the name, so "United Kingdom" and
               "Netherlands" both truncate — on the one column whose entire job
               is telling you which country you are in. */
            /* 15rem, not 16: at the 960px CSS viewport a television reports,
               the three columns are all sitting on their minimums, so every rem
               added here comes straight off the picture — and 16 pushed SHARE
               onto a second row under the player. 15 fits "United Kingdom"
               beside a 26px flag and leaves the action row on one line. */
            ? 'glass-float w-[20%] min-w-[15rem] max-w-[20rem]'
            : 'w-[17%] min-w-[12rem] max-w-[19rem]'
        }`}
      >
        {sidebar}
      </div>
      <section
        data-nav-scope
        hidden={theatre}
        className={`live-list relative flex min-h-0 min-w-0 flex-col overflow-hidden ${
          modern
            ? 'glass-float w-[30%] min-w-[16rem] max-w-[24rem] shrink-0'
            : 'min-w-0 flex-1 border-r border-rule'
        }`}
      >
        {/* Countries and groups live in the sidebar; search lives in the
            header. What is left above the list is what the list is. */}
        {listHead}
        <FilterBar
          section="live"
          value={filters}
          onChange={onFilters}
          total={total}
          loading={loading}
          genres={false}
          groups={false}
        />
        {/* Bound the list pane: flex-1 alone lets VirtualList grow with content
            (scrollHeight === clientHeight → wheel trapped, every row mounted). */}
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0">{listBody}</div>
        </div>
      </section>

      <section
        /* The third column, declared like the other two. */
        data-nav-scope
        /* No padding around the PICTURE: 15px of panel on every side of a video is
           the "why is it not filling the box" report, and the picture is the one
           thing on the page that should reach its own edges. The padding moves
           inside, to the text below it. */
        /* The pane the picture sits in carries its light — see `.ambient-wash`.
           This is the one place in the app with a windowed player above a wall
           of flat panel colour, which is where an ambient wash is worth having
           and where the letterbox bars are not. */
        /* Theatre: this column IS the screen. No glass, no wash, no scroll —
           a black sheet with the picture on it, and the other two columns
           hidden beside it. `data-nav-contain` keeps the D-pad inside it, which
           is what the portal wrapper used to carry. */
        {...(theatre ? { 'data-nav-contain': true } : {})}
        className={theatre
          ? 'live-stage theatre-sheet fixed inset-0 z-50 flex min-w-0 flex-col overflow-hidden bg-black'
          : `live-stage ambient-wash relative flex min-w-0 flex-col overflow-x-hidden overflow-y-auto ${
            modern
              ? 'glass-float min-w-[16rem] flex-1'
              : 'w-[46%] min-w-[24rem] shrink-0'
          }`}
        /*
         * The doorway into the player, and it has to be THIS element.
         *
         * A horizontal D-pad move only considers candidates whose rows overlap the
         * one focus is on (`lib/spatialNav.ts`, rule 2 — it is what stops RIGHT at
         * the end of a poster rail from diving into the next rail). The player's
         * controls sit level with the top of the picture, so a channel two thirds
         * down the list shared a row with none of them and RIGHT did nothing at
         * all: measured, three presses, no movement. That is "I cannot move to
         * full screen options".
         *
         * This column is full height, so it overlaps every row in the list. Landing
         * here hands focus straight on to the picture, which wakes the controls —
         * so one press of RIGHT from anywhere in the list arrives at the player
         * with its chrome up, and the next press reaches the buttons.
         */
        {...(current ? { tabIndex: 0 } : {})}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          const stage = e.currentTarget.querySelector<HTMLElement>('.stage[tabindex]');
          if (stage) stage.focus();
        }}
      >
        {theatre ? cloneElement(surface, { className: 'h-full w-full' }) : surface}
        {/* ONE level of spacing under the picture, and one left edge for all of
            it: the action row, the title and the programmes are siblings of
            this box and nothing inside indents again. It used to sit inside the
            pane's own 0.75rem as well, so the text was framed twice — "those
            ugly paddings arround things mutiple times, and nothing is flush with
            teh glassy card". */}
        <div hidden={theatre} className="flex min-h-0 flex-col gap-3 p-3">
          {detail}
        </div>
      </section>
      {countryPicker && (
        <FacetPicker
          title="Countries"
          options={countryOptions}
          selected={sportMarkets}
          onToggle={(id) => {
            /* A country picked under the sport in the countries layout is the
               address's; this choice is the device's, and applies to every sport. */
            if (filters.markets.length > 0) onFilters({ ...filters, markets: [] });
            setSportsMarkets(sportMarkets.includes(id) ? sportMarkets.filter((m) => m !== id) : [...sportMarkets, id]);
          }}
          onClear={() => {
            if (filters.markets.length > 0) onFilters({ ...filters, markets: [] });
            setSportsMarkets([]);
          }}
          onClose={() => setCountryPicker(false)}
        />
      )}
      {showMenu && (
        <HoldMenu
          title={`Show · ${sportLabel}`}
          actions={showActions}
          onClose={() => setShowMenu(false)}
        />
      )}
      {rowMenu !== null && (
        <HoldMenu
          title={displayName(rowMenu.name)}
          actions={rowActions}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * An event channel's line: LIVE / NEXT / ENDED, when, and what it is part of.
 * "Tennis: Jakub Mensik vs Learner Tien @ Sep 6 04:00 AM :MAX FR 12" becomes the
 * title "Jakub Mensik vs Learner Tien" over "ENDED · Sat 6 Sep · 04:00 · MAX FR 12".
 */
/** The Show menu's words, one each — on the button and in the menu. */
const SHOW_WORD: Record<SportsShow, string> = { all: 'All', live: 'Live', next: 'Next', ended: 'Ended', today: 'Today', tomorrow: 'Tomorrow' };

function EventLine({ ev }: { ev: ChannelEvent }) {
  const tone = ev.state === 'live' ? 'text-tally' : 'text-ink-3';
  const word = ev.state === 'live' ? 'Live' : ev.state === 'next' ? 'Next' : ev.state === 'ended' ? 'Ended' : null;
  const rest = [ev.at !== null ? eventWhen(ev.at) : null, ev.competition ?? ev.feed].filter(Boolean).join(' · ');
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--t-xs)] text-ink-3">
      {word !== null && (
        <span className={`shrink-0 font-mono text-[length:var(--t-2xs)] font-semibold uppercase tracking-wider ${tone}`}>
          {word}
        </span>
      )}
      {rest !== '' && <span className="min-w-0 truncate">{rest}</span>}
    </span>
  );
}
