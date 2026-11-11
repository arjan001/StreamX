import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock, ChevronLeft, ChevronRight, Clock, History, Play, RotateCcw,
  Search, SlidersHorizontal, Star, X,
} from 'lucide-react';
import { api, linkId, type EpgSlot, type GridChannel, type Item } from '../lib/api';

import { useShape } from '../lib/formFactor';
import { useScope } from '../lib/scope';
import { useMarkets } from '../lib/groups';
import { isFieldSubmit, useKeyLayer, type Binding } from '../lib/keys';
import { focusFirst } from '../lib/spatialNav';
import { displayName } from '../lib/displayName';
import { hasSection, useInventory } from '../lib/sections';
import { Nothing } from '../components/Nothing';
import { openAddAccount } from '../lib/addAccount';
import { Poster } from '../components/Poster';
import { Chip, Field, Select } from '../components/ui';
import { Sheet } from '../components/Sheet';
import { useTally } from '../lib/tally';
import { localIndexOfItem, localItem, localItems } from '../lib/localRead';
import { usePrefs } from '../lib/prefs';
import {
  HOUR, archiveFloor, blockGeometry, clockOf, dayChips, effectiveArchiveDays, floorTo,
  guideMaxTs, guideMinTs, hourTicks, isPlayable, progress, slotAt, slotState, visibleSlots,
} from '../lib/guide';

/** Icon at rest, label on focus — same rule as header destinations / FilterBar. */
const DEST = (on: boolean) =>
  `dest tap flex shrink-0 items-center gap-1.5 border px-2 py-1 font-mono
   text-[length:var(--t-2xs)] tracking-wider transition-colors
   ${on
     ? 'border-tally text-tally'
     : 'border-rule text-ink-2 hover:border-ink-3 hover:text-ink focus-visible:border-focus focus-visible:text-focus'}`;

/**
 * How many channels one screen of guide asks about.
 *
 * Thirty rather than fifty because of the fill rate, not the render cost: the
 * queue behind `/topup` runs two at a time with 250ms between starts, so a page
 * of fifty takes ~12s to populate on a cold cache and a page of thirty takes ~7s.
 * The rows arrive progressively either way, but a screenful that completes is
 * worth more than one that is still filling below the fold.
 */
/*
 * Fewer, and bigger.
 *
 * Thirty 52px rows filled the screen with truncated text. Rows are now 80px, so
 * a page of twelve is about what a 720p television shows at once — which is what
 * "make it like four or five items at a time so they are properly visible" is
 * asking for once the rows are readable rather than crushed.
 */
const PAGE = 12;

/*
 * How tall a channel's row is, in the two cases it has.
 *
 * A row that has something to show in the window gets a comfortable line; one
 * that has nothing gets the short one.
 */
/*
 * ── and then measured on a television, where they were twice too tall ──
 *
 * 76px is a *pixel* count, and the television it was tuned against reports 960
 * x540 CSS pixels: four channels of 374 on screen at once, the rest of the guide
 * below the fold, and three of those four rows spending 76px to say "no guide
 * for this channel".
 *
 * So the heights are in rem now — the app's whole scale is the root font size
 * (see index.css) — and a row is only as tall as it has something to put in it:
 *
 *   single   a channel with something to show in the window on screen
 *   bare     a channel with no guide, none loaded yet, or none in THIS window
 *
 * Measured after: nine channels on the same screen, the empty ones costing a
 * third of what they did.
 *
 * ── and then the third height went, with the lanes it existed for ──
 *
 * There used to be a `lane` height as well, because programmes too short to
 * label were stacked onto extra compact lines inside one channel's row. It is
 * gone, and so is `lib/guideLanes.ts`. Two reasons, both visible on a real
 * guide: a row given three lanes to place ONE visible block was
 * three times too tall and mostly empty, and the short blocks that earned the
 * extra lanes rendered as "Wee", "Wee", "Wee" — clipped fragments stacked above
 * their neighbours.
 *
 * Lanes were solving "a block must carry its own description", and it no longer
 * has to: the banner above the grid does that for whatever the highlight is on.
 * A programme too narrow to label is now a plain coloured bar, which is what
 * every television guide shows and what the eye reads as "something, briefly".
 */
const SINGLE_REM = 3;
const BARE_REM = 1.8;

export interface RowGeom { single: number; bare: number }

/** The heights in pixels, from one read of the root size. */
function rowGeom(root: number): RowGeom {
  return { single: root * SINGLE_REM, bare: root * BARE_REM };
}
/**
 * How many hours the grid shows, and it is the WHOLE grid — there is no
 * horizontal scrolling any more.
 *
 * Six hours at a content-derived zoom produced a cluttered guide, and the
 * arithmetic says why: the scale came
 * from `autoPxPerMin` over the durations on screen, this catalogue is full of
 * 26-minute news bulletins, so it zoomed to about one hour per screen and put
 * the other five behind a sideways scroll a remote has no gesture for. A row was
 * one programme and a lot of empty track.
 *
 * Two hours across the screen instead, fitted to the width, which is what every
 * television guide does — and the ±2h travel buttons already move exactly one
 * screen, so the window and the controls finally mean the same thing.
 */
const SPAN_H = 2;
const STEP_S = 1800;
/** Half the window — how far LEFT/RIGHT at a row's edge travels in one step. */
const WINDOW_STEP_S = (SPAN_H / 2) * HOUR;

/**
 * Fixed, not the theme accent.
 *
 * `bg-tally` is the amber this same screen already spends on catch-up marks and
 * the progress bar — reusing it for "now" would put three different meanings
 * under one colour on the same grid. "Now" is red, and a fixed hex is what makes
 * it red in every skin rather than whatever the active theme's accent happens
 * to be.
 */
const NOW_RED = '#e5484d';

/** A stable empty page, so a loading query's fallback does not defeat memoisation. */
const EMPTY_ROWS: Item[] = [];

/**
 * How long a query key downstream of a held remote key may keep moving before
 * `useSettled` gives up waiting and jumps to wherever it landed.
 *
 * The OS repeats a held D-pad key roughly every 40ms — see the report that
 * started this pass — so anything comfortably above that treats one held press
 * as one gesture instead of dozens. Comfortably below the point where letting
 * go starts to feel sluggish, so releasing the key still reads as instant.
 */
const EDGE_SETTLE_MS = 120;

/**
 * `v`, but slow to leave once it starts moving fast.
 *
 * Built for the two places in this file where a HELD key drives a react-query
 * key straight into the ground: `onEdge` at the bottom of the channel list and
 * `onTimeShift` at a row's time edge both used to feed their key a value that
 * changed on every auto-repeat tick, so a two-second hold minted dozens of keys
 * and fired dozens of fetches — each one a synchronous pass over the on-device
 * catalogue (23ms over 82,666 rows, measured at
 * `packages/core-store/src/query.ts:25`). A plain trailing debounce — see
 * `useDebouncedValue` in `FilterBar.tsx` — would fix the hold but tax the case
 * that has to stay instant: a single press would wait out the same window
 * before its fetch even started.
 *
 * So this fires on the LEADING edge — the first change after being idle lands
 * with no delay — and only starts coalescing once a second change arrives
 * before the first has settled, holding through every tick of a repeat and
 * jumping straight to wherever `v` landed once it stops changing. A single
 * press pays for exactly one fetch, same as before this existed; a held key
 * pays for two — one at the start, one where it lands — instead of one per
 * tick.
 */
function useSettled<T>(v: T, ms: number): T {
  const [settled, setSettled] = useState(v);
  const idle = useRef(true);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      // `settled` already equals `v` from the initialiser above — there is no
      // press yet to treat as a leading edge, only the first real change to
      // this value should ever fire one.
      mounted.current = true;
      return;
    }
    if (idle.current) {
      idle.current = false;
      setSettled(v);
    }
    const t = window.setTimeout(() => {
      idle.current = true;
      setSettled(v);
    }, ms);
    return () => window.clearTimeout(t);
  }, [v, ms]);
  return settled;
}

/**
 * The programme guide.
 *
 * Two projections of the same data, chosen on `shape.panes` exactly like Live:
 *
 * - **A timeline grid** where there is room for one. Channel axis down, time
 *   across, a "now" line, and a programme block you can click.
 * - **A "Now" list** where there is not. That is the grid collapsed onto the
 *   channel axis, and the time axis becomes a CONTROL — a cursor you move —
 *   rather than a direction you scroll. It gives a phone full time travel with no
 *   matrix, and at a past cursor position every archived programme becomes a
 *   catch-up entry point.
 *
 * Nothing here reaches the panel directly. The grid reads the guide stored on
 * the device and queues a top-up for what is missing (`api.epgTopup`, through
 * the provider's request scheduler), so scrolling fast cannot turn into a burst
 * of provider requests.
 */
