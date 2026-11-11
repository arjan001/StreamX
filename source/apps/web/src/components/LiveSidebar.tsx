import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, Check, ChevronDown, Eye, EyeOff, Globe, Search, Star } from 'lucide-react';
import type { Section } from '../lib/api';
import { isAdultPath } from '../lib/adultFilter';
import { useScope } from '../lib/scope';
import { localAllItems } from '../lib/localRead';
import { localEnabled } from '../lib/localCatalogue';
import { setCatOrder, toggleHiddenCat, toggleHiddenPath, usePrefs } from '../lib/prefs';
import {
  MARKET_KINDS, marketKind, marketName, useCategories, useGroupTree, useMarkets,
  type MarketKind,
} from '../lib/groups';
import { marketFlagUrl } from '../lib/marketFlag';
import { crossScope } from '../lib/crossFilter';
import { isFieldSubmit } from '../lib/keys';
import { focusFirst } from '../lib/spatialNav';
import { useOkToType } from '../lib/okToType';
import { reorderFrom } from '../lib/ordering';
import { typingDelay } from '../lib/typingDelay';
import { railSearchScope, type RailScope } from '../lib/railSearchScope';
import type { Filters } from './FilterBar';
import { useTally } from '../lib/tally';
import { useSkin } from '../lib/skin';
import { filterSidebar, listLabel, listRows, standingLabel, type BrowseStyle, type ListRow } from '../lib/liveRows';
import { installMarquee } from '../lib/marquee';
import { useLongPress } from '../lib/longPress';
import { HoldMenu, type HoldAction } from './HoldMenu';

/**
 * Countries, with groups nested underneath the open one.
 *
 * Opening a country selects it and lists every group. "All groups" shows every
 * channel in that country; a group row shows only that group's channels. The
 * channel list is the other pane — this tree is the only place groups are picked.
 *
 * ── or the provider's own list of all of it, which is the default ──
 *
 * `browseStyle` (see `lib/prefs`) turns the tree off: every category in the
 * section stands in one rail with its count, under the name the panel gave it —
 * `NL | CATEGORY | MOVIE`, not "Netherlands › Movie" — which is what the
 * competitor's own sidebar does, what "if they wanna see it as list all of it"
 * meant, and what "no need to filter the names at all" asked for next. A row
 * writes `category` into the address; the tree writes a path. Nothing is hidden
 * either way.
 */
/*
 * Why the rows here are rounded, after a long time square.
 *
 * They carried `no-round` as full-bleed bands: a row spans the rail and its
 * highlight is the row, so rounding it puts notches where the highlight meets
 * the rail's edge. That was the right call for the band and the wrong one for
 * the highlight — the remote's ring, the chosen country and the playing channel
 * were the only square shapes inside rounded panes, and on a television they are
 * the shapes looked at most: "even the highlighted areas are square, but I
 * didn't select the square layout". The rows follow the layout now through
 * `--r-row` (index.css), and are square again under the square layout.
 */
/*
 * Why every row also carries `pick-row`.
 *
 * `.pick` is what a chosen row LOOKS like; `.pick-row` is how tall it is. The
 * rail used to set its own paddings and its own type step per row — `py-2` here,
 * `py-2.5` there, `--t-sm` on two rows and `--t-md` on the rest — and the result,
 * measured at the 960x540 a set-top box reports, was a rail stepping 22.9px
 * beside a channel list stepping 52px. Two lists in one pane row at half each
 * other's rhythm read as two different components, which is exactly what was
 * reported: "you see, they are not the same size both lists … please make the
 * sizes consistant". The pitch now comes from one class and one number, shared
 * with the virtualiser. See `lib/liveRows.ts`.
 */
