import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { VideoPlayer } from '../components/VideoPlayer';
import { DetailHero, DetailSpecs } from '../components/DetailHero';
import { cleanTitle } from '../lib/displayName';
import type { HeroFacts } from '../components/DetailHero';
import type { SubtitleContext } from '../components/SubtitleMenu';
import { api, apiUrl, linkId } from '../lib/api';
import { artworkAt } from '../lib/artwork';
import { player } from '../lib/playerCore';
import { playFailureHint } from '../lib/playUnavailable';
import { noteDetailPlayer, noteShellHide } from '../lib/shellState';
import { getWatch, resumeAt } from '../lib/watch';
import { showDiagnostics } from '../lib/direct';
import { noteLastPlayed } from '../lib/resume';
import { usePrefs } from '../lib/prefs';
import { revealStage } from '../lib/revealStage';
import { rememberListArt } from '../lib/listArt';
import { artIsDead } from '../lib/deadArt';
import { NO_NEIGHBOURS, reelFor } from '../lib/reel';

/** Shaped like the real page — hero, spec block, rail — so nothing jumps when
 *  the panel answers a second later. */
function Loading() {
  return (
    <div data-hero-scroll className="h-full overflow-y-auto">
      <div className="skeleton min-h-[62vh] w-full" />
      <div className="border-t border-rule px-5 py-6 sm:px-8">
        <div className="grid gap-x-10 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton my-2 h-4 w-full" />
          ))}
        </div>
      </div>
      <div className="flex gap-3 border-t border-rule px-5 py-6 sm:px-8">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton aspect-[2/3] w-[132px] shrink-0" />
        ))}
      </div>
    </div>
  );
}

