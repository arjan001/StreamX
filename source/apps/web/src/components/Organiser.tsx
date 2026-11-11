import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff, Layers, Pin, RotateCcw, Search, Star,
} from 'lucide-react';
import { type Category, type Section } from '../lib/api';
import { displayName, groupLabel } from '../lib/displayName';
import { useShape } from '../lib/formFactor';
import { marketName, useCategories, useMarkets } from '../lib/groups';
import { moveMarket } from '../lib/marketOrder';
import { reorderFrom } from '../lib/ordering';
import {
  isFav, setCatOrder, setPrefs, toggleFav, toggleHiddenCat, toggleHiddenStream, usePrefs,
} from '../lib/prefs';
import { usePagedItems } from '../lib/usePagedItems';
import { Poster } from './Poster';
import { VirtualList } from './VirtualList';
import { useTally } from '../lib/tally';
import { useOkToType } from '../lib/okToType';

/**
 * The two-grid: the tree on the left, what is inside it on the right.
 *
 * This is the screen the client insisted on, and the shape is theirs: countries
 * with their packages nested under them down the left, and the channels of
 * whatever is focused on the right. "they choose countries, they reorder
 * countries, they hide or unhide countries, countries have groups and they can
 * select" — and then the channels of the thing they are standing on.
 *
 * ── it follows focus, it does not wait to be pressed ──
 *
 * The right-hand grid is a consequence of where you are, not of what you
 * pressed. On a remote that difference is the whole feel of the screen: with 79
 * countries and 1,051 packages, a viewer who has to press OK to look and Back to
 * leave presses four hundred buttons to survey their subscription. Moving down
 * the tree and watching the right side change costs one press per row.
 *
 * The cost of that is a request per row focused, so it is debounced by 220ms —
 * holding Down through forty countries fires one request, for the fortieth. The
 * same reason the live screen waits before re-tuning a channel.
 *
 * ── countries are not a second screen ──
 *
 * They were, for one afternoon: a Countries pane with its own tick boxes,
 * sitting in the sidebar above this one. "the channals and countries are the
 * saame thing" — and they are. The left column of this grid IS the country
 * list, with the same names, the same counts, the same order and the same
 * hide, so a second screen offering the same three actions was somewhere to
 * make a choice that the other screen would then contradict.
 *
 * What came across from it is everything it had that this did not: the search
 * (79 countries on a subscription, 178 in the free lists), the count line, the
 * reset to the default order, and the positive selection — "I only watch these
 * three" — which is genuinely a different statement from "I have hidden these
 * seventy-six" and is why `prefs.markets` still exists beside `hidePaths`. See
 * `toggleMarket` for how one press means the same thing to a viewer whichever
 * of those two lists ends up carrying it.
 *
 * ── six keys, and no drag ──
 *
 * Up and Down travel rows, Left and Right change column, OK expands or selects,
 * Back leaves. The actions — hide, show, all the packages at once, pin, move up,
 * move down — are a bar across the top of the column that acts on whatever row
 * is focused, and it names its target so nothing is a guess about what is about
 * to disappear.
 *
 * ── the bar is glyphs at rest and words on focus ──
 *
 * It was seven labelled buttons, and on the 1280×720 television this app is for
 * they wrapped onto two rows with the last label clipped to "D…". Reported as
 * "everything is cramped"; `scripts/density-probe.mjs` counted the cluster.
 *
 * The labels are only ever read at the moment somebody is choosing, so they
 * arrive with focus — the same rule the header destinations use, `.dest-label`
 * in index.css — and at rest the bar is six ~34px glyphs against a pane about a
 * thousand wide, on one row, with room to spare. `aria-label` carries the name
 * for a screen reader whatever is painted, and `title` for a pointer.
 *
 * Nothing moved behind a "More" button: on a remote a second press to reach an
 * action is the same cost as the wrap was, and every one of these is one press
 * from every other along a single row.
 *
 * They are NOT three buttons in every row, which is what this had first: those
 * sit exactly where the press that crosses to the next column has to go, so
 * reaching the channels of a package meant walking past Hide, Move up and Move
 * down. The plan called that out before a line of this was written. The icons
 * are still in each row for a pointer, where they are the fastest thing on the
 * screen; they are simply out of the remote's path.
 *
 * A television has no drag gesture, so moving with two buttons is not the lesser
 * path — it is the only path on the device this app is for.
 *
 * ── every action is reversible from this screen ──
 *
 * Hidden rows stay in the tree, dimmed and marked, because a hidden row that
 * disappears is a row nobody can bring back. The plan called this out as one of
 * the two traps to close here; the other is that you cannot hide your way into
 * an empty app, which the browse screens answer by saying so and offering the
 * reset.
 */

