import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info, Play, Star } from 'lucide-react';
import { api, apiUrl, linkId } from '../lib/api';
import { useArtColour } from '../lib/useArtColour';
import { artworkAt } from '../lib/artwork';
import { artIsDead } from '../lib/deadArt';

import { useScope } from '../lib/scope';
import { channelsOnly, useInventory } from '../lib/sections';
import { dayNumber, spotlight, type Slide } from '../lib/home';
import { getWatch } from '../lib/watch';
import { cleanTitle } from '../lib/displayName';
import { FavButton } from './FavButton';
import { Poster } from './Poster';

const COUNT = 6;
const DWELL_MS = 9000;
/** Fraction of the width a drag must cover to count as "next", not "a wobble". */
const SWIPE = 0.12;
/** Hero plot budget — a full synopsis belongs on the detail page, not the shelf. */
const PLOT_WORDS = 22;

function briefPlot(plot: string): string {
  const parts = plot.trim().split(/\s+/);
  if (parts.length <= PLOT_WORDS) return plot.trim();
  return `${parts.slice(0, PLOT_WORDS).join(' ')}…`;
}

/** Normalised extras — the two detail endpoints answer different shapes. */
interface Extra {
  backdrop: string | null;
  plot: string | null;
  duration: string | null;
}

async function extraFor(slide: Slide): Promise<Extra> {
  /* A channel has no detail endpoint and needs none: what a hero shows for one is
     its own artwork and its name. */
  if (slide.section === 'live') {
    return { backdrop: null, plot: null, duration: null };
  }
  /*
   * The provider's own backdrop and plot, or none. TMDB used to fill what the
   * panel would not say, through our box; the box no longer answers that
   * (2026-10-01), so a title the panel says nothing about shows its poster and
   * its name.
   */
  return panelExtra(slide).catch((): Extra => ({ backdrop: null, plot: null, duration: null }));
}

async function panelExtra(slide: Slide): Promise<Extra> {
  if (slide.section === 'movies') {
    const d = await api.movieDetail(slide.item.id);
    return {
      backdrop: d.detail?.backdrops[0] ?? null,
      plot: d.detail?.plot ?? null,
      duration: d.detail?.duration ?? null,
    };
  }
  const d = await api.seriesDetail(slide.item.id);
  return {
    backdrop: d.meta?.backdrops?.[0] ?? null,
    plot: d.series.plot ?? null,
    duration: null,
  };
}

/**
 * One slide, owning its own metadata request.
 *
 * `near` is what keeps this affordable. A slide fetches its artwork only when it
 * is the one on screen or the one either side of it, so a visit costs three
 * requests rather than six — and because the featured set is day-stable, the
 * server answers all of them from a seven-day cache after the first visit of the
 * day. Rendering the neighbours is not optional: a slider needs something to
 * slide to.
 */
