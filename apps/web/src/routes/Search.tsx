import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, Film, Layers, Search as SearchIcon, Tag, Tv, Tv2, User } from 'lucide-react';
import { Poster } from '../components/Poster';
import { HScroll } from '../components/HScroll';
import { useKeyLayer, type Binding } from '../lib/keys';
import { focusFirst } from '../lib/spatialNav';
import { api, linkId, type Item } from '../lib/api';
import { displayName } from '../lib/displayName';
import { artworkAt } from '../lib/artwork';
import { warmSearchIndex } from '../lib/searchIndex';
import { sectionForPath } from '../lib/sections';
import { listArt } from '../lib/listArt';
import { typingDelay } from '../lib/typingDelay';
import { useOkToType } from '../lib/okToType';
import { localSearchSuggestions } from '../lib/localRead';
import {
  filterByGenres, filterByPeople, itemCategoryLabel, itemSearchBlurb,
  searchFacets, type SearchGenre, type SearchPerson,
} from '../lib/searchFacets';
import {
  effectiveScope, facetsApply, hitsInScope, scopeChips, scopeOnArrival, scopeRowWorthShowing,
  type Scope,
} from '../lib/searchScope';
import { personPortraits } from '../lib/personPortraits';
import { ensureEpgIndex, rankProgrammes, type ProgrammeHit } from '../lib/epgSearch';
import { getPrefs } from '../lib/prefs';
import { useCategories } from '../lib/groups';
import { useScope } from '../lib/scope';
import { categoryHits } from '../lib/categoryHits';

type Kind = 'live' | 'movies' | 'series';

interface Hit {
  kind: Kind;
  item: Item;
  href: string;
}

/**
 * A programme-search row, alongside a catalogue `Hit` rather than folded into
 * it: a programme is not a catalogue row, it is a title found in the on-device
 * guide (`lib/epgSearch.ts`), and it carries its own channel/time/state fields
 * instead of an `Item`. `item` is a structural placeholder — see `ScopedHit` in
 * `lib/searchScope.ts` — so this still slots into the same `hitsInScope` /
 * `scopeChips` / `effectiveScope` machinery every other kind goes through.
 */
interface OnTvHit {
  kind: 'ontv';
  /** No honest `archive` bit of its own — see `ScopedHit` in `searchScope.ts`. */
  item: { archive?: boolean };
  href: string;
  programme: ProgrammeHit;
}

/** What the chip row, the count and the block ordering all operate on. */
type SearchHit = Hit | OnTvHit;

function kindLabel(k: Kind): string {
  if (k === 'live') return 'Live';
  if (k === 'movies') return 'Movie';
  return 'Series';
}

function hrefOf(kind: Kind, item: Item): string {
  if (kind === 'live') return `/live?ch=${item.id}`;
  if (kind === 'movies') return `/movie/${linkId(item)}`;
  return `/series/${linkId(item)}`;
}

function metaBits(kind: Kind, item: Item): string[] {
  const bits: string[] = [];
  if (item.year !== null && item.year !== '') bits.push(item.year);
  const cat = itemCategoryLabel(item);
  if (cat !== null) bits.push(cat);
  else bits.push(kindLabel(kind));
  if (item.rating !== null) bits.push(item.rating.toFixed(1));
  return bits;
}

function listParam(params: URLSearchParams, key: string): string[] {
  return params.getAll(key).map((v) => v.trim()).filter((v) => v.length > 0);
}

/** One array, so a scope that ignores the facet picks does not churn the memos. */
const NO_FACETS: string[] = [];
/** Same reason: no programme hits yet (index still building, or too short a
 *  query) must not be a fresh array every render. */