/** Everything a row can do, in one place so the tree and the list agree. */
export function RowButton({ label, on, onClick, children, navSkip = true }: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /**
   * Out of the remote's path, by default.
   *
   * Three icon buttons per row steal Right — the press that has to move to
   * the next column — so reaching the channels of a package meant walking
   * past Hide, Move up and Move down first. The plan called this out before
   * a line of it was written: "Four icon buttons in each row — steals
   * Left/Right, which must move between the columns."
   *
   * So they stay for a pointer, where they are the fastest thing on the
   * screen, and a remote uses the action bar at the top of the column, which
   * acts on whatever row is focused. Same actions, one place, and Right
   * still means "show me what is in this".
   *
   * A screen with no second column to protect — `MyChannels` in
   * `routes/Organise.tsx` is a flat list, nothing sits to the right of it —
   * has no reason to hide its own row buttons from a D-pad, and every one of
   * its controls has to be reachable some way. `navSkip={false}` there opts
   * back into ordinary tab order instead.
   */
  navSkip?: boolean;
}) {
  return (
    <button
      type="button"
      {...(navSkip ? { 'data-nav-skip': '' as const, tabIndex: -1 } : {})}
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`tap grid h-8 w-7 shrink-0 place-items-center transition-colors
        hover:text-tally focus-visible:text-focus ${on === true ? 'text-tally' : 'text-ink-3'}`}
    >
      {children}
    </button>
  );
}

type Focus =
  | { kind: 'market'; id: string; label: string }
  | { kind: 'package'; ref: string; id: number; label: string };

/**
 * The right-hand column: every channel (or title) inside the focused row.
 *
 * Windowed, and paged, because a country here is hundreds to thousands of
 * rows — the same problem Live already solved. Rendering the first 120 as a
 * plain map left the rest unreachable and put 120 posters in the DOM at once.
 */
