import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Clapperboard, Eye, RotateCcw, Star, Tv, Tv2 } from 'lucide-react';
import { Organiser, RowButton, organiserColumns } from '../components/Organiser';
import { Poster } from '../components/Poster';
import { displayName } from '../lib/displayName';
import { localAllItems, localItem } from '../lib/localRead';
import { moveFav, setPrefs, toggleFav, usePrefs } from '../lib/prefs';
import { columnArrow } from '../lib/columns';
import { isTypingTarget, useKeyLayer, type Binding } from '../lib/keys';
import type { Item, Section } from '../lib/api';

/**
 * Organise: what this television is allowed to show.
 *
 * ── what it replaces ──
 *
 * Profiles. Asked for as "replace the whole current profile with single profile
 * and that area" — and the app is better for it. A profile was a set of
 * countries plus a list of hidden groups, wrapped in machinery for having
 * several of them: create, rename, duplicate, delete, switch, and a landing
 * screen asking who is watching before anybody could watch anything. On a
 * television in one living room that machinery answered a question nobody was
 * asking. There is one set of choices now, it belongs to the device, and this is
 * the screen where it is made.
 *
 * Nothing that the carving DOES was removed — countries, packages, categories,
 * individual channels, the order they appear in, and what is hidden are the same
 * settings the rest of the app already reads. What went is being asked which
 * person's copy of them to use.
 *
 * ── the shape ──
 *
 * Sections down the left, the open one on the right, which is now the shape of
 * every menu in this app: settings, the player, and this. On a D-pad the left
 * column is the state — you can see what you are in, what else there is, and
 * Left always goes back to the list.
 *
 * ── the pane has no heading, on purpose ──
 *
 * `scripts/density-probe.mjs` measured this screen at 86 words of prose in the
 * first screenful, 171px of it, on a 720px television — the worst screen in the
 * app after /home. Reported as "there is too many text and too many information
 * and everything is cramped, spaces are wasted and nothing works properly, I
 * cannot see the countries or packages and channels".
 *
 * Four of those five paragraphs were overhead above the list: a heading (3w), a
 * 51-word intro that explained what the buttons underneath already say, and a
 * 25-word note in the empty right-hand column. All of it sat between the top of
 * the screen and the country list, which is the one thing this screen exists to
 * show.
 *
 * So the heading is gone: the sidebar row beside it is lit, in tally, at the
 * same height — a title repeating it is a title nobody reads twice. The intro is
 * gone: every verb it described is a button in the action bar that names itself
 * on focus. The heading survives for a screen reader only (`sr-only`), which is
 * the one audience that cannot see the lit row.
 *
 * ── why there is no Countries section ──
 *
 * There was, and it was the first thing in the list: a pane of tick boxes with
 * a search and a count beside every name, lifted out of the deleted setup
 * wizard. It lasted one afternoon. "the channals and countries are the saame
 * thing" — and they are, because the left column of the two-grid below IS the
 * country list, with the same names, counts, order and hide. Two screens for
 * one set of choices is two places to make a choice the other one contradicts.
 *
 * So the country list is the tree, and everything the pane had that the tree
 * did not — the search, the count line, the default-order reset, and the
 * positive "I only watch these three" selection — moved into it. See the head
 * of `components/Organiser.tsx`.
 */

/**
 * What has been hidden, and the way back.
 *
 * The trap this closes is the one every filter screen has: hiding something with
 * no list of what is hidden leaves the only way back as "clear everything". Both
 * kinds are here — a package hidden from the sections above, and a channel
 * hidden from inside one — and a channel is named by asking the catalogue for
 * its stable ref, falling back to the id on a device that no longer holds it.
 *
 * The pane's own heading and its 14-word note are gone with the rest of this
 * screen's prose: the sidebar row says Hidden, and each group below names itself
 * and counts itself. See the density note at the head of this file.
 */