export function Guide() {
  const inventory = useInventory();
  const [params, setParams] = useSearchParams();
  const shape = useShape();
  const qc = useQueryClient();
  const { scope } = useScope();
  const { markets } = useMarkets('live', scope, [], []);
  const [prefs] = usePrefs();

  const market = params.get('market') ?? '';
  const page = Math.max(0, Number(params.get('p') ?? 0));
  const archiveOnly = params.get('archive') === '1';
  const q = params.get('q') ?? '';
  /** `/guide?ch=<id>` — a deep link from search, a resume banner or, soon, the
      player's own Guide button. See the arrival effect below. */
  const chParam = params.get('ch');
  /** The one press back to everything, off the bouquet default. See `bouquet`. */
  const all = params.get('all') === '1';

  const patch = useCallback(
    (next: Record<string, string | null>) => {
      const p = new URLSearchParams(params);
      for (const [k, v] of Object.entries(next)) {
        if (v === null || v === '') p.delete(k);
        else p.set(k, v);
      }
      setParams(p, { replace: true });
    },
    [params, setParams],
  );

  /* The cursor: which instant the guide is showing. Stored as an offset from now
     in seconds so "NOW" is always exactly now, however long the page is open. */
  const [cursor, setCursor] = useState<number | null>(null);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const at = cursor ?? nowS;

  /**
   * How many of the profile's favourite channels this device can actually show.
   *
   * Not how many are stored: a favourite survives a change of provider, and
   * opening on channels that no longer exist would answer "your channels" with
   * an empty screen. The same "can actually SHOW" rule `lib/liveOpening` uses to
   * open Live on favourites.
   */
  const favIds = prefs.favs.live;
  /*
   * Memoised on `favIds` alone, not left as a bare expression in the render
   * body: this is the ~23ms / 82,666-row pass documented at
   * `packages/core-store/src/query.ts:25`, and a bare expression here paid it
   * on every render of `Guide` — including the one a focus move causes on
   * every single D-pad repeat tick (`onFocus` below sets `pick`, which is
   * Guide's own state). `favIds` is `prefs.favs.live`, and `usePrefs` only
   * hands back a new array when the favourites themselves change (see
   * `view()`/`subs` in `lib/prefs.ts`) — a focus move, a page turn or a cursor
   * move never touches it — so keying the memo on its reference is safe where
   * keying it on `page` or `archiveOnly` would not be: those are primitives
   * that already carry their own identity, but an object that changed identity
   * every render would make this memo a no-op.
   */
  const favShowable = useMemo(
    () => (favIds.length === 0
      ? 0
      : localItems('live', { streamIds: favIds, limit: 1 })?.total ?? 0),
    [favIds],
  );
  /*
   * The bouquet, unless the address says otherwise.
   *
   * `?all=1` is the one press back to everything — the Filters popover's MY
   * CHANNELS chip writes it, and the arrival effect below writes it too when
   * `?ch=` points at a channel outside the bouquet. With no favourites to show,
   * there is nothing to default to and the guide opens exactly as it always has.
   */
  const bouquet = favShowable > 0 && !all;

  /*
   * The page fed to the CHANNELS fetch, settled — not `page` itself.
   *
   * `page` still updates the instant the URL does, so the pager label and the
   * PREV/NEXT bounds keep feeling live under a held key. Only the react-query
   * key and its `offset` wait: holding DOWN at the bottom row calls `onEdge`
   * once per ~40ms auto-repeat tick (see `onKeyDown` in `Timeline`), and
   * `patch` writes a new `p` on every one of them, so an unguarded `page` here
   * used to mint a new key — and fire a new catalogue read — per tick. See
   * `useSettled` above for why a held key now costs two of those instead of
   * one per tick, while a single press costs exactly the one it always did.
   *
   * Only the `!bouquet` branch below actually varies with the page: the
   * bouquet branch's key is `['fav', favIds]` with no page in it at all, so it
   * was never re-fetching per tick in the first place and is left alone here.
   */
  const pageSettled = useSettled(page, EDGE_SETTLE_MS);
  const channels = useQuery({
    queryKey: ['guide', 'channels', market, archiveOnly, q, scope, bouquet ? ['fav', favIds] : ['all', pageSettled]],
    queryFn: async () => {
      if (!bouquet) {
        return api.items('live', {
          limit: PAGE,
          offset: pageSettled * PAGE,
          // Channels with a tvg_id first: those are the ones with listings, and
          // the panel's own order opens with hundreds of schedule-less
          // placeholders.
          sort: 'epg',
          ...(market ? { markets: [market] } : {}),
          ...(archiveOnly ? { archiveOnly: true } : {}),
          ...(q.trim().length >= 2 ? { q: q.trim() } : {}),
          ...scope,
        });
      }
      /*
       * The whole bouquet in one read, then ordered and paged here.
       *
       * The catalogue's `streamIds` filter is a SET — it answers "which of
       * these", in the panel's own sort, and there is no sort key there for
       * "the order I starred them in". A profile's favourites are few enough
       * that reading all of them and doing both by hand is cheap, and it is the
       * only way "in favourite order" stays true past whatever fits on the
       * first page.
       */
      const res = await api.items('live', {
        limit: Math.max(favIds.length, 1),
        sort: 'epg',
        streamIds: favIds,
        ...(market ? { markets: [market] } : {}),
        ...(archiveOnly ? { archiveOnly: true } : {}),
        ...(q.trim().length >= 2 ? { q: q.trim() } : {}),
        ...scope,
      });
      const order = new Map(favIds.map((id, i) => [id, i]));
      const sorted = [...res.rows].sort((a, b) =>
        (order.get(a.streamId ?? -1) ?? 0) - (order.get(b.streamId ?? -1) ?? 0));
      return {
        rows: sorted.slice(page * PAGE, page * PAGE + PAGE),
        total: sorted.length, offset: page * PAGE, limit: PAGE,
      };
    },
    staleTime: 120_000,
    /*
     * Hold the page that is on screen until the next one is ready.
     *
     * Without this, turning the page unmounts the grid: `isLoading` goes true
     * for the new key, the render falls to the skeleton branch, and the element
     * holding the highlight stops existing. On a remote that is the worst
     * outcome there is — the highlight does not move, it VANISHES, and no
     * direction brings it back. Now the old rows stay under the highlight until
     * the new ones replace them, which is also why `landing` in `Timeline` can
     * wait for `rows` to change identity and know the page has actually turned.
     */
    placeholderData: (prev) => prev,
  });
  const channelRows = channels.data?.rows ?? EMPTY_ROWS;
  const ids = useMemo(() => channelRows.map((r) => r.id), [channelRows]);

  /*
   * How far the window may travel, from the channels actually on screen.
   *
   * Off the channel LIST rather than the grid, so the bound exists from the
   * first paint — waiting on the grid query would leave every control unbounded
   * for however long the schedule takes to arrive.
   */
  const winMin = useMemo(() => guideMinTs(channelRows, nowS), [channelRows, nowS]);
  const winMax = useMemo(() => guideMaxTs(nowS), [nowS]);
  const deepestArchiveDays = useMemo(
    () => channelRows.reduce((m, c) => Math.max(m, effectiveArchiveDays(c)), 0),
    [channelRows],
  );

  /** Every way of moving the cursor funnels through here, so none of them — the
      transport buttons, the day chips, the row-edge travel — can push the window
      earlier than the deepest archive on screen or later than tomorrow. */
  const setCursorBounded = useCallback((ts: number | null) => {
    setCursor(ts === null ? null : Math.min(Math.max(ts, winMin), winMax));
  }, [winMin, winMax]);

  /**
   * The guide is where a remote's transport buttons finally make sense.
   *
   * FWD and REW move the window two hours rather than seeking anything — there is
   * nothing playing to seek — and that is the gesture people already have for
   * "later" and "earlier". YELLOW comes back to now, which is the one thing you
   * always want after travelling, and RED narrows to the channels that keep an
   * archive, because a guide showing the past is only useful on those.
   */
  const bindings = useMemo((): Binding[] => [
    { intent: 'yellow', label: 'Now', act: () => setCursor(null) },
    {
      intent: 'red',
      label: archiveOnly ? 'All channels' : 'Catch-up only',
      act: () => patch({ archive: archiveOnly ? null : '1', p: null }),
    },
    { intent: 'forward', label: '+2 hours', act: () => setCursorBounded(at + 2 * HOUR) },
    { intent: 'back', label: '−2 hours', act: () => setCursorBounded(at - 2 * HOUR) },
  ], [archiveOnly, at, patch, setCursorBounded]);
  useKeyLayer(bindings);

  const from = floorTo(shape.panes ? at - HOUR : at, STEP_S);
  /*
   * Settled for the same reason `pageSettled` is: holding LEFT/RIGHT at a
   * row's time edge calls `onTimeShift` once per auto-repeat tick, each one
   * moving `at` (and so `from`) by half a window (`WINDOW_STEP_S`) and minting
   * a fresh `['guide','grid', …]` key. `Timeline` below is handed this same
   * settled value rather than the raw `from`, deliberately: its ruler and its
   * blocks both read off `from`, and letting them race ahead of the data they
   * are drawing would slide the ruler over programmes that have not moved yet.
   * The controls band above still reads the raw, instant `at` for the clock
   * and the day stamp, which is what keeps a held key feeling live at all.
   */
  const fromSettled = useSettled(from, EDGE_SETTLE_MS);
  const grid = useQuery({
    queryKey: ['guide', 'grid', ids, fromSettled, shape.panes],
    queryFn: () => api.epgGrid(ids, fromSettled, shape.panes ? SPAN_H : 3),
    enabled: ids.length > 0,
    staleTime: 60_000,
    /* Same reason as the channel query above: the grid must not blank out from
       under the highlight while the next page's listings are being read. */
    placeholderData: (prev) => prev,
  });

  /**
   * Fill the gaps, once per set of channels.
   *
   * `asked` is a ref rather than state because a re-render must not re-ask: the
   * queue behind `/topup` is polite, but asking it the same question forty times
   * while React settles is still forty questions.
   */
  const asked = useRef(new Set<number>());
  useEffect(() => {
    const missing = (grid.data?.channels ?? [])
      .filter((c) => !c.known && !asked.current.has(c.id))
      .map((c) => c.id);
    if (missing.length === 0) return;
    for (const id of missing) asked.current.add(id);
    /* A page of the guide supersedes the last: see `topUp`. */
    void api.epgTopup(missing, true).catch(() => {});
  }, [grid.data]);

  /**
   * Fill in progressively rather than all at once.
   *
   * A cold page takes the queue several seconds to satisfy, and the difference
   * between "rows appearing one after another" and "an empty grid for seven
   * seconds" is the difference between a page that is working and a page that
   * looks broken. Re-reads the cache every few seconds while anything is still
   * missing, and stops — bounded, so a channel the panel simply has no guide for
   * cannot make this poll forever.
   */
  const waiting = (grid.data?.channels ?? []).filter((c) => !c.known).length;
  const polls = useRef(0);
  useEffect(() => {
    if (waiting === 0) {
      polls.current = 0;
      return;
    }
    if (polls.current > 12) return;
    const t = window.setTimeout(() => {
      polls.current += 1;
      void qc.invalidateQueries({ queryKey: ['guide', 'grid'] });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [waiting, grid.dataUpdatedAt, qc]);

  const rows = grid.data?.channels ?? [];
  const total = channels.data?.total ?? 0;
  const pages = Math.ceil(total / PAGE);
  const [open, setOpen] = useState<{ ch: GridChannel; slot: EpgSlot } | null>(null);

  /*
   * What the highlight is on, for the banner above the grid.
   *
   * Held here rather than in `Timeline` because the banner is a sibling of the
   * grid, not a child of it: it has to stay put while the grid scrolls under it.
   */
  const [pick, setPick] = useState<Picked | null>(null);

  /*
   * Before the highlight has been anywhere, describe what is ON.
   *
   * The guide opens with focus on the controls, so a banner that only ever
   * followed the highlight would spend the whole first screen saying "move the
   * highlight" — an instruction where a person expects information. Falling back
   * to the first channel that has a programme running right now means the banner
   * is useful the moment the page paints, and the caption is only ever seen
   * before any listing has arrived at all.
   */
  const shown = useMemo((): Picked | null => {
    if (pick !== null) return pick;
    for (const ch of rows) {
      const usable = ch.slots.filter((s): s is EpgSlot & { startTs: number } => s.startTs !== null);
      const cur = slotAt(usable, at);
      /* `slotAt` answers with the narrow shape it compares on, so the row it
         found is looked up again rather than cast — the banner needs the whole
         slot, description and archive flag included. */
      const found = cur === null ? undefined : usable.find((s) => s.startTs === cur.startTs);
      if (found !== undefined) return { ch, slot: found };
    }
    return null;
  }, [pick, rows, at]);
  /* A page of different channels is a different set of programmes, so whatever
     the banner was describing is gone. Better blank than confidently wrong. */
  useEffect(() => { setPick(null); }, [page, market, archiveOnly, q, bouquet]);

  /**
   * Running out of rows turns the page, and says whether it did.
   *
   * `Timeline` consumes the press only when this returns true, so DOWN on the
   * last page and UP on the first still behave the way they always did — the
   * press escalates and the highlight leaves the grid, which is the only way
   * back to the controls.
   */
  const onEdge = useCallback((dir: 1 | -1): boolean => {
    const next = page + dir;
    if (next < 0 || next >= pages) return false;
    patch({ p: next === 0 ? null : String(next) });
    return true;
  }, [page, pages, patch]);

  /**
   * RIGHT at a row's last visible block, or LEFT at its first — see `Timeline`.
   *
   * RIGHT is bounded by the same tomorrow cap as everything else. LEFT is
   * bounded by THIS channel's own floor rather than the shared `winMin`: the
   * window is one strip of time for every row on screen, so a deeper archive
   * elsewhere would happily carry it further back than THIS row has anything to
   * show, and focus would land on nothing. A channel with no catch-up at all
   * refuses outright — "for channels that have no catch-up it makes no sense to
   * show historic EPG data" was the partner's own rule for drawing the grid, and
   * it applies just as much to travelling into the past as to drawing it.
   */
  const onTimeShift = useCallback((dir: 1 | -1, ch: { archive: boolean; archiveDays: number }): boolean => {
    if (dir === -1 && effectiveArchiveDays(ch) <= 0) return false;
    const bound = dir === -1 ? archiveFloor(ch, nowS) : winMax;
    const want = at + dir * WINDOW_STEP_S;
    const clamped = dir === -1 ? Math.max(want, bound) : Math.min(want, bound);
    if (clamped === at) return false;
    setCursorBounded(clamped);
    return true;
  }, [at, nowS, winMax, setCursorBounded]);

  /**
   * Arriving with `?ch=` — the player's Guide button, search, a resume banner.
   *
   * Runs once: every input is read at the moment of arrival, the same rule
   * `Live`'s own `?ch=` handling uses, and re-running it on a later change to
   * favourites or scope would put the arriving channel back on screen over
   * wherever the viewer had since moved to. Which page it lands on depends on
   * whether the channel IS a favourite — the bouquet's own order for one, the
   * full list's order for the other — so the address is healed to match: a
   * stale market, search or catch-up filter that would hide the channel is
   * cleared, and `all` is set or cleared to whichever list actually contains it.
   * `Timeline` does the actual focusing once that page's data is in, through
   * `landOnChannel`.
   *
   * A short poll, not a single try: the on-device catalogue loads in the
   * background from `main.tsx` and `Guide` itself is a lazy chunk, so arriving
   * here straight from a cold launch — the Guide button, the very first thing
   * pressed — can reach this mount before `localItem` has anything to answer
   * with. `localItem` returning null once is "ask again in a moment", not
   * "this channel doesn't exist".
   */
  const chArrival = useRef(false);
  useEffect(() => {
    if (chArrival.current) return;
    chArrival.current = true;
    if (chParam === null) return;
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 15 && !cancelled; attempt++) {
        const item = localItem(chParam);
        if (item !== null) {
          const isFav = item.streamId !== null && favIds.includes(item.streamId);
          if (isFav) {
            const idx = favIds.indexOf(item.streamId!);
            if (idx >= 0) {
              const p = Math.floor(idx / PAGE);
              patch({ p: p === 0 ? null : String(p), all: null, market: null, q: null, archive: null });
            }
            return;
          }
          const idx = localIndexOfItem('live', { sort: 'epg', ...scope }, item.id);
          if (idx >= 0) {
            const p = Math.floor(idx / PAGE);
            patch({ p: p === 0 ? null : String(p), all: '1', market: null, q: null, archive: null });
          }
          return;
        }
        await new Promise((r) => { setTimeout(r, 200); });
      }
    })();
    return () => { cancelled = true; };
    // Mount only — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controls = (
    <GuideControls
      markets={markets}
      market={market}
      onMarket={(m) => patch({ market: m, p: null })}
      q={q}
      onQ={(v) => patch({ q: v, p: null })}
      archiveOnly={archiveOnly}
      onArchiveOnly={(v) => patch({ archive: v ? '1' : null, p: null })}
      at={at}
      nowS={nowS}
      onCursor={setCursorBounded}
      total={total}
      waiting={waiting}
      loaded={rows.length - waiting}
      deepestArchiveDays={deepestArchiveDays}
      showBouquetToggle={favShowable > 0}
      bouquet={bouquet}
      onToggleBouquet={() => patch({ all: bouquet ? '1' : null, p: null })}
    />
  );

  /*
   * A guide with no listings is a grid of empty hours, not a guide.
   *
   * `hasSection('guide')` is the same test the tab bar uses, so the page and the
   * navigation agree: a playlist with no guide link has thousands of
   * `tvg-id`s and not one programme behind them, because listings come from a
   * guide. Rendering the apparatus anyway — a channel column, a seven-day date
   * strip, PREV and NEXT — was twenty-two controls over nothing.
   */
  if (!hasSection('guide', inventory)) {
    return (
      <Nothing
        Icon={CalendarClock}
        title="No programme listings"
        body="Programme listings come from the source you add, and this one has none. Watch Live without a schedule, or add another source."
        actions={[
          { to: '/live', label: 'Live TV', primary: true },
          { act: openAddAccount, label: 'Add a source' },
        ]}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {controls}

      {channels.isLoading ? (
        <div className="space-y-1 p-3">
          {Array.from({ length: 10 }, (_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="p-4 font-mono text-[length:var(--t-2xs)] text-ink-3">
          No channels{market || archiveOnly || q ? ' match these filters' : ''}.
        </p>
      ) : shape.panes ? (
        <>
          <GuideDetail pick={shown} nowS={nowS} />
          <Timeline
            rows={rows}
            from={fromSettled}
            spanS={SPAN_H * HOUR}
            nowS={nowS}
            winMax={winMax}
            onPick={setOpen}
            onCursor={setPick}
            onEdge={onEdge}
            onTimeShift={onTimeShift}
            landOnChannel={chParam}
          />
        </>
      ) : (
        <NowList rows={rows} at={at} nowS={nowS} onPick={setOpen} />
      )}

      {pages > 1 && (
        <div
          data-nav-scope
          className="flex shrink-0 items-center justify-center gap-2 border-t border-rule px-3 py-2"
        >
          <button
            className="btn pill px-3 py-1.5 disabled:opacity-40"
            disabled={page === 0}
            onClick={() => patch({ p: String(page - 1) })}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> PREV
          </button>
          <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">
            {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total.toLocaleString()}
          </span>
          <button
            className="btn pill px-3 py-1.5 disabled:opacity-40"
            disabled={page + 1 >= pages}
            onClick={() => patch({ p: String(page + 1) })}
          >
            NEXT <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {open && <SlotSheet ch={open.ch} slot={open.slot} nowS={nowS} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ── controls ─────────────────────────────────────────────────────────────── */

function GuideControls({
  markets, market, onMarket, q, onQ, archiveOnly, onArchiveOnly, at, nowS, onCursor, total,
  waiting, loaded, deepestArchiveDays, showBouquetToggle, bouquet, onToggleBouquet,
}: {
  markets: { id: string; label: string; count: number }[];
  market: string;
  onMarket: (m: string) => void;
  q: string;
  onQ: (v: string) => void;
  archiveOnly: boolean;
  onArchiveOnly: (v: boolean) => void;
  at: number;
  nowS: number;
  onCursor: (ts: number | null) => void;
  total: number;
  /** How many rows on screen are still waiting for their schedule. */
  waiting: number;
  loaded: number;
  /** The deepest catch-up retention among the channels on screen — the day
      strip's only past days, per the partner's "no sense to show historic EPG
      data" rule for anything deeper than that. */
  deepestArchiveDays: number;
  /** Whether there is a bouquet at all worth offering a toggle for. */
  showBouquetToggle: boolean;
  bouquet: boolean;
  onToggleBouquet: () => void;
}) {
  const tallyOf = useTally();
  /*
   * Bounded by what the SCREEN can show, not a flat seven days: back is the
   * deepest archive among the channels on screen (none of them keeping
   * anything means zero past chips), forward is tomorrow and no further — this
   * app records nothing, so a day of schedule next week is nothing to open.
   */
  const days = useMemo(
    () => dayChips(Date.now(), { back: deepestArchiveDays, forward: 1 }),
    [deepestArchiveDays],
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const dayOf = (ts: number) => {
    const d = new Date(ts * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  const activeDay = dayOf(at);
  const todayChip = days.find((d) => d.offset === 0);
  const dayIndex = days.findIndex((d) => d.ts === activeDay);
  const activeChip = dayIndex >= 0 ? days[dayIndex] : undefined;
  const goDay = (d: (typeof days)[number]) => {
    // Keep the time of day when changing day: 20:00 yesterday → 20:00 today.
    const secondsIntoDay = at - activeDay;
    onCursor(d.offset === 0 && Math.abs(secondsIntoDay - (nowS - dayOf(nowS))) < 120
      ? null
      : d.ts + secondsIntoDay);
  };
  const stepDay = (dir: -1 | 1) => {
    let i = dayIndex;
    if (i < 0) {
      const next = days.findIndex((d) => d.ts > activeDay);
      i = dir < 0
        ? (next < 0 ? days.length - 1 : next - 1)
        : (next < 0 ? -1 : next);
    } else {
      i += dir;
    }
    const target = days[i];
    if (target) goDay(target);
  };
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const canPrev = firstDay !== undefined
    && (dayIndex > 0 || (dayIndex < 0 && activeDay > firstDay.ts));
  const canNext = lastDay !== undefined
    && ((dayIndex >= 0 && dayIndex < days.length - 1)
      || (dayIndex < 0 && activeDay < lastDay.ts));
  const marketLabel = market
    ? markets.find((m) => m.id === market)?.label ?? market
    : null;
  const applied = [
    marketLabel,
    q.trim().length >= 2 ? q.trim() : null,
    archiveOnly ? 'catch-up' : null,
  ].filter((x): x is string => x !== null);
  const filterCount = applied.length;
  const dirty = filterCount > 0;
  const clearFilters = () => {
    onMarket('');
    onQ('');
    onArchiveOnly(false);
  };
  const dayStamp = activeChip && activeChip.offset !== 0
    ? activeChip.label
    : activeChip
      ? null
      : new Date(activeDay * 1000).toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      });

  return (
    /* Band above the grid; a section so DOWN leaves the strip for the rows. */
    <div data-nav-scope className="relative shrink-0 border-b border-rule">
      {/*
        Always-on: Filters (+ Reset when dirty) and the time cursor. Country,
        search, archive, catch-up, and day Prev/Today/Next live behind Filters
        so this strip stays one row (≤6 chrome).
      */}
      <div className="relative z-[60] flex items-center gap-2 px-3 py-1.5">
        {/*
          The channel search, out where it can be seen.

          It already existed — behind the Filters button, in a panel that is shut
          by default. Which is the same as not existing: "it's also like a text
          search, I don't see it." A guide of 369 channels has exactly one
          question you ask it first, and the control for that question must not be
          two presses inside a disclosure. Country, archive and the day controls
          stay behind Filters; they are choices, and this is a lookup.
        */}
        <Field
          value={q}
          onValue={onQ}
          placeholder="find a channel…"
          icon={<Search className="h-3 w-3" />}
          className="w-40 shrink-0 sm:w-56"
          enterKeyHint="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          /*
            The IME's own action key: close the keyboard and hand focus to
            whatever the filter turned up, rather than leave the remote
            pointed at a field with nothing selected. `isFieldSubmit` keeps a
            composing IME's own Enter out of this — see `lib/keys.ts`.
          */
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (!isFieldSubmit(e.key, e.nativeEvent.isComposing, e.keyCode)) return;
            e.preventDefault();
            e.currentTarget.blur();
            requestAnimationFrame(() => focusFirst());
          }}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={filterCount > 0 ? `Filters (${filterCount})` : 'Filters'}
            title="Filters"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
            className={DEST(filtersOpen || dirty)}
          >
            <SlidersHorizontal className="h-3 w-3" />
            <span className="dest-label">
              Filters{filterCount > 0 ? ` (${filterCount})` : ''}
            </span>
          </button>
          {dirty && (
            <button
              type="button"
              aria-label="Reset filters"
              title="Reset filters"
              onClick={clearFilters}
              className={DEST(false)}
            >
              <RotateCcw className="h-3 w-3" />
              <span className="dest-label">Reset</span>
            </button>
          )}
        </div>

        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t-2xs)] text-ink-3">
          {tallyOf(total) ?? ''}
          {applied.length > 0 ? `${tallyOf(total) === null ? '' : ' · '}${applied.join(' · ')}` : ''}
          {waiting > 0 ? ` · ${loaded}/${loaded + waiting}` : ''}
        </span>

        <div className="flex shrink-0 items-center gap-1.5">
          <Chip onClick={() => onCursor(at - 2 * HOUR)} className="shrink-0" title="Two hours earlier">
            <ChevronLeft className="h-3 w-3" /> 2h
          </Chip>
          <Chip onClick={() => onCursor(null)} on={Math.abs(at - nowS) < 120} className="shrink-0">
            <Clock className="h-3 w-3" /> NOW
          </Chip>
          <Chip onClick={() => onCursor(at + 2 * HOUR)} className="shrink-0" title="Two hours later">
            2h <ChevronRight className="h-3 w-3" />
          </Chip>
          <span className="shrink-0 px-1 font-mono text-[length:var(--t-xs)] tabular-nums text-tally">
            {dayStamp ? `${dayStamp} · ` : ''}{clockOf(at)}
          </span>
        </div>
      </div>

      {filtersOpen && (
        <GuideFiltersPopover
          markets={markets}
          market={market}
          onMarket={onMarket}
          q={q}
          onQ={onQ}
          archiveOnly={archiveOnly}
          onArchiveOnly={onArchiveOnly}
          canPrev={canPrev}
          canNext={canNext}
          todayOn={activeChip?.offset === 0}
          onPrevDay={() => stepDay(-1)}
          onToday={() => { if (todayChip) goDay(todayChip); }}
          onNextDay={() => stepDay(1)}
          onClose={() => setFiltersOpen(false)}
          showBouquetToggle={showBouquetToggle}
          bouquet={bouquet}
          onToggleBouquet={onToggleBouquet}
        />
      )}
    </div>
  );
}

function GuideFiltersPopover({
  markets, market, onMarket, q, onQ, archiveOnly, onArchiveOnly,
  canPrev, canNext, todayOn, onPrevDay, onToday, onNextDay, onClose,
  showBouquetToggle, bouquet, onToggleBouquet,
}: {
  markets: { id: string; label: string; count: number }[];
  market: string;
  onMarket: (m: string) => void;
  q: string;
  onQ: (v: string) => void;
  archiveOnly: boolean;
  onArchiveOnly: (v: boolean) => void;
  canPrev: boolean;
  canNext: boolean;
  todayOn: boolean;
  onPrevDay: () => void;
  onToday: () => void;
  onNextDay: () => void;
  onClose: () => void;
  showBouquetToggle: boolean;
  bouquet: boolean;
  onToggleBouquet: () => void;
}) {
  const tallyOf = useTally();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button data-nav-skip className="fixed inset-0 z-40 cursor-default" aria-label="Close filters" onClick={onClose} />
      <div
        data-nav-contain
        className="glass-float sheet-panel absolute left-3 right-3 top-full z-50 border border-rule bg-panel shadow-2xl anim-rise
                   md:right-auto md:w-[22rem]"
      >
        <div className="flex items-center justify-between border-b border-rule px-3 py-1.5">
          <span className="font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">FILTERS</span>
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-2.5 p-3">
          <Field
            value={q}
            onValue={onQ}
            placeholder="find a channel…"
            icon={<Search className="h-3 w-3" />}
            enterKeyHint="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            /*
              The IME's own action key: close the keyboard and hand focus to
              the next control — the Country select, or the channel list once
              the panel itself is closed — rather than leave the remote
              pointed at a field with nothing selected. `isFieldSubmit` keeps
              a composing IME's own Enter out of this — see `lib/keys.ts`.
            */
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (!isFieldSubmit(e.key, e.nativeEvent.isComposing, e.keyCode)) return;
              e.preventDefault();
              e.currentTarget.blur();
              requestAnimationFrame(() => focusFirst());
            }}
          />
          <Select
            label="Country"
            value={market}
            onChange={onMarket}
            options={[
              { value: '', label: 'All countries' },
              ...markets.map((m) => ({
                value: m.id,
                label: m.label,
                hint: tallyOf(m.count) ?? '',
              })),
            ]}
          />
          <div className="flex flex-wrap gap-1.5">
            {showBouquetToggle && (
              <Chip
                onClick={onToggleBouquet}
                title={bouquet ? 'Showing your starred channels — press for every channel' : 'Show only your starred channels'}
                on={bouquet}
              >
                <Star className="h-3.5 w-3.5" /> {bouquet ? 'MY CHANNELS' : 'ALL CHANNELS'}
              </Chip>
            )}
            <Chip
              onClick={() => onArchiveOnly(!archiveOnly)}
              title="Only channels that keep a recording archive"
              on={archiveOnly}
            >
              <History className="h-3.5 w-3.5" /> CATCH-UP ONLY
            </Chip>
            <Link to="/catchup" className="chip" onClick={onClose}>
              <Play className="h-3 w-3" /> CATCH-UP PAGE
            </Link>
          </div>
          {/* Day axis lives here so the strip above stays one row (≤6 chrome). */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-rule pt-2.5">
            <button
              type="button"
              aria-label="Previous day"
              title="Previous day"
              disabled={!canPrev}
              onClick={onPrevDay}
              className={`${DEST(false)} disabled:opacity-40`}
            >
              <ChevronLeft className="h-3 w-3" />
              <span className="dest-label">Prev</span>
            </button>
            <button
              type="button"
              aria-label="Today"
              title="Today"
              onClick={onToday}
              className={DEST(todayOn)}
            >
              <CalendarClock className="h-3 w-3" />
              <span className="dest-label">Today</span>
            </button>
            <button
              type="button"
              aria-label="Next day"
              title="Next day"
              disabled={!canNext}
              onClick={onNextDay}
              className={`${DEST(false)} disabled:opacity-40`}
            >
              <span className="dest-label">Next</span>
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── the grid ─────────────────────────────────────────────────────────────── */

/** The root font size, which is this app's entire scale — see index.css. */
function rootPx(): number {
  if (typeof document === 'undefined') return 16;
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/* ── what the highlight is on ─────────────────────────────────────────────── */

/** A channel and one of its programmes — what the grid points at. */
export interface Picked { ch: GridChannel; slot: EpgSlot }

/**
 * The programme under the highlight, in words, above the grid.
 *
 * The detail is the half a grid cannot carry. Everything the guide knew
 * about a programme lived behind OK, in a sheet that covered the grid: to find
 * out what something WAS you had to leave the thing you were browsing. So the
 * grid had to carry the whole story in a block the width of half an hour, which
 * is what drove the lane packing, the 88px label floor and the three-line rows
 * that made it unreadable.
 *
 * With the description up here the block below only has to say WHEN and roughly
 * what — a title and a time — and that is a thing a single line can do. One
 * change removes the reason for four others.
 *
 * `data-nav-skip`, emphatically: it is prose that changes as the highlight
 * moves, and a remote landing in it would be a highlight inside a caption with
 * no way out. `aria-live="polite"` so a screen reader hears the programme it has
 * just moved onto, which is the same information by another route.
 */
function GuideDetail({ pick, nowS }: { pick: Picked | null; nowS: number }) {
  const slot = pick?.slot ?? null;
  const start = slot?.startTs ?? null;
  const stop = slot?.stopTs ?? null;
  const state = start === null ? null : slotState({ startTs: start, stopTs: stop }, nowS);
  const frac = start === null ? null : progress({ startTs: start, stopTs: stop }, nowS);
  const mins = start !== null && stop !== null ? Math.round((stop - start) / 60) : null;
  /* "170m" is a number a person has to convert. Films and sport are routinely
     over an hour, so the hour is the unit most listings need. */
  const runtime = mins === null || mins <= 0
    ? null
    : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 === 0 ? '' : ` ${mins % 60}m`}`;
  const playable = pick !== null && start !== null
    ? isPlayable({ startTs: start, stopTs: stop, hasArchive: slot?.hasArchive }, pick.ch, nowS)
    : false;

  /*
   * Two lines, and it costs the grid as little as it can.
   *
   * The first attempt was four lines and a 3.5rem logo, and measuring it on the
   * television answered the question: 960x540 CSS pixels, minus the app header,
   * the guide controls, the hour ruler and the pager, leaves about 300 for rows.
   * A 5.5rem banner took a third of that and dropped the guide from eight
   * channels on screen to four. A guide you can see four channels of is not a
   * guide, however well it describes one programme.
   *
   * So: title and timing share the first line, the description has the second,
   * and both are clamped to exactly one line so the banner cannot change height
   * as the highlight moves. A box that grows and shrinks under a moving
   * highlight makes the rows below it jump, which on a television reads as the
   * whole page twitching.
   */
  return (
    <div
      data-nav-skip
      aria-live="polite"
      className="flex min-h-[3.4rem] shrink-0 items-center gap-2.5 border-b border-rule
                 bg-panel-2/40 px-4 py-1.5"
    >
      {pick === null ? (
        /* Reached only before any listing has arrived — `Guide` falls back to
           whatever is on now, so in practice this is the cold-start state. */
        <p className="font-mono text-[length:var(--t-2xs)] tracking-wider text-ink-3">
          MOVE THE HIGHLIGHT ONTO A PROGRAMME
        </p>
      ) : (
        <>
          <span className="w-9 shrink-0">
            <Poster src={pick.ch.logo} alt={displayName(pick.ch.name)} ratio="logo" fit="contain" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-[length:var(--t-sm)] leading-tight text-ink">
                {slot?.title ?? 'No programme listed'}
              </span>
              {state === 'live' && (
                <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tracking-wider text-tally">
                  ON NOW
                </span>
              )}
              {playable && state !== 'live' && (
                <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tracking-wider text-tally">
                  CATCH-UP
                </span>
              )}
              {/* Timing sits at the END of the title line rather than under it:
                  it is short, it is always the same shape, and it buys a whole
                  line back for the description. */}
              <span className="ml-auto flex shrink-0 items-center gap-2 font-mono
                               text-[length:var(--t-2xs)] tabular-nums text-ink-3">
                {frac !== null && (
                  <span aria-hidden className="meter block h-0.5 w-12 bg-rule">
                    <span className="block h-full bg-tally" style={{ width: `${frac * 100}%` }} />
                  </span>
                )}
                {start !== null && (
                  <span>
                    {clockOf(start)}
                    {stop !== null ? `–${clockOf(stop)}` : ''}
                  </span>
                )}
                {runtime !== null && <span>{runtime}</span>}
                {pick.ch.archiveDays > 0 && <span>{pick.ch.archiveDays}d</span>}
              </span>
            </span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tracking-wider text-ink-3">
                {displayName(pick.ch.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[length:var(--t-xs)] leading-snug text-ink-2">
                {slot?.description !== undefined && slot.description !== null && slot.description !== ''
                  ? slot.description
                  : 'No description in the listing.'}
              </span>
            </span>
          </span>
        </>
      )}
    </div>
  );
}

/* ── the grid ─────────────────────────────────────────────────────────────── */

/**
 * Does any part of this programme fall inside the window on screen?
 *
 * A row is only as tall as it has something to put in it, and "has listings" is
 * not the same question as "has listings HERE": a channel whose guide starts
 * this evening was given a full-height row at six in the morning to display
 * nothing at all. Cheap enough to ask per slot — a comparison against two
 * numbers — and it is the same test `blockGeometry` applies before it draws.
 */
function showsAnything(ch: GridChannel, from: number, spanS: number): boolean {
  const until = from + spanS;
  return ch.slots.some((s) => s.startTs !== null
    && s.startTs < until
    && (s.stopTs ?? s.startTs + HOUR) > from);
}

/**
 * One height per channel: comfortable when it has something to put in it,
 * short when not.
 *
 * "Something" now includes the no-catch-up mask, not only a programme block —
 * a channel with nothing but the mask used to stay BARE regardless, and the
 * track div's explicit height (`style={{height}}` on a flex child with no
 * `align-items` override) does not stretch to match its taller sibling, the
 * channel-name link. So the mask rendered at the bare height while the ROW
 * itself was pulled tall by the link beside it, and the extra space below
 * read as a rendering fault rather than as a border. `hasMask` closes that:
 * anything the row actually draws gets the same single-row height.
 */
function rowH(ch: GridChannel, from: number, spanS: number, geom: RowGeom, hasMask: boolean): number {
  if (!ch.known) return geom.bare;
  return showsAnything(ch, from, spanS) || hasMask ? geom.single : geom.bare;
}

function Timeline({
  rows, from, spanS, nowS, winMax, onPick, onCursor, onEdge, onTimeShift, landOnChannel,
}: {
  rows: GridChannel[];
  from: number;
  spanS: number;
  nowS: number;
  /** The future cap, for RIGHT at the last row's last block — see `onTimeShift`. */
  winMax: number;
  onPick: (p: Picked) => void;
  /** The highlight moved onto something — see `GuideDetail`. */
  onCursor: (p: Picked | null) => void;
  /**
   * A vertical press ran out of rows. Returns true if it turned the page, in
   * which case the press is consumed and this lands the highlight on the row
   * that has just arrived.
   */
  onEdge: (dir: 1 | -1) => boolean;
  /**
   * A horizontal press ran out of blocks in the row. Returns true if it moved
   * the window, in which case the press is consumed and this lands the
   * highlight on the newly revealed edge of the SAME row.
   */
  onTimeShift: (dir: 1 | -1, ch: GridChannel) => boolean;
  /** `?ch=` on arrival, until it has been found and focused once. */
  landOnChannel: string | null;
}) {
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  /*
   * The track measures itself, because the window now FITS.
   *
   * Blocks are placed in percentages of the track, so the layout needs no pixel
   * count at all — but a block still has to decide whether it has room for its
   * clock as well as its title, and that is a question about pixels. One
   * measurement, published to every block, so they cannot disagree.
   */
  const [trackW, setTrackW] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return;
    const read = () => setTrackW(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* One read of the root for the whole grid — the row heights come from it. */
  const root = rootPx();
  const geom = rowGeom(root);
  const ticks = hourTicks(from, spanS);
  const nowPct = ((nowS - from) / spanS) * 100;

  /*
   * Land the highlight on the page that has just arrived.
   *
   * Consumed exactly once, by a ref that is cleared the moment it is spent. The
   * grid re-reads its cache every few seconds while listings are still filling
   * in, so `rows` changes identity repeatedly for reasons that have nothing to
   * do with paging — and a landing that fired on each of those would yank the
   * highlight out from under somebody reading.
   *
   * A block first, the channel name second. The row a page lands on may have no
   * listings at all, and focusing nothing is how a remote gets stuck: the press
   * is consumed, the page turns, and there is no highlight anywhere.
   */
  const landing = useRef<1 | -1 | null>(null);
  useEffect(() => {
    const want = landing.current;
    if (want === null || rows.length === 0) return;
    const scope = scopeRef.current;
    if (scope === null) return;
    const all = [...scope.querySelectorAll('[data-guide-row]')];
    const row = want === 1 ? all[0] : all[all.length - 1];
    if (!(row instanceof HTMLElement)) return;
    const target = row.querySelector('[data-guide-block]') ?? row.querySelector('a');
    if (!(target instanceof HTMLElement)) return;
    landing.current = null;
    target.focus({ preventScroll: false });
  }, [rows]);

  /**
   * Land on the edge RIGHT/LEFT just revealed, in the SAME row.
   *
   * The mirror of `landing` above, but keyed to a row index rather than to
   * "first or last page": the window moved, the row itself did not. RIGHT
   * lands on the row's new last block, LEFT on its new first — both are the
   * edge a held key needs focus sitting on to keep walking (see `onKeyDown`).
   */
  const rowLanding = useRef<{ row: number; dir: 1 | -1 } | null>(null);
  useEffect(() => {
    const want = rowLanding.current;
    if (want === null) return;
    const scope = scopeRef.current;
    if (scope === null) return;
    const row = scope.querySelector(`[data-guide-row="${want.row}"]`);
    if (!(row instanceof HTMLElement)) return;
    const blocks = [...row.querySelectorAll('[data-guide-block]')];
    const target = (want.dir === 1 ? blocks[blocks.length - 1] : blocks[0]) ?? row.querySelector('a');
    if (!(target instanceof HTMLElement)) return;
    rowLanding.current = null;
    target.focus({ preventScroll: false });
  }, [rows]);

  /**
   * `?ch=` on arrival: find the channel once its page has loaded, and focus its
   * current programme.
   *
   * `landedFor` remembers which id was last handled so a later, unrelated
   * change to `rows` — the topup poll re-reading the cache while listings are
   * still filling in — cannot refocus a channel the viewer has since moved
   * away from. It fires again only when `landOnChannel` itself changes, i.e. a
   * fresh arrival.
   */
  const landedFor = useRef<string | null>(null);
  useEffect(() => {
    if (landOnChannel === null || landOnChannel === landedFor.current) return;
    const idx = rows.findIndex((r) => linkId(r) === landOnChannel);
    if (idx < 0) return; // not on this page (yet) — keep waiting for the right one
    const scope = scopeRef.current;
    if (scope === null) return;
    const row = scope.querySelector(`[data-guide-row="${idx}"]`);
    if (!(row instanceof HTMLElement)) return;
    landedFor.current = landOnChannel;
    const ch = rows[idx]!;
    const usable = ch.slots.filter((s): s is EpgSlot & { startTs: number } => s.startTs !== null);
    const cur = slotAt(usable, nowS);
    const target = (cur !== null ? row.querySelector(`[data-start="${cur.startTs}"]`) : null)
      ?? row.querySelector('[data-guide-block]')
      ?? row.querySelector('a');
    if (!(target instanceof HTMLElement)) return;
    target.focus({ preventScroll: false });
    const found = cur === null ? undefined : usable.find((s) => s.startTs === cur.startTs);
    if (found !== undefined) onCursor({ ch, slot: found });
  }, [rows, landOnChannel, nowS, onCursor]);

  /*
   * DOWN off the bottom turns the page, UP off the top turns it back.
   *
   * 343 channels at twelve a page is twenty-nine presses of NEXT, and NEXT is a
   * button at the bottom of the screen that a highlight has to travel to and
   * back from. Vertical movement is what a person is already doing to read the
   * guide, so it is what should carry them through it — the buttons stay for a
   * cursor, and a remote never needs them.
   *
   * UP on the first page is deliberately NOT consumed: there is no previous page
   * to go to, and letting it climb out to the controls is the only way back to
   * the filters and the clock.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const on = document.activeElement;
      if (!(on instanceof HTMLElement)) return;
      const row = on.closest('[data-guide-row]');
      if (row === null) return;
      const i = Number(row.getAttribute('data-guide-row'));
      const dir: 1 | -1 = e.key === 'ArrowDown' ? 1 : -1;
      const atEdge = dir === 1 ? i === rows.length - 1 : i === 0;
      if (!atEdge) return;
      if (!onEdge(dir)) return;
      landing.current = dir;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      /*
       * Time moves at the window edge.
       *
       * A block with a neighbour in this direction is left to the generic
       * spatial-nav walk (`lib/spatialNav`) — this only fires at the true edge
       * of a row's visible programmes, where that walk finds nothing in the row
       * and would otherwise just stop. `onTimeShift` carries the archive rules
       * (see `Guide`); it returning false — the bound is already reached, or
       * this row has no catch-up to travel into — leaves the press unhandled so
       * the fallback spatial nav can still try, exactly like `onEdge` above.
       */
      const on = document.activeElement;
      if (!(on instanceof HTMLElement) || !on.hasAttribute('data-guide-block')) return;
      const dir: 1 | -1 = e.key === 'ArrowRight' ? 1 : -1;
      const atEdge = dir === 1 ? on.nextElementSibling === null : on.previousElementSibling === null;
      if (!atEdge) return;
      const row = on.closest('[data-guide-row]');
      if (row === null) return;
      const i = Number(row.getAttribute('data-guide-row'));
      const ch = rows[i];
      if (!ch) return;
      if (!onTimeShift(dir, ch)) return;
      rowLanding.current = { row: i, dir };
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    /*
      The whole grid is ONE section, deliberately — not one per column.
      The channel names are not a column in the DOM: each row is a name and a
      track side by side. What a section buys here is the boundary around the
      OUTSIDE: a press at the top of the guide climbs to the controls, one at the
      bottom reaches the pager, and one at either edge stops rather than
      escalating into a band it is level with.
    */
    <div
      ref={scopeRef}
      data-nav-scope
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      {/* Sticky header of hour labels. Only the vertical axis moves now, so it
          only has to stick to the top. */}
      <div className="no-round sticky top-0 z-20 flex border-b border-rule bg-panel">
        <div className="no-round w-36 shrink-0 border-r border-rule bg-panel px-3
                        py-1.5 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
          CHANNEL
        </div>
        <div ref={trackRef} className="relative flex-1">
          {ticks.map((t) => (
            <span
              key={t.ts}
              className="absolute top-0 border-l border-rule/70 py-1.5 pl-1.5 font-mono text-[length:var(--t-2xs)]
                         tabular-nums text-ink-3"
              style={{ left: `${t.leftPct}%` }}
            >
              {clockOf(t.ts)}
            </span>
          ))}
          {/* The "now" cap — see the line below for why it is a fixed red. */}
          {nowPct >= 0 && nowPct <= 100 && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-0 z-10 h-1.5 w-1.5 -translate-x-1/2 rounded-full"
              style={{ left: `${nowPct}%`, background: NOW_RED }}
            />
          )}
        </div>
      </div>

      <div className="relative">
        {/*
          One line for "now", over every row rather than per row. It lives in an
          overlay that starts where the track starts, so its percentage is a
          percentage of the TRACK and not of the row.

          Fixed red rather than `bg-tally`: the theme accent is already spent
          twice on this same screen — catch-up marks, the progress bar under a
          live block — and "now" has to read the same in every skin rather than
          as whatever amber that skin happens to pick.
        */}
        {nowPct >= 0 && nowPct <= 100 && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-36 right-0 z-10">
            <div
              data-guide-now
              className="absolute top-0 bottom-0 w-0.5"
              style={{ left: `${nowPct}%`, background: NOW_RED }}
            />
          </div>
        )}

        {rows.map((ch, i) => {
          const archiveDays = effectiveArchiveDays(ch);
          const floor = archiveFloor(ch, nowS);
          const usable = ch.slots.filter((s): s is EpgSlot & { startTs: number } => s.startTs !== null);
          const shown = visibleSlots(usable, ch, nowS);
          /*
           * The stretch of THIS row's track before its own retention.
           *
           * "No catch-up" for a channel with none at all, "further back than
           * this one keeps" for a channel that keeps less than the window
           * currently shows (another row's deeper archive can carry the shared
           * window further back than this one goes — see `onTimeShift` in
           * `Guide`). Never touches the live/future two-thirds of the row —
           * and that includes the LEFT half of a programme that is airing
           * RIGHT NOW: a live slot always started in the past, which is "before
           * the floor" for a no-archive channel exactly as often as not, and
           * without this clamp the mask painted straight over the live block's
           * own title. The mask only ever covers what `shown` does not.
           */
          const liveSlot = shown.find((s) => slotState(s, nowS) === 'live');
          const maskEnd = liveSlot !== undefined ? Math.min(floor, liveSlot.startTs) : floor;
          const maskWidthPct = maskEnd > from
            ? Math.min(((Math.min(maskEnd, from + spanS) - from) / spanS) * 100, 100)
            : 0;
          const maskPx = (maskWidthPct / 100) * trackW;
          return (
            <div
              key={ch.id}
              data-guide-row={i}
              data-guide-archive-days={archiveDays}
              /*
                Named rather than plain `group`: `RelatedRail`/`Rail` already
                use this exact pattern for the same reason — a bare `.group`
                would answer to `group-hover:`/`group-focus-within:` on ANY
                descendant of ANY ancestor also marked `group`, not just this
                row's own label.
              */
              className="group/guiderow flex border-b border-rule/50"
            >
              <Link
                to={`/live?ch=${linkId(ch)}`}
                className="r-row flex w-36 shrink-0 items-center gap-2 bg-panel px-2 py-1.5
                           transition-colors hover:bg-panel-2"
              >
                <Poster src={ch.logo} alt={displayName(ch.name)} ratio="logo" fit="contain" />
                <span className="min-w-0 flex-1">
                  <span className="block line-clamp-2 text-[length:var(--t-sm)] leading-tight text-ink">
                    {displayName(ch.name)}
                  </span>
                </span>
              </Link>

              <div className="relative flex-1" style={{ height: rowH(ch, from, spanS, geom, maskWidthPct > 0) }}>
                {!ch.known ? (
                  <span className="absolute inset-y-1 left-1 right-1 skeleton" />
                ) : !showsAnything(ch, from, spanS) && maskWidthPct === 0 ? (
                  /* A dash, not a sentence. "no guide for this channel" spelled out
                     on two rows in three is a paragraph of apology where the eye
                     only needs to skip the row. */
                  <span className="absolute inset-y-0 left-2 flex items-center font-mono
                                   text-[length:var(--t-2xs)] text-ink-3/70">
                    —
                  </span>
                ) : (
                  <>
                    {maskWidthPct > 0 && (
                      /*
                        The past this row cannot show, quiet and unfocusable — a
                        plain `div`, never a button. Nothing here is pressable,
                        which is what leaves LEFT from a no-archive channel's
                        current block with no sibling to land on: see the
                        ArrowLeft branch of `onKeyDown` and `Guide`'s
                        `onTimeShift`, which both rely on this NOT being a
                        `[data-guide-block]`.

                        A dim track at rest, no label — printed on most of the
                        rows on screen, "NO CATCH-UP" read as clutter rather
                        than information. The label answers
                        one question — why can't I go left here — and that
                        question only comes up once a viewer is already
                        looking at this row: on focus (a block or the channel
                        name inside it, from the keyboard) or on hover (a
                        pointer, off `group/guiderow` on the row itself so
                        hovering the channel name or a later block reveals it
                        too, not just the mask directly).
                      */
                      <div
                        aria-hidden
                        data-nav-skip
                        className="absolute inset-y-0.5 left-0 overflow-hidden rounded-[var(--r-xs)] bg-panel-2/40"
                        style={{ width: `${maskWidthPct}%` }}
                      >
                        {maskPx >= 60 && (
                          <span
                            className="absolute inset-0 flex items-center justify-center px-1 font-mono
                                       text-[length:var(--t-2xs)] text-ink-3/70 opacity-0 transition-opacity
                                       group-focus-within/guiderow:opacity-100 group-hover/guiderow:opacity-100"
                          >
                            {archiveDays > 0 ? `${archiveDays}D ONLY` : 'NO CATCH-UP'}
                          </span>
                        )}
                      </div>
                    )}
                    {/* The NEXT slot's start is what ends this one when the panel
                        did not say — see `blockGeometry`. `shown` keeps the same
                        relative order as `ch.slots` (it only ever drops a PREFIX
                        too old for this channel's own retention), so the
                        neighbour is still the next index. */}
                    {shown.map((s, j) => (
                      <Block key={s.startTs} ch={ch} slot={s} from={from} spanS={spanS}
                             nextStartTs={shown[j + 1]?.startTs ?? null}
                             trackW={trackW} nowS={nowS} onPick={onPick} onCursor={onCursor} />
                    ))}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Block({
  ch, slot, from, spanS, trackW, nowS, onPick, onCursor, nextStartTs,
}: {
  ch: GridChannel;
  slot: EpgSlot;
  /** Where the next programme starts, so this one can end there. */
  nextStartTs?: number | null;
  from: number;
  spanS: number;
  /** Pixel width of the whole track, so a block knows how much room it has. */
  trackW: number;
  nowS: number;
  onPick: (p: Picked) => void;
  onCursor: (p: Picked | null) => void;
}) {
  if (slot.startTs === null) return null;
  const geo = blockGeometry(
    { startTs: slot.startTs, stopTs: slot.stopTs }, from, spanS, nextStartTs,
  );
  if (!geo) return null;
  const state = slotState({ startTs: slot.startTs, stopTs: slot.stopTs }, nowS);
  const playable = isPlayable(
    { startTs: slot.startTs, stopTs: slot.stopTs, hasArchive: slot.hasArchive },
    ch, nowS,
  );
  const frac = progress({ startTs: slot.startTs, stopTs: slot.stopTs }, nowS);
  /** What this block is actually painted at, in pixels. */
  const width = (geo.widthPct / 100) * trackW;

  return (
    <button
      type="button"
      data-guide-block
      /* Looked up by the `?ch=` arrival effect to focus the exact "now" slot —
         see `landOnChannel` in `Timeline`. */
      data-start={slot.startTs}
      onClick={() => onPick({ ch, slot })}
      /* The highlight arriving IS the request for detail — on a remote there is
         no hover, and asking a person to press OK to find out whether they want
         to press OK is the sheet-shaped hole this fills. */
      onFocus={() => onCursor({ ch, slot })}
      onMouseEnter={() => onCursor({ ch, slot })}
      title={`${clockOf(slot.startTs)} ${slot.title ?? ''}`}
      /*
        What is ON is a FILL; what is SELECTED is the ring.
        These used to be the same amber border, so a screenful of twelve
        channels showed up to twelve blocks that all looked chosen and the one
        actually carrying the highlight was indistinguishable from the rest —
        the single largest reason the grid read as a mess. The focus ring comes
        from `:focus-visible` in index.css and there is only ever one of those.
      */
      className={`absolute inset-y-0.5 overflow-hidden px-1.5 text-left transition-colors
        ${state === 'live'
          ? 'border border-rule bg-tally/20 text-ink'
          : playable
            ? 'border border-rule bg-panel-2 text-ink-2 hover:border-ink-3 hover:text-ink'
            : 'border border-rule/60 bg-panel text-ink-3 hover:border-ink-3'}`}
      /* The hairline minimum lives here rather than in the percentage, so a
         one-minute programme is still visible and still pressable without
         stealing width from the programme after it. */
      style={{
        left: `${geo.leftPct}%`,
        width: `${geo.widthPct}%`,
        minWidth: '2px',
      }}
    >
      {/*
        A title needs room for a title.

        Below about two characters plus the padding, `truncate` produces a single
        clipped letter — the "S", "S2", "RG", "V" column that made the right-hand
        end of the grid read as corruption. A bare bar is the honest rendering at
        that width: it keeps its colour and its state, the tooltip still names it,
        and the banner above says what it is the moment the highlight lands.

        ONE line, not two. `line-clamp-2` was right when the block was the only
        place a title could appear; now a name too long for the block is finished
        in the banner, and a second line of wrapped title inside a half-hour box
        is what made every row look full of text.
      */}
      {width >= 30 && (
        <span className="block truncate text-[length:var(--t-xs)] leading-tight">{slot.title ?? 'No title'}</span>
      )}
      {/* Below ~4.5rem there is room for a title or a time, not both. */}
      {width >= 72 && (
        <span className="block truncate font-mono text-[length:var(--t-2xs)] tabular-nums opacity-80">
          {clockOf(slot.startTs)}{playable ? ' · catch-up' : ''}
        </span>
      )}
      {playable && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-tally/70" />
      )}
      {frac !== null && (
        <span aria-hidden className="meter-edge absolute inset-x-0 bottom-0 h-0.5 bg-tally/30">
          <span className="block h-full bg-tally" style={{ width: `${frac * 100}%` }} />
        </span>
      )}
    </button>
  );
}

/* ── the phone projection ─────────────────────────────────────────────────── */

function NowList({
  rows, at, nowS, onPick,
}: {
  rows: GridChannel[];
  at: number;
  nowS: number;
  onPick: (p: { ch: GridChannel; slot: EpgSlot }) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {rows.map((ch) => {
        const usable = ch.slots.filter((s): s is EpgSlot & { startTs: number } => s.startTs !== null);
        const cur = slotAt(usable.map((s) => ({ ...s, startTs: s.startTs })), at) as (EpgSlot & { startTs: number }) | null;
        const next = usable.find((s) => s.startTs > at) ?? null;
        const frac = cur ? progress({ startTs: cur.startTs, stopTs: cur.stopTs }, nowS) : null;
        const playable = cur
          ? isPlayable({ startTs: cur.startTs, stopTs: cur.stopTs, hasArchive: cur.hasArchive }, ch, nowS)
          : false;

        return (
          <button
            key={ch.id}
            type="button"
            onClick={() => (cur ? onPick({ ch, slot: cur }) : undefined)}
            className="tap row-hover flex w-full items-center gap-2.5 border-b border-rule/50 px-3 py-2 text-left"
          >
            <Poster src={ch.logo} alt={displayName(ch.name)} ratio="logo" fit="contain" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[length:var(--t-sm)] text-ink">{displayName(ch.name)}</span>
                {playable && <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-tally">CATCH-UP</span>}
              </span>
              <span className="block truncate text-[length:var(--t-xs)] text-ink-2">
                {!ch.known ? 'loading guide…' : cur?.title ?? 'no programme listed'}
              </span>
              {frac !== null && (
                <span className="meter mt-1 block h-0.5 bg-rule">
                  <span className="block h-full bg-tally" style={{ width: `${frac * 100}%` }} />
                </span>
              )}
              {next?.title && (
                <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3">
                  next {clockOf(next.startTs)} · {next.title}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── what a programme offers ──────────────────────────────────────────────── */

function SlotSheet({
  ch, slot, nowS, onClose,
}: {
  ch: GridChannel;
  slot: EpgSlot;
  nowS: number;
  onClose: () => void;
}) {
  if (slot.startTs === null) return null;
  const state = slotState({ startTs: slot.startTs, stopTs: slot.stopTs }, nowS);
  const playable = isPlayable(
    { startTs: slot.startTs, stopTs: slot.stopTs, hasArchive: slot.hasArchive },
    ch, nowS,
  );
  const stop = slot.stopTs ?? slot.startTs + HOUR;
  const day = new Date(slot.startTs * 1000).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <Sheet title={displayName(ch.name)} onClose={onClose} height="60dvh">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="font-mono text-[length:var(--t-2xs)] tracking-wide text-ink-3">
          {day} · {clockOf(slot.startTs)}–{clockOf(stop)} · {Math.round((stop - slot.startTs) / 60)} min
        </p>
        <h2 className="text-[length:var(--t-lg)] font-semibold leading-tight text-ink">{slot.title ?? 'No title'}</h2>
        {slot.description && (
          <p className="text-[length:var(--t-sm)] leading-relaxed text-ink-2">{slot.description}</p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {state === 'live' && (
            <Link to={`/live?ch=${linkId(ch)}`} className="btn btn-primary pill">
              <Play className="h-3.5 w-3.5 fill-current" /> WATCH LIVE
            </Link>
          )}
          {playable && (
            <Link
              to={`/catchup?ch=${linkId(ch)}&start=${slot.startTs}&stop=${stop}`}
              className="btn btn-primary pill"
            >
              <RotateCcw className="h-3.5 w-3.5" /> PLAY FROM THE ARCHIVE
            </Link>
          )}
          {state === 'past' && !playable && (
            <p className="font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
              {!ch.archive
                ? 'This channel keeps no archive, so this programme is gone.'
                : `Outside the archive window — this channel keeps ${ch.archiveDays} day(s).`}
            </p>
          )}
          {state === 'future' && (
            <Link to={`/live?ch=${linkId(ch)}`} className="btn pill">
              <Play className="h-3.5 w-3.5" /> OPEN THE CHANNEL
            </Link>
          )}
          <button type="button" onClick={onClose} className="btn pill">
            <X className="h-3.5 w-3.5" /> CLOSE
          </button>
        </div>
      </div>
    </Sheet>
  );
}