export function MovieDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const movieBase = '/movie';
  const [params, setParams] = useSearchParams();
  const fromAdult = params.get('from') === 'adult';
  const backTo = fromAdult ? '/adult' : '/movies';
  /**
   * Passed through as a STRING, not parsed.
   *
   * The path now carries a stable `<kind>.<provider id>` ref, which `Number()`
   * turns into NaN. The server accepts a ref, this generation's row id, or an
   * older one, so there is nothing left here to validate.
   */
  const routeId = id ?? '';
  const [showPlayer, setShowPlayer] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  /** Bumps when leaving or starting another play — stale `api.play` must not load. */
  const playGen = useRef(0);
  const [prefs] = usePrefs();
  /* Only for the diagnostics below: they belong to a failure, not to a film. */
  const [phase, setPhase] = useState(player.state.phase);
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

  useEffect(() => player.subscribe((st) => setPhase(st.phase)), []);

  useEffect(() => {
    noteDetailPlayer(showPlayer);
    return () => noteDetailPlayer(false);
  }, [showPlayer]);

  /*
   * The catalogue answers first, the panel fills in.
   *
   * `api.movieDetail` cannot return until `get_vod_info` does — over four
   * seconds on this subscription with its backoff — and until then this page was
   * `<Loading />`: a skeleton with no PLAY button in it. That is what put the
   * focus ring on the search icon in the header, because the arrival ladder
   * (Chrome.tsx) looks for something in `<main>` to aim at and a skeleton offers
   * nothing. Measured on /movie/2.735123 at 960x540: blank hero, focus on
   * `a[Search]`, no `<h1>` on the page 2.6 seconds after OK.
   *
   * The device already holds the row — name, poster, year, rating, category — so
   * the page can be right immediately and merely incomplete. `placeholderData`
   * makes the query resolve to that at once and swap in the panel's answer when
   * it lands; `isPlaceholderData` is what tells the plot and specs below to keep
   * their skeletons rather than claim the panel said nothing.
   */
  const { data, isLoading, error, isPlaceholderData } = useQuery({
    queryKey: ['movie', routeId],
    queryFn: () => api.movieDetail(routeId),
    retry: false,
    placeholderData: () => api.movieDetailSeed(routeId) ?? undefined,
  });

  const play = useCallback(async () => {
    if (!data) return;
    const mine = ++playGen.current;
    started.current = true;
    noteDetailPlayer(true);
    setShowPlayer(true);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('play', '1');
      return next;
    }, { replace: true });
    // Release whatever was playing before asking for a URL: the account allows one
    // connection, and a resolve that fails must not leave the old stream running
    // with its retry timer armed.
    player.teardown();
    /* Named before the asking. `teardown()` leaves the player idle and resolving
       a URL is a round trip to the panel, so without this the first second of
       every playback was a placeholder telling someone who had just pressed PLAY
       to select something to play. */
    /*
     * ONE label, used by all three calls below.
     *
     * `opening` and `noteLastPlayed` were cleaning the name and `load` was not,
     * and `load` is the one that wins: it overwrites the player's title the
     * moment the URL comes back. So the film page showed "Kira Thorn - Rough
     * Anal" for the half second the panel took to answer and then replaced it
     * with "[X][4K] [LegalPorno] Kira Thorn - Rough Anal" for the whole film —
     * "the player shows things in array like [x][4k]", reported from a
     * television.
     */
    const label = cleanTitle(data.item.name);
    player.opening(label);
    try {
      noteLastPlayed({
        route: `${movieBase}/${encodeURIComponent(linkId(data.item))}?play=1`,
        label,
        logo: data.item.logo,
        kind: 'movie',
        key: linkId(data.item),
      });
      const t = await api.play(linkId(data.item));
      if (mine !== playGen.current) return;
      setNotes(t.notes);
      const rec = getWatch('movies', data.item.streamId);
      await player.load(t, label, { live: false, startAt: resumeAt(rec), key: linkId(data.item) });
    } catch (err) {
      if (mine !== playGen.current) return;
      player.fail(
        'this title could not be opened',
        playFailureHint(err, 'The panel did not answer with a playable URL. Try again in a moment.'),
      );
    }
  }, [data, setParams, movieBase]);

  useEffect(() => () => {
    playGen.current += 1;
    player.teardown();
  }, []);

  /**
   * Previous and next — the titles either side of this one in its package.
   *
   * `lib/reel.ts` holds what "either side" means and why it is the package.
   * Read from the device's own catalogue, so it costs nothing and is ready
   * before the panel has answered: the buttons are on the bar from the first
   * frame rather than appearing a second into the film.
   */
  const reel = useMemo(() => (data ? reelFor('movies', data.item) : NO_NEIGHBOURS), [data]);

  /**
   * Going to the neighbour, on the route this film is already on.
   *
   * `replace`, because skipping through six films must not put six entries in
   * the trail — BACK belongs to the list that opened the first one.
   *
   * `?play=1` is what makes it PLAY rather than land on a details page, and it
   * is honoured by both branches below: the immersive one plays regardless, and
   * the page one reads exactly this parameter.
   */
  const goTo = useCallback((to: { ref: string | null; id: number } | null) => {
    if (to === null) return;
    nav(`${movieBase}/${encodeURIComponent(linkId(to))}?play=1`, { replace: true });
  }, [nav, movieBase]);

  /**
   * A different film on the same route is a different film.
   *
   * React Router keeps this component mounted when only the `:id` changes, so
   * `started` — the latch that stops the auto-play effect firing twice for one
   * title — survived the change and swallowed the next film's play. Symptom
   * from a chair: press Next, the title and the artwork change, the picture
   * stays on the film that was already running. Declared ABOVE the auto-play
   * effect so it is cleared in the same commit, before that effect reads it.
   */
  useEffect(() => {
    started.current = false;
  }, [routeId]);

  /**
   * This screen, unless the viewer asked for the picture instead.
   *
   * `openStyle` decides what OK on a tile means (see `lib/prefs`), and the
   * default is this page. `?details=1` is how the hold menu asks for it when the
   * setting points the other way, so both destinations stay reachable from every
   * tile whichever way it is pointing.
   */
  const wantsPage = prefs.openStyle === 'page' || params.get('details') === '1';

  /* The shell goes away for the picture whichever route reached it: the
     immersive branch never had a header, and the page branch now covers its
     own. A `z-40` header under a `z-50` picture is invisible either way, but
     telling the shell means it also stops taking key presses. */
  useEffect(() => {
    noteShellHide('movie-immersive', !wantsPage || showPlayer);
    return () => noteShellHide('movie-immersive', false);
  }, [wantsPage, showPlayer]);

  useEffect(() => {
    if (!data || started.current) return;
    if (params.get('play') !== '1' && wantsPage) return;
    void play();
  }, [data, params, play, wantsPage]);

  /* Nothing to scroll to any more: the picture covers the page rather than
     sitting at the top of it. Kept as a no-op guard rather than deleted because
     `revealStage` on a `fixed` element scrolls the page underneath for no
     reason, which is a jump the viewer sees on the way back out. */
  useEffect(() => {
    void showPlayer;
  }, [showPlayer]);

  if (isLoading && wantsPage) return <Loading />;
  if (error) return <p className="p-6 font-mono text-xs text-alert">{(error as Error).message}</p>;
  if (!data) return null;

  const { item, detail, category } = data;
  const rec = item.streamId === null
    ? null
    : prefs.history.find((r) => r.section === 'movies' && r.streamId === item.streamId) ?? null;

  /* The panel's own name is cleaner than the catalogue name, and both need the
     provider noise stripped before a subtitle search will match anything. */
  const title = cleanTitle(detail?.name ?? item.name);
  const subtitleContext: SubtitleContext = {
    title,
    year: detail?.releaseDate ?? item.year,
  };

  const facts: HeroFacts = {
    section: 'movies',
    title,
    cover: detail?.cover ?? item.logo,
    backdrop: detail?.backdrops[0] ?? null,
    year: detail?.releaseDate ?? item.year,
    releaseDate: detail?.releaseDate ?? item.year,
    rating: detail?.rating ?? item.rating,
    mpaa: detail?.mpaa ?? null,
    duration: detail?.duration ?? null,
    durationSecs: detail?.durationSecs ?? null,
    genres: detail?.genres ?? [],
    plot: detail?.plot ?? null,
    cast: detail?.cast ?? [],
    director: detail?.director ?? null,
    country: detail?.country ?? null,
    trailer: detail?.youtubeTrailer ?? null,
    container: detail?.containerExtension ?? item.ext,
    bitrate: detail?.bitrate ?? null,
    video: detail?.video ?? null,
    audio: detail?.audio ?? null,
    category,
  };

  /* Detail already prefers a live backdrop when the poster host is dead — keep
     that for the grid too, once this title has been opened. */
  {
    const cover = facts.cover;
    const backdrop = facts.backdrop;
    const list = cover !== null && !artIsDead(cover)
      ? cover
      : backdrop;
    rememberListArt(item.id, list);
  }

  /*
   * The film, filling the screen, and nothing else on it.
   *
   * Not a second route: every tile in the app already links here, so making the
   * DESTINATION honour the setting covers the rails, the grids, search,
   * favourites, continue-watching and the related rail in one place — and BACK
   * still returns to whatever opened it, which a separate player route would
   * have had to reinvent.
   *
   * `onClose` leaves rather than revealing the page underneath. In this mode
   * there is no page underneath; closing the picture means going back to the
   * list, which is what the button looks like it does.
   */
  if (!wantsPage) {
    return createPortal(
      /*
        The WHOLE screen, not the whole of `<main>`.
        `h-full w-full` only filled the route's own box, which sits under a
        `z-40` header — so "open it full screen" still had the tab bar, the
        clock and the account button across the top of the film, and the
        picture started below them. Reported bluntly, and fairly: "it doesnt go
        full screen, like no menues or anything and proper full screen".
        `fixed inset-0 z-50` is the same layer the player's own fullscreen
        fallback uses (see `cssFull` in VideoPlayer), so the two cannot fight
        over which is on top. Portaled to body so Modern glass blur cannot trap it.
      */
      <div data-nav-contain className="fixed inset-0 z-50 bg-black">
        <VideoPlayer
          className="h-full w-full"
          onRetry={() => void play()}
          onClose={() => { player.teardown(); noteDetailPlayer(false); nav(backTo); }}
          subtitleContext={subtitleContext}
          resume={item.streamId === null ? null : { section: 'movies', streamId: item.streamId }}
          idleHint={`Opening ${title}\u2026`}
          {...(reel.prev !== null ? { onPrev: () => goTo(reel.prev) } : {})}
          {...(reel.next !== null ? { onNext: () => goTo(reel.next) } : {})}
          /* This div IS the whole screen: see `screenFilled` in VideoPlayer for
             why the title needs telling that explicitly. */
          screenFilled
        />
      </div>,
      document.body,
    );
  }

  const playerSheet = createPortal(

        /*
          PLAY fills the screen, even though the DETAILS page is what OK opens.
          Both were asked for and they are not in conflict: "i think its best for
          movies and series, we play it direcly full screen" is about watching,
          and "i think its fine if they go to details page first so that by
          default" is about browsing. So the page stays the destination and the
          picture stops being a panel inside it.

          It was also measurably making the complaint "mvies are way too dark"
          worse. Measured at the box's 960x540: the in-page picture was 730x410
          with 726x301 of actual film — 42% of the screen — and the panel's
          average luma came out at 27.4 against the film's own 41.4. A small
          bright rectangle in a near-black surround reads dimmer than it is, and
          on a set with dynamic contrast or local dimming the backlight follows
          the average and physically pulls down. The film was never the only
          reason it looked dark; two thirds of the screen was black chrome.

          `fixed inset-0 z-50` and `data-nav-contain` are the same layer and the
          same boundary the immersive branch uses (and `cssFull` in VideoPlayer),
          so nothing can fight over which is on top or leak focus into the page
          behind. `onClose` still returns to the page rather than leaving, which
          is the one thing that must differ from the immersive branch.
        */
        <div ref={stage} data-nav-contain className="fixed inset-0 z-50 bg-black">
          <div className="h-full w-full">
            <VideoPlayer
              className="h-full w-full"
              onRetry={() => void play()}
              onClose={() => {
                player.teardown();
                noteDetailPlayer(false);
                setShowPlayer(false);
                started.current = false;
                setParams((p) => {
                  const next = new URLSearchParams(p);
                  next.delete('play');
                  return next;
                }, { replace: true });
              }}
              subtitleContext={subtitleContext}
              resume={item.streamId === null ? null : { section: 'movies', streamId: item.streamId }}
              {...(reel.prev !== null ? { onPrev: () => goTo(reel.prev) } : {})}
              {...(reel.next !== null ? { onNext: () => goTo(reel.next) } : {})}
              /* Same cover as the immersive branch above: no heading anywhere
                 else on this screen, so the player has to say the title itself. */
              screenFilled
            />
            {/*
              Only when something actually went wrong.

              `container "mkv" may not decode natively in a browser` was printed
              under every MKV — including the 53,168 of them that play perfectly
              through the native engine — so the commonest container in the
              catalogue came with a warning label attached to a working film. The
              error panel already names the missing codec and gives a quotable
              code when playback really does fail; that is where this belongs.
              Suppressed entirely on a phone and in the APK: see lib/direct.ts.
            */}
            {showDiagnostics() && phase === 'error' && notes.map((n) => (
              <p key={n} className="mt-2 font-mono text-[length:var(--t-xs)] text-ink-3">{n}</p>
            ))}
          </div>
        </div>,
    document.body,
  );

  /*
   * While the picture is up, the page is NOT rendered — not merely covered.
   *
   * Covering it was the bug: on the box the film is drawn by libVLC on a real
   * surface BEHIND a transparent WebView, so the page punches a hole where the
   * picture is (see `surface` in playerCore and the hole rules in index.css).
   * That clears BACKGROUNDS; it cannot clear CONTENT. While the picture was a
   * box inside the page that did not matter, because the cast list and the spec
   * table were somewhere else on it — now the picture is the whole screen, so
   * every word on the page sits over the film. Reported exactly that way: "now
   * when people goes to full screen the details area show up on top of the full
   * screen of the movies and everything".
   *
   * An early return also stops the hero decoding its backdrop and the spec table
   * laying out while a film plays, which on a television is the most expensive
   * work on the page.
   */
  if (showPlayer) return playerSheet;

  const pageArt = facts.backdrop ?? facts.cover;
  const pageArtUrl = pageArt !== null ? apiUrl(artworkAt(pageArt, 1280)) : null;

  return (
    <div data-hero-scroll className="h-full overflow-y-auto">
      {/*
        One piece of art for the whole page — hero AND details. The modern shell
        plate used to show under DETAILS and read as a second, unrelated body
        image; the film's own cover/backdrop replaces that.
      */}
      <div className="relative min-h-full">
        {pageArtUrl !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat"
            style={{ backgroundImage: `url("${pageArtUrl}")` }}
          />
        )}
        {/*
          The scrim, and it has to be a RAMP rather than a wash.

          A flat 35% is right for the hero, where the art is the point, and
          wrong for everything under it: the page is one picture from top to
          bottom, so below the last row of content there was nothing but a
          photograph at two thirds brightness filling the rest of the screen —
          "the body doesn't take the whole screen".

          The stops are in `vh` deliberately. The hero is `min-h-[56vh]`, a
          viewport measure, so the ramp can be pinned to where it actually ends
          no matter how long the page turns out to be. Percentages would move
          with the content and put the solid part in the middle of a long page.
        */}
        <div
          aria-hidden
          className="detail-room pointer-events-none absolute inset-0"
        />
        <div className="relative">
          <DetailHero
            pageBleed
            back={backTo}
            onPlay={() => void play()}
            playLabel={resumeAt(rec) ? 'CONTINUE' : 'PLAY'}
            facts={facts}
          />

          {/* Only once the panel has actually answered. While `data` is the local
              seed there is nothing to report yet, and saying "no metadata" then is
              a wrong sentence that appears on every film for four seconds. */}
          {!detail && !isPlaceholderData && (
            <p className="relative border-t border-rule px-5 py-4 font-mono text-[length:var(--t-xs)] text-ink-3 sm:px-8">
              The panel returned no metadata for this title — only what the catalogue already had.
            </p>
          )}

          <DetailSpecs facts={facts} />
        </div>
      </div>
    </div>
  );
}
