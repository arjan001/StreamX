/**
 * What the two lists on Live have to agree about.
 *
 * Live is two full-height lists standing side by side in the same pane row — the
 * country/group rail and the channel list — and they were written at different
 * times by different rules. Measured at the 960x540 the set-top boxes report,
 * the rail stepped 22.9px and the channels stepped 52px, so one column read as a
 * dense index and the column beside it as a menu. The owner's words: "you see,
 * they are not the same size both lists … please make the sizes consistant".
 *
 * Two lists cannot be made consistent by tuning two files. Everything here is
 * the part of that agreement that can be DECIDED rather than drawn — a pitch in
 * pixels, what a query matches, what the line under a channel name says — so it
 * is one module with a test rather than two components that happen to agree
 * today.
 *
 * All of it is pure. Nothing in here touches the DOM, the catalogue, the panel
 * or storage; `LiveSidebar` and `Live` draw what it returns.
 */
import { stripMarks, unshout } from './titleCase.ts';
import { searchKey } from '@iptv/core-xtream';
import type { FormFactor } from './formFactor.ts';
import { marketSort } from './marketOrder.ts';
import type { Section } from './api.ts';

/* ── 1. one row, one pitch ──────────────────────────────────────────────── */

/**
 * The row pitch of BOTH lists, in CSS pixels.
 *
 * A number and not a class, for the reason `docs/11-ui-rewrite.md` §10.4 gives
 * and `useGridMetrics` learned the hard way: the virtualiser positions rows by
 * pixel offset, so growing a row in CSS alone leaves every row at the wrong
 * offset and the rows overlap. In px rather than rem for the same reason —
 * a rem desyncs the instant the root font size moves, which the TV density does
 * (`html[data-density='tv']` clamps to 13px on a 960x540 box).
 *
 * The stylesheet gets the identical numbers as `--row-step`, and
 * `liveRows.test.ts` reads `index.css` and refuses to let the two drift.
 *
 * 44 on a television, down from 52, because the owner looked at 1.17.0 and said
 * "too much space for text". Measured rather than guessed, on the channel row —
 * the taller of the two, a logo beside a name over a catch-up chip and the
 * programme on now — with the two lines at line-height 1.2 and no gap between
 * them (see the row in `routes/Live.tsx`):
 *
 *   the box, 960x540 at ratio 2 (root 13px)   logo 32.5, two lines of text 28.3
 *   a desk window at 1600 (root 16px)         logo 36 (capped), text 34.4
 *   a desk window at 1920 (root 18px)         logo 36 (capped), text 38.4
 *   a desk window at 2560 (root 20px, cap)    logo 36 (capped), text 42.5
 *
 * so 44 holds every one of them without a pixel spilling into the next row, and
 * holds the box's with nearly six pixels clear above and below the logo — room
 * for the 2px inward focus ring without it drawing across the artwork. At 52 the
 * same row spilled 1px under an 18px root and 7px under 20px. The logo is capped
 * in `index.css` (`.pick-row .art`) at the step less that ring room, because the
 * step is px and the logo is rem: at a 16px root an uncapped 2.5rem logo is 40px
 * and would press both rules. The country rail steps the identical 44, hairline
 * included — measured, where 1.17.0 had it at 52.97 beside the list's 52. 48 on
 * glass keeps a finger's 44pt target with margin; 40 at a desk, where a cursor
 * needs no more.
 */
export const ROW_STEP = { tv: 44, touch: 48, desk: 40 } as const;

export function rowStep(ff: FormFactor, touch: boolean): number {
  if (ff === 'tv') return ROW_STEP.tv;
  return touch ? ROW_STEP.touch : ROW_STEP.desk;
}

/* ── 2. a search field over the rail ────────────────────────────────────── */

/** Anything the sidebar puts on a row and can be searched by. */
export interface SidebarRow {
  id: string;
  label: string;
  /**
   * Labels nested under this row, when it is a country that can be opened.
   *
   * Typing "sport" has to find the country whose SPORTS package is the thing
   * being looked for, or the field only works for people who already know which
   * country a package belongs to — which is the whole reason they are searching.
   */
  under?: readonly string[];
}

