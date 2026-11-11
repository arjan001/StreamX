import { memo, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api';
import { monogram } from '../lib/monogram';
import { artIsDead, noteArtFailure, noteArtSuccess } from '../lib/deadArt';
import { artworkAt } from '../lib/artwork';
import { takeTurn, turnsApply } from '../lib/imageTurns';
import { whenOnScreen } from '../lib/onScreen';

/**
 * Artwork with a graceful failure. Provider logo URLs rot constantly — 291,309
 * distinct logo hosts in the reference catalogue — so a broken image must not
 * leave a hole in the grid.
 *
 * `src` arrives from `safeImage` already decided: an `https://` provider URL is
 * passed through, and a plaintext one — blocked as mixed content on an https
 * page — is fetched on the device by the APK's `/_img` route, or used as it is
 * on the website. `apiUrl` leaves an absolute address alone.
 *
 * ── why this is a frame around an image ──
 *
 * The border used to sit on the `<img>`, and the hover lift scaled that same
 * `<img>` by 1.02. Measured, that makes the 1px border render as 1.020px at a
 * fractional device offset, and pushes the tile 1.4px wider on each side — which
 * is more than the 2px of horizontal room the strip has, so an edge tile's side
 * border really is clipped.
 *
 * Being straight about the limit of that finding: a pixel read of the top edge at
 * device ratios 1, 1.25, 1.5 and 2 showed the scaled border still rendering at
 * full brightness, so scaling is NOT what made a border visibly vanish. The one
 * cause reproduced for that is clipping — `overflow-x: auto` computes `overflow-y`
 * to `auto`, so a scroller with no vertical clearance eats the top row of pixels
 * of anything that lifts inside it (`.rail` in index.css owns that clearance).
 *
 * So the frame owns the border and only ever translates by whole pixels, and the
 * image inside it is what zooms, against `overflow: hidden`. Same effect, a
 * measurably crisper edge, and nothing grows sideways into the clip.
 * `scripts/rail-probe.mjs` holds all of it.
 *
 * ── when there is no picture ──
 *
 * A generated tile, not two grey letters on a flat panel. Measured on this
 * catalogue: the host carrying 14,688 of the paid channel logos —
 * `203.0.113.40` — does not answer at all from here (8s, no connection, while
 * two other picon hosts in the same catalogue answer in 30-100ms), so a channel
 * list is a wall of identical grey squares. `lib/monogram.ts` already existed for
 * exactly this and its own comment counted 5,362 items pointing at picon hosts
 * that never answer; it was kept out of here on the grounds that a missing image
 * might be temporary. Seen on a television, a wall of grey squares is not
 * temporary-looking, it is broken-looking, and a deterministic colour per name is
 * something a viewer can actually navigate by.
 *
 * A URL that failed once is remembered for the session, so a virtualised list
 * that mounts the same row twenty times does not ask twenty times for an image
 * that is not coming.
 *
 * ── a dead host does not fail, it HANGS ──
 *
 * `onError` is not enough on its own, and this is the part that decides whether
 * any of the above is ever seen. Measured against the live catalogue: a request
 * to the picon host behind most of these logos gets no connection and no refusal
 * — the socket simply stays open. The browser holds it for its own timeout, which
 * is tens of seconds, and until then `complete` is false, `onError` has not
 * fired, and the tile is an empty frame. That is precisely what a channel list
 * full of blank squares is.
 *
 * So a tile that has not loaded within `SLOW_MS` is treated as dead. Eight
 * seconds is chosen against what these files are: picons are 3-20KB, so eight
 * seconds is already several times the worst honest case on a slow connection,
 * and the cost of being wrong is a generated tile where a logo would have
 * appeared — which is recovered on the next visit, since a timeout does NOT go
 * into `dead`.
 */

/**
 * URLs that have already failed outright. Module-level: it outlives a remount.
 *
 * Bounded the same way this file's neighbours bound their own module-level
 * caches — `REWRITTEN` in lib/artwork.ts, `titleCodecs` in lib/localRead.ts,
 * `cache` in lib/artColour.ts — because rapid scrolling was found to grow this
 * one without limit: thousands of tiles fail against the catalogue's known-dead
 * art host in a single fast pass (see the head of this file — `203.0.113.40`,
 * unreachable, carrying most of this catalogue's logos), each adding up to
 * three long URLs (the primary, the caller's fallback) that
 * were never once removed.
 *
 * `DEAD_MAX` follows `REWRITTEN_MAX` rather than the smaller `TITLE_CODEC_MAX`
 * or `CACHE_MAX`: like `REWRITTEN`, this is consulted across the WHOLE
 * catalogue rather than a handful of open titles or sampled heroes, and a Set
 * of bare URL strings costs less per entry than `REWRITTEN`'s rewritten-URL
 * values do, so matching its cap rather than undercutting it costs little.
 *
 * A `Set` already keeps insertion order, so — as `titleCodecs` and `cache` do
 * for their Maps — the oldest entry is whatever `dead.values().next()` yields,
 * and `rememberDead` below deletes it before re-adding on a write, for the same
 * reason those two delete before they set: so a URL that fails again after
 * surviving one eviction moves back to the young end instead of ageing out a
 * second time sooner than a URL that has only failed once.
 *
 * What a `.has()` read does NOT do is refresh that order — neither `titleCodec`
 * nor `cachedColour` moves an entry on a hit either, only a fresh write does,
 * and doing it here would mean touching this Set on every mount of every tile
 * in a long list rather than only on the failures that actually change it.
 * That is safe to skip: eviction only ever means "this URL may be tried once
 * more", never a wrong answer, since `failed` is decided once per mount and
 * once per `src` change (see the `useState` and `useEffect` below) and is never
 * re-checked against this Set while a tile just sits on screen unchanged. So a
 * tile that stays put cannot be made to flicker or retry by an eviction it
 * never asks about — the earliest it can ask again is a new mount or a changed
 * `src`, and either of those is a new question, not a repeat of the old one.
 */
const dead = new Set<string>();
const DEAD_MAX = 4_000;

function rememberDead(url: string): void {
  /* Delete before add so a URL failing again after eviction lands at the
     young end, exactly as `titleCodecs.set` and `rememberColour` do for their
     Maps — see the comment above. */
  dead.delete(url);
  dead.add(url);
  while (dead.size > DEAD_MAX) {
    const oldest = dead.values().next().value;
    if (oldest === undefined) break;
    dead.delete(oldest);
  }
}

/*
 * And the HOST is remembered too — see lib/deadArt.ts.
 *
 * The eight-second rule below is right for one image and wrong for a page of
 * forty from the same dead host: each tile waits its own eight seconds and a
 * home page arrives at the same answer forty times, holding forty sockets open
 * to do it. After several failures from a host that has never answered,
 * everything on it draws its tile immediately and asks for nothing.
 */

/** How long a tile may stay blank before the monogram takes over. */
const SLOW_MS = 8_000;

/**
 * The image, and the shimmer that stands where it will be.
 *
 * Asked for as "for images that its loading, cant to make like skeleton
 * loading? instead of partially loading images and stuff" — and it is the right
 * call for more than tidiness. A progressive JPEG on a slow connection paints
 * in bands, and a poster arriving in bands over a dark panel looks like a
 * corrupt file rather than a loading one; worse, the browser lays the element
 * out at its intrinsic size the moment the header arrives, so a rail visibly
 * re-flows while it fills.
 *
 * So the frame carries `.skeleton` — the same shimmer every other pending
 * surface in this app uses — and the image is invisible until it has ALL
 * arrived, then crosses over in 200ms. `decoding="async"` keeps the decode off
 * the frame that reveals it, which matters on a TV box where that thread is
 * also compositing video.
 *
 * `complete` is checked on mount because a cached image can finish before React
 * attaches the handler, and an image that never fires `onLoad` would sit at
 * `opacity-0` forever — the same class of bug as the eight-second hang below,
 * arriving from the opposite direction.
 */
function Art({ url, alt, fit, frame, onFail, onOk }: {
  url: string;
  alt: string;
  fit: 'cover' | 'contain';
  frame: string;
  onFail: () => void;
  /** One picture that arrived — proof the host is answering. */
  onOk?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const img = useRef<HTMLImageElement | null>(null);
  const frameEl = useRef<HTMLSpanElement | null>(null);
  /*
   * On the television a picture waits for its turn — see `lib/imageTurns.ts`.
   * A drawn cover (`data:`) is not fetched from anywhere and never waits.
   */
  const rationed = turnsApply() && !/^(data|blob):/i.test(url);
  const [turn, setTurn] = useState(!rationed);
  /* Breathes only once it has been on screen: an overscan row's placeholder
     that pulses unseen costs the television a frame, every frame. */
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = frameEl.current;
    if (el === null || loaded) return undefined;
    return whenOnScreen(el, () => setSeen(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  const giveBack = useRef<(() => void) | null>(null);
  const release = () => { giveBack.current?.(); giveBack.current = null; };
  useEffect(() => {
    if (!rationed) return undefined;
    const el = frameEl.current;
    const ask = () => { if (giveBack.current === null) giveBack.current = takeTurn(() => setTurn(true)); };
    if (el === null) {
      ask();
      return release;
    }
    /* Only once it is on screen: an overscan row asking first would hold a
       turn with a lazy image that never loads. One shared observer for every
       tile — see lib/onScreen.ts. */
    const stop = whenOnScreen(el, ask);
    return () => { stop(); release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, rationed]);
  const fail = useRef(onFail);
  fail.current = () => { release(); onFail(); };
  const ok = () => {
    release();
    setLoaded(true);
    if (onOk !== undefined) onOk();
  };

  /*
   * The hang, given a deadline — and the deadline starts when the browser
   * starts, not when React mounts the tile.
   *
   * Every tile is `loading="lazy"`, so an off-screen one is NOT fetched.
   * A deadline armed on mount then expired on those un-requested tiles,
   * charged each silence to their host, and condemned `image.tmdb.org`.
   * An image that was never asked for cannot have been refused, so the
   * timer arms on the tile becoming visible.
   */
  useEffect(() => {
    const el = img.current;
    if (el === null || !turn) return undefined;
    if (el.complete && el.naturalWidth > 0) return undefined;
    let timer = 0;
    const arm = () => {
      if (timer !== 0) return;
      timer = window.setTimeout(() => {
        const now = img.current;
        if (now !== null && now.complete && now.naturalWidth > 0) return;
        fail.current();
      }, SLOW_MS);
    };
    const stop = whenOnScreen(el, arm);
    return () => {
      stop();
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [url, turn]);

  return (
    <span ref={frameEl} className={`${frame} ${loaded ? '' : seen ? 'skeleton' : 'skeleton-still'}`}>
      {turn && <img
        ref={(el) => {
          img.current = el;
          if (el !== null && el.complete && el.naturalWidth > 0) ok();
        }}
        src={apiUrl(url)}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={ok}
        onError={() => fail.current()}
        className={`art-img h-full w-full transition-opacity duration-200
          ${loaded ? 'opacity-100' : 'opacity-0'}
          ${fit === 'contain' ? 'object-contain p-1.5' : 'object-cover'}`}
      />}
    </span>
  );
}

/**
 * How wide each shape is drawn, in CSS pixels, when the caller does not say.
 *
 * Only a fallback — the poster grid passes its measured `cardWidth`, which is
 * the number that matters. These cover the places a picture is one fixed size:
 * a 36px row logo, a 16:9 rail tile, a square grid cell. Generous rather than
 * exact, because asking for slightly too much is a soft cost and asking for too
 * little is a visibly blurry tile.
 */
const DEFAULT_WIDTH = { poster: 180, wide: 320, square: 180, logo: 56 } as const;

/**
 * Memoised, because the tile around it re-renders for reasons the picture does
 * not share.
 *
 * `PosterCard` reads `usePrefs`, and every preference write hands every consumer
 * a fresh object — so saving the playhead, which `useWatchProgress` does every
 * four seconds while something plays, re-rendered every mounted tile. Measured
 * at 960x540 on a 4x-throttled CPU with 30 tiles on screen, one preference write
 * cost 29.7ms of script; the picture is the deepest part of that tree (its own
 * state, an IntersectionObserver effect, a monogram) and its props are all
 * primitives, so a shallow compare skips it entirely.
 *
 * The props MUST stay primitive for this to hold. `width` arrives from the
 * grid's measurement and `src`/`alt` from the row; none of them is an object,
 * and adding one would silently turn this back into a full re-render.
 */
export const Poster = memo(PosterArt);

function PosterArt({
  src,
  alt,
  className,
  fallback,
  ratio = 'poster',
  fit = 'cover',
  width,
}: {
  src: string | null;
  /**
   * The DISPLAY name — `displayName(row.name)` — never the raw catalogue string.
   *
   * This is not only what a screen reader says. It is also what `monogram`
   * draws its initials from: `initialsOf` splits on words, and `BE| VTM 4` gives
   * the tile "BV" where "VTM 4" gives it "VT".
   */
  alt: string;
  /** Frame-level classes: border colour, shadow, box. Never image content. */
  className?: string;
  /**
   * `poster` is 2:3 artwork. The other three are all the channel-logo case.
   *
   * A channel has a LOGO, not a poster: a transparent PNG of no fixed shape —
   * a wide wordmark, a round bug, a square badge. `logo` is the 36px version for
   * a list row, `wide` the 16:9 one for a rail, and `square` the grid-cell one,
   * which is the shape that wastes the least room on a wordmark and crops
   * nothing at all. Whichever you pick, pair it with `fit="contain"`.
   */
  ratio?: 'poster' | 'logo' | 'wide' | 'square';
  /** Channel logos are transparent PNGs of wildly varying shape, so they are
   *  contained rather than cropped — cover would slice the wordmark in half. */
  fit?: 'cover' | 'contain';
  /**
   * How wide this will actually be drawn, in CSS pixels.
   *
   * Passed to `artworkAt`, which asks the origin for that size instead of its
   * master copy. Worth threading from anywhere that already knows the number:
   * the poster grid measures a card width every layout, and using it is the
   * difference between a 35KB tile and a 1.3MB one.
   */
  width?: number;
  /**
   * A second picture of the SAME thing, tried before giving up.
   *
   * "Same for images, i think if one doesnt work it doesnt go to others, then
   * then nothing." For a grid tile the device knows only one URL — but
   * a film's detail page holds both a poster and a backdrop, and it was showing
   * two grey letters while the backdrop sat unused. The hero only substituted
   * when the poster's host had ALREADY been written off this session, which on a
   * cold start is never: the first film opened still failed to a monogram.
   *
   * Same title, already known, so there is no chance of showing the wrong film's
   * artwork — which is the reason a name-matched poster is not offered here.
   */
  fallback?: string | null;
}) {
  const [failed, setFailed] = useState(() => (src === null ? false : dead.has(src) || artIsDead(src)));
  /** The caller's second picture, once this one has been tried and failed. */
  const [fallbackFailed, setFallbackFailed] = useState(false);
  /* Virtualised grids reuse the same cell for a new title. Without a reset, a
     failed load on the previous title left every later title in that cell as a
     monogram — and a successful previous image briefly sat under the next name. */
  useEffect(() => {
    setFailed(src === null || src === '' ? true : dead.has(src) || artIsDead(src));
    setFallbackFailed(false);
  }, [src]);
  /* The size this box will be drawn at, which is what the origin should send.
     See lib/artwork.ts — this is the single largest cost in the app. */
  const drawnAt = width !== undefined && width > 0 ? width : DEFAULT_WIDTH[ratio];
  const box =
    ratio === 'poster'
      ? 'aspect-[2/3] w-full'
      : ratio === 'wide'
        ? 'aspect-video w-full'
        : ratio === 'square'
          ? 'aspect-square w-full'
          /* 40px, not 36. A channel logo is the only thing distinguishing a
             hundred rows of similar text, and the mockup's tile is comfortably
             larger than the type beside it rather than the same height as it —
             which is the difference between a list you scan by picture and one
             you have to read. */
          : 'h-10 w-10 shrink-0';
  // `art` is the hover contract: the frame lifts, the image inside it zooms, and
  // both are driven from `.tile:hover` — see index.css.
  const frame = `art ${box} ${className ?? ''} block overflow-hidden border border-rule bg-panel-2`;

  /*
   * The caller's second picture, when the first fails.
   *
   * It is the same title's own artwork rather than a name match, so it is the
   * better answer wherever it exists — and it exists exactly where the monogram
   * looked worst, on a detail page four hundred pixels wide.
   */
  const second = fallback === undefined || fallback === null || fallback === '' || fallback === src
    ? null
    : fallback;
  if (second !== null && !fallbackFailed && (src === null || src === '' || failed)) {
    return (
      <Art
        key={second}
        url={artworkAt(second, drawnAt)}
        alt={alt}
        fit={fit}
        frame={frame}
        onFail={() => { rememberDead(second); noteArtFailure(second); setFallbackFailed(true); }}
        onOk={() => noteArtSuccess(second)}
      />
    );
  }

  if (!src || failed) {
    const m = monogram(alt === '' ? '··' : alt);
    /* The initials scale with the box: a 36px channel tile and a full poster
       cannot carry the same type size, and 10px lost in the middle of a poster is
       what made the old fallback read as an empty frame. */
    const text = ratio === 'logo'
      ? 'text-[length:var(--t-2xs)]'
      : ratio === 'wide' || ratio === 'square' ? 'text-base' : 'text-xl';
    return (
      <span
        className={`${frame} grid place-items-center font-mono ${text}`}
        style={{ background: m.background, color: m.colour }}
        aria-hidden
      >
        {m.initials}
      </span>
    );
  }
  return (
    <Art
      /* Keyed on what is actually being fetched, so a new picture remounts and
         restarts the slow-host deadline rather than inheriting a timer that has
         already half expired. */
      key={src}
      url={artworkAt(src, drawnAt)}
      alt={alt}
      fit={fit}
      frame={frame}
      onFail={() => {
        /* `deadArt` unwraps a wrapped url back to the origin, so the dead-host
           tally is about the picture rather than the route taken to it. */
        rememberDead(src);
        noteArtFailure(src);
        setFailed(true);
      }}
      onOk={() => noteArtSuccess(src)}
    />
  );
}