const EMPTY_ONTV: OnTvHit[] = [];

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const from = params.get('from');
  const scopePressed = params.get('scope') !== null;
  const arrivalScope = scopeOnArrival(params.get('scope'), from);
  /*
   * The cast and category picks only exist where there are titles to apply them
   * to. Under Live or Catch-up the rows that offer them are not on screen, so
   * the picks are not in force either — otherwise a `?scope=live&person=…`
   * address, which is a bookmark somebody can perfectly well make, would open on
   * a page with nothing on it and nothing visible to blame. `facetsApply` is the
   * single answer both the hiding and this reading take.
   */
  const facetsOn = facetsApply(arrivalScope);
  const rawPeople = useMemo(() => listParam(params, 'person'), [params]);
  const rawGenres = useMemo(() => listParam(params, 'genre'), [params]);
  const peopleSel = facetsOn ? rawPeople : NO_FACETS;
  const genresSel = facetsOn ? rawGenres : NO_FACETS;
  const [draft, setDraft] = useState(q);
  /* Focus parks, OK types — one rule for every field, see `lib/okToType.ts`. */
  const ok = useOkToType();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(q), [q]);

  useEffect(() => { warmSearchIndex(); }, []);

  /*
   * Autocomplete suggestions: computed synchronously on every draft change.
   * The underlying `search` call is 4–8 ms, so it never blocks a keystroke.
   * Only shown when the input is focused and the query is at least 2 chars.
   */
  const suggestions = useMemo(() => {
    const t = draft.trim();
    if (t.length < 2) return [];
    return localSearchSuggestions(t, 8);
  }, [draft]);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    setShowSuggestions(true);
  }, []);

  const handleSuggestionClick = useCallback((name: string, type?: string) => {
    setDraft(name);
    setShowSuggestions(false);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('q', name);
      next.delete('genre');
      if (type === 'actor') {
        // When clicking an actor suggestion, filter by that person
        const folded = name.toLowerCase().trim();
        next.set('person', folded);
      } else {
        next.delete('person');
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const handleInputFocus = useCallback(() => {
    setShowSuggestions(true);
  }, []);

  const handleInputBlur = useCallback(() => {
    /* Delay to allow clicking a suggestion before the dropdown closes. */
    setTimeout(() => setShowSuggestions(false), 150);
  }, []);

  const suggestionIcon = (type: string) => {
    if (type === 'channel') return <Tv className="h-3.5 w-3.5 shrink-0 text-ink-3" />;
    if (type === 'movie') return <Film className="h-3.5 w-3.5 shrink-0 text-ink-3" />;
    if (type === 'series') return <Tv2 className="h-3.5 w-3.5 shrink-0 text-ink-3" />;
    return <User className="h-3.5 w-3.5 shrink-0 text-ink-3" />;
  };

  /*
   * The clock "on air right now" is read against.
   *
   * Ticked rather than read once, for the reason `Catchup.tsx` and `Guide.tsx`
   * both tick it: a viewer can sit on this screen for a while before typing a
   * programme name, and a LIVE mark or a "Today 20:30" that was true when the
   * screen opened and false five minutes later is a wrong answer sitting still.
   */
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 60_000);
    return () => window.clearInterval(id);
  }, []);

  /*
   * The programme index: built once from the guide listings already on the
   * device (never a network fetch — see `epgSearch.ts`), and held by
   * `ensureEpgIndex` itself across remounts of this screen. `useQuery` is used
   * here purely for the loading/caching wiring the rest of this file already
   * leans on; the actual "build once, hold it" discipline lives in
   * `lib/epgSearch.ts`, not in this query.
   */
  const epgIndex = useQuery({
    queryKey: ['epg-search-index'],
    queryFn: () => ensureEpgIndex(),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const t = draft.trim();
    if (t === q) return;
    const id = window.setTimeout(() => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (t.length >= 2) next.set('q', t);
        else next.delete('q');
        /* Fresh letters: drop facet picks that belonged to the previous word. */
        next.delete('person');
        next.delete('genre');
        return next;
      }, { replace: true });
    }, typingDelay());
    return () => window.clearTimeout(id);
  }, [draft, q, setParams]);

  const { data, isLoading, isPlaceholderData } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });

  const bindings = useMemo((): Binding[] => [
    { intent: 'red', label: 'Clear', act: () => setDraft('') },
  ], []);
  useKeyLayer(bindings);

  const primary = from === null ? null : sectionForPath(`/${from}`);

  const facets = useMemo(() => {
    /* Keep chips while a new search is still showing previous rows — wiping on
       `isPlaceholderData` made the people rail vanish on every deselect. */
    if (data === undefined || !facetsOn) {
      return { people: [] as SearchPerson[], genres: [] as SearchGenre[] };
    }
    return searchFacets(q, data.live, data.movies, data.series, {
      people: peopleSel,
      genres: genresSel,
    });
  }, [data, facetsOn, genresSel, peopleSel, q]);

  const portraits = useQuery({
    queryKey: ['search-portraits', facets.people.map((p) => p.id).join('|')],
    queryFn: () => personPortraits(q, facets.people),
    enabled: q.length >= 2 && facets.people.length > 0,
    staleTime: 3_600_000,
    placeholderData: keepPreviousData,
  });

  /*
   * Programme titles, ranked — the guide the device already holds, never a
   * network fetch per keystroke. `epgIndex.data` is undefined until the index
   * has finished its (lazy, one-time) build; until then this is empty, exactly
   * like the catalogue's own `data` before its query resolves.
   */
  const ontvHits = useMemo((): OnTvHit[] => {
    const index = epgIndex.data;
    if (index === undefined || q.trim().length < 2) return EMPTY_ONTV;
    const favouriteStreamIds = new Set(getPrefs().favs.live);
    return rankProgrammes(index.candidates, q, nowS, favouriteStreamIds)
      .map((programme): OnTvHit => ({ kind: 'ontv', item: {}, href: programme.href, programme }));
  }, [epgIndex.data, nowS, q]);

  /**
   * Packages and countries that match what was typed.
   *
   * "the search should search both tv categores as well as channals and in other
   * places aswell" — so all three libraries' category lists are asked, not just
   * Live. `useCategories` shares its react-query key with the sidebar and the
   * filter bar, so on a device that has been anywhere near those screens this
   * costs nothing; the ranking is `lib/categoryHits.ts`, pure and tested.
   */
  const { scope: catScope } = useScope();
  const liveCats = useCategories('live', catScope);
  const movieCats = useCategories('movies', catScope);
  const seriesCats = useCategories('series', catScope);
  const catHits = useMemo(
    () => categoryHits([
      { section: 'live' as const, categories: liveCats },
      { section: 'movies' as const, categories: movieCats },
      { section: 'series' as const, categories: seriesCats },
    ], q),
    [liveCats, movieCats, seriesCats, q],
  );

  const hits = useMemo((): SearchHit[] => {
    if (data === undefined) return [];
    let live = data.live;
    let movies = data.movies;
    let series = data.series;
    let ontv: OnTvHit[] = ontvHits;
    const faceted = peopleSel.length > 0 || genresSel.length > 0;
    if (peopleSel.length > 0) {
      movies = filterByPeople(movies, peopleSel);
      series = filterByPeople(series, peopleSel);
    }
    if (genresSel.length > 0) {
      movies = filterByGenres(movies, genresSel);
      series = filterByGenres(series, genresSel);
    }
    /* A cast or category pick is a statement about titles; a channel merely
       sharing a word with the query is noise under it, and so — for the same
       reason — is a programme merely airing on one. See `facetsApply`. */
    if (faceted) { live = []; ontv = EMPTY_ONTV; }
    const pack = (kind: Kind, items: Item[]): Hit[] =>
      items.map((item) => ({ kind, item, href: hrefOf(kind, item) }));
    /* `ontv` carries pre-built rows rather than an `Item[]` a shared `pack`
       could run over — it is not a catalogue kind, see `OnTvHit`. Right after
       `live` is where the partner's own pairing of the two puts it. */
    const blocks: { id: Kind | 'ontv'; hits: SearchHit[] }[] = [
      { id: 'live', hits: pack('live', live) },
      { id: 'ontv', hits: ontv },
      { id: 'movies', hits: pack('movies', movies) },
      { id: 'series', hits: pack('series', series) },
    ];
    const ordered = primary === null
      ? blocks
      : [...blocks.filter((b) => b.id === primary), ...blocks.filter((b) => b.id !== primary)];
    return ordered.flatMap((b) => b.hits);
  }, [data, genresSel, ontvHits, peopleSel, primary]);

  /* The app's guess stands aside when it is empty and something else is not;
     a chip somebody actually pressed never does. See `effectiveScope`. */
  const scope = effectiveScope(hits, arrivalScope, scopePressed);

  /*
   * The row, and then the rows.
   *
   * Both come off `hits` and nothing else, which is the point: a chip saying
   * "Movies 12" over a list of eleven films is the kind of wrong that survives
   * every test suite and is spotted instantly by the person holding the remote.
   * The count IS the length of the list the chip opens, because it is counted
   * from it.
   */
  const chips = useMemo(() => scopeChips(hits, scope), [hits, scope]);
  const shown = useMemo((): SearchHit[] => {
    const rows = hitsInScope(hits, scope);
    if (scope !== 'catchup') return rows;
    /*
     * Somebody who asked for recordings and was handed the live stream was not
     * answered. `linkId` rather than the row id for the reason `Catchup` gives
     * beside `?ch=`: a re-ingest renumbers every row, and a catch-up link that
     * is reopened after one points at whatever inherited the number.
     *
     * The `h.kind === 'live'` check is a type guard, not a real branch: every
     * row here has kind `live` — `inScope`'s catch-up case admits nothing else
     * — but `SearchHit`'s `item` field only carries `id`/`ref` on that branch.
     */
    return rows.map((h) => (h.kind === 'live' ? { ...h, href: `/catchup?ch=${linkId(h.item)}` } : h));
  }, [hits, scope]);

  /*
   * The scope goes in the address, beside `q`, and is written with `replace` for
   * the same two reasons that one is: a reload or a shared link has to come back
   * to the same screen, and BACK on a remote means "leave this screen" — a
   * history entry per chip press turns one press out of search into five.
   */
  const pickScope = (next: Scope) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      /* Always written, never inferred once it has been pressed: with `?from=`
         still in the address, deleting `scope` on "All" would hand the page
         straight back to the section it was opened from. */
      p.set('scope', next);
      /* Live and Catch-up have no cast and no film categories, so the picks go
         with the rows that offered them. Leaving them in the address would mean
         the chip you pressed opened on an empty page. */
      if (!facetsApply(next)) {
        p.delete('person');
        p.delete('genre');
      }
      return p;
    }, { replace: true });
  };

  const settled = data !== undefined && !isPlaceholderData && q.length >= 2;
  const empty = settled && hits.length === 0;
  /* Found something, just not here. The way out is the chip row directly above,
     so this says which way rather than offering a second control. */
  const elsewhere = settled && hits.length > 0 && shown.length === 0;

  const toggleFacet = (key: 'person' | 'genre', id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const cur = listParam(next, key);
      next.delete(key);
      const on = cur.includes(id);
      for (const v of cur) {
        if (v !== id) next.append(key, v);
      }
      if (!on) next.append(key, id);
      return next;
    }, { replace: true });
  };

  const peopleOn = useMemo(() => new Set(peopleSel), [peopleSel]);
  const genresOn = useMemo(() => new Set(genresSel), [genresSel]);

  return (
    <div className="h-full overflow-y-auto">
      {/* `search-sheet` is the Modern shell's hook: this column is the whole
          page, and without a surface of its own it sat straight on the room.
          Nothing in Classic spends the class. */}
      <div className="search-sheet glass-float mx-auto w-full max-w-3xl px-4 py-4 sm:py-6">
        <form
          data-nav-scope
          className="relative mb-5"
          onSubmit={(e) => {
            e.preventDefault();
            setShowSuggestions(false);
            if (draft.trim().length >= 2) {
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('q', draft.trim());
                next.delete('person');
                next.delete('genre');
                return next;
              }, { replace: true });
            }
            /*
              The IME's own action key, once it has actually run the search:
              close the keyboard and hand focus to whatever the query turned
              up, so OK does not leave the remote pointed at a field with
              nothing selected — see the owner's report that OK, with the
              keyboard open, was landing on a character instead of doing
              anything. `requestAnimationFrame` gives the blur — which can
              resize the page under `--kbd-h`, see `softKeyboard.ts` — one
              frame to settle before `focusFirst` measures anything.
            */
            e.currentTarget.querySelector('input')?.blur();
            requestAnimationFrame(() => focusFirst());
          }}
        >
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={(e) => {
              ok.props.onBlur(e);
              handleInputBlur();
            }}
            autoFocus={q === ''}
            enterKeyHint="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="Search"
            placeholder="Titles, people, channels…"
            data-ok-to-type="typing"
            onKeyDown={ok.props.onKeyDown}
            onPointerDown={ok.props.onPointerDown}
            className="w-full border border-rule bg-panel py-3 pl-10 pr-3 text-[length:var(--t-md)] text-ink
                       placeholder:text-ink-3 focus:border-focus focus:outline-none
                       tv:py-4 tv:pl-12 tv:text-[length:var(--t-lg)]"
          />

          {/* Autocomplete suggestions dropdown */}
          {showSuggestions && suggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute left-0 right-0 top-full z-50 mt-1 border border-rule bg-panel/95 backdrop-blur-md shadow-[0_8px_24px_-12px_rgb(0_0_0/.55)] overflow-hidden"
            >
              <div className="px-2 py-1.5">
                <p className="font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
                  Suggestions
                </p>
              </div>
              {suggestions.map((s, i) => (
                <button
                  key={`${s.type}-${s.name}-${i}`}
                  type="button"
                  tabIndex={-1}
                  onClick={() => handleSuggestionClick(s.name, s.type)}
                  className="tap flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-panel/80"
                >
                  {suggestionIcon(s.type)}
                  <span className="truncate text-[length:var(--t-sm)] text-ink">
                    {s.name}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3 capitalize">
                    {s.type}
                  </span>
                </button>
              ))}
            </div>
          )}
        </form>

        {q.length >= 2 && data?.corrected === true && !isPlaceholderData && (
          <p className="mb-3 text-[length:var(--t-sm)] text-ink-3">
            Showing results for corrected spelling of{' '}
            <span className="text-ink">{q}</span>
          </p>
        )}

        {draft.length < 2 && (
          <p className="text-[length:var(--t-sm)] text-ink-3">Type at least two letters.</p>
        )}

        {(isLoading || isPlaceholderData) && q.length >= 2 && (
          <p className="mb-3 text-[length:var(--t-sm)] text-ink-3">Searching…</p>
        )}

        {/*
          * The content-type row. No heading over it, unlike the two rails below:
          * the chips name themselves, and this box reports a 540px-tall viewport
          * on the television — every line spent above the results is a line of
          * results nobody sees without scrolling first.
          */}
        {scopeRowWorthShowing(chips) && (
          <div data-nav-scope className="mb-4">
            <HScroll scrollKey={scope}>
              {chips.map((c) => {
                const on = c.id === scope;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => pickScope(c.id)}
                    className={`tap flex shrink-0 items-center gap-1.5 border px-3 py-1.5
                                text-[length:var(--t-sm)] transition-colors
                                ${on
                                  ? 'border-tally bg-tally/15 text-tally'
                                  : 'border-rule bg-panel text-ink-2 hover:border-ink-3 hover:text-ink'}`}
                  >
                    <span className="truncate">{c.label}</span>
                    <span className={`font-mono text-[length:var(--t-2xs)] ${on ? 'opacity-80' : 'opacity-60'}`}>
                      {c.count}
                    </span>
                  </button>
                );
              })}
            </HScroll>
          </div>
        )}

        {/*
          Where the results live, rather than which results they are.

          A place to go, so it sits with People and the genre chips above the
          list and not inside it — see the note at the top of `lib/categoryHits`
          on why this is not a fifth scope.
        */}
        {catHits.length > 0 && (
          <div data-nav-scope className="mb-4">
            <p className="mb-2 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
              Groups &amp; packages
            </p>
            <HScroll scrollKey={q}>
              {catHits.map((c) => (
                <Link
                  key={`${c.section}.${c.id}`}
                  to={c.href}
                  className="tap flex shrink-0 items-center gap-1.5 border border-rule bg-panel px-3 py-1.5
                             text-[length:var(--t-sm)] text-ink-2 transition-colors
                             hover:border-ink-3 hover:text-ink focus-visible:border-focus"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{c.label}</span>
                  <span className="shrink-0 font-mono text-[length:var(--t-2xs)] text-ink-3">
                    {c.count.toLocaleString()}
                  </span>
                </Link>
              ))}
            </HScroll>
          </div>
        )}

        {/* ── green: categories ─────────────────────────────────────────── */}
        {facets.genres.length > 0 && (
          <div data-nav-scope className="mb-4">
            <p className="mb-2 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
              Categories
            </p>
            <HScroll scrollKey={genresSel.join('|')}>
              {facets.genres.map((g) => {
                const on = genresOn.has(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleFacet('genre', g.id)}
                    className={`tap flex shrink-0 items-center gap-1.5 border px-3 py-1.5
                                text-[length:var(--t-sm)] transition-colors
                                ${on
                                  ? 'border-tally bg-tally/15 text-tally'
                                  : 'border-rule bg-panel text-ink-2 hover:border-ink-3 hover:text-ink'}`}
                  >
                    <Tag className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{g.label}</span>
                  </button>
                );
              })}
            </HScroll>
          </div>
        )}

        {/* ── red: actors ───────────────────────────────────────────────── */}
        {facets.people.length > 0 && (
          <div data-nav-scope className="mb-5">
            <p className="mb-2 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
              People
            </p>
            <HScroll className="gap-3" scrollKey={peopleSel.join('|')}>
              {facets.people.map((p) => {
                const on = peopleOn.has(p.id);
                const src = portraits.data?.[p.id];
                const initials = p.label.split(' ').slice(0, 2).map((w) => w[0]).join('');
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    title={p.label}
                    onClick={() => toggleFacet('person', p.id)}
                    className={`tap flex w-[4.75rem] shrink-0 flex-col items-center gap-1.5
                                focus-visible:outline-none
                                ${on ? 'text-tally' : 'text-ink-2 hover:text-ink'}`}
                  >
                    <span
                      className={`relative flex h-16 w-16 items-center justify-center overflow-hidden
                                  rounded-full border bg-panel text-[length:var(--t-sm)] font-medium
                                  ${on ? 'border-tally ring-1 ring-tally' : 'border-rule'}`}
                      style={{ borderRadius: '9999px' }}
                    >
                      {src !== undefined ? (
                        <img
                          src={artworkAt(src, 128)}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <span aria-hidden>{initials}</span>
                      )}
                    </span>
                    <span className="line-clamp-2 w-full text-center text-[length:var(--t-2xs)] leading-snug">
                      {p.label}
                    </span>
                  </button>
                );
              })}
            </HScroll>
          </div>
        )}

        {/* ── blue: DVD + info rows ─────────────────────────────────────── */}
        {empty && (
          <p className="text-[length:var(--t-sm)] text-ink-3">Nothing matched.</p>
        )}
        {elsewhere && (
          <p className="text-[length:var(--t-sm)] text-ink-3">
            Nothing under {chips.find((c) => c.id === scope)?.label ?? 'this'}.{' '}
            <span className="text-ink-2">{hits.length}</span>{' '}
            {hits.length === 1 ? 'result' : 'results'} elsewhere — the row above moves.
          </p>
        )}
        {shown.length > 0 && (
          <ul data-nav-scope className="divide-y divide-rule border-y border-rule">
            {shown.map((h) => {
              if (h.kind === 'ontv') {
                const p = h.programme;
                return (
                  <li key={`ontv-${p.streamId}-${p.startTs}`}>
                    <Link
                      to={h.href}
                      className="tap row-hover flex items-start gap-3 px-1 py-2.5 sm:gap-3.5 sm:py-3"
                    >
                      <span className="w-12 shrink-0 sm:w-14">
                        <Poster src={p.channelLogo} alt="" ratio="square" fit="contain" className="bg-panel" />
                      </span>
                      <span className="min-w-0 flex-1 self-center">
                        <span className="block truncate text-[length:var(--t-md)] font-medium text-ink">
                          {p.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[length:var(--t-sm)] text-ink-2">
                          <span className="truncate">{displayName(p.channelName)}</span>
                          <span aria-hidden className="shrink-0 text-ink-3">·</span>
                          <span className="shrink-0">{p.when}</span>
                          {p.state !== null && (
                            <span
                              className={`shrink-0 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider
                                          ${p.state === 'live' ? 'text-tally' : 'text-ink-3'}`}
                            >
                              {p.state === 'live' ? 'LIVE' : 'CATCH-UP'}
                            </span>
                          )}
                        </span>
                      </span>
                      <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                    </Link>
                  </li>
                );
              }
              const bits = metaBits(h.kind, h.item);
              const blurb = h.kind === 'live' ? null : itemSearchBlurb(h.item);
              return (
                <li key={`${h.kind}-${h.item.id}`}>
                  <Link
                    to={h.href}
                    className="tap row-hover flex items-start gap-3 px-1 py-2.5 sm:gap-3.5 sm:py-3"
                  >
                    <span className="w-12 shrink-0 sm:w-14">
                      <Poster
                        src={h.kind === 'live' ? h.item.logo : listArt(h.item)}
                        alt=""
                        ratio={h.kind === 'live' ? 'square' : 'poster'}
                        fit={h.kind === 'live' ? 'contain' : 'cover'}
                        className={h.kind === 'live' ? 'bg-panel' : undefined}
                      />
                    </span>
                    <span className="min-w-0 flex-1 self-center">
                      <span className="block truncate text-[length:var(--t-md)] font-medium text-ink">
                        {displayName(h.item.name)}
                      </span>
                      {bits.length > 0 && (
                        <span className="mt-0.5 block truncate text-[length:var(--t-sm)] text-ink-2">
                          {bits.join(' · ')}
                        </span>
                      )}
                      {blurb !== null && (
                        <span className="mt-0.5 line-clamp-2 text-[length:var(--t-sm)] leading-snug text-ink-3">
                          {blurb}
                        </span>
                      )}
                    </span>
                    <ChevronRight className="mt-3 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