/**
 * The query, folded once.
 *
 * `searchKey` is the app's own folding (`@iptv/core-xtream`): case, accents and
 * punctuation all go, so "quebec" finds Québec and "uk|sky" finds `UK/SKY`.
 * Exported because the caller folds each row's text once per render and this has
 * to be the same function on both sides of the comparison.
 */
export function fold(text: string | null | undefined): string {
  return searchKey(text);
}

export function matchesQuery(row: SidebarRow, folded: string): boolean {
  if (folded === '') return true;
  if (fold(row.label).includes(folded)) return true;
  if (fold(row.id).includes(folded)) return true;
  return (row.under ?? []).some((u) => fold(u).includes(folded));
}

/** Rows a query leaves standing, in the order they were given. */
export function filterSidebar<T extends SidebarRow>(
  rows: readonly T[],
  query: string,
  /**
   * Rows whose CONTENTS match, even though nothing about their name does.
   *
   * The tree's half of "it should check both channals as well as categories":
   * a country stays on screen when a channel inside it matches, so typing
   * "discovery" narrows the rail to the countries that have one rather than
   * emptying it.
   */
  childMatches: ReadonlySet<string> = new Set(),
): T[] {
  const folded = fold(query);
  if (folded === '') return [...rows];
  return rows.filter((r) => matchesQuery(r, folded) || childMatches.has(r.id));
}

/* ── 3. groups, or the provider's own list of everything ────────────────── */

/**
 * How the rail is shaped: a tree of countries, or every category at once.
 *
 * Asked for as "i want you to add a seeetings where if they wanna see it as
 * groups or if they wanna see it as list all of it", and the competitor's own
 * sidebar is the clearest statement of what "list" means: no country level at
 * all, just `VM | SPORTS 73`, `UK | FREE TO AIR 111` one after another with
 * their counts down the right.
 *
 * `groups`, the tree the rail always was, is the default. It was `list` from
 * 1.18.0 — "by default make it a list mode instead of groups", said the day the
 * setting shipped — until 2026-10-01: "instead countries its showing
 * categories", about a rail of "UKF General", "UKF Religious"… with no country
 * in sight.
 * Nothing is hidden in `list`: every category the tree is built from is a row,
 * under the provider's own name and with its own count. It writes a `category`
 * into the address where the tree writes a path, and every list that filters —
 * the channel list, the poster grid — reads both. See `listRows`.
 *
 * Declared here rather than in `lib/prefs` because it is a statement about how
 * these two lists are drawn, which is what this module is; `prefs` imports it
 * and wires the pref around it the way it wires `openStyle`.
 */
export type BrowseStyle = 'groups' | 'list';

export const BROWSE_STYLES: BrowseStyle[] = ['groups', 'list'];

/** Anything unrecognised is the default, the list. See `adoptedBrowseStyle` in
    prefs for the once-only rule that reaches devices which saved `groups` while it
    was the default. */
export function readBrowseStyle(v: unknown): BrowseStyle {
  return typeof v === 'string' && (BROWSE_STYLES as string[]).includes(v)
    ? (v as BrowseStyle)
    : 'list';
}

/**
 * What the standing row says when nothing is picked — Favourites and a
 * category aside, this is what BOTH `Live` and `LiveSidebar` fall back to.
 *
 * Reported as the heading and the sidebar disagreeing: with list mode the
 * default since 1.18.0, the sidebar's standing row reads "All channels"
 * (`flat`) while the heading over the channel list, built as a `Live.tsx`
 * literal that never looked at `browseStyle` at all, kept saying "All
 * countries" underneath it — correct only in tree mode, which stopped being
 * the default a release earlier. One function so a THIRD place cannot say a
 * third thing.
 *
 * `channels` for the same reason `LiveSidebar`'s own local of the same name
 * exists: the tree's depth-1 row is a COUNTRY for channels and a
 * language/provider group for films and series, so the word has to follow the
 * section or a correct list reads as a broken one.
 */