function HeroSlide({
  slide, active, near, held,
}: {
  slide: Slide; active: boolean; near: boolean; held: boolean;
}) {
  const extra = useQuery({
    queryKey: ['home', 'hero', slide.section, slide.item.id],
    queryFn: () => extraFor(slide),
    enabled: near,
    staleTime: 3_600_000,
    retry: false,
  });

  const item = slide.item;
  const title = cleanTitle(item.name);
  /* Watch position is kept for films and series only — a live channel has no
     "where I was", it has a now. */
  const rec = slide.section === 'live' ? null : getWatch(slide.section, item.streamId);
  const to = slide.section === 'movies'
    ? `/movie/${linkId(item)}`
    : slide.section === 'live'
      ? `/live?ch=${encodeURIComponent(linkId(item))}`
      : `/series/${linkId(item)}`;
  const year = item.year ? item.year.slice(0, 4) : null;
  const backdrop = extra.data?.backdrop ?? null;
  /* Only sampled when there is no backdrop, and only while the poster host is
     still answering — otherwise colour opens wsrv against a known-dead picon. */
  const tint = useArtColour(
    !backdrop && item.logo && !artIsDead(item.logo) ? apiUrl(item.logo) : null,
  );

  /*
   * A channel is not a film, and pretending otherwise is what made the hero look
   * broken on a device holding only free channels: no backdrop, no poster, a
   * transparent logo blurred to nothing, and a large dark rectangle where the
   * artwork should be. So a channel slide gets its own treatment — the logo shown
   * whole on a tinted panel, which is the only picture a channel actually has.
   */
  const channel = slide.section === 'live';

  return (
    <div className="relative h-full w-full shrink-0 overflow-hidden" aria-hidden={!active}>
      {channel && (
        <>
          {/* Never flat black: a wash of the brand accent, so an empty-looking
              area reads as a designed one. Square by declaration — `.hero-card`
              below is the rounded frame and it clips with `overflow-hidden`, so
              corners on the fill would be corners inside corners. */}
          <div aria-hidden className="channel-wash no-round absolute inset-0" />
          {item.logo && (
            <div
              aria-hidden
              className="absolute inset-y-0 right-0 hidden w-[42%] items-center justify-center p-8 sm:flex"
            >
              <span className="grid h-full w-full max-h-[15rem] place-items-center border border-rule/60
                               bg-ground/75 p-6">
                <img
                  src={apiUrl(artworkAt(item.logo, 320))}
                  alt=""
                  loading={near ? undefined : 'lazy'}
                  decoding="async"
                  className="max-h-full max-w-full object-contain drop-shadow-[0_4px_18px_rgb(0_0_0/.5)]"
                />
              </span>
            </div>
          )}
        </>
      )}
      {/*
        No backdrop from the panel, so the poster is shown WHOLE on a field made
        from its own colours.

        Three versions preceded this and the first two were both wrong. Blurring
        the poster across the frame gives a large out-of-focus area where the
        picture should be. Cropping it to 16:9 throws away two thirds of the
        image and reads as "the card, bigger". A 2:3 poster simply cannot become
        a 16:9 one.

        What works - and what Plex and Emby do - is to stop pretending: the
        poster keeps its shape and its sharpness, and the rest of the frame
        becomes a wash built from the poster's dominant colour. The two read as
        one composition instead of a small picture stranded on black. The colour
        is sampled from 256 pixels of the image itself, so it is always right for
        the title on screen, and falls back to the brand wash if the image
        cannot be read.
      */}
      {!channel && !backdrop && (
        <>
          {tint === null ? (
            /* Clipped by `.hero-card`; see the note on the other wash. */
            <div aria-hidden className="channel-wash no-round absolute inset-0" />
          ) : (
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  `radial-gradient(115% 95% at 78% 42%, rgb(${tint} / 0.62), transparent 68%),`
                  + ` linear-gradient(90deg, rgb(${tint} / 0.10), rgb(${tint} / 0.34))`,
              }}
            />
          )}
          {item.logo && (
            <div
              aria-hidden
              className="absolute inset-y-0 right-0 hidden w-[40%] items-center justify-center
                         p-5 sm:flex tv:right-[6%] tv:w-[34%] tv:p-8"
            >
              <img
                /* A hero poster is drawn about a third of the frame wide; asking
                   for the master copy of it was 192KB on average. See
                   lib/artwork.ts. */
                src={apiUrl(artworkAt(item.logo, 340))}
                alt=""
                loading={near ? undefined : 'lazy'}
                decoding="async"
                className="max-h-full max-w-full object-contain
                           drop-shadow-[0_10px_40px_rgb(0_0_0/.7)]"
              />
            </div>
          )}
        </>
      )}
      {backdrop && (
        <img
          key={backdrop}
          src={apiUrl(backdrop)}
          alt=""
          aria-hidden
          /*
            `near` already gated the metadata request and the comment above says
            why — three slides' worth, not six. It never gated the PICTURES,
            which are the expensive half: all six mounted, all six fetched a
            full-width backdrop on load. Lazy on the far ones hands that decision
            back to the browser, which will not fetch what is translated off
            screen.
          */
          loading={near ? undefined : 'lazy'}
          decoding="async"
          /*
            Bias to the right: the left half is copy + scrim, so the photograph
            should read on the open side — faces and set dressing land where
            the eye actually looks.
          */
          className={`anim-fade absolute inset-0 h-full w-full object-cover object-[70%_20%]
            ${active && !held ? 'anim-drift' : ''}`}
        />
      )}

      {/*
        Cover on the backdrop — the recognisable DVD art up front, photograph
        still visible around it on the right.

        Without a backdrop the poster already owns that side (branch above).
        With one, a small card buried under a full-frame wash was invisible in
        practice; size + lighter right scrim is what makes both read.
      */}
      {backdrop && item.logo && (
        <div
          aria-hidden
          className="absolute right-12 top-[42%] z-10 hidden w-[10.5rem] -translate-y-1/2
                     sm:right-14 sm:block sm:w-[12.5rem]
                     md:right-16 md:w-[14rem] xl:w-[16rem]
                     tv:right-[4.5rem] tv:w-[17rem]"
        >
          <Poster src={item.logo} alt="" className="shadow-[0_22px_60px_-10px_rgb(0_0_0/.9)]" />
        </div>
      )}

      {/* Scrims: top for the overlay header, bottom for the overlapping rail,
          left only so the right third keeps the photograph (and the cover). */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-ground via-ground/70 to-transparent" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ground via-ground/70 to-transparent" />
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 hidden w-[62%] bg-gradient-to-r
                   from-ground via-ground/80 to-transparent sm:block"
      />

      {/*
        Copy only on the active slide.

        Every slide sits in the same vertical band of the viewport — the track
        translates sideways — so inactive titles and synopses still measured as
        on-screen prose. Six featured plots turned /home into the densest route
        in the probe. Neighbours keep their artwork for the swipe; the words
        arrive with the slide that owns them.
      */}
      {/* `tv:pl-20` clears the previous-slide arrow. Bottom pad leaves room for
          the overlapping first rail. */}
      <div
        className={`relative flex h-full flex-col justify-end gap-2 p-4 pb-[min(28vh,12rem)]
                    sm:max-w-[36rem] sm:justify-center sm:gap-3 sm:p-8 sm:pb-[min(30vh,14rem)]
                    tv:max-w-[36rem] tv:pl-20
                    ${active ? '' : 'hidden'}`}
      >
        <div className="step flex flex-col gap-2 sm:gap-3">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[length:var(--t-2xs)] tracking-widest">
            <span className="chip pill border-tally/60 text-tally">
              {slide.section === 'movies' ? 'FILM' : slide.section === 'live' ? 'LIVE' : 'SERIES'}
            </span>
            {item.rating !== null && item.rating > 0 && (
              <span className="flex items-center gap-1 text-ink-2">
                <Star className="h-3 w-3 fill-current text-tally" />
                {item.rating.toFixed(1)}
              </span>
            )}
            {year && <span className="text-ink-3">{year}</span>}
            {extra.data?.duration && <span className="text-ink-3">{extra.data.duration}</span>}
          </div>

          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-ink
                         drop-shadow-[0_2px_12px_rgb(0_0_0/.55)] sm:text-[2.2rem]
                         tv:text-[length:var(--t-lg)]">
            {title}
          </h1>

          {extra.data?.plot && (
            <p className="line-clamp-2 max-w-prose text-[length:var(--t-sm)] leading-snug text-ink-2">
              {briefPlot(extra.data.plot)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* Films play from here: the detail route understands ?play=1 and
                resumes from the stored playhead on its own. A series has no one
                thing to play, so it opens. */}
            <Link
              to={slide.section === 'movies' ? `${to}?play=1` : to}
              tabIndex={active ? 0 : -1}
              className="btn btn-primary pill px-5 py-2.5"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              {slide.section === 'series' ? 'OPEN' : rec ? 'CONTINUE' : 'PLAY'}
            </Link>
            {/* Icon at rest — label only when focused/hovered. A channel has no
                detail page, so DETAILS would be the same link as PLAY. */}
            {!channel && (
              <Link
                to={to}
                tabIndex={active ? 0 : -1}
                aria-label="Details"
                className="dest btn gap-1.5 p-2.5"
              >
                <Info className="h-3.5 w-3.5" />
                <span className="dest-label">DETAILS</span>
              </Link>
            )}
            <FavButton
              section={slide.section}
              streamId={item.streamId}
              size="md"
              className="btn pill p-2.5"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The featured carousel.
 *
 * A real slider: the slides sit in a track that translates, so a change of slide
 * is a movement the eye can follow rather than one picture replacing another.
 * It advances itself, shows how long is left as a line rather than as nothing at
 * all, follows a finger, and stops the moment anyone touches, hovers or focuses
 * it — or the tab goes to the background, because an unattended carousel walking
 * through slides is how a page ends up having fetched everything it could.
 */
export function Spotlight() {
  const { scope } = useScope();
  const day = useMemo(() => dayNumber(Date.now(), new Date().getTimezoneOffset()), []);

  /* A rating floor rather than a rating sort: the panel gives a score with no
     vote count, so sorting by it puts a wall of single-vote 10.0 unknowns at the
     top. Recency is the honest signal; the floor keeps the obvious duds out. */
  const q = { sort: 'added' as const, dir: 'desc' as const, limit: 30, minRating: 7, ...scope };
  const movies = useQuery({
    queryKey: ['home', 'spotlight', 'movies', scope],
    queryFn: () => api.items('movies', q),
    staleTime: 600_000,
  });
  const series = useQuery({
    queryKey: ['home', 'spotlight', 'series', scope],
    queryFn: () => api.items('series', q),
    staleTime: 600_000,
  });

  /*
   * The fallback pool, fetched only when there is nothing else to feature.
   *
   * The rating floor above is right for a panel catalogue and fatal for a playlist
   * one: public lists carry no ratings, so every film was filtered out and the
   * hero rendered nothing at all. Channels have artwork and are what that device
   * is for. `enabled` keeps this off the wire for everyone else.
   */
  /*
   * And only on a library that HAS no films — not on one that has not fetched
   * them yet.
   *
   * "Sections leak to the home page": a subscription offering 66,709 films, with
   * none of its packages downloaded, answered both queries above with nothing —
   * so this fired, and the showcase opened on a hero of live channels with a
   * countries strip under it. Empty rows are not the same fact as an empty
   * library, and only the inventory can tell them apart.
   */
  const inventory = useInventory();
  const nothingRated = channelsOnly(inventory)
    && (movies.data?.rows.length ?? 0) === 0
    && (series.data?.rows.length ?? 0) === 0
    && !movies.isLoading && !series.isLoading;
  const live = useQuery({
    queryKey: ['home', 'spotlight', 'live', scope],
    queryFn: () => api.items('live', { sort: 'default' as const, limit: 30, ...scope }),
    enabled: nothingRated,
    staleTime: 600_000,
  });

  const slides = useMemo(
    () => spotlight(movies.data?.rows ?? [], series.data?.rows ?? [], {
      count: COUNT, day, live: live.data?.rows ?? [],
    }),
    [movies.data, series.data, live.data, day],
  );
  const n = slides.length;

  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<{ x: number; id: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const i = n === 0 ? 0 : ((at % n) + n) % n;

  const go = useCallback((delta: number) => setAt((x) => x + delta), []);

  useEffect(() => {
    if (n < 2 || held) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = window.setInterval(() => setAt((x) => x + 1), DWELL_MS);
    return () => window.clearInterval(t);
  }, [n, held]);

  useEffect(() => {
    const onVis = () => setHeld(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  /* Arrow keys, but only while the carousel actually has focus — a global
     handler here would fight the channel list and the player. */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };

  const onDown = (e: React.PointerEvent) => {
    // Mouse drags are for selecting text and clicking links; only touch and pen
    // get to swipe, which is also what keeps a click on PLAY from becoming a drag.
    if (e.pointerType === 'mouse') return;
    dragFrom.current = { x: e.clientX, id: e.pointerId };
    setHeld(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from || from.id !== e.pointerId) return;
    setDrag(e.clientX - from.x);
  };
  const onUp = (e: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from || from.id !== e.pointerId) return;
    const width = box.current?.clientWidth ?? 1;
    const moved = e.clientX - from.x;
    dragFrom.current = null;
    setDrag(0);
    setHeld(false);
    if (Math.abs(moved) > width * SWIPE) go(moved < 0 ? 1 : -1);
  };

  /* Full viewport — rails overlap the lower band; see Home.tsx. */
  const band = 'h-[100svh] min-h-[100svh]';

  if (movies.isLoading || series.isLoading) {
    return (
      <div className={`skeleton w-full ${band}`} />
    );
  }
  if (n === 0) return null;

  const near = new Set([(i - 1 + n) % n, i, (i + 1) % n]);

  return (
    <div className="relative">
      <section
        ref={box}
        aria-label="Featured"
        aria-roledescription="carousel"
        /*
          A section: the hero's own buttons and its slide picker belong together,
          and a press among them must not wander off into the rails underneath.
        */
        data-nav-scope
        tabIndex={0}
        onKeyDown={onKey}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        /*
          Edge-to-edge under a transparent header. No card chrome — a framed hero
          put a seam under the nav that the reference layout never has.
        */
        className={`group relative isolate overflow-hidden bg-panel
                    ${band} ${held ? 'hero-held' : ''} touch-pan-y select-none
                    focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
      >
        <div
          className="flex h-full"
          style={{
            transform: `translate3d(calc(${-i * 100}% + ${drag}px), 0, 0)`,
            transition: dragFrom.current ? 'none' : 'transform .62s cubic-bezier(.22,.9,.24,1)',
          }}
        >
          {slides.map((s, k) => (
            <HeroSlide
              key={`${s.section}-${s.item.id}`}
              slide={s}
              active={k === i}
              near={near.has(k)}
              held={held}
            />
          ))}
        </div>

        {n > 1 && (
          <>
            <HeroArrow side="left" onClick={() => go(-1)} />
            <HeroArrow side="right" onClick={() => go(1)} />
          </>
        )}

        {/* Wide glass gets the line-up as posters; phone gets dots. Television
            skips the strip entirely — LEFT/RIGHT already change slide, and six
            extra targets in the first screenful were pure chrome. */}
        {n > 1 && (
          <div
            /*
              A sign of where you are in the line-up, not a place to land.

              Measured: DOWN from PLAY jumped 736px to the right onto a slide
              thumbnail, and the next DOWN then entered a rail 444px off from
              there — two presses to travel most of the screen sideways without
              ever meaning to. The picker is a POINTER affordance; a remote
              changes slide with LEFT and RIGHT, which `onKey` above handles from
              anywhere in the hero because the keydown bubbles up to it. So the
              D-pad skips this strip and DOWN from the hero's buttons goes where
              it should, which is the first rail.
            */
            data-nav-skip
            className="absolute bottom-[min(26vh,11rem)] right-3 z-10 flex items-end gap-2
                       sm:right-5 tv:hidden"
          >
            {slides.map((s, k) => (
              <button
                key={`${s.section}-${s.item.id}`}
                type="button"
                onClick={() => setAt(k)}
                aria-label={`Featured ${k + 1} of ${n}: ${cleanTitle(s.item.name)}`}
                aria-current={k === i}
                className={`hidden shrink-0 transition-all duration-300 lg:block
                  ${k === i ? 'w-[5.5rem] opacity-100 tv:w-[7rem]' : 'w-[4.25rem] opacity-55 hover:opacity-90 tv:w-[5.5rem]'}`}
              >
                <Poster
                  src={s.item.logo}
                  alt=""
                  className={k === i ? 'border-tally shadow-2xl' : ''}
                />
              </button>
            ))}
            {slides.map((s, k) => (
              <button
                key={`dot-${s.section}-${s.item.id}`}
                type="button"
                onClick={() => setAt(k)}
                aria-label={`Featured ${k + 1} of ${n}`}
                className={`pill h-1.5 transition-all lg:hidden
                  ${k === i ? 'w-6 bg-tally' : 'w-2 bg-ink-3/60 hover:bg-ink-2'}`}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function HeroArrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous' : 'Next'}
      /* Hidden on glass, where the gesture is a swipe and the button would only
         cover the picture. `reveal` keeps it permanently visible on a remote. */
      className={`reveal pill absolute top-1/2 z-10 hidden -translate-y-1/2 border border-rule
                  bg-ground/92 p-2.5 text-ink-2 transition-colors
                  hover:border-tally hover:text-tally mouse:block tv:block
                  ${side === 'left' ? 'left-3' : 'right-3'}`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