export function LiveSidebar({
  section = 'live',
  value,
  onChange,
  style,
  excludeTopic,
}: {
  section?: Section;
  /**
   * The whole filter set, not just the two fields this tree writes.
   *
   * It reads the rest: a genre, a language or a package chosen elsewhere on the
   * page has to narrow what this list offers, or the sidebar sits beside a
   * comedy grid still listing every country in the library — press one and the
   * grid goes empty. See `crossScope`.
   */
  value: Filters;
  onChange: (patch: {
    favs?: boolean; markets?: string[]; paths?: string[]; path?: string | null;
    categoryId?: number | null; cats?: number[]; q?: string;
  }) => void;
  /**
   * Tree or flat list. Defaults to the viewer's own setting, which is what every
   * caller wants — the prop exists so a screen that has a reason to pin one
   * shape can, without this component growing a second source of truth.
   */
  style?: BrowseStyle;
  /**
   * A topic this sidebar leaves out, counts and all — Live TV passes "sports",
   * whose channels are on Sports TV, so a package of nothing but sport does not
   * sit here reading zero or listing the same channels twice.
   */
  excludeTopic?: string;
}) {
  const tallyOf = useTally();
  const [prefs] = usePrefs();
  const nav = useNavigate();
  /*
   * Hold a row here for what can be done TO it.
   *
   * The same gesture the channel list has, for the same reason — "make a hold
   * action on hold in TV live lists you can hide unhide stuff fav and so on,
   * reorder them and what not". A group's own verbs are show and hide; the
   * ordering of groups and countries stays in Organise, which is where a list
   * long enough to reorder is actually workable, and the menu says so.
   */
  interface RowVerbs {
    title: string;
    /** Absent on a group row, which has no stable ref to store an order under. */
    ref: string | null;
    hidden: boolean;
    hide: () => void;
  }
  const [rowMenu, setRowMenu] = useState<RowVerbs | null>(null);
  const holdRow = useRef<RowVerbs | null>(null);
  const holdMenu = useLongPress(() => {
    if (holdRow.current !== null) setRowMenu(holdRow.current);
  });
  /**
   * Move is a MODE, not two menu items.
   *
   * "if they choose move up/down they can select and move it up in left side …
   * so its like when they select the option to move it they can move it
   * anywhere". Two menu entries move a row one place per visit to the menu,
   * which for a row that belongs forty places up is forty visits. So the menu
   * hands the row to the arrows instead: up and down carry it, OK puts it down,
   * BACK puts it back where it was.
   *
   * The order is materialised on the first move — `reorderFrom` turns what is on
   * screen into the stored order — because a partial order cannot express "here,
   * between these two". From then on the list is exactly what the viewer
   * arranged, which is what `ListRow.placed` tells `listRows` not to re-rank.
   */
  const [moving, setMoving] = useState<string | null>(null);
  const undoOrder = useRef<string[] | null>(null);
  /* A truncated name slides to its end while its row is focused or hovered. One
     set of listeners for the whole app — see lib/marquee; this only asks. */
  useEffect(() => { installMarquee(); }, []);
  const { scope: profileScope } = useScope();
  const scope = useMemo(
    () => (excludeTopic ? { ...profileScope, excludeTopic } : profileScope),
    [profileScope, excludeTopic],
  );
  const modern = useSkin().shell === 'modern';
  const flat = (style ?? prefs.browseStyle) === 'list';
  /**
   * What has been typed, and what is actually filtering.
   *
   * Two values with `typingDelay()` between them, the same shape and the same
   * number `routes/Search.tsx` uses. It is not about the cost of the filter —
   * this is an array of at most a few hundred rows — it is about what the rail
   * DOES while somebody types: re-filtering on every keystroke re-lays the rows
   * out under the highlight four times a word, and on a remote the highlight is
   * the cursor. The number itself follows where the catalogue lives; see
   * `lib/typingDelay.ts`.
   */
  const [draft, setDraft] = useState(value.q);
  /*
     One rule for every field in the app: focus parks, OK types. See
     `lib/okToType.ts` — this is the field the owner was describing, the one a
     D-pad walks over on the way down the rail.
  */
  const ok = useOkToType({
    onKeyDown: (e) => {
      if (!isFieldSubmit(e.key, e.nativeEvent.isComposing, e.keyCode)) return;
      e.preventDefault();
      e.currentTarget.blur();
      requestAnimationFrame(() => focusFirst());
    },
  });

  const filter = value.q.trim();
  /*
   * One search for the whole screen.
   *
   * There were two fields — this one over the rail, filtering group NAMES, and
   * the strip's, filtering what the list holds — and they were the "too many
   * duplicate thing" in "the fiters for TV, filter channals with it as well,
   * same in movies and so on, one search for all". Photographed: "BBC" typed
   * here narrowed the rail to the groups carrying a BBC channel, and the column
   * beside it still listed every channel in the group that happened to be open.
   *
   * So this field writes the page's one query. The rail keeps what it always
   * did on top of it — a group survives on its name OR on what is inside it —
   * and the list beside it filters to the same word.
   */
  useEffect(() => { setDraft(value.q); }, [value.q]);
  /**
   * Where the viewer was before they started typing. See `lib/searchScope.ts`
   * for the whole rule and the photograph that asked for it — in one line: a
   * search asks the WHOLE library, because searching inside an empty Favourites
   * list finds nothing however many channels match, and clearing the box puts
   * the viewer back.
   */
  const parked = useRef<RailScope | null>(null);
  /** The fields this rule moves, as they stand right now. */
  const scopeNow = (): RailScope => ({
    favs: value.favs,
    markets: value.markets,
    paths: value.paths,
    path: value.path,
    categoryId: value.categoryId,
    cats: value.cats,
  });
  useEffect(() => {
    const t = draft.trim();
    if (t === filter) return;
    const id = window.setTimeout(() => {
      const move = railSearchScope(filter, t, scopeNow(), parked.current);
      parked.current = move.parked;
      onChange(move.patch);
    }, typingDelay());
    return () => window.clearTimeout(id);
    // `onChange` is rebuilt every render by every caller; the query is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, filter]);
  /**
   * Emptying the box, from a control rather than from the keyboard.
   *
   * It has to go through the same rule, or the two ways out of a search disagree:
   * pressing BACKSPACE until the box is empty would restore the scope and
   * pressing the CLEAR row would leave the viewer in the widened one.
   */
  const clearSearch = () => {
    setDraft('');
    const move = railSearchScope(filter, '', scopeNow(), parked.current);
    parked.current = move.parked;
    onChange(move.patch);
  };
  /** Country whose groups are hidden. Cleared whenever a country is picked. */
  const [folded, setFolded] = useState<string | null>(null);
  /**
   * Package path whose sub-groups are open (e.g. `UK/SKY`).
   *
   * The panel nests brands: `UK| SKY STORE` and `UK| SKY SPORT+ VIP` become
   * `UK/SKY/STORE` and `UK/SKY/SPORT+ VIP`. Without a second open level the
   * sidebar only shows "Sky" once and the other packages look missing.
   */
  const [openPkg, setOpenPkg] = useState<string | null>(null);

  const selected = value.markets;
  const paths = value.paths;
  const favs = value.favs;

  /* Everything except this tree's own axis. Scoping the tree by the group it is
     standing in would collapse it to that one branch, leaving no way to reach a
     neighbour — the whole point of a permanent sidebar.

     The CATEGORY is this rail's axis too now — it is what a row of the list
     shape picks — so it comes out of the scope the same way. Left in, picking
     one category would collapse the list to that one row. */
  const listScope = useMemo(
    () => crossScope(scope, { ...value, categoryId: null, cats: [] }, 'groups'),
    [scope, value],
  );

  const tree = useGroupTree(section, listScope);
  const categories = useCategories(section, listScope);
  const { markets } = useMarkets(section, listScope, tree.tree, categories);

  /**
   * The same list, WITHOUT the hidden filter — because the rail draws them.
   *
   * A hidden package used to vanish from this rail and be recoverable only from
   * Settings → Organise, which is the arrangement the owner threw out: "can u
   * not say hide from this list and put in bottom in like hidden list, they find
   * settings to complicated". A row you hid is still a row here, dimmed and last.
   *
   * A second read rather than a filter on the first, and the split is
   * deliberate: the tree and the market counts stay on the SCOPED list, because
   * a country's count is a promise about what you would see if you pressed it,
   * and a hidden package is not part of that.
   */
  const railScope = useMemo(() => {
    const { hideCats: _cats, hideCatRefs: _refs, ...rest } = listScope;
    return rest;
  }, [listScope]);
  const railCategories = useCategories(section, railScope);

  /**
   * What the field over the rail actually searched.
   *
   * "when you search ontop of the countries or catyeogies, it should check both
   * channals as well as categories, and then show those categorites with that
   * keyword as well as those categories that its children has it". Typing
   * "discovery" matched no PACKAGE on this provider and emptied the column,
   * while six packages carried a Discovery channel each.
   *
   * So the query is also put to the catalogue, and what comes back is folded to
   * the two things this rail draws: the category ids that hold a match, and the
   * markets those categories sit under. `localAllItems` is the unclamped read —
   * a paged one would answer "which of the first 200" and quietly miss the rest,
   * which is the mistake `docs`' own note on paged readers is about — and it is
   * a device-local pass over an index that searches 124,157 items in 2.1 ms.
   *
   * Empty on a device with no local catalogue, where the rail behaves exactly as
   * it did: names only.
   */
  const childMatches = useMemo(() => {
    const empty = { cats: new Set<number>(), markets: new Set<string>() };
    if (filter.length < 2 || !localEnabled()) return empty;
    const cats = new Set<number>();
    for (const item of localAllItems(section, { q: filter, ...(excludeTopic ? { excludeTopic } : {}) })) {
      if (item.categoryId !== null) cats.add(item.categoryId);
    }
    if (cats.size === 0) return empty;
    const markets = new Set<string>();
    for (const c of categories) {
      if (!cats.has(c.id)) continue;
      const market = (c.path ?? [])[0];
      if (market !== undefined) markets.add(market);
    }
    return { cats, markets };
  }, [filter, section, categories, excludeTopic]);


  const open = selected[0] ?? null;
  const activePath = paths[0] ?? null;
  const activeCategory = value.categoryId;
  /* All is on only when nothing on this rail is — a category counts, or a list
     row and the All row above it would both be lit. */
  const allOn = !favs && open === null && activeCategory === null && value.cats.length === 0;

  useEffect(() => { setOpenPkg(null); }, [open]);
  useEffect(() => {
    if (activePath === null) return;
    const segs = activePath.split('/');
    if (segs.length >= 3) setOpenPkg(segs.slice(0, 2).join('/'));
  }, [activePath]);

  /**
   * Bring the chosen country into view when it was chosen elsewhere.
   *
   * Opening a channel from search or from a home rail selects its country here
   * (see `Live.tsx`), and on a list of 200 that selection is usually a hundred
   * rows off screen: the channel list filtered itself, the address said
   * `markets=PKF`, and the sidebar still showed Afghanistan down to Brazil with
   * no sign of what had happened. On a D-pad it is worse than cosmetic — the
   * highlighted row is where arrow-down starts from, and it was somewhere the
   * viewer could not see.
   *
   * Only when it is actually out of view, so pressing a country that is already
   * on screen does not yank the list out from under the press.
   */
  const selectedRow = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = selectedRow.current;
    if ((open === null && activeCategory === null) || el === null) return;
    const box = el.getBoundingClientRect();
    const scroller = el.closest<HTMLElement>('.overflow-y-auto');
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    if (box.top >= view.top && box.bottom <= view.bottom) return;
    el.scrollIntoView({ block: 'center' });
  }, [open, activeCategory]);

  const childrenOf = useMemo(() => {
    const m = new Map<string, { id: string; label: string; count: number }[]>();
    const index = (nodes: typeof tree.tree) => {
      for (const n of nodes) {
        m.set(
          n.id,
          [...n.children]
            .filter((c) => !prefs.hidePaths.includes(c.id) && !isAdultPath(c.id))
            .sort((a, b) => b.count - a.count)
            .map((c) => ({ id: c.id, label: c.label, count: c.count })),
        );
        index(n.children);
      }
    };
    index(tree.tree);
    return m;
  }, [tree.tree, prefs.hidePaths]);

  const shown = useMemo(() => {
    const rows = markets.map((m) => ({
      ...m,
      /* What is nested under this country, so the field can find a package
         without the viewer having to know whose it is. See `matchesQuery`. */
      under: (childrenOf.get(m.id) ?? []).map((g) => g.label),
    }));
    /* The chosen country, kept on the list at zero.
       Narrowing can empty it — a country with no comedy in it drops out the
       moment Comedy is picked — and a highlighted row that vanishes takes the
       only way of un-picking it with it. The genre chips solve the same problem
       the same way (`visibleGenres`). */
    if (open !== null && !rows.some((m) => m.id === open)) {
      rows.push({ id: open, label: marketName(open), count: 0, categories: [], under: [] });
    }
    /* Deliberately no `.sort()` here. `markets` already carries the rank
       `useMarkets` computed — the United Kingdom, then Europe, then the rest,
       see `lib/marketOrder.ts` — and this used to sort the result alphabetically
       on top of that, which threw the rank away right before drawing it: the
       one place in this rail's own render path that still read UK, US, NL like
       any other three letters instead of by the order `useMarkets` had already
       worked out. `filterSidebar` keeps whatever order it is given. */
    return filterSidebar(rows, filter, childMatches.markets)
      .filter((m) => !isAdultPath(m.id))
      /* Drop empty rows once something else is filtering — a zero that cannot
         be pressed into content is noise. */
      .filter((m) => m.count > 0 || m.id === open);
  }, [markets, filter, childrenOf, open, childMatches]);

  /**
   * Every category in the section, in one rail, when that is the shape asked for.
   *
   * Grouped by market and ranked the same way the tree above is — the United
   * Kingdom, then Europe, then the rest, `prefs.marketOrder` first of all — and
   * under the provider's own names within a market. It used to be the group
   * TREE flattened into friendly paths and sorted by size; "no need to filter
   * the names at all" retired the friendly paths. `listRows` holds the rules;
   * adult is dropped here, by its path, the way every other row on this rail
   * drops it.
   */
  const flatRows = useMemo((): ListRow[] => {
    if (!flat) return [];
    return listRows(
      railCategories.filter((c) => !isAdultPath((c.path ?? []).join('/') || (c.region ?? ''))),
      filter,
      prefs.marketOrder,
      section,
      { placed: new Set(prefs.catOrder[section]), hidden: new Set(prefs.hideCatRefs) },
      childMatches.cats,
    );
  }, [flat, railCategories, filter, prefs.marketOrder, prefs.catOrder, prefs.hideCatRefs, section,
    childMatches]);

  /**
   * The highlight follows the row being carried.
   *
   * Two reasons it has to be explicit. The menu that started the carry took
   * focus, and closing it hands focus back to the rail's first row rather than
   * to the row somebody is holding — measured: after choosing Move, the arrows
   * were moving the highlight from "Favourites". And every reorder re-parents
   * the row in the DOM, which drops focus. So this runs after each render while
   * a carry is in progress, which is exactly when it is cheap to be certain.
   */
  useEffect(() => {
    if (moving === null) return;
    const el = document.querySelector<HTMLElement>(`[data-cat-ref="${moving}"]`);
    if (el !== null && document.activeElement !== el) el.focus();
  });

  /** Where the hidden band starts, so one divider can be drawn above it. */
  const firstHidden = useMemo(
    () => flatRows.findIndex((r) => r.hidden),
    [flatRows],
  );

  /*
   * Countries together, and everything that is not a country said out loud.
   *
   * This provider's prefixes are a mix: 26 countries, two languages (EN, AR),
   * five regions (Africa, Asia, Latin America, Scandinavia, Ex-Yugoslavia) and
   * four topics (Music, Sports, Other) — all of them listed in one rail
   * under a heading that said Country. Reported as "show really bad like
   * languges and counties mixed".
   *
   * Nothing is dropped: somebody who wants the Arabic films wants that filter.
   * The rows are grouped by what they ARE and each group says so, and a rail
   * that turns out to be all countries gets no headings at all — a heading over
   * every row would be the same noise in a different shape.
   */
  const ordered = useMemo(() => {
    const byKind = new Map<MarketKind, typeof shown>();
    for (const m of shown) {
      const k = marketKind(m.id, section);
      const list = byKind.get(k);
      if (list === undefined) byKind.set(k, [m]);
      else list.push(m);
    }
    return MARKET_KINDS.flatMap(({ kind }) => byKind.get(kind) ?? []);
  }, [shown, section]);

  const headingFor = useMemo(() => {
    const kinds = new Set(ordered.map((m) => marketKind(m.id, section)));
    if (kinds.size < 2) return new Map<string, string>();
    const seen = new Set<MarketKind>();
    const out = new Map<string, string>();
    for (const m of ordered) {
      const k = marketKind(m.id, section);
      if (seen.has(k)) continue;
      seen.add(k);
      out.set(m.id, MARKET_KINDS.find((x) => x.kind === k)?.label ?? '');
    }
    return out;
  }, [ordered, section]);


  /*
   * A scope the viewer picked THEMSELVES is theirs to keep.
   *
   * The search parked where they were so that clearing the box could put them
   * back — but if they have since chosen a package from the rail, that is a
   * decision rather than a detour, and dragging them out of it when the query
   * goes would be the same rudeness in the other direction.
   */
  const keepThisScope = () => { parked.current = null; };

  /* Every pick clears the other shape's choice as well as its own: a category
     left in the address under a country picked from the tree would AND the two,
     and almost always into nothing. */
  const pickFavourites = () => {
    keepThisScope();
    onChange({ favs: true, markets: [], paths: [], path: null, categoryId: null, cats: [] });
  };

  const pickCountry = (code: string | null) => {
    keepThisScope();
    setFolded(null);
    onChange({
      favs: false,
      markets: code === null ? [] : [code],
      paths: [],
      path: null,
      categoryId: null,
      cats: [],
    });
  };

  const pickGroup = (market: string, path: string | null) => {
    keepThisScope();
    onChange({
      favs: false,
      markets: [market],
      paths: path === null ? [] : [path],
      path: null,
      categoryId: null,
      cats: [],
    });
  };

  /* A row of the list shape: the category, and nothing else narrowing beside it
     on this rail. The profile's countries still apply — they ride in on the
     scope, not on these fields. */
  const pickCategory = (id: number) => {
    keepThisScope();
    setFolded(null);
    onChange({ favs: false, markets: [], paths: [], path: null, categoryId: id, cats: [] });
  };

  const allCount = tree.total;
  /* The same tree over three different libraries, so the words have to follow the
     section: depth-1 is a COUNTRY for channels and a language/provider group for
     films and series ("English", "4K NETFLIX MOVIES"). Calling those countries is
     how a correct list reads as a broken one. */
  const channels = section === 'live';
  /* `standingLabel` (lib/liveRows.ts) so this and the heading over the channel
     list in `Live.tsx` cannot drift apart again — they used to, in list mode. */
  const allLabel = standingLabel(flat, channels);
  /*
   * Short on the row, complete in the name.
   *
   * "find a country or group…" is 24 characters and the field is 143px of text
   * at TV type — it painted as "find a country or group." with the last word
   * clipped, which is a placeholder that looks like a bug. The visible string is
   * what fits; `aria-label` carries the whole promise, which is what a screen
   * reader and the hint bar read (see `Field` in ui.tsx on why a placeholder is
   * not a name).
   */
  const findLabel = channels ? 'search channels…' : 'search titles…';
  const findName = channels
    ? 'Search channels and groups'
    : 'Search titles and groups';

  /*
   * The two standing rows are searched too, and that is what makes DOWN work.
   *
   * They are rows on this rail like any other, so a query that does not describe
   * them has to take them off it — otherwise typing "sport" leaves Favourites and
   * All sitting above the matches, and the first press of DOWN out of the field
   * lands on neither of the things just searched for. Typing "fav" still finds
   * Favourites, which is the other half of the same rule.
   */
  const standing = useMemo(
    () => new Set(
      filterSidebar(
        [{ id: 'favourites', label: 'Favourites' }, { id: 'all', label: allLabel }],
        filter,
      ).map((r) => r.id),
    ),
    [filter, allLabel],
  );

  const rowCount = (flat ? flatRows.length : ordered.length) + standing.size;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-rule bg-panel">
      <div className="relative min-h-0 flex-1">
        {/*
          Remembers the country (or nested group) last focused so LEFT out of
          the channel list returns here — not to Favourites at the same Y as
          the channel row. See `land` in `lib/spatialNav.ts`.
        */}
        <div
          className="absolute inset-0 flex flex-col"
          data-nav-group="countries"
          data-nav-memory
        >
        {/*
          The rail searches itself again, and it is INSIDE the group on purpose.

          There used to be three fields on this screen — over the countries, over
          the channels and in the header — which was three places to look for the
          same thing and three scopes to hold in your head, so all three became
          one header search over the whole library. That is still the right answer
          for finding a PROGRAMME. It is the wrong answer for finding a row on
          this rail, which is a different question with a different scope: "in
          groups or lists, add a search bar on everywhere on that sidebar". This
          one never leaves the sidebar and never touches the grid.

          ── why it sits inside `data-nav-group="countries"` ──

          `land` restores a remembering group's last row whenever focus arrives
          from a DIFFERENT group. A field in its own wrapper above the rail is a
          different group, so pressing DOWN out of it would have jumped to
          whichever country was last highlighted rather than to the first row the
          query matched. Inside the group the names match, no restore happens, and
          DOWN is plain geometry — the row directly underneath. It is the same
          placement, for the same reason, as the Organiser's own country search,
          and it inherits that screen's rule: a remote ARRIVES on a country and
          the field is one press UP from there, because landing on a text box
          raises the television's keyboard over half the screen.

          Always on screen: "which search am I looking at" is asked from halfway
          down a list, not from the top of one.

          ── and ABOVE the scroller now, not stuck to the top inside it ──

          It was `sticky top-0` inside the element that scrolls, so the rows
          scrolled up underneath it: in the owner's 1.17.0 screenshot the first
          visible row was half-hidden behind the field. The group is a column of
          two things instead — this band, which never moves, and the scroller
          under it — so a row is either wholly in view or wholly out of it, and
          both stay inside `data-nav-group` for the reason above. `keyline` finds
          the scroller by its computed overflow and the reveal effect further up
          by its `overflow-y-auto` class, which it still carries, so neither
          needed to know.

          A band across the pane, like a row: no wrapper padding, the field's own
          edge is the pane's edge, and its icon and its text start in the same
          two columns as a row's icon and title.
        */}
        <div className="shrink-0">
          <span className="relative block min-w-0">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
            />
            {/*
              One stop, so `clearable` is off.

              `ui.tsx`'s Field draws a clear button inside itself, which is a
              second focusable thing immediately to the RIGHT of the caret — and
              RIGHT out of this rail is how a viewer reaches the channel list.
              That is the mistake the country rows already made with their
              chevron and their hide button, and it has the same fix: one
              control. A query that finds nothing offers its own way out below.
            */}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={findLabel}
              aria-label={findName}
              enterKeyHint="search"
              inputMode="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              /*
                The IME's own action key. This field has no form and no
                submit of its own — it filters as it is typed — so OK's job
                is only to close the keyboard and hand focus to whatever is
                now showing below, rather than leave the remote pointed at a
                field with nothing selected. `isFieldSubmit` keeps a
                composing IME's own Enter (confirming a candidate) out of
                this: see `lib/keys.ts`. `requestAnimationFrame` gives the
                blur one frame to settle before `focusFirst` measures anything.
              */
              {...ok.props}
              className="block w-full border-0 border-b border-rule/60 bg-ground/50 py-2 pl-9 pr-3
                         text-[length:var(--t-sm)] text-ink outline-none
                         placeholder:text-ink-3 focus:border-focus"
            />
          </span>
        </div>

        {/* The scroller. `rail-rows` is the flex column in index.css that keeps
            row margins from collapsing — see the note there. */}
        <div className="rail-rows min-h-0 flex-1 overflow-y-auto" data-nav-column>
        {standing.has('favourites') && (
          <button
            onClick={pickFavourites}
            className={`pick pick-row tap border-b border-rule/40 pl-3 ${favs ? 'is-on' : ''}`}
          >
            <Star className={`h-3.5 w-3.5 shrink-0 ${favs ? 'fill-current text-tally' : 'text-ink-3'}`} />
            <span className="pick-title min-w-0 flex-1 truncate">Favourites</span>
            <Count>{tallyOf(prefs.favs[section].length)}</Count>
            {!flat && <Slot />}
          </button>
        )}
        {standing.has('all') && (
          <button
            onClick={() => pickCountry(null)}
            className={`pick pick-row tap border-b border-rule/40 pl-3 ${allOn ? 'is-on' : ''}`}
          >
            <Globe className={`h-3.5 w-3.5 shrink-0 ${allOn ? 'text-tally' : 'text-ink-3'}`} />
            <span className="pick-title min-w-0 flex-1 truncate">{allLabel}</span>
            <Count>{tallyOf(allCount)}</Count>
            {!flat && <Slot />}
          </button>
        )}

        {flat ? flatRows.map((c, i) => {
          const on = !favs && activeCategory === c.id;
          const isMoving = moving !== null && moving === c.ref;
          const verbs = {
            title: c.label,
            ref: c.ref === '' ? null : c.ref,
            hidden: c.hidden,
            hide: () => { if (c.ref !== '') toggleHiddenCat(c.ref); },
          };
          return (
            <div
              key={c.id}
              ref={on ? selectedRow : undefined}
            >
              {/*
                The one divider on this rail, and only when there is something
                under it. Everything below it is hidden — still here, still one
                press from coming back, and out of the way of the list you use.
              */}
              {i === firstHidden && (
                <div
                  className="flex items-center gap-2 border-b border-rule/40 bg-ground/40 px-3 py-1
                             font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3"
                >
                  <EyeOff className="h-3 w-3" />
                  <span>Hidden</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  /* A row being carried is put down here; a hidden row comes
                     back; anything else is a filter, as it always was. */
                  if (isMoving) { setMoving(null); undoOrder.current = null; return; }
                  if (c.hidden) { if (c.ref !== '') toggleHiddenCat(c.ref); return; }
                  pickCategory(c.id);
                }}
                {...holdMenu}
                onPointerDown={(e) => { holdRow.current = verbs; holdMenu.onPointerDown(e); }}
                onKeyDown={(e) => {
                  holdRow.current = verbs;
                  /* While this row is being carried the arrows move it instead of
                     moving the highlight, and BACK undoes the whole carry. */
                  if (isMoving) {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      e.stopPropagation();
                      const to = i + (e.key === 'ArrowUp' ? -1 : 1);
                      if (to < 0 || to >= flatRows.length || flatRows[to]?.hidden === true) return;
                      setCatOrder(section, reorderFrom(flatRows, i, to));
                      return;
                    }
                    if (e.key === 'Escape' || e.key === 'Backspace') {
                      e.preventDefault();
                      e.stopPropagation();
                      if (undoOrder.current !== null) setCatOrder(section, undoOrder.current);
                      undoOrder.current = null;
                      setMoving(null);
                      return;
                    }
                  }
                  holdMenu.onKeyDown(e);
                }}
                data-cat-ref={c.ref === '' ? undefined : c.ref}
                className={`pick pick-row tap w-full border-b border-rule/40 pl-3 text-left
                  ${on ? 'is-on' : ''}
                  ${c.hidden ? 'opacity-45' : ''}
                  ${isMoving ? 'is-on ring-1 ring-inset ring-tally' : ''}`}
              >
                {/* `dir="auto"`: a name the provider wrote in Arabic reads, and
                    truncates, from its own start — and slides the other way. The
                    inner span is what lib/marquee moves. */}
                {(() => {
                  const l = listLabel(c.label);
                  return (
                    <span dir="auto" className="pick-title min-w-0 flex-1 truncate">
                      {l.market !== null && (
                        <span className="mr-1.5 font-mono text-[length:var(--t-2xs)] tracking-wide text-ink-3">
                          {l.market}
                        </span>
                      )}
                      <span data-marquee>{l.name}</span>
                    </span>
                  );
                })()}
                {isMoving
                  ? (
                    <span className="flex shrink-0 items-center gap-1 pr-1 text-tally">
                      <ArrowUpDown className="h-3.5 w-3.5" />
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  )
                  : <Count>{tallyOf(c.count)}</Count>}
              </button>
            </div>
          );
        }) : ordered.map((m) => {
          const selectedHere = !favs && open === m.id;
          const groups = childrenOf.get(m.id) ?? [];
          // One nested group is the country itself (AFG → Afghanistan). Listing
          // it under All groups is the same filter twice.
          const nestable = groups.length > 1;
          const expanded = nestable && selectedHere && folded !== m.id;
          /*
           * The resolved name wins over the stored one when the stored one is
           * just the code.
           *
           * Group labels are baked at ingest, so a code the ingest could not
           * name — `AF`, `CN`, `SCA`, `ISR` — is stored as itself and rendered
           * as two or three raw letters. Preferring `marketName` here fixes
           * those on devices that already hold a catalogue, without a rebuild,
           * and it also applies the films-and-series meaning of a code the live
           * side reads differently (`LA` is Latvia there, Latin America here).
           */
          const named = marketName(m.id, section);
          const label = named !== m.id ? named : (m.label || m.id);
          const heading = headingFor.get(m.id);
          const flag = modern && channels ? marketFlagUrl(m.id, section) : null;
          return (
            <div
              key={m.id}
              ref={selectedHere ? selectedRow : undefined}
            >
              {/* A label, never a stop: a D-pad walking this rail must not have
                  to press through the word "Languages" to reach one. */}
              {heading === undefined ? null : (
                <p
                  data-nav-skip
                  className="border-b border-rule/40 bg-panel-2/60 px-3 py-1
                             font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3"
                >
                  {heading}
                </p>
              )}
              {/*
                One control, not two.

                Every country used to be a label button plus a chevron button,
                which made this rail 337 focusable things in 224 pixels — and the
                chevron sat directly to the RIGHT of the label, so pressing RIGHT
                to leave the rail for the channel list landed on the chevron
                instead. Reported from the living room twice: "I cannot go from
                the left menu to the middle column with the remote", and then
                "the navigation on the left is a complete mess".

                It is the same mistake the channel rows made with their star, and
                it has the same fix: the row is one button, and the second action
                is folded into it. Pressing a country selects it and opens its
                groups; pressing the one you are already on closes them again.
                The chevron stays as a SIGN of what will happen — it is not a
                target any more.
              */}
              <button
                type="button"
                onClick={() => {
                  if (selectedHere && nestable) setFolded(expanded ? m.id : null);
                  else pickCountry(m.id);
                }}
                aria-expanded={nestable ? expanded : undefined}
                /* The hairline is the ROW's, inside its own height, so this rail
                   steps exactly `--row-step` like the channel list beside it. It
                   was on the wrapper div, a pixel outside the row: measured 52.97
                   against the list's 52 in 1.17.0, a row's drift every 50. */
                {...holdMenu}
                onPointerDown={(e) => {
                  /* A country has no category ref, so it has no stored order to
                     move within — hide and show are its whole vocabulary here. */
                  holdRow.current = {
                    title: m.label, ref: null, hidden: prefs.hidePaths.includes(m.id),
                    hide: () => toggleHiddenPath(m.id),
                  };
                  holdMenu.onPointerDown(e);
                }}
                onKeyDown={(e) => {
                  /* A country has no category ref, so it has no stored order to
                     move within — hide and show are its whole vocabulary here. */
                  holdRow.current = {
                    title: m.label, ref: null, hidden: prefs.hidePaths.includes(m.id),
                    hide: () => toggleHiddenPath(m.id),
                  };
                  holdMenu.onKeyDown(e);
                }}
                className={`pick pick-row tap w-full border-b border-rule/40 pl-3 text-left ${selectedHere ? 'is-on' : ''}`}
              >
                {flag !== null ? (
                  /*
                   * 26x18, not 18x12.
                   *
                   * A flag is read at three metres, and at 18x12 the four that
                   * matter most on this list — Belgium, Netherlands, France,
                   * Italy — are three coloured bands about four pixels wide
                   * each. They do not resolve into a country; they resolve into
                   * a smudge, which is "icons are bad". The mockup's are half as
                   * wide again as the text is tall, which is what makes the
                   * column scannable without reading a word of it.
                   *
                   * `rounded-[3px]` and a hairline ring because a flag is a
                   * rectangle of flat colour and needs an edge to sit on a dark
                   * panel at all — a white flag otherwise bleeds into nothing and
                   * a dark one disappears entirely.
                   */
                  <img
                    src={flag}
                    alt=""
                    width={26}
                    height={18}
                    loading="lazy"
                    decoding="async"
                    className="h-[1.125rem] w-[1.625rem] shrink-0 rounded-[3px] object-cover
                               ring-1 ring-black/30"
                    onError={(e) => { e.currentTarget.hidden = true; }}
                  />
                ) : null}
                <span dir="auto" className="pick-title min-w-0 flex-1 truncate">
                  <span data-marquee>{label}</span>
                </span>
                <Count>{tallyOf(m.count)}</Count>
                {nestable ? (
                  <span
                    aria-hidden
                    className={`grid w-8 shrink-0 place-items-center touch:w-10
                      ${expanded ? 'text-tally' : 'text-ink-3'}`}
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`}
                    />
                  </span>
                ) : (
                  <Slot />
                )}
              </button>

              {expanded && (
                <div className="bg-ground/40">
                  <button
                    type="button"
                    onClick={() => pickGroup(m.id, null)}
                    className={`pick pick-row pick-sub tap border-b border-rule/25 pl-8 ${activePath === null ? 'is-on' : ''}`}
                  >
                    <span className="pick-title min-w-0 flex-1 truncate">All groups</span>
                    <Count>{tallyOf(m.count)}</Count>
                    <Slot />
                  </button>
                  {groups.map((g) => {
                    const subs = childrenOf.get(g.id) ?? [];
                    const hasSubs = subs.length > 0;
                    const underHere = activePath === g.id
                      || (activePath !== null && activePath.startsWith(`${g.id}/`));
                    const pkgOpen = hasSubs && (openPkg === g.id || underHere);
                    return (
                      <div key={g.id}>
                        <div className={`pick pick-row pick-sub border-b border-rule/25 ${activePath === g.id ? 'is-on' : ''}`}>
                          <button
                            type="button"
                            onClick={() => {
                              if (hasSubs) {
                                setOpenPkg(pkgOpen && activePath === g.id ? null : g.id);
                              }
                              pickGroup(m.id, g.id);
                            }}
                            aria-expanded={hasSubs ? pkgOpen : undefined}
                            className="tap flex min-w-0 flex-1 items-center gap-1 self-stretch
                                       pl-8 text-left"
                          >
                            <span dir="auto" className="pick-title min-w-0 flex-1 truncate">
                              <span data-marquee>{g.label}</span>
                            </span>
                            <Count>{tallyOf(g.count)}</Count>
                          </button>
                          {hasSubs ? (
                            <span
                              aria-hidden
                              className={`grid w-8 shrink-0 place-items-center
                                ${pkgOpen ? 'text-tally' : 'text-ink-3'}`}
                            >
                              <ChevronDown
                                className={`h-3.5 w-3.5 transition-transform ${pkgOpen ? '' : '-rotate-90'}`}
                              />
                            </span>
                          ) : (
                            <Slot />
                          )}
                        </div>
                        {pkgOpen && subs.map((s) => {
                          const on = activePath === s.id;
                          return (
                            <div key={s.id} className={`pick pick-row pick-sub border-b border-rule/25 ${on ? 'is-on' : ''}`}>
                              <button
                                type="button"
                                onClick={() => pickGroup(m.id, s.id)}
                                className="tap flex min-w-0 flex-1 items-center self-stretch
                                           pl-12 text-left"
                              >
                                <span dir="auto" className="pick-title min-w-0 flex-1 truncate">
                                  <span data-marquee>{s.label}</span>
                                </span>
                                <Count>{tallyOf(s.count)}</Count>
                              </button>
                              <Slot />
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/*
          A query that matches nothing is a dead end on a remote, so it carries
          its own way out.

          Saying "no country matches" and leaving an empty column is honest and
          useless: the field is the only focusable thing left in the rail, there
          is nothing below it to press DOWN onto, and clearing a text box with a
          D-pad means summoning the television's keyboard to find its backspace.
          One press instead. It is a control that only exists in the state where
          there are no other controls, so it costs nothing on the way down.
        */}
        {rowCount === 0 && (
          <button
            type="button"
            onClick={clearSearch}
            className="pick pick-row tap w-full px-3 text-left"
          >
            <span className="min-w-0 flex-1 leading-snug text-ink-3">
              nothing matches “{filter}”.
              <span className="mt-0.5 block text-ink-2">Press OK to show them all.</span>
            </span>
          </button>
        )}
        </div>
      </div>
      </div>
      {rowMenu !== null && (
        <HoldMenu
          title={rowMenu.title}
          actions={[
            {
              id: 'hide',
              label: rowMenu.hidden ? 'Show this in the list again' : 'Hide this',
              hint: rowMenu.hidden
                ? 'It goes back where it was'
                : 'It moves to the bottom of this list, not out of the app',
              Icon: rowMenu.hidden ? Eye : EyeOff,
              act: () => { rowMenu.hide(); setRowMenu(null); },
            },
            ...(rowMenu.ref !== null && !rowMenu.hidden
              ? [{
                id: 'move',
                label: 'Move this',
                hint: 'Up and down carry it · OK puts it down · BACK cancels',
                Icon: ArrowUpDown,
                act: () => {
                  undoOrder.current = [...prefs.catOrder[section]];
                  setMoving(rowMenu.ref);
                  setRowMenu(null);
                },
              }]
              : []),
          ] satisfies HoldAction[]}
          onClose={() => setRowMenu(null)}
        />
      )}
    </aside>
  );
}

/**
 * The per-row hide button is gone.
 *
 * Every country and every group carried an eye that wrote to the profile's
 * hidden list, which put a destructive control one stray press from the thing it
 * would remove — on a D-pad, one column right of the row you were trying to
 * open. Hiding is a settings job and it is getting its own screen; the lists
 * here are for choosing what to watch. Nothing about hiding was removed from the
 * app: `toggleHiddenPath` is still in `lib/prefs`, the hidden list still scopes
 * every request (`hidePaths` reaches the tree, the counts and the grid), and the
 * package manager and the profile sheet still edit it.
 */
/** Shared right-rail so counts line up whether a row has a chevron or not. */
/**
 * The row counts.
 *
 * How many titles survive every OTHER filter already set. Kept compact so a 220px rail still fits the
 * label — and EMPTY at zero, via `tally`, which is why the span is still drawn
 * when there is no number in it: the counts on the rows above and below have to
 * stay in a column.
 *
 * The argument for printing the zero was that a country landing on an empty grid
 * "looks like a broken press rather than a zero". A row with no count at all
 * does not look like a broken press either, and it stops the rail offering
 * twenty invitations to nowhere at the same weight as the ones that lead
 * somewhere. See `lib/tally`.
 */
function Count({ children }: { children?: React.ReactNode }) {
  /*
   * No count, no box.
   *
   * `useTally` answers null whenever the counts setting is off — which is the
   * default — and this used to render the span anyway, so every row in every
   * list carried 12px of padding around nothing. With the arrow slot beside it
   * that was 44px of a 195px rail spent on emptiness, and it is why a name was
   * clipped with room to spare: "you see its not taking the whole row, its like
   * elepised".
   */
  if (children === null || children === undefined || children === '') return null;
  return (
    <span className="shrink-0 px-1.5 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
      {children}
    </span>
  );
}

function Slot() {
  // Must track the real buttons' width, including the touch bump, or the counts
  // stop lining up on glass.
  return <span className="w-8 shrink-0 touch:w-10" />;
}