export function standingLabel(flat: boolean, channels: boolean): string {
  return flat
    ? (channels ? 'All channels' : 'All titles')
    : (channels ? 'All countries' : 'All groups');
}

/**
 * A list row's name, laid out: the market as a tag, the rest set properly.
 *
 * Two requests, a release apart, and both kept. 1.17.0: "in list mode, no need
 * to filter the names at all, if country is nl | category | movie just show it
 * like that" — the country and the structure are the viewer's landmarks. Then:
 * "read all types of categories and titles, I want you to format them well" —
 * "UK| MC VIDEO ᴴᴰ" in capitals with a tier mark is not a landmark, it is noise.
 * So nothing is dropped: the market leads as a tag, every further field stays
 * (joined by a dot rather than a pipe), and only the capitals and the marks go.
 * Search still reads the raw name (`filterSidebar`), so a query typed the way
 * the panel spells it still finds the row.
 */
export function listLabel(raw: string): { market: string | null; name: string } {
  const m = /^\s*\|?\s*([A-Z0-9+]{2,6})\s*\|\s*(.+)$/.exec(raw);
  const market = m === null ? null : m[1]!;
  const rest = (m === null ? raw : m[2]!)
    .split('|').map((p) => p.trim()).filter((p) => p !== '').join(' · ');
  const name = unshout(stripMarks(rest)) || raw.trim();
  return { market, name };
}

/** A row of the list shape: one provider category, named as the provider names it. */
export interface ListRow {
  /** The category's id — what `categoryId` filters the grid and the channels by. */
  id: number;
  /** The stable ref (`<kind>.<provider id>`), which is what an order is stored as. */
  ref: string;
  /** EXACTLY the panel's `category_name`: "NL | CATEGORY | MOVIE", untouched. */
  label: string;
  count: number;
  /**
   * Hidden by the viewer, and therefore at the BOTTOM of this same list.
   *
   * It used to leave the list entirely and be recoverable only from Settings →
   * Organise, which is the arrangement the owner threw out: "can u not say hide
   * from this list and put in bottom in like hidden list, they find settings to
   * complicated … as 100 users a day explaining". So a hidden row is still a row
   * — dimmed, last, and one press from coming back.
   */
  hidden: boolean;
  /**
   * The viewer put this row where it is, so nothing may re-sort it.
   *
   * Market ranking is a default for a list nobody has arranged. Once somebody
   * moves a row, the arrangement they can see is the truth — "so its like when
   * they select the option to move it they can move it anywhere" — and a row
   * they placed must not spring back under its country the moment it repaints.
   */
  placed: boolean;
}

/** The part of a category this needs — structurally a subset of `Category`. */
export interface ListSource {
  id: number;
  /** `<kind>.<provider id>` — the id an order and a hidden list are stored as. */
  ref?: string;
  name: string;
  count: number;
  /** Market / package / group, e.g. `['EN', 'NEWS']` — `Category.path`'s own
      shape. Depth 1 is the market a row is grouped and ranked by; absent or
      empty means the row has none and sorts after every market that does. */
  path?: string[];
}