function InsideList({ section, shown }: { section: Section; shown: Focus }) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();

  const shape = useShape();
  const query = useMemo(() => (
    shown.kind === 'market'
      ? { categoryId: null, sort: 'default' as const, dir: 'asc' as const, q: '', markets: [shown.id] }
      : { categoryId: shown.id, sort: 'default' as const, dir: 'asc' as const, q: '' }
  ), [shown]);
  const { total, rows, loading, ensureRange } = usePagedItems(section, query);
  const onRange = useCallback((start: number, end: number) => {
    void ensureRange(start, end);
  }, [ensureRange]);
  const rowHeight = shape.touch ? 56 : 48;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-rule/60 bg-panel px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--t-2xs)] uppercase
                         tracking-wider text-ink-3">
          {shown.label}{tallyOf(total) === null ? '' : ` · ${tallyOf(total)}`}
        </span>
        {loading && (
          <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">loading…</span>
        )}
      </div>

      {total === 0 && !loading && (
        <p className="p-4 font-mono text-[length:var(--t-xs)] text-ink-3">Nothing in this one.</p>
      )}

      {(total > 0 || loading) && (
        <VirtualList
          count={total}
          rowHeight={rowHeight}
          navGroup={`inside-${section}`}
          onRangeChange={onRange}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
          render={(i) => {
            const item = rows.get(i);
            if (!item) {
              return (
                <div className="h-full px-3 py-2.5">
                  <div className="skeleton h-full" />
                </div>
              );
            }
            const off = prefs.hideStreams.includes(item.streamId ?? -1);
            const fav = isFav(section === 'live' ? 'live' : section, item.streamId);
            const name = displayName(item.name);
            return (
              <div
                data-stream-id={item.streamId ?? undefined}
                className={`flex h-full items-center gap-2 border-b border-rule/30 pr-1.5
                  ${off ? 'opacity-45' : ''}`}
              >
                <button
                  type="button"
                  className="tap flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left
                             hover:bg-panel-2"
                  onClick={() => toggleHiddenStream(item.streamId)}
                >
                  <Poster src={item.logo} alt={name} ratio="logo" fit="contain" />
                  <span className="min-w-0 flex-1 truncate text-[0.8rem] text-ink-2 tv:text-[0.95rem]">
                    {name}
                  </span>
                </button>
                <RowButton label={fav ? `Unstar ${name}` : `Star ${name}`} on={fav}
                           onClick={() => toggleFav(section === 'live' ? 'live' : section, item.streamId)}>
                  <Star className={`h-3.5 w-3.5 ${fav ? 'fill-current' : ''}`} />
                </RowButton>
                <RowButton label={off ? `Show ${name}` : `Hide ${name}`} on={off}
                           onClick={() => toggleHiddenStream(item.streamId)}>
                  {off ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </RowButton>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

export function Organiser({ section, aside = null }: {
  section: Section;
  /**
   * One control that belongs to the country LIST rather than to a row.
   *
   * The free-list switch, today (see `FreeChip` in routes/Organise.tsx). It was
   * a card above this box — 20 words and ~50px of a 720px screen — and what it
   * actually says is "there are this many more countries available", which is
   * the sentence the count line under the search already starts. So the caller
   * decides WHAT the fact is and this decides WHERE it reads.
   */
  aside?: React.ReactNode;
}) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  /* Focus parks, OK types — one rule for every field, see `lib/okToType.ts`. */
  const ok = useOkToType();
  const [focus, setFocus] = useState<Focus | null>(null);
  /* What the right-hand grid is actually showing, which lags `focus` by a beat
     so that travelling through the tree does not fire a request per row. */
  const [shown, setShown] = useState<Focus | null>(null);

  useEffect(() => {
    if (focus === null) return undefined;
    const t = window.setTimeout(() => setShown(focus), 220);
    return () => window.clearTimeout(t);
  }, [focus]);

  /* Unscoped on purpose, both of them: this is the screen where hidden things
     are brought back, so it has to be able to see them. Everywhere else in the
     app reads the same lists through `scopeParams`, which drops them. */
  const { markets } = useMarkets(section, {}, [], []);
  const cats = useCategories(section, {});

  const hiddenMarkets = new Set(prefs.hidePaths);
  const hiddenCats = new Set(prefs.hideCatRefs);
  const order = prefs.catOrder[section] ?? [];

  /*
   * Watching three countries, and hiding one, are different facts.
   *
   * `prefs.markets` is "these are the countries I watch" — a positive
   * selection, which is what the old wizard wrote and what `effectiveMarkets`
   * intersects into every query in the app. `prefs.hidePaths` is "this one,
   * no". Both make lists shorter, and a viewer pressing HIDE on a country means
   * "stop showing me this" without caring which list carries it, so this screen
   * shows one state and writes to whichever one is currently doing the work.
   */
  const picked = prefs.markets;
  const scoped = picked.length > 0;
  const marketOff = (id: string): boolean =>
    hiddenMarkets.has(id) || (scoped && !picked.includes(id));

  const toggleMarket = (id: string): void => {
    if (hiddenMarkets.has(id)) {
      setPrefs({ hidePaths: prefs.hidePaths.filter((x) => x !== id) });
      return;
    }
    if (!scoped) { setPrefs({ hidePaths: [...prefs.hidePaths, id] }); return; }
    if (!picked.includes(id)) { setPrefs({ markets: [...picked, id] }); return; }
    /* Emptying a selection means "show everything", so dropping its last
       country would turn one press of HIDE into showing seventy-eight others.
       The selection is converted into a hide instead of emptied. */
    if (picked.length === 1) {
      setPrefs({ markets: [], hidePaths: [...prefs.hidePaths, id] });
      return;
    }
    setPrefs({ markets: picked.filter((x) => x !== id) });
  };
  /**
   * Positive country selection (`prefs.markets`), separate from hide/show.
   *
   * This is the "favourites countries" list: it always edits the allow-list,
   * never `hidePaths`, so adding several countries is explicit and predictable.
   */
  const togglePickedMarket = (id: string): void => {
    if (picked.includes(id)) {
      setPrefs({ markets: picked.filter((x) => x !== id) });
      return;
    }
    setPrefs({ markets: [...picked, id] });
  };

  /* Searching 178 countries, which is the other thing the deleted pane had. */
  const shownMarkets = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (f === '') return markets;
    return markets.filter((m) => m.id.toLowerCase().includes(f)
      || (m.label || marketName(m.id)).toLowerCase().includes(f));
  }, [markets, q]);
  /* A move is applied to the real order, so it is not offered while a search is
     showing a different one — otherwise the row moves somewhere invisible. */
  const ordering = q.trim() === '';
  const total = markets.reduce((n, m) => n + (marketOff(m.id) ? 0 : m.count), 0);

  /** The packages under one country, in the viewer's order. */
  const under = useMemo(() => {
    const by = new Map<string, Category[]>();
    for (const c of cats) {
      const key = c.region ?? '';
      if (key === '') continue;
      const list = by.get(key) ?? [];
      list.push(c);
      by.set(key, list);
    }
    const rank = new Map(order.map((ref, i) => [ref, i]));
    for (const list of by.values()) {
      list.sort((a, b) => {
        const ra = rank.get(a.ref);
        const rb = rank.get(b.ref);
        if (ra !== undefined || rb !== undefined) {
          if (ra === undefined) return 1;
          if (rb === undefined) return -1;
          return ra - rb;
        }
        return b.count - a.count;
      });
    }
    return by;
  }, [cats, order]);

  const treeEl = useRef<HTMLDivElement | null>(null);

  const moveCat = (region: string, ref: string, dir: -1 | 1) => {
    const list = under.get(region) ?? [];
    const from = list.findIndex((c) => c.ref === ref);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    setCatOrder(section, reorderFrom(list, from, to));
  };

  /* What the action bar acts on, and what each action does to it. */
  const target = focus;
  const targetHidden = target === null
    ? false
    : target.kind === 'market' ? marketOff(target.id) : hiddenCats.has(target.ref);
  const targetPinned = target !== null && target.kind === 'package' && order.includes(target.ref);
  const regionOf = (ref: string): string => {
    for (const [region, list] of under) if (list.some((c) => c.ref === ref)) return region;
    return '';
  };

  const toggleTarget = () => {
    if (target === null) return;
    if (target.kind === 'market') { toggleMarket(target.id); return; }
    toggleHiddenCat(target.ref);
  };
  const moveTarget = (dir: -1 | 1) => {
    if (target === null) return;
    if (target.kind === 'market') { setPrefs({ marketOrder: moveMarket(markets, target.id, dir) }); return; }
    moveCat(regionOf(target.ref), target.ref, dir);
  };
  const pinTarget = () => {
    if (target === null || target.kind !== 'package') return;
    const region = regionOf(target.ref);
    const list = under.get(region) ?? [];
    const from = list.findIndex((c) => c.ref === target.ref);
    if (from < 0) return;
    setCatOrder(section, targetPinned
      ? order.filter((x) => x !== target.ref)
      : reorderFrom(list, from, 0));
  };
  /*
   * "I only watch this one" — the tick-box pane's whole purpose, as one press.
   *
   * Hiding seventy-eight countries one at a time is not a thing anybody does,
   * and it was the reason a positive selection existed in the first place. It
   * toggles: pressed again on the only picked country, it goes back to all.
   */
  const onlyTarget = () => {
    if (target === null || target.kind !== 'market') return;
    const already = picked.length === 1 && picked[0] === target.id;
    setPrefs({ markets: already ? [] : [target.id] });
  };
  const pickTarget = () => {
    if (target === null || target.kind !== 'market') return;
    togglePickedMarket(target.id);
  };
  /*
   * Every package under the focused country at once — the plan's "act on the
   * container", which is what a checkbox toolbar was doing the long way round.
   *
   * ONE button rather than the two it was. HIDE ALL and SHOW ALL are the same
   * question asked from opposite ends, and which end you are at is a fact this
   * screen already knows: if every package under this country is hidden the only
   * useful press is SHOW ALL, and the reverse. Two buttons for one state is one
   * button that is always dead — and on the row that had already wrapped.
   *
   * Disabled, not hidden, on a country with no packages of its own (the free
   * lists): a control that vanishes as you travel the tree moves the ones beside
   * it under your thumb.
   */
  const allUnder = (hide: boolean) => {
    if (target === null || target.kind !== 'market') return;
    const refs = (under.get(target.id) ?? []).map((c) => c.ref);
    if (refs.length === 0) return;
    setPrefs({
      hideCatRefs: hide
        ? [...new Set([...prefs.hideCatRefs, ...refs])]
        : prefs.hideCatRefs.filter((r) => !refs.includes(r)),
    });
  };

  /* What the container actions have to work with, and which way round they are. */
  const targetKids = target !== null && target.kind === 'market' ? under.get(target.id) ?? [] : [];
  const allKidsHidden = targetKids.length > 0 && targetKids.every((c) => hiddenCats.has(c.ref));

  /* `dest` is what shows the label on focus — see the head of this file and
     `.dest-label` in index.css. The size comes off the type scale rather than
     0.58rem so it clears the 12px caption floor a television is held to. */
  const ACT = 'dest tap flex shrink-0 items-center gap-1.5 border border-rule px-2 py-1 font-mono'
    + ' text-[length:var(--t-2xs)] tracking-wider text-ink-2 transition-colors'
    + ' hover:border-tally hover:text-tally focus-visible:border-focus focus-visible:text-focus'
    + ' disabled:opacity-35';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--r-md)] border border-rule/60">
      {/*
        The action bar: what you can do to the row you are standing on.

        One place rather than three buttons in every row, because on a remote the
        row's own buttons sit exactly where the press that crosses to the next
        column has to go. It names its target, so nothing here is a guess about
        what is about to be hidden.
      */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-rule/60
                      bg-ground/40 px-2.5 py-1.5">
        {/* The target, and no more of it than fits: the row it names is two
            centimetres below and still highlighted. Not `flex-1` — the slack
            belongs at the END of the row, so a label appearing on focus pushes
            into empty space instead of shifting the button under your thumb. */}
        <span className="min-w-0 max-w-[11rem] shrink truncate font-mono text-[length:var(--t-2xs)]
                         uppercase tracking-wider text-ink-3 tv:max-w-[18rem]">
          {target === null ? 'Nothing selected' : target.label}
        </span>
        {/*
          Same rule as the header destinations: one row, scroll sideways when
          focus paints the labels. Six actions at most (HIDE · WATCH · ONLY ·
          ALL · UP · DOWN on a country) — wrapping into a second row was the
          cramped cluster this bar was rewritten to avoid.
        */}
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            className={ACT}
            disabled={target === null}
            aria-label={targetHidden ? 'Show this' : 'Hide this'}
            title={targetHidden ? 'Show this' : 'Hide this'}
            onClick={toggleTarget}
          >
            {targetHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            <span className="dest-label">{targetHidden ? 'SHOW' : 'HIDE'}</span>
          </button>
          {target !== null && target.kind === 'market' && (
            <>
              <button
                type="button"
                className={ACT}
                aria-label={picked.includes(target.id) ? 'Stop watching this country' : 'Watch this country'}
                title={picked.includes(target.id) ? 'Stop watching this country' : 'Watch this country'}
                onClick={pickTarget}
              >
                <Star className={`h-3.5 w-3.5 ${picked.includes(target.id) ? 'fill-current text-tally' : ''}`} />
                <span className="dest-label">{picked.includes(target.id) ? 'UNWATCH' : 'WATCH'}</span>
              </button>
              <button
                type="button"
                className={ACT}
                aria-label={picked.length === 1 && picked[0] === target.id
                  ? 'Show every country again' : 'Watch only this country'}
                title={picked.length === 1 && picked[0] === target.id
                  ? 'Show every country again' : 'Watch only this country'}
                onClick={onlyTarget}
              >
                <Check className={`h-3.5 w-3.5 ${picked.length === 1 && picked[0] === target.id ? 'text-tally' : ''}`} />
                <span className="dest-label">
                  {picked.length === 1 && picked[0] === target.id ? 'EVERY COUNTRY' : 'ONLY THIS'}
                </span>
              </button>
              <button
                type="button"
                className={ACT}
                disabled={targetKids.length === 0}
                aria-label={allKidsHidden
                  ? 'Show every package in this country' : 'Hide every package in this country'}
                title={allKidsHidden
                  ? 'Show every package in this country' : 'Hide every package in this country'}
                onClick={() => allUnder(!allKidsHidden)}
              >
                <Layers className={`h-3.5 w-3.5 ${allKidsHidden ? 'text-tally' : ''}`} />
                <span className="dest-label">{allKidsHidden ? 'SHOW ALL' : 'HIDE ALL'}</span>
              </button>
            </>
          )}
          {target !== null && target.kind === 'package' && (
            <button
              type="button"
              className={ACT}
              aria-label={targetPinned ? 'Unpin this package' : 'Pin this package to the top'}
              title={targetPinned ? 'Unpin this package' : 'Pin this package to the top'}
              onClick={pinTarget}
            >
              <Pin className={`h-3.5 w-3.5 ${targetPinned ? 'text-tally' : ''}`} />
              <span className="dest-label">{targetPinned ? 'UNPIN' : 'PIN TO TOP'}</span>
            </button>
          )}
          <button
            type="button"
            className={ACT}
            disabled={target === null || (!ordering && target.kind === 'market')}
            aria-label="Move this up"
            title="Move this up"
            onClick={() => moveTarget(-1)}
          >
            <ChevronUp className="h-3.5 w-3.5" />
            <span className="dest-label">UP</span>
          </button>
          <button
            type="button"
            className={ACT}
            disabled={target === null || (!ordering && target.kind === 'market')}
            aria-label="Move this down"
            title="Move this down"
            onClick={() => moveTarget(1)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span className="dest-label">DOWN</span>
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
      {/* ── the tree ─────────────────────────────────────────────────────── */}
      <div
        ref={treeEl}
        data-nav-group={`tree-${section}`}
        data-nav-memory
        className="min-h-0 w-[17rem] shrink-0 overflow-y-auto border-r border-rule/60 tv:w-[22rem]"
      >
        {/*
          Sticky, because the count line is the answer to "why am I only seeing
          three countries" and that question gets asked from halfway down the
          list, not from the top of it.
        */}
        <div className="sticky top-0 z-10 border-b border-rule/60 bg-panel px-2 py-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-3" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find a country"
              {...ok.props}
              className="w-full border border-rule bg-ground py-1.5 pl-7 pr-2 text-[0.75rem] text-ink
                         placeholder:text-ink-3 focus:border-focus outline-none tv:text-[0.9rem]"
            />
          </div>
          {/* Everything on this line is a NUMBER or a switch on that number,
              which is why the free lists ended up here: "All 8 countries" and
              "+ 12,923 FREE" are the same sentence. Sized off the type scale —
              0.63rem is 10px on a television, under the 12px caption floor. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p className="min-w-0 flex-1 truncate font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
              {scoped
                ? `${picked.length} of ${markets.length} · ${total.toLocaleString()} channels`
                : `All ${markets.length} countries · ${total.toLocaleString()} channels`}
            </p>
            {aside}
            {scoped && (
              <button
                type="button"
                onClick={() => setPrefs({ markets: [] })}
                className="tap shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3 transition-colors
                           hover:text-tally"
              >
                EVERY COUNTRY
              </button>
            )}
            {prefs.marketOrder.length > 0 && (
              <button
                type="button"
                onClick={() => setPrefs({ marketOrder: [] })}
                className="tap flex shrink-0 items-center gap-1 font-mono text-[length:var(--t-2xs)] text-ink-3
                           transition-colors hover:text-tally"
              >
                <RotateCcw className="h-2.5 w-2.5" /> DEFAULT ORDER
              </button>
            )}
          </div>
        </div>

        {markets.length === 0 && (
          <p className="p-3 font-mono text-[length:var(--t-xs)] text-ink-3">No countries in this section yet.</p>
        )}
        {markets.length > 0 && shownMarkets.length === 0 && (
          <p className="p-3 font-mono text-[length:var(--t-xs)] text-ink-3">Nothing matches that.</p>
        )}
        {shownMarkets.map((m) => {
          const isOpen = open.has(m.id);
          const off = marketOff(m.id);
          const on = picked.includes(m.id);
          const kids = under.get(m.id) ?? [];
          const hiddenKids = kids.filter((c) => hiddenCats.has(c.ref)).length;
          return (
            <section key={m.id}>
              <div className={`flex items-center border-b border-rule/40 ${off ? 'opacity-45' : ''}`}>
                <button
                  type="button"
                  /* Where Left from the channels comes back to. `focusFirst`
                     would otherwise return to the first country in the list,
                     which is a long way from wherever you were. */
                  data-row=""
                  {...(focus?.kind === 'market' && focus.id === m.id ? { 'data-here': '' } : {})}
                  onFocus={() => setFocus({ kind: 'market', id: m.id, label: m.label || marketName(m.id) })}
                  onClick={() => {
                    setFocus({ kind: 'market', id: m.id, label: m.label || marketName(m.id) });
                    setOpen((s) => {
                      const next = new Set(s);
                      if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                      return next;
                    });
                  }}
                  aria-expanded={isOpen}
                  className="tap flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left
                             hover:bg-panel-2 tv:py-2.5"
                >
                  {isOpen
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />}
                  {/* A tick, not a colour: while a selection is in force the
                      difference between watched and not is the whole state of
                      this screen and has to read at three metres. */}
                  {on && <Check className="h-3 w-3 shrink-0 text-tally" />}
                  <span className="min-w-0 flex-1 truncate text-[0.85rem] text-ink tv:text-[1rem]">
                    {m.label || marketName(m.id)}
                  </span>
                  <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
                    {/* Packages, then channels, joined only when both are there:
                        with counts switched off this printed "13·" — a number
                        and a dangling dot nobody could read. */}
                    {[kids.length > 0 ? `${kids.length} ${kids.length === 1 ? 'package' : 'packages'}` : null,
                      tallyOf(m.count)].filter((x) => x !== null && x !== '').join(' · ')}
                  </span>
                </button>
                {/* Acting on the container: one press hides the country and
                    everything under it, which is what "hide all" meant on the
                    client's screen — and what a checkbox toolbar was doing the
                    long way round. */}
                <RowButton
                  label={off ? `Show ${m.label || marketName(m.id)}` : `Hide ${m.label || marketName(m.id)}`}
                  on={off}
                  onClick={() => toggleMarket(m.id)}
                >
                  {off ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </RowButton>
                <RowButton
                  label={on ? `Remove ${m.label || marketName(m.id)} from watched countries` : `Watch ${m.label || marketName(m.id)}`}
                  on={on}
                  onClick={() => togglePickedMarket(m.id)}
                >
                  <Star className={`h-4 w-4 ${on ? 'fill-current' : ''}`} />
                </RowButton>
                {ordering && (
                  <>
                    <RowButton label={`Move ${m.label || marketName(m.id)} up`}
                               onClick={() => setPrefs({ marketOrder: moveMarket(markets, m.id, -1) })}>
                      <ChevronUp className="h-4 w-4" />
                    </RowButton>
                    <RowButton label={`Move ${m.label || marketName(m.id)} down`}
                               onClick={() => setPrefs({ marketOrder: moveMarket(markets, m.id, 1) })}>
                      <ChevronDown className="h-4 w-4" />
                    </RowButton>
                  </>
                )}
              </div>

              {isOpen && kids.length === 0 && (
                <p className="px-3 py-1.5 font-mono text-[length:var(--t-2xs)] text-ink-3">
                  {section === 'live' ? 'No packages — the country is the group.' : 'No packages.'}
                </p>
              )}
              {isOpen && kids.map((c) => {
                const catOff = hiddenCats.has(c.ref);
                const pinned = order.includes(c.ref);
                /* The same rule the rails use — a package is not a title, and
                   `cleanName` is the ingest-time answer that still leaves a
                   market prefix on 46 of this fixture's 223 live categories
                   ("EU| LUXEMBOURG", "BR| CULTURA"). See `groupLabel`. */
                const label = groupLabel(c.cleanName !== '' ? c.cleanName : c.name);
                return (
                  <div
                    key={c.ref}
                    className={`flex items-center border-b border-rule/30 bg-ground/40
                      ${catOff ? 'opacity-45' : ''}`}
                  >
                    <button
                      type="button"
                      {...(focus?.kind === 'package' && focus.ref === c.ref ? { 'data-here': '' } : {})}
                      onFocus={() => setFocus({ kind: 'package', ref: c.ref, id: c.id, label })}
                      onClick={() => setFocus({ kind: 'package', ref: c.ref, id: c.id, label })}
                      className="tap flex min-w-0 flex-1 items-center gap-2 pl-7 pr-2 py-1.5
                                 text-left hover:bg-panel-2 tv:py-2"
                    >
                      {pinned && <Pin className="h-3 w-3 shrink-0 text-tally" />}
                      <span className="min-w-0 flex-1 truncate text-[0.78rem] text-ink-2 tv:text-[0.92rem]">
                        {label}
                      </span>
                      <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
                        {tallyOf(c.count)}
                      </span>
                    </button>
                    <RowButton label={catOff ? `Show ${label}` : `Hide ${label}`} on={catOff}
                               onClick={() => toggleHiddenCat(c.ref)}>
                      {catOff ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </RowButton>
                    <RowButton label={`Move ${label} up`} onClick={() => moveCat(m.id, c.ref, -1)}>
                      <ChevronUp className="h-3.5 w-3.5" />
                    </RowButton>
                    <RowButton label={`Move ${label} down`} onClick={() => moveCat(m.id, c.ref, 1)}>
                      <ChevronDown className="h-3.5 w-3.5" />
                    </RowButton>
                  </div>
                );
              })}
              {/* A count, not a sentence: the dimmed rows are directly above it
                  and each one carries its own eye. */}
              {isOpen && hiddenKids > 0 && (
                <p className="px-3 py-1 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
                  {hiddenKids} of {kids.length} hidden
                </p>
              )}
            </section>
          );
        })}
      </div>

      {/* ── what is inside it ────────────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {shown === null ? (
          /* 25 words became 7. The old note explained that the column follows
             focus rather than a press — which is a thing you learn by pressing
             Down once, and which cost 67px of the 720 this screen has. */
          <p className="p-4 font-mono text-[length:var(--t-xs)] text-ink-3">
            {section === 'live' ? 'Stand on a country to see its channels.' : 'Stand on a row to see what is inside it.'}
          </p>
        ) : (
          <InsideList section={section} shown={shown} />
        )}
      </div>
      </div>
    </div>
  );
}

/** The two columns, for the screen that owns the arrows. */
export function organiserColumns(el: HTMLElement | null, section: Section): {
  tree: HTMLElement | null;
  inside: HTMLElement | null;
  /** The row the tree is standing on, so coming back lands where you left. */
  here: HTMLElement | null;
} {
  if (el === null) return { tree: null, inside: null, here: null };
  const tree = el.querySelector<HTMLElement>(`[data-nav-group="tree-${section}"]`);
  return {
    tree,
    inside: el.querySelector<HTMLElement>(`[data-nav-group="inside-${section}"]`),
    /*
     * Where Right from the sidebar lands, and where Left from the channels
     * comes back to: the row you were standing on, else the first country.
     *
     * NOT `focusFirst`, which now finds the search field at the top of the
     * column — a remote arriving on a text box may raise the television's own
     * keyboard, and the first press of a screen about countries should be on a
     * country. The field is one press Up from there.
     */
    here: tree?.querySelector<HTMLElement>('[data-here]')
      ?? tree?.querySelector<HTMLElement>('[data-row]')
      ?? null,
  };
}
