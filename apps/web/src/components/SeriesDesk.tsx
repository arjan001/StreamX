import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play, Star } from 'lucide-react';
import { VideoPlayer } from './VideoPlayer';
import { Poster } from './Poster';
import { SeriesEpisodes } from './SeriesEpisodes';
import { cleanTitle } from '../lib/displayName';
import type { SubtitleContext } from './SubtitleMenu';
import { api, apiUrl, type Episode } from '../lib/api';
import { artworkAt } from '../lib/artwork';
import { player } from '../lib/playerCore';
import { playFailureHint } from '../lib/playUnavailable';
import { noteDetailPlayer, noteShellHide } from '../lib/shellState';
import { noteLastPlayed } from '../lib/resume';
import { resumeAt } from '../lib/watch';
import { toggleFav, usePrefs } from '../lib/prefs';
import { useKeyLayer, type Binding } from '../lib/keys';
import { bySeason, episodeProgress, nextUp } from '../lib/seriesProgress';
import { useSkin } from '../lib/skin';

/**
 * The series screen: the film page's shape, with the episodes in it.
 *
 * Settled after three tries, in the owner's own words:
 *
 *   "Make it like the show page for movies, but instead of showing only the
 *    detail — on the left the episodes and on the right the player, and below it
 *    all those recommendations or similar. I think I was wrong, I was overdoing
 *    things."
 *
 * So it is `routes/MovieDetail` with one substitution. That page is a picture, a
 * block of detail and a rail of similar titles; this one keeps the detail and
 * the rail and splits the middle in two — the episode list where the film page
 * has nothing to list, the picture beside it rather than above it.
 *
 *   ┌───────────────────────────┬──────────────────┐
 *   │ title · badges · PLAY · ★ │                  │
 *   ├───────────────────────────┤     PICTURE      │
 *   │ 01 …   02 …   03 …        │                  │
 *   ├───────────────────────────┴──────────────────┤
 *   │ MORE LIKE THIS  ▤ ▤ ▤ ▤ ▤                    │
 *   └──────────────────────────────────────────────┘
 *
 * ── what it replaced, and why that went ──
 *
 * Two things stood here and both were more screen than the job needed. A 22%
 * rail of every series went on one line — "please no left column here" — and
 * then the whole library as a filtered grid a screen below went on another:
 * "I think I was wrong, I was overdoing things." A screen that browses 894
 * series is `/series`, it already exists, and BACK is one press. What belongs
 * under an open title is the handful that are like it.
 *
 * ── what the player is, and is not ──
 *
 * One `VideoPlayer`, mounted for the whole life of the screen and never
 * conditionally: playerCore owns a single media element and `load()` returns
 * early when no <video> is attached, so unmounting the surface between episodes
 * silently swallows the next play. Picking another title does NOT stop it — a
 * viewer browsing the library with something on is the normal case, not an edge
 * one — which is the whole reason the tiles below are addresses on this page
 * rather than links to another one.
 */