/**
 * Every category the section offers, as the provider named it — grouped by
 * market, the markets in rank order.
 *
 * This was `flatGroups`: the group TREE flattened into friendly paths —
 * "Germany › Anime Serien", "English › Anime" — which is the app's own reading
 * of the names, one step removed from the thing the viewer has seen in every
 * other player. The owner, on 1.17.0: "please in list mode, no need to filter
 * the names at all, i mean if country is nl | category | movie just show it like
 * that". So a row still says exactly what the panel says.
 *
 * The ROWS kept that rule; the ORDER did not. A flat list in the provider's own
 * category order interleaves markets — a photo of 1.19.1's list mode came back
 * reading US| PARAMOUNT+ PPV, NL| ODIDO VERMAAK, NL| RADIO LIVE, US|
 * ENTERTAINMENT, … UK| NOW TV, US| TUBI, the provider's raw order, with the
 * owner's own words on it: "please at least fix the order always for show UK
 * then others UK and other Europe countries after it and then so on and order
 * it properly because right now it's mixed". So rows are grouped by the market
 * their path starts with (`path[0]`, per `Category.path`'s own doc — "Depth 1
 * IS the market") and the groups are ordered by `marketSort` — the same rank
 * `lib/marketOrder.ts` gives the groups-mode tree, so a viewer sees the same
 * United-Kingdom-then-Europe-then-the-rest order whichever way they browse.
 * WITHIN one market nothing changes: categories keep the order they arrived
 * in, which is the provider's, or the viewer's own package order once
 * `useCategories` has applied `Prefs.catOrder` — grouping only ever moves which
 * MARKET a row sits under, never its neighbours inside that market. A category
 * with no market (`path` absent or empty) sorts after every real one, rather
 * than joining whichever market happens to rank last today.
 *
 * Two rules beyond the grouping, both about what is a destination rather than
 * how it is named:
 *
 *   - nothing behind it, no row — the rail already refuses a destination with
 *     nothing in it, and the count is the category's own;
 *   - the field over the rail matches the RAW name, through the app's folding,
 *     so "sky sports" finds `UK| SKY SPORTS` whatever its pipes and spacing —
 *     and only removes rows, never reorders the ones left (`fold`/`matchesQuery`
 *     do the same for the tree; see `filterSidebar`).
 *
 */
export function listRows(
  categories: readonly ListSource[],
  query: string,
  order: string[] = [],
  section?: Section,
  /**
   * Refs the viewer has arranged and refs the viewer has hidden.
   *
   * `categories` arrives already in `catOrder` (`useCategories` applies it), so
   * a placed row is simply one this must not re-group: it keeps the position it
   * came in with, ahead of everything the market ranking still decides. Hidden
   * refs fall to the bottom whatever else is true of them.
   */
  arranged: { placed?: ReadonlySet<string>; hidden?: ReadonlySet<string> } = {},
  /**
   * Categories whose CONTENTS match the query, even though their name does not.
   *
   * "when you search ontop of the countries or catyeogies, it should check both
   * channals as well as categories, and then show those categorites with that
   * keyword as well as those categories that its children has it". Typing
   * "discovery" over the rail matched no package on this provider and emptied
   * the column, while six packages carried a Discovery channel each.
   *
   * Passed in rather than computed here because this module is pure and the
   * answer comes from the catalogue; `LiveSidebar` reads it.
   */
  childMatches: ReadonlySet<number> = new Set(),
): ListRow[] {
  const placed = arranged.placed ?? new Set<string>();
  const hiddenRefs = arranged.hidden ?? new Set<string>();
  const live = categories.filter((c) => c.count > 0);

  /* One entry per market, sized by every live category under it — not only the
     ones a search leaves standing, or a market's rank would jump around as
     somebody typed a query. `marketSort` is the same function the groups-mode
     tree ranks with; this is the list-mode equivalent of `useMarkets`'
     category-prefix fallback, built from the same `path[0]`. */
  const totals = new Map<string, number>();
  for (const c of live) {
    const market = c.path?.[0] ?? null;
    if (market !== null) totals.set(market, (totals.get(market) ?? 0) + c.count);
  }
  const rank = new Map(
    marketSort([...totals].map(([id, count]) => ({ id, count })), order, section)
      .map((m, i) => [m.id, i] as const),
  );
  /* No market at all ranks after every real one — see the doc comment above. */
  const NO_MARKET = rank.size;

  /* Stable on purpose: two categories under the same market keep the order
     they arrived in, and `Array.prototype.sort` is guaranteed stable, but the
     explicit index tie-break says so rather than leaning on the spec. */
  /*
   * Three bands, in this order: what the viewer arranged, what the market rank
   * decides, and what the viewer hid. A row cannot be in two of them — hidden
   * wins over placed, because a hidden row is not on the list you arranged.
   */
  const bandOf = (c: ListSource): number => {
    const ref = c.ref ?? '';
    if (ref !== '' && hiddenRefs.has(ref)) return 2;
    if (ref !== '' && placed.has(ref)) return 0;
    return 1;
  };
  const withRank = live.map((c, i) => {
    const market = c.path?.[0] ?? null;
    const band = bandOf(c);
    return {
      c,
      i,
      band,
      /* A placed or hidden row keeps the order it arrived in — only the middle
         band is ranked by market. */
      r: band === 1 && market !== null ? (rank.get(market) ?? NO_MARKET) : NO_MARKET,
    };
  });
  withRank.sort((a, b) => (a.band - b.band) || (a.r - b.r) || (a.i - b.i));

  const folded = fold(query);
  const out: ListRow[] = [];
  for (const { c, band } of withRank) {
    if (folded !== '' && !fold(c.name).includes(folded) && !childMatches.has(c.id)) continue;
    out.push({
      id: c.id,
      ref: c.ref ?? '',
      label: c.name,
      count: c.count,
      hidden: band === 2,
      placed: band === 0,
    });
  }
  return out;
}