function Hidden() {
  const [prefs] = usePrefs();
  const packages = prefs.hideCatRefs;
  const channels = prefs.hideStreams;
  const paths = prefs.hidePaths;
  const nothing = packages.length + channels.length + paths.length === 0;

  const name = (streamId: number): string => {
    const row = localItem(`1.${streamId}`);
    return row === null ? `channel ${streamId}` : displayName(row.name);
  };

  return (
    <div className="min-h-0">
      {/* The one audience that cannot see the lit sidebar row. */}
      <h2 className="sr-only">Hidden</h2>

      {nothing && (
        <p className="font-mono text-[length:var(--t-xs)] text-ink-3">Nothing is hidden.</p>
      )}

      {packages.length > 0 && (
        <>
          <p className="mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
            Packages · {packages.length}
          </p>
          <div className="mb-4 space-y-px">
            {packages.map((ref) => (
              <button
                key={ref}
                onClick={() => setPrefs({ hideCatRefs: packages.filter((x) => x !== ref) })}
                className="tap flex w-full items-center justify-between gap-2 bg-ground/60 px-3 py-1.5
                           text-left font-mono text-[length:var(--t-xs)] text-ink-2 hover:text-tally"
              >
                <span className="truncate">{ref}</span>
                <Eye className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))}
          </div>
        </>
      )}

      {channels.length > 0 && (
        <>
          <p className="mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
            Channels · {channels.length}
          </p>
          <div className="mb-4 space-y-px">
            {channels.map((id) => (
              <button
                key={id}
                onClick={() => setPrefs({ hideStreams: channels.filter((x) => x !== id) })}
                className="tap flex w-full items-center justify-between gap-2 bg-ground/60 px-3 py-1.5
                           text-left font-mono text-[length:var(--t-xs)] text-ink-2 hover:text-tally"
              >
                <span className="truncate">{name(id)}</span>
                <Eye className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))}
          </div>
        </>
      )}

      {paths.length > 0 && (
        <>
          <p className="mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
            Groups · {paths.length}
          </p>
          <div className="mb-4 space-y-px">
            {paths.map((p) => (
              <button
                key={p}
                onClick={() => setPrefs({ hidePaths: paths.filter((x) => x !== p) })}
                className="tap flex w-full items-center justify-between gap-2 bg-ground/60 px-3 py-1.5
                           text-left font-mono text-[length:var(--t-xs)] text-ink-2 hover:text-tally"
              >
                <span className="truncate">{p.replace(/\//g, ' › ')}</span>
                <Eye className="h-3.5 w-3.5 shrink-0" />
              </button>
            ))}
          </div>
        </>
      )}

      {!nothing && (
        <button
          onClick={() => setPrefs({ hideCatRefs: [], hideStreams: [], hidePaths: [], hideCats: [] })}
          className="tap flex items-center gap-2 border border-rule px-3 py-2 font-mono
                     text-[length:var(--t-2xs)] text-ink-2 transition-colors hover:border-tally hover:text-tally"
        >
          <RotateCcw className="h-3.5 w-3.5" /> SHOW EVERYTHING AGAIN
        </button>
      )}
    </div>
  );
}

/**
 * The bouquet: the channels a viewer starred, in the order they want them.
 *
 * "in the TV menu you only navigate through that bouquet, via its EPG" — the
 * Guide and Live's Favourites view already do that (`lib/prefs.ts`
 * `Favourites`, `moveFav`); this is where the order is MADE. It orders and it
 * removes. It does not add.
 *
 * Adding is deliberately not here. `components/Organiser.tsx`'s channel list
 * (the right-hand column of "Countries & channels") already stars a channel —
 * the same STAR control this screen's own rows show as filled — so a second
 * picker here would be two places offering one action, which is exactly the
 * mistake the deleted Countries pane was (see the head of `components/
 * Organiser.tsx`). This screen links to that one instead of rebuilding it.
 *
 * ── the reorder interaction is the one this app already has ──
 *
 * Two `RowButton`s per row, moving one step at a time — the same control and
 * the same one-row-at-a-time idea `Organiser` already uses for a country or a
 * package (`moveCat`/`moveTarget`, `ChevronUp`/`ChevronDown`). The difference
 * is `navSkip={false}`: the tree hides these from the D-pad because Right has
 * to reach the column beside it, and a flat list has no column beside it, so
 * nothing here needs to be out of the remote's path.
 *
 * ── focus, after a move or a removal ──
 *
 * A move never touches focus at all: each row is keyed by its channel's
 * stream id, so reordering the array reorders where React puts that row's
 * existing DOM node — the same button the remote was just standing on — and
 * the browser's focus stays attached to it for free. A removal is the one
 * case a node actually disappears, so that one refocuses the row that takes
 * its place explicitly, in `remove` below.
 */
function MyChannels() {
  const [prefs] = usePrefs();
  const favIds = prefs.favs.live;
  const listEl = useRef<HTMLDivElement | null>(null);

  /*
   * Unclamped, like `Hidden` above.
   *
   * `localItems` is a PAGE and the store caps a page at 200 — fine for a
   * browsing list, dishonest for a screen whose whole job is "here is your
   * entire bouquet". Favourites are bounded in practice, so reading all of
   * them and laying them out by hand is cheap — the same move
   * `routes/Guide.tsx` already makes for its own bouquet, for the same
   * reason: the catalogue's `streamIds` filter is a SET, not a sort key for
   * "the order I starred them in".
   */
  const items = useMemo(() => {
    if (favIds.length === 0) return [];
    const order = new Map(favIds.map((id, i) => [id, i]));
    return localAllItems('live', { streamIds: favIds })
      .filter((it): it is Item & { streamId: number } => it.streamId !== null)
      .sort((a, b) => (order.get(a.streamId) ?? 0) - (order.get(b.streamId) ?? 0));
  }, [favIds]);

  const move = (streamId: number, dir: -1 | 1): void => {
    const from = items.findIndex((it) => it.streamId === streamId);
    if (from < 0) return;
    moveFav('live', streamId, from + dir);
  };

  /** Removing is the one case a row's own DOM node actually goes away. */
  const remove = (streamId: number): void => {
    const from = items.findIndex((it) => it.streamId === streamId);
    const nextId = items[from + 1]?.streamId ?? items[from - 1]?.streamId ?? null;
    toggleFav('live', streamId);
    if (nextId === null) return;
    requestAnimationFrame(() => {
      listEl.current?.querySelector<HTMLElement>(`[data-stream-id="${nextId}"] button`)?.focus();
    });
  };

  const browseLink = (
    <Link to="/organise?s=live" className="text-tally underline-offset-2 hover:underline">
      Countries &amp; channels
    </Link>
  );

  if (items.length === 0) {
    return (
      <div className="min-h-0">
        <h2 className="sr-only">My channels</h2>
        <p className="font-mono text-[length:var(--t-xs)] leading-relaxed text-ink-3">
          Star a channel to keep it here. Hold OK — or press the remote's STAR
          key — on a row in Live, or star one from {browseLink}.
        </p>
      </div>
    );
  }

  return (
    <div ref={listEl} className="min-h-0">
      <h2 className="sr-only">My channels</h2>
      <p className="mb-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
        {items.length} channel{items.length === 1 ? '' : 's'} · this is the order Live and the Guide use
      </p>
      <div className="mb-3 space-y-px">
        {items.map((item) => {
          const name = displayName(item.name);
          return (
            <div
              key={item.streamId}
              data-stream-id={item.streamId}
              className="pick pick-row gap-2 border-b border-rule/40 pr-1"
            >
              <Poster src={item.logo} alt={name} ratio="logo" fit="contain" />
              <span dir="auto" className="pick-title min-w-0 flex-1 truncate">
                {name}
              </span>
              <RowButton navSkip={false} label={`Move ${name} up`} onClick={() => move(item.streamId, -1)}>
                <ChevronUp className="h-4 w-4" />
              </RowButton>
              <RowButton navSkip={false} label={`Move ${name} down`} onClick={() => move(item.streamId, 1)}>
                <ChevronDown className="h-4 w-4" />
              </RowButton>
              <RowButton navSkip={false} on label={`Remove ${name} from My channels`}
                         onClick={() => remove(item.streamId)}>
                <Star className="h-4 w-4 fill-current" />
              </RowButton>
            </div>
          );
        })}
      </div>
      <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">
        Star more from {browseLink}.
      </p>
    </div>
  );
}

export function Organise() {
  const [params, setParams] = useSearchParams();
  const [prefs] = usePrefs();

  /* State, not prose: the one hint left in this rail counts what is behind the
     row it sits under, which is the only thing a viewer cannot see from here. */
  const hiddenCount = prefs.hideCatRefs.length + prefs.hideStreams.length + prefs.hidePaths.length;
  const favCount = prefs.favs.live.length;

  /*
   * The hints under Countries & channels, Films and Series are gone — "and
   * their packages", "packages", "packages". A television reads a rail of
   * five rows in one glance; a second line under each one is five more lines
   * to read and it repeated the label above it. `Films` is films. My channels
   * and Hidden keep theirs because a COUNT is the one thing this rail cannot
   * otherwise say — how much is behind a row is exactly what is not visible
   * from here.
   */
  const sections = [
    { id: 'live', label: 'Countries & channels', hint: '', Icon: Tv },
    { id: 'mychannels', label: 'My channels', hint: favCount === 0 ? '' : `${favCount} starred`, Icon: Star },
    { id: 'movies', label: 'Films', hint: '', Icon: Clapperboard },
    { id: 'series', label: 'Series', hint: '', Icon: Tv2 },
    { id: 'hidden', label: 'Hidden', hint: hiddenCount === 0 ? '' : `${hiddenCount} hidden`, Icon: Eye },
  ] as const;

  const wanted = params.get('s');
  const current = sections.find((x) => x.id === wanted) ?? sections[0];

  /* What is open lives in the URL, so a section is a place: it survives a
     reload, a link can point at one, and BACK leaves the screen rather than
     walking back through every section that was looked at. */
  useEffect(() => {
    if (wanted !== current.id) setParams({ s: current.id }, { replace: true });
  }, [wanted, current.id, setParams]);

  /* The three sections whose pane is the two-grid rather than a list. */
  const grid = current.id === 'live' || current.id === 'movies' || current.id === 'series';

  const navEl = useRef<HTMLElement | null>(null);
  const paneEl = useRef<HTMLDivElement | null>(null);
  const openEl = useRef<HTMLButtonElement | null>(null);

  /* The arrows, on a screen made of two columns. See lib/columns.ts for why the
     general geometry cannot answer this one. */
  const bindings = useMemo((): Binding[] => [], []);
  useKeyLayer(bindings, (intent) => {
    if (intent !== 'up' && intent !== 'down' && intent !== 'left' && intent !== 'right') return false;
    /* A text field keeps its own left and right: the caret and the word being
       typed matter more than the columns. Up and Down still leave the field. */
    if (isTypingTarget(document.activeElement) && (intent === 'left' || intent === 'right')) return false;
    /*
      Three columns on the package sections, two everywhere else.
      The tree and its contents are inside the pane, so they are found through
      it rather than held as refs of their own — the pane is keyed on the
      section and remounts, and a ref captured before that points at a detached
      element.
    */
    const { tree, inside, here } = grid
      ? organiserColumns(paneEl.current, current.id as Section)
      : { tree: null, inside: null, here: null };
    return columnArrow(intent, [
      { el: navEl.current, entry: openEl.current },
      ...(tree !== null ? [{ el: tree, entry: here }] : []),
      ...(inside !== null ? [{ el: inside }] : []),
      ...(tree === null ? [{ el: paneEl.current }] : []),
    ], { entryFromAbove: true });
  });

  return (
    <div className="flex h-full min-h-0">
      <nav
        ref={navEl}
        /* A section as well as a group: the group gives it memory, and the
           section is what stops UP out of its first row crossing into the pane
           beside it instead of climbing to the header. */
        data-nav-scope
        data-nav-group="organise"
        data-nav-memory
        /* `no-round` and `.pick` for the same reason the settings rail has them:
           these two screens are the same shape and a viewer moving between them
           should not be able to tell which one they are on from the rail. */
        className="no-round flex h-full min-h-0 w-[13rem] shrink-0 flex-col overflow-y-auto border-r border-rule
                   bg-panel/40 py-4 tv:w-[20rem] tv:py-6"
      >
        <p className="mb-2 px-4 font-mono text-[length:var(--t-2xs)] uppercase tracking-widest text-ink-3 tv:px-6">
          Organise
        </p>
        {sections.map(({ id, label, hint, Icon }) => {
          const on = id === current.id;
          return (
            <button
              key={id}
              ref={on ? openEl : undefined}
              type="button"
              onClick={() => setParams({ s: id }, { replace: true })}
              aria-current={on ? 'page' : undefined}
              className={`pick tap gap-3 px-4 py-2.5 tv:gap-4 tv:px-6 tv:py-3.5 ${on ? 'is-on' : ''}`}
            >
              <Icon className={`h-4 w-4 shrink-0 tv:h-5 tv:w-5 ${on ? 'text-tally' : 'text-ink-3'}`} />
              <span className="min-w-0 flex-1">
                <span className="pick-title block text-[length:var(--t-md)] tv:text-[length:var(--t-lg)]">
                  {label}
                </span>
                {hint !== '' && (
                  <span className="block truncate font-mono text-[length:var(--t-2xs)] text-ink-3 tv:text-[length:var(--t-xs)]">
                    {hint}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </nav>

      <div
        key={current.id}
        ref={paneEl}
        data-nav-scope
        tabIndex={-1}
        /*
         * The grid pane is padded tighter than the reading pane, and it is the
         * whole point of the screen.
         *
         * At `py-7` on a television the two-grid gave 56px of its height to
         * white space it does not use — the box has its own border and its two
         * columns scroll inside themselves, so the room around it is room the
         * country list is not getting. Hidden is a page of rows that IS read
         * across a room, so it keeps the wider frame.
         */
        className={`anim-fade min-h-0 min-w-0 flex-1 outline-none
          ${grid ? 'overflow-hidden px-3 py-3 tv:px-6 tv:py-4' : 'overflow-y-auto px-5 py-4 tv:px-10 tv:py-7'}`}
      >
        <div className={`mx-auto flex h-full w-full flex-col
          ${current.id === 'hidden' || current.id === 'mychannels' ? 'max-w-3xl tv:max-w-5xl' : ''}`}>
          {current.id === 'hidden' && <Hidden />}
          {current.id === 'mychannels' && <MyChannels />}
          {grid && (
            /* The two-grid: the tree on the left of the pane, and whatever is
               inside the focused row on its right. One section at a time, chosen
               in the sidebar rather than by a second row of tabs inside the pane. */
            <Organiser
              section={current.id as Section}
            />
          )}
        </div>
      </div>
    </div>
  );
}