export function SeriesDesk({ routeId }: { routeId: string }) {
  const [params, setParams] = useSearchParams();
  const [prefs] = usePrefs();
  const { shell } = useSkin();
  const modern = shell === 'modern';
  /* See the branch below, and `Prefs.openStyle`. `?details=1` is how the hold
     menu asks for the desk when the setting says otherwise. */
  const wantsPage = prefs.openStyle === 'page' || params.get('details') === '1';
  const seriesBase = '/series';

  /**
   * Which series is open — and why it is a search parameter rather than the path.
   *
   * `Chrome` renders the page as `<main key={pathname}>`, so ANY change of path
   * remounts the entire route: the grid, its virtual list, the player, all of
   * it. Measured on this screen before this was moved: walking thirty titles
   * down the old rail and pressing OK put the scroll offset back to 0 (from
   * 1379) and threw focus to the first row — the viewer lost their place in the
   * list at the exact moment they chose something from it — and the picture,
   * which had 11 seconds on the clock, stopped dead.
   *
   * `Live` has never had that problem because a channel there travels as `?ch=`.
   * This is the same shape: the path is where the viewer came in, the search
   * string is where they have walked to since, and the search string does not
   * remount anything. Both are real addresses — `/series/A?s=B` opens B, and
   * once something plays, the mark written for a later launch is the canonical
   * `/series/B?ep=…` with no `?s` at all.
   */
  const selected = params.get('s') ?? routeId;

  const { data, isLoading, error } = useQuery({
    // A stable ref or a row id; the server resolves either. See MovieDetail.
    queryKey: ['series', selected],
    queryFn: () => api.seriesDetail(selected),
    retry: false,
  });

  const [season, setSeason] = useState<number | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [theatre, setTheatre] = useState(false);
  const started = useRef(false);
  /** Bumps when leaving or starting another episode — stale play must not load. */
  const playGen = useRef(0);

  /*
   * The shell must not float over this screen.
   *
   * `Chrome` treats `/series/…` as a hero page: the header sits ON the content
   * until it scrolls, which is right for a full-bleed backdrop and wrong for
   * columns whose first row of controls is at the top of the frame. The flag it
   * reads for the exception is "a detail player stage is mounted", and on this
   * screen that is not a workaround but a fact — the stage is mounted from the
   * first paint to the last.
   */
  useEffect(() => {
    noteDetailPlayer(true);
    return () => noteDetailPlayer(false);
  }, []);

  useEffect(() => {
    noteShellHide('series-theatre', theatre);
    return () => noteShellHide('series-theatre', false);
  }, [theatre]);

  /* Take the remote with it — the press came from the episode list, which
     theatre hides, and focus on a hidden element falls to `<body>` where a
     D-pad has nothing to move to. See the same effect in `routes/Live.tsx`. */
  useEffect(() => {
    if (!theatre) return;
    const id = window.setTimeout(() => {
      document.querySelector<HTMLElement>('.stage[tabindex]')?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [theatre]);

  /* Leaving the screen stops the stream. Staying on it and picking another
     series does not — see the header. */
  useEffect(() => () => {
    playGen.current += 1;
    player.teardown();
  }, []);

  const title = data === undefined ? '' : cleanTitle(data.series.name);
  const seriesId = data?.series.series_id ?? null;

  const groups = useMemo(() => bySeason(data?.detail.episodes ?? []), [data]);
  const flat = useMemo(() => groups.flatMap((g) => g.episodes), [groups]);

  /**
   * This series' single playhead, and every episode it has been through.
   *
   * Read from `prefs` rather than through `getWatch` so the marks re-render the
   * moment the player writes one — `useWatchProgress` saves every four seconds
   * while an episode plays, and a progress bar that only moves when you leave
   * the page is a progress bar nobody believes.
   */
  const record = useMemo(
    () => (seriesId === null
      ? null
      : prefs.history.find((r) => r.section === 'series' && r.streamId === seriesId) ?? null),
    [prefs.history, seriesId],
  );
  const marks = useMemo(
    () => episodeProgress(flat, prefs.plays, record),
    [flat, prefs.plays, record],
  );

  /**
   * The one episode this series is "at".
   *
   * Where the hero's PLAY button goes, and — since the owner asked for it —
   * what opening the series starts on its own. Hoisted above the effects that
   * need it rather than computed down in the render body where it began.
   *
   * `nextUp` rather than "the playhead's episode, else the first", which is what
   * stood here and is wrong for the commonest case: finishing an episode deletes
   * the history row (see `lib/seriesProgress`), so somebody three episodes in has
   * no playhead and was being offered episode one. It reads the per-episode play
   * marks as well, so a finished episode hands over the next one.
   */
  const resumeTarget = useMemo(() => nextUp(flat, marks), [flat, marks]);

  /**
   * Which season is open, chosen for the viewer exactly once.
   *
   * Where they left off, not season one: a viewer coming back to a show they are
   * eleven seasons into should not have to walk past ten headers to reach it.
   * `null` while nothing is known keeps this out of the way of the fold gesture
   * — `onSeason(null)` means "the viewer folded it", and re-deriving a default
   * on the next render would fight them for it.
   */
  const chosen = useRef<string | null>(null);
  useEffect(() => {
    if (data === undefined || chosen.current === selected) return;
    chosen.current = selected;
    const at = record?.episodeId ?? null;
    const resumeIn = at === null ? undefined : flat.find((e) => e.episodeId === at);
    setSeason(resumeIn?.seasonNumber ?? groups[0]?.season ?? null);
  }, [data, selected, record, flat, groups]);

  /** Artwork for the resume mark, in a ref so `playEpisode` stays stable. */
  const coverForMark = useRef<string | null>(null);
  coverForMark.current = data?.series.cover ?? data?.meta?.cover ?? null;

  const playEpisode = useCallback(
    async (episode: Episode, startAt?: number) => {
      if (data === undefined) return;
      const mine = ++playGen.current;
      const label = `${cleanTitle(data.series.name)} · S${episode.seasonNumber}E${episode.episodeNumber ?? 1}`;
      started.current = true;
      setPlaying({
        routeId: selected,
        seriesId: data.series.series_id,
        seriesTitle: cleanTitle(data.series.name),
        episode,
      });
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set('ep', String(episode.episodeId));
        return next;
      }, { replace: true });
      /* Remembered before the request: an episode that fails to open is still
         where the viewer was, and coming back to something that needs a retry is
         more useful than coming back to the home page. */
      noteLastPlayed({
        /* Canonical, and deliberately without `?s`: a mark is an address for a
           later launch, and the honest one names the series in the path. */
        route: `${seriesBase}/${encodeURIComponent(selected)}?ep=${episode.episodeId}`,
        label,
        logo: coverForMark.current,
        kind: 'episode',
        key: `3.${episode.episodeId}`,
      });
      player.teardown();
      player.opening(label);
      try {
        const t = await api.episodePlay(episode.episodeId, episode.ext);
        if (mine !== playGen.current) return;
        await player.load(t, label, { live: false, startAt, key: `3.${episode.episodeId}` });
      } catch (err) {
        if (mine !== playGen.current) return;
        player.fail(
          'this episode could not be opened',
          playFailureHint(err, 'The panel did not answer with a playable URL. Try again in a moment.'),
        );
      }
    },
    [data, selected, seriesBase, setParams],
  );

  /** Press an episode: play it, resuming if this is the one holding the playhead. */
  const onPlay = useCallback(
    (episode: Episode) => {
      void playEpisode(
        episode,
        episode.episodeId === record?.episodeId ? resumeAt(record) : undefined,
      );
    },
    [playEpisode, record],
  );

  /**
   * `?ep=` — a resume mark, a deep link, or the back button.
   *
   * Once per arrival: `started` is set by any play, including this one, so a
   * viewer who has since pressed something else is never dragged back to the
   * episode the address opened with.
   */
  useEffect(() => {
    if (data === undefined || started.current) return;
    const epId = Number(params.get('ep'));
    if (!Number.isInteger(epId) || epId <= 0) return;
    const ep = data.detail.episodes.find((e) => e.episodeId === epId);
    if (ep === undefined) return;
    setSeason(ep.seasonNumber);
    void playEpisode(ep, ep.episodeId === record?.episodeId ? resumeAt(record) : undefined);
  }, [data, params, playEpisode, record]);

  /**
   * Opening a series STARTS it — where you left off, or at the first episode.
   *
   * "when you open a series it should automatically play the 1st one instead of
   * me picking or continue from where it stopped."
   *
   * This reverses an argument made right here, and it is worth saying why rather
   * than quietly deleting the old note. The case against was that a series has
   * forty things to play, `api.seriesDetail` has no device-side seed the way
   * `api.movieDetailSeed` does, and so playing on arrival meant a few seconds of
   * black followed by a GUESS — with a wrong guess dropping someone six episodes
   * in back at S01E01, full screen, with no list on screen to fix it from.
   *
   * What answers that is `resumeTarget`. It is not a guess: it is the episode
   * holding this series' playhead, and only falls back to the first when the
   * series has never been played. The viewer six episodes in gets episode seven
   * at the second they stopped, which is the thing they were going to press
   * anyway. And the list is one BACK away — `close` returns to it rather than
   * leaving the series — so the wrong-guess case costs one press instead of
   * being unrecoverable.
   *
   * The wait is still there and is not hidden: the player is up with the title
   * on it while the panel answers, which is what it does for a film too.
   *
   * ── and it is NOT gated on `openStyle` ──
   *
   * The first version of this was, on the tidy-looking argument that
   * `openStyle: 'page'` means "show me the title first" and one preference
   * should not mean browse here and play there. `page` is the DEFAULT — settled
   * for films, deliberately, in the owner's own words — so that gate meant the
   * feature never once fired for the person who asked for it. Caught by
   * `scripts/transport-probe.mjs` rather than by reading it, which is the whole
   * argument for driving the thing.
   *
   * A series is not a film here. The film page is ONE thing you might press; the
   * series page is a list of forty, and "instead of me picking" is the request.
   * In the desk layout the picture sits beside the list, so starting it costs
   * nothing — the list is still right there to choose differently from.
   *
   * `?details=1` is the exception, and it is the honest one: that is the hold
   * menu's "show me the details", an explicit ask to look rather than watch.
   *
   * `started` is never reset, so closing the picture leaves you on the episode
   * list rather than being pulled straight back into it.
   */
  useEffect(() => {
    if (data === undefined || started.current) return;
    if (params.get('details') === '1') return;
    /* An address that names an episode is answered by the effect above. */
    if (params.get('ep') !== null) return;
    if (resumeTarget === null) return;
    setSeason(resumeTarget.seasonNumber);
    void playEpisode(
      resumeTarget,
      resumeTarget.episodeId === record?.episodeId ? resumeAt(record) : undefined,
    );
  }, [data, params, resumeTarget, playEpisode, record]);

  /* Prev/next in the flat episode list of whatever is PLAYING — which is the
     open series unless the viewer has since browsed elsewhere, in which case
     stepping has no list to walk and the controls are not offered. */
  const playingHere = playing !== null && playing.routeId === selected;
  const step = useCallback(
    (delta: number) => {
      if (playing === null || !playingHere) return;
      const at = flat.findIndex((e) => e.episodeId === playing.episode.episodeId);
      const next = flat[at + delta];
      if (at < 0 || next === undefined) return;
      setSeason(next.seasonNumber);
      void playEpisode(next);
    },
    [flat, playing, playingHere, playEpisode],
  );

  const close = useCallback(() => {
    /* BACK out of full screen first, and keep the episode playing. Only a second
       BACK — when the picture is beside the list again — stops it. */
    if (theatre) { setTheatre(false); return; }
    player.teardown();
    setPlaying(null);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete('ep');
      return next;
    }, { replace: true });
  }, [theatre, setParams]);

  const starred = seriesId !== null && prefs.favs.series.includes(seriesId);

  /**
   * The star button on the remote, and what it stars.
   *
   * Whichever tile has focus when there is one — that is what STAR means
   * everywhere else, and it is how a viewer favourites six titles while walking
   * the grid below — and the open series otherwise, which is also the answer
   * when focus is in the episode list or on the picture. `data-stream-id` on the
   * grid tiles is how that is read without threading focus state through the
   * screen.
   */
  const favHere = useCallback(() => {
    const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-stream-id]');
    const fromRow = el?.dataset['streamId'];
    const id = fromRow !== undefined && fromRow !== '' ? Number(fromRow) : seriesId;
    if (id === null || !Number.isFinite(id)) return;
    toggleFav('series', id);
  }, [seriesId]);

  const bindings = useMemo((): Binding[] => [
    { intent: 'red', label: 'Favourite', act: favHere },
    { intent: 'favourite', label: 'Favourite', act: favHere },
  ], [favHere]);
  useKeyLayer(bindings);

  /* OpenSubtitles results are per-episode, so the search needs the numbers of
     the episode actually playing — not the one the picker happens to show. */
  const subtitleContext: SubtitleContext | null = playing === null ? null : {
    title: playing.seriesTitle,
    year: data?.series.release_date ?? data?.meta?.releaseDate ?? null,
    season: playing.episode.seasonNumber,
    episode: playing.episode.episodeNumber,
  };

  const surface = (
    <VideoPlayer
      /*
        Square, because this picture is full-bleed.

        `VideoPlayer` deliberately lets the stage carry the app's corner setting
        and asks a full-bleed call site to say so — see its own note. This column
        has no padding on any side for exactly the reason recorded below, so the
        stage meets the top and right edges of the frame, and a 12px radius there
        is a wedge of page showing through the corner of the picture: "same for
        the player, some area should not have rouninesses".

        The default box classes have to be repeated because `className` REPLACES
        them rather than adding to them, and `aspect-video w-full` is what stops
        the surface being squeezed to zero height in a flex column.
      */
      className="no-round aspect-video w-full"
      subtitleContext={subtitleContext}
      resume={playing === null ? null : {
        section: 'series',
        streamId: playing.seriesId,
        episodeId: playing.episode.episodeId,
        season: playing.episode.seasonNumber,
        episode: playing.episode.episodeNumber,
      }}
      {/* Retry goes through `onPlay`, so a stream that failed once comes back at
          the playhead rather than at the start of the episode. */
        ...(playing !== null ? { onRetry: () => onPlay(playing.episode) } : {})}
      {...(playing !== null ? { onClose: close } : {})}
      {...(playingHere ? { onPrev: () => step(-1), onNext: () => step(1) } : {})}
      theatre={{ on: theatre, toggle: () => setTheatre((v) => !v) }}
      idleHint="Pick an episode."
    />
  );


  /* What is on, when something is; what the title is about otherwise. */
  const plotLine = (playingHere ? playing.episode.plot : null)
    ?? data?.series.plot ?? data?.meta?.plot ?? null;

  const pageArt = data?.meta?.backdrops?.[0] ?? data?.series.cover ?? data?.meta?.cover ?? null;
  const pageArtUrl = pageArt !== null ? apiUrl(artworkAt(pageArt, 1280)) : null;

  /**
   * A series, opened the way a television opens one: the episodes, full screen.
   *
   * `openStyle` sends a FILM straight to its picture, and the owner asked for
   * the same for series — "for series, a menu for checking episodes and
   * seasons". A series cannot do quite that, and this is the one place I argued
   * with the plan. A film has exactly one thing to play, so OK is unambiguous. A
   * series has forty, `api.seriesDetail` has no device-side seed (unlike
   * `api.movieDetailSeed`, which is what makes the film page instant), so
   * playing on arrival would mean up to four seconds of black and then a GUESS
   * at which episode — and a wrong guess drops someone six episodes in back at
   * S01E01, full screen, with no list on screen to correct it from.
   *
   * So OK opens the LIST, full screen, and the list is the whole screen rather
   * than a column beside a picture. `data-nav-first` is on the resume line, so
   * arriving still puts the remote one press from carrying on watching — the
   * same destination the plan wanted, without the guess.
   *
   * No related rail, no spec table, no hero column: "no similer movies and what
   * not... that way, we save lots of perfoemnce and junky UI". The rail alone
   * decoded twenty posters on every open.
   */
  if (!wantsPage) {
    if (playingHere) {
      return createPortal(
        /* The whole screen — see the note in routes/MovieDetail. */
        <div data-nav-contain className="fixed inset-0 z-50 bg-black">
          <VideoPlayer
            className="h-full w-full"
            subtitleContext={subtitleContext}
            resume={{
              section: 'series',
              streamId: playing.seriesId,
              episodeId: playing.episode.episodeId,
              season: playing.episode.seasonNumber,
              episode: playing.episode.episodeNumber,
            }}
            onRetry={() => onPlay(playing.episode)}
            /* Back to the list, not out of the series — the list is this
               screen, and someone closing an episode is nearly always after
               the next one. */
            onClose={() => { player.teardown(); setPlaying(null); }}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            idleHint="Pick an episode."
            /* No `theatre` here on purpose: this portal has no split layout to
               leave, so faking one would offer a "show the list" button that
               closes the player instead. The screen IS the cover already,
               though, so the title still needs to say what's playing. */
            screenFilled
          />
        </div>,
        document.body,
      );
    }
    const art = data?.meta?.backdrops?.[0] ?? data?.series.cover ?? data?.meta?.cover ?? null;
    return createPortal(
      /* Also the whole screen: the list IS this screen, and a tab bar over it
         is the same complaint one step earlier. */
      <div data-nav-contain className="fixed inset-0 z-50 overflow-hidden bg-ground">
        {/* The cover, dimmed far enough that white-on-it stays readable at three
            metres. `aria-hidden` because it says nothing the title does not. */}
        {art !== null && (
          <img
            src={art}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-ground via-ground/85 to-ground/40" />
        <div data-nav-scope className="relative flex h-full min-h-0 flex-col">
          <div className="shrink-0 px-5 pb-2 pt-4">
            <h1 className="truncate text-[length:var(--t-2xl)] font-semibold text-ink">{title}</h1>
            <p className="mt-1 truncate font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">
              {[
                ...genresOf(data?.series.genre, data?.meta?.genres),
                prettyDate(data?.series.release_date ?? data?.meta?.releaseDate),
                ratingOf(data?.series.rating ?? data?.meta?.rating),
              ].filter((f): f is string => f !== null && f !== '').join(' · ')}
            </p>
            {resumeTarget !== null && (
              <button
                type="button"
                data-nav-first
                onClick={() => onPlay(resumeTarget)}
                className="tap mt-3 flex items-center gap-2 border border-tally px-3 py-1.5
                           font-mono text-[length:var(--t-xs)] uppercase tracking-widest text-tally"
              >
                <Play className="h-3.5 w-3.5" />
                {resumeTarget.episodeId === record?.episodeId && resumeAt(record) !== undefined
                  ? 'Resume' : 'Play'}
                {` S${String(resumeTarget.seasonNumber).padStart(2, '0')}`
                  + `E${String(resumeTarget.episodeNumber ?? 1).padStart(2, '0')}`}
              </button>
            )}
          </div>
          <SeriesEpisodes
            seriesKey={selected}
            groups={groups}
            marks={marks}
            activeSeason={season}
            onSeason={setSeason}
            playingId={null}
            onPlay={onPlay}
            loading={isLoading}
            error={error === null ? null : (error as Error).message}
          />
        </div>
      </div>,
      document.body,
    );
  }

  /*
    Page-mode theatre: cover the shell like MovieDetail / cssFull.

    In place, not in a portal — see the long note in `routes/Live.tsx`, which
    had the identical early return and the identical fault. Returning a
    different tree unmounts VideoPlayer, whose cleanup runs `player.teardown()`,
    which empties the snapshot to `phase: 'idle'` — so the press that was meant
    to fill the screen stopped the episode and wrote the idle hint across a black
    one instead. The picture column is promoted where it stands and its siblings
    are hidden, so `surface` never leaves its position in the tree.
  */

  return (
    <div
      className={`relative flex h-full min-w-0 flex-col overflow-hidden ${
        modern ? 'gap-3 p-3 tv:gap-4 tv:p-4' : ''
      }`}
    >
      {/* Series art behind the glass columns — not the modern browse plate. */}
      {/*
        `nv-cover` on both of these, and it is not belt-and-braces.

        An episode plays on the native surface far more often than a channel
        does — the panel publishes a codec for VOD and 19.5% of episodes carry
        AC-3, E-AC-3 or DTS, so they go to libVLC — and libVLC draws BEHIND a
        transparent WebView. The player clears what it can see: it walks up from
        the `<video>` and blanks the background-colour of every opaque ancestor.
        Neither of these is an ancestor of anything — they are siblings of the
        picture column, one of them painting a background-IMAGE, which is a
        layer that walk can neither see nor clear. Both therefore kept painting
        across the picture rectangle while the film arrived behind them: "kan je
        episode kiezen, maar video start niet, enkel audio in de achtergrond".

        They are scenery and nothing else — both are `aria-hidden`, neither can
        be focused or pressed — so while the native surface owns the picture
        they are hidden outright (`index.css`, the native-hole block). Every
        other screen keeps them exactly as they are.
      */}
      {pageArtUrl !== null && !theatre && (
        <div
          aria-hidden
          className="nv-cover pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${pageArtUrl}")` }}
        />
      )}
      <div
        aria-hidden
        hidden={theatre}
        className="nv-cover pointer-events-none absolute inset-0 bg-ground/50"
      />
      {/*
        The middle of the film page, split in two.

        `min-h-0` and `flex-1`: this row takes whatever is left after the rail
        below it, and the two columns inside it are then free to be shorter than
        their own content and scroll — which the episode list does and the
        picture does not. Without it a long episode list pushes the rail off the
        bottom of a television, which is the one thing this arrangement exists to
        avoid.
      */}
      <div className={`relative flex min-h-0 min-w-0 flex-1 ${modern ? 'gap-3' : ''}`}>
        <div
          /* A section, so a press cannot fall out of it sideways — see the
             note in `SeriesEpisodes`. The rule between it and the picture
             lives here rather than on either child, so the seam is one line
             down the full height of the row. */
          data-nav-scope
          hidden={theatre}
          className={`flex h-full min-w-0 flex-col overflow-hidden ${
            modern
              ? 'glass-float w-[38%] min-w-[15rem] max-w-[22rem] shrink-0'
              : 'min-w-0 flex-1 border-r border-rule'
          }`}
        >
          <SeriesHero
            title={title}
            cover={data?.series.cover ?? data?.meta?.cover ?? null}
            backdrop={data?.meta?.backdrops?.[0] ?? null}
            /* In the order somebody scans it: what kind of thing this is, when
               it is from, and what it scored. Anything the panel did not
               answer simply is not in the list — an "unknown" is a fact about
               the catalogue, not about the programme, and an empty badge is
               furniture saying "no". */
            facts={[
              ...genresOf(data?.series.genre, data?.meta?.genres),
              prettyDate(data?.series.release_date ?? data?.meta?.releaseDate),
              ratingOf(data?.series.rating ?? data?.meta?.rating),
            ].filter((f): f is string => f !== null && f !== '')}
            /* Four, because four is what one line holds at 960. The full cast
               is reference material for a desk; this is who is in it. */
            cast={(data?.meta?.cast ?? []).map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean).slice(0, 4)}
            starred={starred}
            onToggleFav={seriesId === null ? null : () => toggleFav('series', seriesId)}
            resume={resumeTarget === null ? null : {
              label: `S${String(resumeTarget.seasonNumber).padStart(2, '0')}`
                + `E${String(resumeTarget.episodeNumber ?? 1).padStart(2, '0')}`,
              /* "Resume" only when there is genuinely a place to come back to.
                 A finished series offers its first episode again, and calling
                 that Resume would be a lie about where you are. */
              continuing: resumeTarget.episodeId === record?.episodeId
                && resumeAt(record) !== undefined,
              play: () => onPlay(resumeTarget),
            }}
          />

          <SeriesEpisodes
            seriesKey={selected}
            groups={groups}
            marks={marks}
            activeSeason={season}
            onSeason={setSeason}
            playingId={playingHere ? playing.episode.episodeId : null}
            onPlay={onPlay}
            loading={isLoading}
            error={error === null ? null : (error as Error).message}
          />
        </div>

        <section
          data-nav-scope
          /* No padding around the PICTURE: panel on every side of a video is the
             "why is it not filling the box" report, and the picture is the one
             thing on the page that should reach its own edges. */
          /* Theatre: this column IS the screen. `data-nav-contain` is what the
             portal wrapper used to carry. */
          {...(theatre ? { 'data-nav-contain': true } : {})}
          className={theatre
            ? 'theatre-sheet fixed inset-0 z-50 flex min-w-0 flex-col overflow-hidden bg-black'
            : `flex h-full min-w-0 flex-col overflow-hidden ${
              modern
                ? 'glass-float min-w-[18rem] flex-1'
                : 'w-[46%] min-w-[18rem] shrink-0'
            }`}
          /*
           * The doorway into the player, and it has to be THIS element.
           *
           * A horizontal D-pad move only considers candidates whose rows overlap
           * the one focus is on (lib/spatialNav.ts, rule 2). The player's
           * controls sit level with the top of the picture, so an episode two
           * thirds down the list shares a row with none of them and RIGHT would
           * do nothing at all. This column is full height, so it overlaps every
           * row in the list; landing here hands focus straight to the picture,
           * which wakes the controls, so one press of RIGHT arrives at the
           * player with its chrome up and the next reaches the buttons.
           */
          {...(playing !== null ? { tabIndex: 0 } : {})}
          onFocus={(e) => {
            if (e.target !== e.currentTarget) return;
            const stage = e.currentTarget.querySelector<HTMLElement>('.stage[tabindex]');
            if (stage) stage.focus();
          }}
        >
          <div className="min-h-0 min-w-0 flex-1">
            {cloneElement(surface, { className: 'h-full w-full' })}
          </div>
          {/*
            The description, in the band the picture leaves under itself.

            A 16:9 picture in a 46% column is 248px of a 297px row, so there are
            about fifty pixels here that belong to nothing else — and the film
            page this screen is modelled on puts its detail directly under its
            picture. Clamped and unfocusable: it is the one thing on this screen
            that can be skipped without losing anything, so it gets the leftovers
            rather than a share.
          */}
          {plotLine !== null && plotLine !== '' && !theatre && (
            <p className="shrink-0 line-clamp-2 px-4 py-2 text-[length:var(--t-xs)] leading-snug text-ink-3">
              {plotLine}
            </p>
          )}
        </section>
      </div>

      {/* MORE LIKE THIS is gone — see the note in routes/MovieDetail. A rail of
          posters decoded on every open, below the fold, on a remote. */}
    </div>
  );
}

/** What is on the screen, held apart from what is being browsed. */
interface Playing {
  /** The address the episode belongs to, so browsing away is detectable. */
  routeId: string;
  seriesId: number;
  seriesTitle: string;
  episode: Episode;
}

/**
 * The hero: what this series IS, and the one press that starts it.
 *
 * "On top will be the series details hero section and all those kind of stuff",
 * and from the drawing, the parts named: the series info, the dvd thing, and the
 * background. So: the cover, the facts, the cast, a faint frame of the programme
 * behind them, and a star.
 *
 * ── the fold, which decides every question in this box ──
 *
 * This box and the episode list share one screen, and the list is the thing
 * somebody came for — every pixel here is a row they cannot see. Measured at
 * 960×540, the CSS viewport this box's own television reports: the deck is 487px
 * and this takes about 130 of them, which leaves eight episode rows. That budget
 * is why the facts are one row of badges, why the description lives under the
 * picture instead, and why the cast row does not wrap (`flex-nowrap`, scrolls if
 * it must) — a panel whose height depends on how long a Korean drama's cast list
 * happens to be is a panel that pushes the episodes off somebody's screen.
 *
 * Two focus stops, and no more. The cover is `data-nav-skip` — "in showpage why
 * am I still able to see like the genres as buttons, I mean don't do that, they
 * can just go back and filter there, so they will just see the play button here"
 * — so the badges are text, the cover is a picture, and the only things a remote
 * can land on are Resume and the star.
 *
 * The description is deliberately NOT here; see the note where it used to be.
 */
function SeriesHero({
  title,
  cover,
  backdrop,
  facts,
  cast,
  starred,
  onToggleFav,
  resume,
}: {
  title: string;
  cover: string | null;
  /** A frame from the programme, behind the words. Absent for most titles. */
  backdrop: string | null;
  /** Genres, year, rating — whichever the panel answered, one badge each. */
  facts: string[];
  /** Who is in it, already trimmed to what one line holds. */
  cast: string[];
  starred: boolean;
  /** Null until the title has loaded — a star with nothing to star is not drawn. */
  onToggleFav: (() => void) | null;
  /** The episode this button would start, or null while there are none. */
  resume: { label: string; continuing: boolean; play: () => void } | null;
}) {
  return (
    <div
      /*
        A section of its own, and this is the attribute that makes RESUME and the
        star reachable at all.
        ────────────────────────────────────────────────────────────────────────
        Measured before it was here: focus on the first episode, one press of UP,
        and the highlight jumped over the hero into the shell's Home tab. Not a
        geometry problem — `spatialNav.sectionRect` judges a candidate by the
        SECTION it belongs to rather than by its own box, which is the rule that
        stops UP at the top of a list falling sideways into the column beside it.
        With no scope of its own, the hero's section WAS the whole left column,
        whose rectangle encloses the episode list — so `clearsSection` refused
        every control in it, correctly by its own terms, and the escalation
        carried on past `main` to the header.

        One scope per box that a press can be "above" or "below", then. The
        column around these two still earns its own: without it a press falling
        out of the hero downwards could satisfy itself with the picture beside
        it, which is 224px sideways and never what DOWN means.
      */
      data-nav-scope
      className="relative shrink-0 overflow-hidden border-b border-rule"
    >
      {backdrop !== null && (
        <div
          aria-hidden
          /* Asked for at the width it is drawn, not as the origin's master copy:
             one of these was measured at 1,159,971 bytes for a picture 28px
             wide. See lib/artwork.ts. */
          className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat opacity-25"
          style={{ backgroundImage: `url("${apiUrl(artworkAt(backdrop, 640))}")` }}
        />
      )}
      {/* Left-to-right, so the words stay legible over a bright frame. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-ground via-ground/90 to-ground/50"
      />

      <div className="relative flex gap-3 px-3 py-2">
        {/*
          The one picture on this screen that is not the video, and never a focus
          stop. The highlight landing on artwork instead of on a row has been
          reported repeatedly; `data-nav-skip` states it here so a frame or a
          link around this cover cannot quietly become a target.
        */}
        <span data-nav-skip className="block w-12 shrink-0">
          <Poster src={cover} alt="" ratio="poster" width={48} />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 flex-1 truncate text-[length:var(--t-md)] font-semibold tracking-tight text-ink tv:text-[1.15rem]">
              {title === '' ? '…' : title}
            </h1>
            {onToggleFav !== null && (
              <button
                type="button"
                onClick={onToggleFav}
                aria-pressed={starred}
                aria-label={starred ? 'Remove from favourites' : 'Add to favourites'}
                title={starred ? 'Remove from favourites' : 'Add to favourites'}
                className={`tap grid h-7 w-7 shrink-0 place-items-center border transition-colors
                  ${starred ? 'border-tally text-tally' : 'border-rule text-ink-3 hover:text-ink'}`}
              >
                <Star aria-hidden className={`h-4 w-4 ${starred ? 'fill-current' : ''}`} />
              </button>
            )}
          </div>

          {facts.length > 0 && (
            /* These MAY wrap — there are at most four of them and they are the
               facts, not the furniture. */
            <div className="flex flex-wrap gap-1">
              {facts.map((f) => <Fact key={f}>{f}</Fact>)}
            </div>
          )}

          {/*
            No description here — it is under the picture, once.

            The hero had a two-line clamp of the same paragraph the panel on the
            right prints in full, and screenshotted side by side that is what it
            looked like: the plot twice, cut off in the more prominent of the
            two. The right column is the one the layout was asked for ("then
            below the header, info for the movie, right side the screen"), it has
            six lines to give it, and the two lines this gives back are an
            episode row — which is the thing somebody came to this screen for.
          */}

          <div className="flex min-w-0 items-center gap-2">
            {resume !== null && (
              <button
                type="button"
                onClick={resume.play}
                className="tap flex shrink-0 items-center gap-1.5 border border-tally bg-tally/10 px-2.5 py-1
                           font-mono text-[length:var(--t-2xs)] tracking-wider text-tally
                           transition-colors hover:bg-tally/20"
              >
                <Play aria-hidden className="h-3 w-3 fill-current" />
                {resume.continuing ? 'RESUME' : 'PLAY'} {resume.label}
              </button>
            )}
            {cast.length > 0 && (
              <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto">
                {cast.map((who) => <Fact key={who}>{who}</Fact>)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One fact, in a box of its own.
 *
 * Deliberately not `ui.Badge`: that one is `absolute` and translucent-black
 * because it exists to sit ON artwork — dropped in here it would take itself out
 * of the flow and stack every fact in the same corner. This is the same visual
 * idea in a box that participates in a row, and it is the chip shape the filter
 * rows already use, so the screen has one vocabulary for "a small labelled
 * value" whether it can be pressed or not.
 *
 * `whitespace-nowrap` because a two-word genre broken across two lines inside a
 * bordered box is the one arrangement that looks like a mistake.
 */
function Fact({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap border border-rule px-1.5 py-0.5
                     font-mono text-[length:var(--t-2xs)] tracking-wide text-ink-2">
      {children}
    </span>
  );
}

/* The panel's series genres are a single "Drame / Western" string; `meta` gives
   them already split, so prefer it and fall back to splitting by hand. */
function genresOf(raw: string | null | undefined, meta: string[] | undefined): string[] {
  const list = meta !== undefined && meta.length > 0
    ? meta
    : (raw ?? '').split(/[,;/]/).map((g) => g.trim()).filter(Boolean);
  /* Two, and the budget above is written against four badges: two genres, a year
     and a rating IS four. Badges wrap rather than truncating, so a third genre
     costs a row of the episode list rather than the year. */
  return list.slice(0, 2);
}

/** Panel dates arrive ISO; a month name reads faster than 2021-12-19. */
function prettyDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = Date.parse(raw);
  if (raw.length < 10 || Number.isNaN(t)) return raw;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(t));
}

/* A zero rating is the panel saying it has none, not a title everybody hated. */
function ratingOf(rating: number | null | undefined): string | null {
  return rating === null || rating === undefined || rating <= 0 ? null : `${rating} / 10`;
}