/* ── 4. the line under a channel name ───────────────────────────────────── */

/** What is known about one channel, from the row and from the stored guide. */
export interface ChannelBrief {
  /** The programme on air, when this device already holds listings for it. */
  now?: string | null;
  /** `archive` on the item row — the panel says this channel keeps recordings. */
  archive: boolean;
  archiveDays: number;
}

export interface SecondLine {
  /** The programme on now, or null when the device holds no listings for it. */
  now: string | null;
  /** How many days of catch-up, or null when there is no reachable archive. */
  catchUpDays: number | null;
}

/**
 * What goes under the channel name.
 *
 * Asked for as "if any channal has any catchups show it below its name", beside
 * the competitor's own list, whose every channel row carries a second line.
 *
 * Three honest states, and they are the same three `NowNext` already draws under
 * the picture — which is deliberate, because a channel that says CATCH-UP in the
 * list and offers no catch-up when it opens is worse than a list with no second
 * line at all:
 *
 *   - listings   → the programme on now
 *   - an archive → CATCH-UP, with the window in days
 *   - both       → both, catch-up first because it is the shorter fact
 *   - neither    → nothing, and the ROW DOES NOT CHANGE HEIGHT. The pitch is
 *     decided once (`ROW_STEP`) and a row with one line is the same height as a
 *     row with two; a list that breathes as you scroll past a channel the guide
 *     happens to cover is the thing this was meant to fix.
 *
 * `archiveDays > 0` is required, and matches `NowNext`'s `hasArchive`: the panel
 * flags channels with a zero-day window, and the old right-hand chip in the list
 * printed those as "0d" — a badge for a destination with nothing behind it.
 */
export function secondLine(b: ChannelBrief): SecondLine {
  const title = typeof b.now === 'string' ? b.now.trim() : '';
  return {
    now: title === '' ? null : title,
    catchUpDays: b.archive && b.archiveDays > 0 ? b.archiveDays : null,
  };
}

export function hasSecondLine(line: SecondLine): boolean {
  return line.now !== null || line.catchUpDays !== null;
}

/* ── 5. reading the stored guide without asking for more of it ──────────── */

/**
 * The block of rows a guide read covers, from the window the virtualiser reports.
 *
 * The channel list reports a new visible range on every frame of a scroll. Keying
 * a guide read on that range directly is a fresh read of the device's IndexedDB
 * per frame; quantising it to a block means a flick through a hundred channels is
 * two or three reads, and standing still is none.
 *
 * Deliberately NOT a fetch of any kind. The stored guide is whatever the device
 * already collected for the channels it has opened and for the Guide screen it
 * has visited — asking the panel per row is how a household's address gets
 * flood-blocked (see `lib/localEpg.ts`), so this list reads the cache and shows
 * what is in it.
 */
export const EPG_BLOCK = 40;

export function epgBlock(start: number, end: number, size: number = EPG_BLOCK): {
  from: number; to: number;
} {
  const lo = Math.max(0, Math.floor(Math.min(start, end)));
  const hi = Math.max(lo, Math.floor(Math.max(start, end)));
  const from = Math.floor(lo / size) * size;
  const to = (Math.floor(hi / size) + 1) * size - 1;
  return { from, to };
}
