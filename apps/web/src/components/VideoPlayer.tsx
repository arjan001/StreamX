import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShape } from '../lib/formFactor';
import { cssOf, startAmbient, startNativeAmbient } from '../lib/ambient';
import { usePrefs } from '../lib/prefs';
import { diagnose } from '../lib/codecs';
import { useCapabilities } from '../lib/capabilityStore';
import {
  Play, Pause, Volume2, VolumeX, Maximize2, Minimize2, ClosedCaption, Send,
  Settings, Radio, Loader2, AlertTriangle, RotateCcw, RotateCw, Proportions, Subtitles,
  Gauge, SkipBack, SkipForward, X,
  ArrowLeft, ListOrdered, AudioLines, Info, Columns2, PictureInPicture2,
  History, SlidersHorizontal,
} from 'lucide-react';
import {
  player,
  type AspectMode, type LiveMode, type PlayerSnapshot, type TrackOption,
} from '../lib/playerCore';
import {
  bufferChoiceLabel, getChannelBufferChoice, getGlobalBufferChoice,
  resolveBufferProfile, setChannelBufferChoice, type BufferChoice,
} from '../lib/liveBuffer';
import { BufferChoiceControls } from './LiveBufferControls';
import { captions, type CaptionState } from '../lib/liveCaptions';
import { currentPlatform, liveCaptionsPossible } from '../lib/platform';
import type { Variant } from '../lib/api';
import { displayName } from '../lib/displayName';
import { noteShellHide } from '../lib/shellState';
import { CaptionControls, CaptionLines, TranscriptSheet } from './CaptionOverlay';
import { SubtitleMenu, type SubtitleContext } from './SubtitleMenu';
import { useWatchProgress, type WatchKey } from '../lib/watch';
import { digitOf, type RemoteIntent } from '../lib/remoteKeys';
import { chapterAt, chapters, digitSeek, skipTo } from '../lib/chapters';
import { frameSecond } from '../lib/devicePreview';
import { arrowAction, seekBarNudge, type ArrowIntent } from '../lib/playerArrows';
import { showDiagnostics } from '../lib/direct';
import { sendDebugReport, useDebugEnabled, type ReportOutcome } from '../lib/debugLog';
import { isTypingTarget, useKeyLayer, type Binding } from '../lib/keys';
import { focusFirst, moveWithin } from '../lib/spatialNav';
import { pushBackHandler } from '../lib/nativeBack';
import { LoadingMark } from './LoadingMark';
import { nativeEngine, setImmersive, setScreenAwake } from '../lib/nativePlayer';
import {
  forgetLearnedEngines, getEnginePref, hasNativeEngine, setEnginePref, type EnginePref,
} from '../lib/nativePlayer';

/**
 * The decoder choices, in the order someone reasons about them.
 *
 * `auto` first because it is right for nearly everyone: the browser is faster to
 * start and keeps the features the page composites over the picture, and the one
 * thing it cannot do — decode the tail — now escalates on its own.
 */
/**
 * Live transport, with `auto` first because it is the answer.
 *
 * The other two are kept visible and not hidden behind a "developer" flap: the
 * fastest way to tell whether a stream problem is the transport is to pin the
 * transport, and anyone debugging their own channel deserves that switch.
 */
const LIVE_MODES: { id: LiveMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'falls back per channel' },
  { id: 'lowLatency', label: 'Low latency', hint: 'raw TS, ~1-3s' },
  { id: 'compatible', label: 'Compatible', hint: 'HLS, ~30s' },
];

const ENGINES: { id: EnginePref; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'escalates on failure' },
  { id: 'native', label: 'Native player', hint: 'libVLC' },
  { id: 'webview', label: 'Browser only', hint: 'no libVLC' },
];

const ASPECTS: { id: AspectMode; label: string }[] = [
  { id: 'contain', label: 'Fit' },
  { id: 'cover', label: 'Crop' },
  { id: 'fill', label: 'Stretch' },
  { id: '16:9', label: '16:9' },
  { id: '4:3', label: '4:3' },
];

/** The four keys a remote's directional pad sends, which the player shares. */
/* The four intents that are shared with focus movement, so the player only claims
   them while it actually owns the arrows. */
const ARROW_INTENTS = new Set<RemoteIntent>(['up', 'down', 'left', 'right']);
/* A membership test the compiler believes, so what the arrows DO can be a
   table over four names rather than four names and a cast. */
const isArrow = (i: RemoteIntent): i is ArrowIntent => ARROW_INTENTS.has(i);

/**
 * Aspect, as a cycle.
 *
 * A remote's picture-size button steps through modes; it has no menu to open. The
 * order matches the buttons in the settings drawer so the two agree.
 */
function nextAspect(current: AspectMode): AspectMode {
  const order: AspectMode[] = ['contain', 'cover', 'fill'];
  const i = order.indexOf(current);
  return order[(i + 1) % order.length] ?? 'contain';
}

/**
 * The next track in a list, wrapping through "off".
 *
 * Subtitles wrap to -1 (off) because a viewer cycling with one button needs a way
 * back to no subtitles; audio does not, because "no audio track" is not a state
 * anyone wants to land on by pressing a button twice.
 */
function cycleTrack(tracks: TrackOption[], allowOff: boolean): number {
  const at = tracks.findIndex((t) => t.active);
  const next = at + 1;
  if (next < tracks.length) return tracks[next]?.id ?? -1;
  return allowOff ? -1 : tracks[0]?.id ?? -1;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * A failed stream is retried by the player, not by the viewer.
 *
 *     why just don't show this playback failed just retry At least that way it
 *     will never stop people
 *
 * Right, and the reason it did not is that `onRetry` — the thing the RETRY
 * button calls, which WORKS — was only ever wired to a press. Everything the
 * player could not fix ended at a panel over the picture waiting for a human,
 * including the failures that are a busy line for two seconds.
 *
 * So the button's own handler runs on a timer first. The panel is only what
 * happens after this many attempts have not helped, which is the case where a
 * person really is needed — a file nothing here can decode does not become
 * decodable by asking again.
 *
 * The waits below are not a smooth curve on purpose: the first is short
 * because most of these are a moment's contention and come back at once, and
 * the last is long because by then it is not.
 */
const AUTO_RETRY_MS = [700, 2_000, 5_000, 10_000, 20_000] as const;

/** How long a player notice stays up on its own before it waits for the chrome. */
const NOTICE_FRESH_MS = 12_000;

/**
 * Can the Fullscreen API do anything here?
 *
 * No, inside the APK, and provably: Capacitor's `BridgeWebChromeClient`
 * implements `onShowCustomView` as `callback.onCustomViewHidden()`, so Chromium
 * asks to go fullscreen and is refused in the same call. `requestFullscreen()`
 * does not reject — nothing throws, nothing changes, and the button reads as
 * broken. Asking the platform question up front is cheaper than trying to
 * detect a silent refusal after the fact.
 *
 * `fullscreenEnabled` covers the browser cases that also say no: a sandboxed
 * frame, or a policy that forbids it.
 */
const FULLSCREEN_API = (import.meta.env?.VITE_PLATFORM as string | undefined) !== 'capacitor'
  && typeof document !== 'undefined'
  && document.fullscreenEnabled === true;

/**
 * The sections of the player menu.
 *
 * `info` is new and is the reason the menu changed shape: "move the theater and
 * that info thing all in the player itself along side those other things, and
 * the info in the menu". It used to be a button UNDER the picture belonging to
 * the route, which meant the player had a menu and the page had a second one.
 *
 * `stream` was called `tuning`, which is jargon for the two questions it
 * actually answers — how far behind live to sit, and which decoder to use.
 * Nothing it does was removed; the word was.
 */
type Tab = 'info' | 'quality' | 'audio' | 'subs' | 'stream' | 'jump' | 'view';

const clock = (s: number): string => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

function SeekBar({
  duration, current, buffered, onSeek, stops = [], held = [], frameAt = null,
}: {
  duration: number;
  current: number;
  buffered: number;
  onSeek: (t: number) => void;
  /** Section starts, in seconds. Drawn as ticks; see lib/chapters.ts. */
  stops?: readonly number[];
  /**
   * Every stretch of the film already downloaded — see `PlayerSnapshot.heldSpans`.
   *
   * More than one only where the page owns the buffer: a shaded piece is
   * somewhere the picture will appear the instant it is asked for. Empty
   * everywhere else, where `buffered` says all there is to say.
   */
  held?: readonly { start: number; end: number }[];
  /**
   * The frame at a second, decoded on the device — see `devicePreview.ts`.
   */
  frameAt?: ((t: number) => Promise<string | null>) | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [scrub, setScrub] = useState<number | null>(null);
  /** Where the pointer is over the bar, for the readout. Null when it is not. */
  const [hover, setHover] = useState<number | null>(null);
  /**
   * "when moving it arround you should show a tooltipp or popover to show the time".
   *
   * A mouse can hover and a remote cannot, so the readout has to appear for a
   * press as well — and a press arrives here as nothing but a changed `current`.
   * A JUMP is the thing worth labelling: playback moves a second at a time and
   * would otherwise keep the bubble on screen for the whole film, so only a
   * change too big to be playback counts, and it fades on its own.
   */
  const [jumped, setJumped] = useState(false);
  const was = useRef(current);
  const hide = useRef(0);
  useEffect(() => {
    const moved = Math.abs(current - was.current);
    was.current = current;
    if (moved < 1.5) return;
    setJumped(true);
    /* The timer is held in a ref rather than returned as this effect's
       cleanup. `current` changes several times a second while a film plays, so
       a returned cleanup would be run by the very next tick and the readout
       would flash for a fraction of the time it is meant to be up. */
    window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setJumped(false), 1_400);
  }, [current]);
  useEffect(() => () => window.clearTimeout(hide.current), []);

  const timeAt = (clientX: number): number => {
    const el = track.current;
    if (!el || duration <= 0) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };

  const shown = scrub ?? current;
  const pct = duration > 0 ? Math.min(100, Math.max(0, (shown / duration) * 100)) : 0;
  const buf = duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;
  const at = hover ?? shown;
  /*
   * The bubble sits over the point it is describing, and is pushed back onto
   * the screen only as far as it has to be.
   *
   * The first version clamped the POSITION to between 10% and 90% of the bar so
   * it could never hang off the end. That is a bubble that lies: hover at the
   * very start of a film and the label reads 0:18 while the card floats a tenth
   * of the way along, pointing at nothing. Photographed exactly like that.
   *
   * What actually needs clamping is the card's own edges, in pixels, against
   * the bar's own width — which is measurable, so it is measured. Until the
   * first measurement lands the card is centred honestly and may overhang by a
   * few pixels for one frame, which is the right way round to be wrong.
   */
  const [cardW, setCardW] = useState(0);
  /* Measured rather than read off the ref during render: a ref is null on the
     first one, and nothing would re-measure it when the window changes. */
  const [barW, setBarW] = useState(0);
  useEffect(() => {
    const el = track.current;
    if (el === null) return undefined;
    const measure = () => setBarW(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const anchor = duration > 0 ? Math.min(1, Math.max(0, at / duration)) : 0;
  const half = cardW / 2;
  const nudged = barW > 0 && cardW > 0
    ? Math.min(barW - half, Math.max(half, anchor * barW))
    : anchor * barW;
  const readout = duration > 0 && (hover !== null || scrub !== null || jumped)
    ? { text: clock(at), left: barW > 0 ? nudged : 0, ready: barW > 0 }
    : null;
  /* Bigger while a finger or a mouse button is actually holding the bar: that
     is somebody looking for a place, not glancing at a time. */
  const holding = scrub !== null;

  const showing = readout !== null && duration > 0;
  /* Snapped to the same grid the decoder caches on, so a drag across an hour
     asks for a few dozen frames rather than a few thousand. */
  const spot = showing && frameAt !== null ? frameSecond(at) : null;

  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (spot === null || frameAt === null) { setFrame(null); return undefined; }
    let alive = true;
    /* Never throws and never rejects — a seek bar is not a place to report
       that a decoder did not like a keyframe. */
    void frameAt(spot).then((url) => { if (alive) setFrame(url); });
    return () => { alive = false; };
  }, [spot, frameAt]);

  return (
    <div
      ref={track}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.floor(duration)}
      aria-valuenow={Math.floor(shown)}
      tabIndex={0}
      /* LEFT and RIGHT on this bar move the playhead — see `handle`. The rule
         lives up there rather than in an `onKeyDown` here because the player's
         key layer runs above spatial navigation, and a React handler on this
         div would fire after focus had already been moved off the bar. */
      data-seek-bar
      className="relative flex h-4 flex-1 cursor-pointer items-center touch-none rounded-[var(--r-full)]"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        const t = timeAt(e.clientX);
        setScrub(t);
        onSeek(t);
      }}
      onPointerMove={(e) => {
        const t = timeAt(e.clientX);
        /* Hovering reads the bar; dragging moves it. Both want the readout. */
        setHover(t);
        if (!dragging.current) return;
        setScrub(t);
        onSeek(t);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        onSeek(timeAt(e.clientX));
        setScrub(null);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setScrub(null);
      }}
    >
      {readout !== null && (
        <div
          aria-hidden
          ref={(el) => {
            const w = el?.getBoundingClientRect().width ?? 0;
            if (w > 0 && Math.abs(w - cardW) > 1) setCardW(w);
          }}
          className="pointer-events-none absolute bottom-full z-10 mb-2 flex -translate-x-1/2
            flex-col items-center overflow-hidden rounded bg-ground/95 ring-1 ring-rule"
          style={{ left: `${readout.left}px`, visibility: readout.ready ? 'visible' : 'hidden' }}
        >
          {frame !== null && (
            <span className={`block overflow-hidden border-b border-rule
              ${holding ? 'w-64 sm:w-80' : 'w-40 sm:w-48'}`}
            >
              <img
                src={frame}
                alt=""
                className="block w-full"
              />
            </span>
          )}
          <span className="px-2 py-0.5 text-xs font-medium tabular-nums text-ink">
            {readout.text}
          </span>
        </div>
      )}
      <div className="meter relative h-1 w-full bg-rule">
        {/*
          What is downloaded. One stretch from the element, or every stretch
          the page is holding — drawn the same way, because to a viewer they
          mean the same thing: press here and it plays at once.

          `ink-2/85` and not the `ink-3/50` this was, which was invisible.
          Measured against the track it sits on, in every theme:

            dark 1.81:1 · light 1.60:1 · midnight 1.75:1 · daylight 1.72:1

          The floor for a part of an interface carrying meaning is 3:1 (WCAG
          1.4.11), and this is a four-pixel-tall band seen from a sofa, so the
          floor is the floor rather than a target. `ink-2/85` measures
          3.86-4.81:1 across the same four and stays well under the played
          fill, so the three layers still read in the right order: track,
          downloaded, watched.
        */}
        {held.length > 0
          ? held.map((h) => (
            <div
              key={`${h.start}-${h.end}`}
              className="absolute inset-y-0 bg-ink-2/85"
              style={{
                left: `${Math.max(0, (h.start / duration) * 100)}%`,
                width: `${Math.max(0, ((h.end - h.start) / duration) * 100)}%`,
              }}
            />
          ))
          : <div className="absolute inset-y-0 left-0 bg-ink-2/85" style={{ width: `${buf}%` }} />}
        {/*
          Taller than the band beside it, on purpose.

          Colour alone does not separate these two everywhere: in `carbon light`
          the downloaded band and the watched fill measure **1.03:1** against
          each other — a dark grey and a dark teal at the same luminance — and
          no tuning of one token fixes that without changing palettes. A SHAPE
          difference needs no palette to cooperate. The watched fill stands a
          pixel proud of the track top and bottom, so where it ends there is a
          step in the bar itself, at any contrast, in all twenty-one. The handle
          marks the same point; this is what marks it when nobody is looking
          straight at the handle.
        */}
        <div className="absolute -inset-y-px left-0 bg-tally" style={{ width: `${pct}%` }} />
        {/* The stops, drawn on the bar itself: this is what turns "somewhere in
            two and a half hours" into a countable number of places, and it is the
            same list the jump panel and the remote's chapter buttons use. */}
        {stops.map((t) => (
          <span
            key={t}
            aria-hidden
            className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-ground/80"
            style={{ left: `${(t / duration) * 100}%` }}
          />
        ))}
        <div
          className="meter-knob absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 bg-tally"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Live delay scrubber: left = furthest held behind, right = live edge.
 *
 * The stream keeps downloading at the head while the playhead sits anywhere in
 * the window — scrubbing chooses the lag; it does not stop the buffer filling.
 */
/**
 * Within this of the live edge, you are AT the edge.
 *
 * A live stream is never exactly at its own end — there is always a segment in
 * flight — so a bar that measured the truth would show a handle that never quite
 * reaches the right and a readout that never quite says zero.
 */
const LIVE_EDGE_S = 5;

function LiveDelayBar({
  start, end, current, onSeek,
}: {
  start: number;
  end: number;
  current: number;
  onSeek: (t: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [scrub, setScrub] = useState<number | null>(null);
  /**
   * The bar is measured from the LIVE EDGE, not from the start of the buffer.
   *
   * "why isnt it like youtube live, i mean when you watch live it stays at the
   * end … it will only add space at the end". A live buffer is evicted from the
   * front as it grows at the back, so anchoring the handle to `start` moved it
   * every few seconds while nothing about the viewing position had changed —
   * photographed at a third of the way along a bar whose readout said −0:25.
   *
   * Anchored to `end` instead, the handle means one thing: how far behind live
   * you are. It sits at the right while you are live and stays there, and the
   * window only ever GROWS at the left as more of the stream becomes seekable.
   * `held` is that grown width — the widest window this stream has offered — so
   * the scale under the handle stops breathing too. A seek is still clamped to
   * what the buffer actually holds, so the bar can never offer a position the
   * player would refuse.
   */
  /*
   * The scale is what is REACHABLE right now, not the widest it has ever been.
   *
   * The first version of this held the widest window seen, to stop the scale
   * breathing while the buffer filled and was trimmed. That is a bar that lies:
   * with a window trimmed to half, dragging the handle all the way left still
   * left it sitting in the middle, because the middle was where the true edge
   * now was. "It only works halfway" is what that looks like from the sofa.
   *
   * So the span is the live window, and the steadiness comes from the buffer
   * instead — `autoCleanupMinBackwardDuration` in `playerCore` keeps it from
   * halving underneath this.
   */
  const span = Math.max(end - start, 1);
  const shown = scrub ?? current;
  const lag = Math.max(0, end - shown);
  const atLive = lag <= LIVE_EDGE_S;
  const pct = atLive ? 100 : Math.min(100, Math.max(0, (1 - lag / span) * 100));

  const timeAt = (clientX: number): number => {
    const el = track.current;
    if (!el || span <= 0) return end;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return end;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    /* From the right: the handle's distance from the end IS the delay. Clamped
       into the real window, which may be narrower than the scale. */
    return Math.min(end, Math.max(start, end - (1 - f) * span));
  };

  return (
    /*
      The readout trails the bar rather than leading it.

      It used to sit before the track, which on the timeline row read as a
      number stranded on its own at the left with nothing to its right — "a
      '-0:05' delay readout floating on its own line above the bar's left
      end", photographed. VOD puts its own number, duration, at the END of
      its line (`[elapsed] [SeekBar] [duration]`); this is the same shape
      with one number instead of two, so it goes at the end too, inline on
      the one timeline line rather than floating anywhere.
    */
    <>
      <div
        ref={track}
        role="slider"
        aria-label="Seconds behind live"
        aria-valuemin={0}
        aria-valuemax={Math.floor(span)}
        aria-valuenow={Math.floor(lag)}
        tabIndex={0}
        /* Same as the film bar: the arrows move the playhead while this is the
           selected control. A live scrubber a remote cannot move is a control
           that only exists for a mouse. */
        data-seek-bar
        className="relative flex h-4 flex-1 cursor-pointer items-center touch-none rounded-[var(--r-full)]"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const t = timeAt(e.clientX);
          setScrub(t);
          onSeek(t);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const t = timeAt(e.clientX);
          setScrub(t);
          onSeek(t);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          onSeek(timeAt(e.clientX));
          setScrub(null);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setScrub(null);
        }}
      >
        <div className="meter relative h-1 w-full bg-rule">
          <div className="absolute inset-y-0 left-0 bg-tally/40" style={{ width: '100%' }} />
          <div className="absolute inset-y-0 left-0 bg-tally" style={{ width: `${pct}%` }} />
          <div
            className="meter-knob absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 bg-tally"
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
      {/* At the edge it says so, rather than counting a delay nobody chose. */}
      <span className={`shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums
                        ${atLive ? 'uppercase tracking-widest text-tally' : 'text-ink-2'}`}>
        {atLive ? 'LIVE' : `−${clock(lag)}`}
      </span>
    </>
  );
}

function AspectPicker({ value }: { value: AspectMode }) {
  return (
    <>
      <p className="menu-label">ASPECT</p>
      <div className="flex flex-wrap gap-1 p-2 pt-0">
        {ASPECTS.map((a) => (
          <button
            key={a.id}
            onClick={() => player.setAspect(a.id)}
            className={`border px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
              ${value === a.id ? 'border-tally text-tally' : 'border-rule text-ink-2 hover:text-ink'}`}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}

function TrackList({
  options, onPick,
}: { options: TrackOption[]; onPick: (id: number) => void }) {
  return (
    <div>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onPick(o.id)}
          className={`menu-row ${o.active ? 'is-on' : ''}`}
        >
          <span className="dot" />
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function VideoPlayer({
  className,
  onRetry,
  onBufferChange,
  streamKey,
  subtitleContext,
  variants,
  onPickVariant,
  qualityMode,
  onQualityMode,
  resume,
  allowCaptions: allowCaptionsAsked = true,
  onClose,
  onPrev,
  onNext,
  onGuide,
  onRestart,
  restarted = false,
  onGoLive,
  idleHint,
  info,
  theatre,
  liveMode,
  onLiveMode,
  screenFilled,
  nowPlaying,
  /** Force the video to cover the full container, eliminating letterbox bars.
      Used by the sports view so the pitch fills the screen. */
  forceCover = false,
}: {
  className?: string;
  onRetry?: () => void;
  /** Fires when the buffer profile changes; the caller reloads the stream. */
  onBufferChange?: () => void;
  /**
   * Stable live-channel identity (`1.<id>` / catalogue ref). When set, the Stream
   * buffer control writes a per-channel override; when absent, buffer edits are
   * not offered as channel-specific (VOD has no live buffer).
   */
  streamKey?: string | null;
  /** What to search OpenSubtitles for. Null while nothing is playing. */
  subtitleContext?: SubtitleContext | null;
  /** Other feeds of the same channel; picking one is how quality changes here. */
  variants?: Variant[];
  onPickVariant?: (id: number) => void;
  /** `auto` picks from connection speed; any other value is a locked feed label. */
  qualityMode?: string;
  onQualityMode?: () => void;
  /**
   * What is on, from whoever knows: the route.
   *
   * Rendered as the first section of the player menu. The player knows the
   * stream — resolution, transport, rate — and nothing at all about the
   * programme, the channel or the guide, so the node comes in rather than being
   * assembled here. Absent means the section does not exist.
   */
  info?: React.ReactNode;
  /**
   * Player-only view, and its switch.
   *
   * The button belongs in the control bar with crop, picture-in-picture and
   * fullscreen — every other control that changes how big the picture is — and it
   * was in a strip above the channel list, which is neither the player nor the
   * list. What it DOES belongs to the route, because the route owns the panes it
   * collapses.
   */
  theatre?: { on: boolean; toggle: () => void };
  /**
   * How live channels are fetched, and the setter.
   *
   * Given by the live route, because reloading the stream is its job. This used to
   * be two buttons in a bar ABOVE the picture, which is where the report came from
   * and it was right: a viewer reading "Low latency / Compatible" over a channel
   * list has been handed a question about MPEG-TS demuxing.
   */
  liveMode?: LiveMode;
  onLiveMode?: (m: LiveMode) => void;
  resume?: WatchKey | null;
  /** Live captions and subtitle search. Off where captions do not apply. */
  allowCaptions?: boolean;
  /**
   * Close the player.
   *
   * Given by every route that can be left. On a phone the player fills the top of
   * the screen with no chrome around it, so without this there is literally no
   * way back to the list — which is what the hardware back button is for on
   * Android and what nothing was for in a browser.
   */
  onClose?: () => void;
  /** Previous/next in whatever list opened this. Drives the centre overlay. */
  onPrev?: () => void;
  onNext?: () => void;
  /**
   * The full schedule, from wherever this player is embedded.
   *
   * A calendar icon beside Settings rather than a destination of its own —
   * "we have it under the player, that way its great". Only offered when the
   * caller has somewhere to send it: a bare film has no guide.
   */
  onGuide?: () => void;
  /**
   * Play the current live programme again from its own start.
   *
   * Only meaningful on a channel that actually has an archive AND a known
   * "now" — building both of those is the caller's job (see routes/Live.tsx),
   * because only the route knows the guide and the catalogue's archive flag.
   * Absent means the control does not render at all, the same rule every
   * other conditional button in this bar follows.
   */
  onRestart?: () => void;
  /**
   * True from the moment `onRestart` lands until the viewer presses back to
   * live. While it holds, the LIVE pill reads "Go live" and hands the press
   * to `onGoLive` instead of opening the stream-settings tab — the pill stays
   * the one stop for "what is this stream doing" either way.
   */
  restarted?: boolean;
  /** Pressed on the LIVE pill while `restarted` is true. */
  onGoLive?: () => void;
  /**
   * What to say when nothing is playing and nothing is being opened.
   *
   * Only for a pane that stands there empty on purpose. Leave it unset on a player
   * that exists because someone pressed PLAY: the honest thing to show for the
   * frame before the stream resolves is the picture that is about to appear, not a
   * caption asking for a choice already made.
   */
  idleHint?: string;
  /** Force the video to cover the full container, eliminating letterbox bars. */
  forceCover?: boolean;
  /**
   * The CALLER already fills the screen around this player — MovieDetail's and
   * SeriesDesk's own full-cover portals (`fixed inset-0 z-50`), not Live's or
   * Catch-up's windowed layout.
   *
   * Only reaches the title line below, nothing else `pictureFilled` drives:
   * the Fullscreen button and its menu label must keep answering for the
   * PLAYER's own state (theatre / the Fullscreen API / the CSS sheet), not the
   * route's — a route that already covers the screen still has a real
   * fullscreen to offer on top of it.
   */
  screenFilled?: boolean;
  /**
   * What is on this channel right now — for the title line, in fullscreen.
   *
   * "even in title when full screen show whats playing from when to when and
   * stuff". Windowed, the route says this under the picture (`NowNext`), and
   * fullscreen is exactly when that heading is gone. Times are formatted here so
   * the caller hands over the slot it already has rather than a second string.
   */
  nowPlaying?: { title: string; startTs: number; stopTs: number | null } | null;
}) {
  /* Live captions tap the element's audio, which iOS does not let a page do — see
     `liveCaptionsPossible`. The control is not drawn there rather than failing. */
  const allowCaptions = allowCaptionsAsked && liveCaptionsPossible(currentPlatform());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [s, setS] = useState<PlayerSnapshot>(player.state);
  const [cap, setCap] = useState<CaptionState>(captions.snapshot);
  /*
   * Fullscreen, in the two ways this app has to do it.
   *
   * `element.requestFullscreen()` cannot work in the APK, and not by accident:
   * Capacitor's `BridgeWebChromeClient.onShowCustomView` calls
   * `callback.onCustomViewHidden()` the instant Chromium asks to go fullscreen,
   * which is a refusal. So the button did nothing on the one device this app is
   * for — "thats when i clicked full screen, it didnt go full screen" — while
   * working perfectly in a browser, which is why it survived this long.
   *
   * `cssFull` is the answer that needs nobody's permission: the picture becomes
   * a fixed box over the whole viewport. On a television that IS fullscreen — the
   * app already owns the screen — and it has two properties the API cannot
   * offer here: the page's own controls stay composited over the picture, and
   * the native surface follows, because the rectangle it is told about is the
   * element's and the element just became the screen.
   *
   * The API is still used where it is real (a desktop browser, where the window
   * is not the screen), and `full` is either of them so every consumer — the
   * icon, the immersive flag, the surface bounds, the arrow-key ownership — reads
   * one flag.
   */
  const [apiFull, setApiFull] = useState(false);
  const [cssFull, setCssFull] = useState(false);
  const full = apiFull || cssFull;
  /* Theatre fills the screen the same way fullscreen does for the viewer — the
     control must show "leave", not another Maximize corner set. */
  const pictureFilled = full || theatre?.on === true;
  const shape = useShape();
  /**
   * The chapters in this title — the container's own, or none at all.
   *
   * Nothing here divides the runtime up. No source in this app publishes chapter
   * data today (the panel has none, and no browser exposes a Matroska chapter
   * list to a page), so for every title on this line the list is empty and every
   * chapter control below simply does not render. When libVLC reports them they
   * appear, named. See lib/chapters.ts.
   */
  const stopList = useMemo(
    () => (s.live ? [] : chapters(s.chapters)),
    [s.live, s.chapters],
  );
  const stopTimes = useMemo(() => stopList.map((c) => c.startS), [stopList]);
  const stopHere = chapterAt(stopList, s.currentTime);
  /** Something real to skip between. */
  const hasJump = stopList.length > 1;
  /* The two regions a press must not close the settings panel from: the panel
     itself, and the control bar whose buttons toggle it. */
  const panelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  /**
   * Where the control bar's own controls begin, in pixels from the player's foot.
   *
   * The settings panel and the captions popover stop there. They sat at a fixed
   * `bottom-14`, which is the bar on one layout and not on another: with the seek
   * bar on a row of its own above the buttons the panel covered its right half,
   * the time remaining and the end of the film — photographed on the website.
   * The bar's top padding is the gradient, not a control, so it is not counted.
   */
  const [barTop, setBarTop] = useState<number | null>(null);
  /** Live-captions popover — separate from the settings panel. */
  const [capOpen, setCapOpen] = useState(false);
  const capRef = useRef<HTMLDivElement>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  /** Is media time actually advancing? Not the same question as `phase`. */
  const moving = useRef(false);
  /** Remote woke the bar — focus the play control after it is actually painted. */
  const needChromeFocus = useRef(false);
  const nav = useNavigate();
  const [channelBuffer, setChannelBuffer] = useState<BufferChoice | null>(null);
  const debug = useDebugEnabled();
  const [engine, setEngine] = useState<EnginePref>(getEnginePref);
  const [forgotten, setForgotten] = useState(false);
  /* Only offered where it exists. On the web these rows would be three controls
     for a thing that cannot happen. */
  const nativeAvailable = hasNativeEngine();
  /* Declared here rather than beside the other section flags below: `act` reads
     it, and a const declared after the callback that lists it as a dependency is
     read before it exists. */
  const hasInfo = info !== undefined && info !== null;
  const [transcript, setTranscript] = useState(false);
  /* The report is probed once per session and cached per device, so it is already
     here by the time anything fails. See lib/capabilityStore.ts. */
  const capabilities = useCapabilities();
  const blockedHost = s.error?.blocked?.host ?? null;
  const diagnosis = useMemo(
    () => diagnose(s.error?.message ?? '', {
      codec: s.stats.codec,
      report: capabilities,
      transport: s.transport,
      /* Outranks every codec verdict below it: a request the browser refused
         never reached a decoder. See `diagnose`. */
      blocked: blockedHost === null ? null : { host: blockedHost },
      /* What was true when it gave up, so an unrecognised engine message still
         produces a sentence rather than "Playback failed" on its own. */
      facts: s.error?.facts ?? null,
    }),
    [s.error?.message, s.error?.facts, s.stats.codec, capabilities, s.transport, blockedHost],
  );
  /*
   * Sending the failure, from the failure.
   *
   * The report that answers "why does this brand not play our films" already
   * exists — device, engine, decoders, and the attempt trail — and reaching it
   * meant five taps on the build line in More and a four-digit PIN, which is not
   * a thing somebody staring at a black screen in another country is going to
   * do. So the card that says the stream failed can send it, in one press, and
   * says what happened to it rather than pretending it always works.
   */
  const [reportState, setReportState] = useState<'idle' | 'sending' | ReportOutcome>('idle');
  useEffect(() => { setReportState('idle'); }, [s.loadId]);
  const sendReport = useCallback(() => {
    setReportState('sending');
    void sendDebugReport().then(setReportState).catch(() => setReportState('failed'));
  }, []);

  const hideTimer = useRef<number>(0);

  /**
   * May a resting cursor hold the controls open? Only where a cursor means intent.
   *
   * ── the report ──
   *
   * "Even if it is highlighted, hide the controls. If the mouse is there it will
   * just keep it there forever — it's a remote, it's not a PC, so you hover
   * them." Exactly right, and the cause was two `onMouseEnter` handlers that
   * called `clearTimeout` and put NOTHING back. Not "pause the countdown" —
   * delete it. Once the pointer had crossed the control bar or the menu, the only
   * thing that could ever hide the chrome again was a fresh `wake()`, and a
   * cursor that is not moving does not send events. So the bar stayed lit over
   * the picture for the rest of the programme.
   *
   * On a television that pointer is usually not a person at all. A box with a USB
   * dongle, an air-mouse asleep on the sofa, or a phone remote app parks a cursor
   * somewhere on screen and leaves it there — often over the bottom edge, which is
   * precisely where the control bar is. Hover is evidence of attention on a desk
   * and evidence of nothing on a sofa.
   *
   * So hover holds the controls only on a real pointer device, and even there it
   * HOLDS rather than cancels: leaving restarts the countdown (see the
   * `onMouseLeave` beside each `onMouseEnter`). On a remote the chrome always
   * sleeps on its timer — focused, hovered or neither — and `wake()` hands focus
   * back to the picture as it goes, so nothing is left highlighted underneath an
   * invisible bar.
   */
  const hoverHolds = shape.pointer === 'fine' && !shape.remote;

  /**
   * The chrome is putting focus back on the picture ON ITS WAY OUT. Not an arrival.
   *
   * ── the loop this breaks, which is the other half of "it stays there forever" ──
   *
   * Hiding the controls has to move focus off them: a highlight on a button that
   * has just faded to `opacity-0 pointer-events-none` is a ring on nothing, and
   * the arrows then belong to a control the viewer cannot see. So the hide timer
   * calls `shell.focus()`.
   *
   * But the shell's `onFocus` is the DOORWAY — arriving on the picture from the
   * channel list is supposed to wake the controls and step into them, because
   * that is how RIGHT out of the list reaches the player at all. Both things are
   * right on their own and together they are a loop: hide -> focus the shell ->
   * onFocus -> `wake()` -> the bar lights up again -> `needChromeFocus` puts the
   * highlight back on a control -> the timer expires -> hide -> focus the shell.
   * The controls never go away, and every few seconds they visibly blink.
   *
   * The difference between the two cases is not observable from the event: both
   * are `focus` on the shell with `target === currentTarget`. So the hide path
   * says so explicitly. Cleared in the handler rather than on a timeout, because
   * `focus()` dispatches synchronously — the flag has never outlived the call it
   * was raised for, and it must not, or the next genuine arrival would be eaten.
   */
  const homing = useRef(false);

  /**
   * Picture-in-picture is a document API, and an Android WebView always reports it
   * unavailable — Android's PiP is an Activity mode instead. `playerCore.togglePip`
   * already early-returns, but a control that can never act is worse than no
   * control, so it is not rendered and the shortcut does not claim the key.
   */
  const pipAvailable =
    typeof document !== 'undefined' && document.pictureInPictureEnabled === true;

  /*
   * Two jobs that used to share one `[]` effect, and the sharing was the bug.
   *
   * Subscribing happens once — that part was right. ATTACHING is not a mount
   * event, it is an ELEMENT event: the core keeps one `<video>` and routes every
   * control at it, so the moment React hands us a different node the old one is
   * orphaned. It goes on decoding, nothing in the UI can reach it, and the
   * picture the viewer is looking at is the empty new one. That is the shape of
   * "it keeps playing and I cannot stop it", and `attach` already carries the
   * note — it just was never called a second time to act on it.
   *
   * A ref callback fires on every mount of the element itself, so a re-parent
   * that slips past the two fixes above still ends up attached rather than
   * orphaned. Belt, not braces: nothing should re-parent this any more.
   */
  const holdVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    /* Null is React letting go on the way out; teardown belongs to the unmount
       effect below, which knows whether anything is meant to still be playing. */
    if (el !== null) player.attach(el);
  }, []);

  useEffect(() => player.subscribe(setS), []);

  /*
   * A notice is read when it appears, and again whenever the controls are up.
   *
   * "No sound: this channel's audio is AC-3…" answers the question somebody
   * asks in the first seconds of a silent channel — so it stays for those
   * seconds by itself, and afterwards rides with the chrome: a viewer who
   * reaches for the remote to find out why it is quiet finds it there, and one
   * watching the match is not reading it over the picture for ninety minutes.
   * Keyed by load as well as by text, so re-opening the channel says it again.
   */
  /*
   * Trying again on the viewer's behalf — see `AUTO_RETRY_MS`.
   *
   * Keyed on the LOAD rather than on the error text, because two failures of
   * the same stream in a row are two failures and should not share a budget,
   * and because a viewer who opens something else starts fresh. `onRetry` is
   * the route's own handler, the one behind the button, so this recovers by
   * exactly the path that is known to work.
   */
  const [autoTry, setAutoTry] = useState(0);
  /*
   * Keyed on the STREAM, not the load.
   *
   * It was `loadId`, on the reasoning above — but a retry is itself a new load,
   * so every retry this effect made reset the budget it was spending. Five
   * tries became a retry every 0.7 seconds for as long as the screen stayed
   * open: measured on the TV emulator as 114 failed opens in about two and a
   * half minutes, which on a one-connection subscription is how a single
   * failure turns into the whole account being locked out.
   */
  const failedStream = useRef('');
  useEffect(() => {
    /* Nothing to gain and a connection to lose: see `permanent` on the
       snapshot. The panel refuses every attempt on a one-stream line, so a
       retry loop against an unplayable file is a column of refusals rather
       than a recovery. */
    if (s.permanent) return undefined;
    if (s.phase !== 'error' || onRetry === undefined) {
      /* Back on its feet, or pointed at something else: give the budget back
         only once something has actually played, so a stream that fails, is
         retried and fails again keeps counting rather than looping for ever. */
      if (s.phase === 'playing' || s.phase === 'paused') {
        failedStream.current = '';
        setAutoTry(0);
      }
      return undefined;
    }
    const stream = s.streamKey || s.label;
    if (failedStream.current !== stream) { failedStream.current = stream; setAutoTry(0); }
    const wait = AUTO_RETRY_MS[autoTry];
    if (wait === undefined) return undefined;
    const id = window.setTimeout(() => { setAutoTry((n) => n + 1); onRetry(); }, wait);
    return () => window.clearTimeout(id);
  }, [s.phase, s.loadId, s.streamKey, s.label, autoTry, onRetry]);

  const noticeKey = s.notice === null ? '' : `${s.loadId}:${s.notice.message}`;
  const [noticeFresh, setNoticeFresh] = useState(false);
  useEffect(() => {
    if (noticeKey === '') { setNoticeFresh(false); return; }
    setNoticeFresh(true);
    const t = window.setTimeout(() => setNoticeFresh(false), NOTICE_FRESH_MS);
    return () => window.clearTimeout(t);
  }, [noticeKey]);

  useEffect(() => {
    setChannelBuffer(
      streamKey != null && streamKey !== ''
        ? getChannelBufferChoice(streamKey)
        : null,
    );
  }, [streamKey]);

  /* `s.surface`, NOT `s.transport === 'native'`: the same transport value covers
     the libVLC surface and progressive `<video>` playback, and only one of them
     has anything behind the page to reveal. See `surface` in playerCore. */
  const nativePicture = s.surface;

  /**
   * Tell the native surface where the picture goes.
   *
   * On Android the frames are drawn on a real surface BEHIND this page, not into
   * the `<video>` element — that is what makes hardware decoding of HEVC and AC-3
   * possible. The surface knows nothing about layout, so the element's own
   * rectangle is measured and handed over, and re-handed whenever it moves:
   * rotation, a layout change, entering fullscreen. Getting this wrong does not
   * fail loudly, it just puts the video somewhere else on the screen.
   *
   * A no-op unless the native engine is actually playing.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      /*
       * A zero rectangle is never published, and this is the guard that turns a
       * dead television back into a working one.
       *
       * `body::before` paints the app's ground as `box-shadow: 0 0 0 100vmax`
       * cast OUTWARD from this rectangle — that is what makes a hole without a
       * clip-path. Publish 0x0 and the shadow has nothing to spare: the ground
       * covers every pixel of the screen, the picture behind the page is hidden
       * completely, and nothing on screen ever moves again to correct it. The
       * sound carries on, because libVLC is fine — it is being looked at through
       * a wall. Reported as "go to FULL SCREEN ... then all becomes black and it
       * keeps black".
       *
       * An element mid-reparent measures 0x0, so this is reachable on every
       * fullscreen transition. Skipping leaves the previous rectangle standing —
       * briefly wrong, and self-correcting on the next frame — instead of
       * replacing it with the one value that is catastrophic.
       */
      if (r.width <= 0 || r.height <= 0) return;
      if (player.nativeActive) {
        player.setSurfaceBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
      /* The same rectangle, published to the page — see the hole rules in
         index.css. One measurement drives both so the surface and the hole in
         front of it cannot disagree; two reads would be a picture with a black
         edge down one side.

         Published whenever the hole is OPEN rather than only while the engine
         reports itself active: `data-native-video` is switched by `nativePicture`
         and these variables are the only thing that makes it survivable, so a
         commit where the attribute is on and the rectangle is not yet written is
         a full-screen black card. The two now move together. */
      const root = document.documentElement.style;
      root.setProperty('--nv-x', `${r.left}px`);
      root.setProperty('--nv-y', `${r.top}px`);
      root.setProperty('--nv-w', `${r.width}px`);
      root.setProperty('--nv-h', `${r.height}px`);
      root.setProperty('--nv-r', getComputedStyle(el.parentElement ?? el).borderRadius || '0px');
    };
    report();
    /*
     * And again on the next two frames.
     *
     * Entering the full-screen box re-parents the stage and the new geometry is
     * not final in the commit that caused it — the element can still be 0x0, or
     * still the old size, when this effect runs. One rAF catches the layout, the
     * second catches a transition that starts on it. Cheap, bounded, and the
     * alternative is a measurement that is wrong until something else happens to
     * move the page.
     */
    let raf1 = 0;
    let raf2 = 0;
    if (typeof requestAnimationFrame === 'function') {
      raf1 = requestAnimationFrame(() => {
        report();
        raf2 = requestAnimationFrame(report);
      });
    }
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    ro?.observe(el);
    window.addEventListener('resize', report, { passive: true });
    window.addEventListener('scroll', report, { passive: true, capture: true });
    return () => {
      if (raf1 !== 0) cancelAnimationFrame(raf1);
      if (raf2 !== 0) cancelAnimationFrame(raf2);
      ro?.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('scroll', report, { capture: true } as EventListenerOptions);
    };
    /*
     * The SAME dependencies as the hole effect below, and that is the fix.
     *
     * This used to re-run on `[s.loadId, s.transport, full]` while the hole was
     * re-walked on `[nativePicture, s.loadId, cssFull, theatre?.on]`. Theatre —
     * the in-page full screen, which is the one a television uses — is in the
     * second list and not the first. So entering it re-parented the stage and
     * re-tagged the ancestors for a picture whose rectangle was never measured
     * again: the ResizeObserver was still watching the element that had been
     * left behind, so nothing fired, and the hole stayed where the windowed
     * player used to be. Two effects describing one rectangle have to wake on
     * the same events or they describe two.
     */
  }, [nativePicture, s.loadId, s.transport, cssFull, theatre?.on, full]);
  /**
   * Make the page see-through where the native picture is, and only there.
   *
   * The libVLC surface is behind a transparent WebView, so anything the page
   * paints over that rectangle hides the film — and the page painted three
   * things: the video element's own `bg-black`, the stage's, and the app's
   * ground on `body`. That is the whole of "the movies again hear audio but no
   * video": the frames were arriving behind a black card. The attribute switches
   * on the rules in index.css; the walk up the tree catches the layout-specific
   * layer, which is a pane's `bg-panel` on one route and nothing at all on
   * another.
   *
   * Off again the moment the WebView is the picture, because the hole is a hole:
   * left open, the app would have a transparent window in the middle of it.
   */

  /*
   * The colour of what is playing, in the space around it.
   *
   * "aren't the player always i'm sure there are packages you can like show
   * shades you know what's playing right now like a television" — so the
   * letterbox bars stop being black and carry the light of the picture instead,
   * which is what a modern set does and where there is nothing else to look at.
   *
   * Three conditions, and each one is a real exclusion rather than caution:
   *
   *   - the viewer asked for it (`Prefs.ambient`, on by default)
   *   - something is actually playing. A paused or opening stream has either no
   *     frame or the same frame, and a glow that persists over an error panel is
   *     decoration on a failure.
   *
   * ── it works under libVLC now, and the note that said it could not was wrong ──
   *
   * It used to require the `<video>` ELEMENT, on the grounds that under
   * `s.surface` the film is on an Android surface behind a transparent WebView
   * and there are no pixels in the document to sample. That much is true. What
   * followed from it was not: the pixels exist, they are on the other side of
   * the bridge, and this app is native. `PixelCopy` reads a SurfaceView back —
   * see `ambient` in StreamixPlayerPlugin — so both paths have a sampler and
   * `startNativeAmbient` is the one for the surface.
   *
   * One thing genuinely does NOT survive the switch: the glow layer INSIDE the
   * stage. Over a native surface, anything the page paints there sits on top of
   * the film rather than beside it — the hole-punch clears backgrounds, not
   * content. So `shade` (the in-stage layer) stays element-only, and the native
   * path publishes `--ambient` to the document, which is where the light is
   * worth having anyway: around a WINDOWED player, the live pane, where a 16:9
   * picture has no letterbox bars of its own to fill.
   */
  const [prefs] = usePrefs();
  const [shade, setShade] = useState<string | null>(null);
  const wantsAmbient = prefs.ambient
    && (s.phase === 'playing' || s.phase === 'paused');
  useEffect(() => {
    if (!wantsAmbient) {
      setShade(null);
      /* Removed, not set to transparent: the fallback in the stylesheet is what
         decides what an un-lit pane looks like, and it cannot if this is set. */
      document.documentElement.style.removeProperty('--ambient');
      return;
    }

    /* The surface path: ask the plugin, and never paint inside the stage. */
    if (nativePicture) {
      let stopNative: (() => void) | null = null;
      let dropped = false;
      void nativeEngine().then((plugin) => {
        if (dropped || plugin === null) return;
        stopNative = startNativeAmbient(() => plugin.ambient(), (got) => {
          document.documentElement.style.setProperty('--ambient', cssOf(got));
        });
      });
      return () => {
        dropped = true;
        stopNative?.();
        document.documentElement.style.removeProperty('--ambient');
      };
    }

    const el = videoRef.current;
    if (el === null) return;
    const stop = startAmbient(el, (got) => {
      const css = cssOf(got);
      setShade(css);
      /*
       * Published to the document as well, because the letterbox bars are often
       * not where anyone is looking.
       *
       * A 16:9 film on a 16:9 screen has no bars at all — measured: the glow was
       * sampling correctly and painting behind a picture that covered every
       * pixel of it. Where the ambience is actually worth having is around a
       * WINDOWED player: the live pane, where the channel sits above its own
       * Now/Next panel with a wall of flat panel colour underneath.
       *
       * A custom property rather than a context: the consumers are stylesheets,
       * not components, and `--ambient` costs one property write every 600ms
       * against a re-render of every pane.
       */
      document.documentElement.style.setProperty('--ambient', css);
    });
    return () => {
      stop();
      /* Leaving the player must take its light with it, or a channel list keeps
         glowing the colour of a film that stopped playing. */
      document.documentElement.style.removeProperty('--ambient');
    };
    /* `s.loadId` so a new stream re-reads from its own first frame rather than
       drifting there from the last one's colour. */
  }, [wantsAmbient, s.loadId]);
  useEffect(() => {
    if (!nativePicture) return;
    const el = videoRef.current;
    if (el === null) return;
    const root = document.documentElement;
    const cleared: HTMLElement[] = [];
    for (let n = el.parentElement; n !== null && n !== document.body; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        n.classList.add('nv-clear');
        cleared.push(n);
      }
    }
    root.dataset.nativeVideo = 'on';
    return () => {
      delete root.dataset.nativeVideo;
      for (const n of cleared) n.classList.remove('nv-clear');
    };
    /* Re-walked when the layout around the picture changes, not only when the
       stream does: entering the full-screen box or theatre mode re-parents the
       stage, and an ancestor that is opaque NOW is a black card over the film
       however transparent its predecessor was. */
  }, [nativePicture, s.loadId, cssFull, theatre?.on]);

  useEffect(() => captions.subscribe(setCap), []);
  useEffect(() => {
    if (!allowCaptions) void captions.stop();
  }, [allowCaptions]);

  /* CSS / API fullscreen covers the viewport — hide the shell nav with it. */
  useEffect(() => {
    noteShellHide('player-full', full);
    return () => noteShellHide('player-full', false);
  }, [full]);

  // Release the connection and the caption stream when the surface unmounts.
  useEffect(() => () => {
    void captions.stop();
    player.teardown();
  }, []);

  // After teardown: React cleans up later effects first, so the playhead is
  // flushed while currentTime is still the real one.
  useWatchProgress(resume ?? null);

  /**
   * Show the controls, then take them away again.
   *
   * `after` is how long they linger. An ACTION gets a short one: pressing play
   * means "get out of my way", and the previous behaviour — a fixed 3.6s from the
   * last mouse move — left the overlay sitting on top of the picture on a phone
   * long after the tap that summoned it. Pointer movement keeps the longer dwell,
   * because a moving cursor is someone still looking for a control.
   */
  /**
   * Two dwells, because "idle" means something different once you are USING it.
   *
   * "Make it so it only hides if they are idle — if they are navigating around,
   * closing it will be really bad."
   *
   * A single 3.6s countdown could not tell those apart. It is the right length
   * for a bar that appeared because a finger brushed the screen, and far too
   * short for somebody walking the controls with a remote: reading four labels,
   * deciding, and reaching for the key takes longer than that, and the bar
   * vanishing mid-decision takes the highlight with it. Every press does restart
   * the countdown, so the failure is not fast navigation — it is the PAUSE, which
   * is exactly when someone is looking at the thing you just took away.
   *
   * So the dwell is chosen from where the highlight is. Nothing selected means the
   * chrome is a hint that surfaced on its own, and 3.6s is right. A control
   * selected means they are in the middle of something, and 12s of complete
   * stillness is what it now takes — long enough to read the row and decide,
   * short enough that a bar left lit does not sit over the picture.
   */
  /* Five seconds of stillness — long enough to read a label, short enough that
     the bar is not sitting on the picture. Was 12–15s of "busy" dwell. */
  const IDLE_MS = 5_000;
  const BUSY_MS = 5_000;
  /** Seconds of media time standing still before the picture counts as stopped. */
  const STILL_TICKS = 3;

  /**
   * An open menu is a room, not a hint, and rooms do not close themselves.
   *
   * "When they open a settings it should stay open even after the timeout."
   * Quite right, and the old behaviour was indefensible: the panel is a two-column
   * list you read, so the countdown ran out while it was being READ, and the
   * whole thing disappeared with the highlight inside it.
   *
   * A ref rather than a dep, because `wake` is created once and the timeout it
   * schedules has to see what is true when it FIRES, not what was true when it
   * was set — a panel opened one second into a 3.6s countdown must survive it.
   */
  const menuOpen = useRef(false);

  /**
   * Is there a picture behind the bar at all?
   *
   * The chrome hides itself so it stops covering the film — which is the right
   * rule while a film is on screen and exactly the wrong one before it is.
   * Reported as "when a video is loading why cant i see the controls": opening a
   * title put a spinner on a black rectangle and took the controls away with it,
   * so there was nothing to press while waiting and no way to change anything
   * about the attempt that was failing.
   *
   * A ref rather than a dependency, and read inside the sleep timer the way
   * `menuOpen` is, because the timer is armed once and must decide with what is
   * true when it FIRES, not with what was true when it was set.
   */
  const nothingToCover = useRef(true);

  /**
   * When the last real press was. An IDLE timer needs to know, and only this does.
   *
   * The first attempt chose the dwell when the timer was SET, from where focus was
   * at that moment. It could not work, and the log says why: `wake` is called from
   * a dozen places with a dozen different intentions — the doorway hand-off passes
   * 6000, a colour button passes nothing, the chrome's own focus capture passes
   * nothing — and the one that happens to schedule the surviving timer is not the
   * one that knows whether a person is busy. Measured: the highlight sat on Pause
   * and the bar still went at 2s, because the timer that fired had been set by an
   * earlier call, back when focus was still on the picture.
   *
   * Idleness is a property of the MOMENT THE TIMER FIRES, so it is decided there.
   * Capture phase on the window, so a press that some other handler stops still
   * counts as a person being present.
   */
  const lastInput = useRef(0);
  useEffect(() => {
    const seen = () => { lastInput.current = Date.now(); };
    window.addEventListener('keydown', seen, true);
    window.addEventListener('pointerdown', seen, true);
    return () => {
      window.removeEventListener('keydown', seen, true);
      window.removeEventListener('pointerdown', seen, true);
    };
  }, []);

  const wake = useCallback((after?: number) => {
    setChromeVisible(true);
    window.clearTimeout(hideTimer.current);
    const sleep = (ms: number) => {
      hideTimer.current = window.setTimeout(() => {
      /* Nothing closes a menu but the viewer. The effect watching `tab` fall
         back to null is what restarts the countdown afterwards. */
      if (menuOpen.current) return;
      /* Nothing to get out of the way of — see `nothingToCover`. */
      if (nothingToCover.current) return;
      /*
        Still busy? Wait out the remainder instead of closing under them.

        "Only hide if they are idle — if they are navigating around, closing it
        will be really bad." A control carrying the highlight earns the longer
        dwell, because reading four labels and reaching for the key takes longer
        than a bar that surfaced on its own deserves to live.
      */
      const on = document.activeElement;
      const busy = on instanceof HTMLElement
        && shellRef.current?.contains(on) === true
        && on !== shellRef.current;
      const idle = Date.now() - lastInput.current;
      const need = busy ? BUSY_MS : IDLE_MS;
      if (idle < need) { sleep(need - idle); return; }
      setChromeVisible(false);
      /* Focus left on a now-invisible centre/bar control is how the remote
         gets stuck: arrows adjust volume of a hidden button instead of
         moving, and nothing looks selected. Hand focus back to the surface.
         Leave overlays alone — settings panels own the keys. */
      const shell = shellRef.current;
      const active = document.activeElement;
      if (
        shell
        && active instanceof HTMLElement
        && shell.contains(active)
        && active !== shell
        && active.closest('[data-nav-contain]') === null
      ) {
        /* Leaving, not arriving — see `homing`. Without this the line below
           relights the bar it was just told to put away. */
        homing.current = true;
        shell.focus({ preventScroll: true });
        homing.current = false;
      }
      }, ms);
    };
    sleep(after ?? IDLE_MS);
  }, []);

  /*
   * Keep the chrome up whenever there is no picture behind it.
   *
   * `loading`, `idle` and `error` all mean the same thing to a viewer: a black
   * rectangle. Hiding the controls over one of those is not "getting out of the
   * way of the film", it is taking away the only thing on screen they could
   * press. `wake()` with no argument on entering such a phase, so the bar is
   * both up and awake; the ref keeps it up until something actually plays.
   */
  useEffect(() => {
    const bare = s.phase !== 'playing' && s.phase !== 'paused';
    /* `playing` is not the same as PLAYING — see `moving` below. A stream that
       has flipped the phase but not yet produced a second of media time is a
       black rectangle like any other, and the bar has to stay on it. */
    nothingToCover.current = bare || (s.phase === 'playing' && !moving.current);
    if (nothingToCover.current) wake();
  }, [s.phase, wake]);

  /*
   * The controls stay up until the picture actually MOVES, and come back if it
   * stops.
   *
   * "if they open a video for the first time ... it's best if you show the
   * controls always till a video plays, and then that timeout and things will
   * apply, because right now I cannot go back if it's stuck or if it's bad."
   *
   * `nothingToCover` already held the bar up through `loading`, `idle` and
   * `error`. What it did not hold is the state people are actually trapped in:
   * the engine reports `playing`, the phase flips, the countdown starts, the bar
   * goes away — and then media time never advances. A frozen frame with no
   * controls over it, on a device whose only input is a remote, is a television
   * with no way out, and it is worse than the error box because nothing on
   * screen admits anything is wrong.
   *
   * So media time is sampled once a second and `playing` only counts while it is
   * going up. Sampled rather than event-driven on purpose: a stall is the
   * ABSENCE of events, so there is nothing to listen for.
   */
  useEffect(() => {
    let seen = -1;
    let still = 0;
    const tick = () => {
      const snap = player.state;
      if (snap.phase !== 'playing') { seen = -1; still = 0; moving.current = false; return; }
      const now = snap.currentTime;
      if (now > seen + 0.05) {
        seen = now;
        still = 0;
        if (!moving.current) {
          moving.current = true;
          nothingToCover.current = false;
          /* It is playing at last: re-arm the countdown that the held-up bar
             swallowed, so the controls get out of the way on their own. */
          wake();
        }
        return;
      }
      still += 1;
      if (still < STILL_TICKS || !moving.current) return;
      /* Stopped. Put the controls back and keep them there. */
      moving.current = false;
      nothingToCover.current = true;
      wake();
    };
    const t = window.setInterval(tick, 1000);
    return () => { window.clearInterval(t); };
  }, [player, wake]);

  useEffect(() => {
    const bar = barRef.current;
    if (bar === null || typeof ResizeObserver === 'undefined') return;
    const read = (): void => {
      const pad = parseFloat(getComputedStyle(bar).paddingTop) || 0;
      setBarTop(Math.max(0, Math.round(bar.offsetHeight - pad)));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  /**
   * Put the remote on a real control in the bar.
   *
   * The shell surface is only a doorway (RIGHT from the channel list). Leaving
   * focus there makes every arrow mean volume/seek — which is exactly "I cannot
   * navigate in the player". Prefer the bar over the centre cluster.
   */
  const focusPlayerChrome = useCallback((): boolean => {
    const bar = barRef.current;
    const shell = shellRef.current;
    if (bar !== null && focusFirst(bar)) return true;
    if (shell === null) return false;
    /*
      Then ANYTHING else in the player.

      This loop used to re-apply `bar.contains(el)`, which made it a slower way of
      asking the question `focusFirst(bar)` had already answered — so when the bar
      was not the place the controls were, it found nothing. The state where that
      matters is the one people hit: a channel that failed to open has no control
      bar at all, only RETRY in the error panel, and the hand-off below then had
      nowhere to send the press.
    */
    const control = [...shell.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].find((el) => {
      if (el === shell) return false;
      if (el.closest('[data-nav-skip]') !== null) return false;
      /*
       * `tabindex="-1"` means "focusable by script, not by navigation", and this
       * IS navigation — the press that arrives here came from a D-pad. The
       * selector above misses that case because a `<button tabindex="-1">` still
       * matches `button:not([disabled])`, and the centre cluster over the picture
       * is exactly that on a remote: five thumb targets, deliberately not focus
       * stops. Measured: one press of RIGHT out of the episode list landed on the
       * cluster's Previous instead of on the bar's play/pause, so the two ways
       * into this player disagreed about where the door was.
       */
      if (el.getAttribute('tabindex') === '-1') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.pointerEvents !== 'none' && st.opacity !== '0';
    });
    if (control === undefined) return false;
    control.focus({ preventScroll: true });
    return true;
  }, []);

  useEffect(() => {
    if (!chromeVisible || !needChromeFocus.current) return;
    needChromeFocus.current = false;
    focusPlayerChrome();
  }, [chromeVisible, focusPlayerChrome]);

  /** Wrap any control so using it also dismisses the chrome. */
  const acted = useCallback((fn: () => void) => () => {
    fn();
    wake(1200);
  }, [wake]);

  useEffect(() => {
    wake();
    return () => window.clearTimeout(hideTimer.current);
  }, [wake, s.label]);

  const toggleFull = useCallback(async () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement !== null) {
      await document.exitFullscreen().catch(() => {});
      return;
    }
    if (cssFull) { setCssFull(false); return; }
    /* Theatre IS the full-screen picture on Live — the Maximize button must
       leave it, not offer to go "more" fullscreen on top of it. */
    if (theatre?.on) { theatre.toggle(); return; }
    /*
     * Inside the APK there is no Fullscreen API, and the CSS box is the wrong
     * answer where the page has a theatre of its own.
     *
     * `cssFull` only promotes the player's own shell: everything the ROUTE
     * paints stays exactly where it is, one stacking context over. On Live that
     * costs nothing, because Live's maximise goes through `theatre` anyway. On
     * Series it is the whole of "ook in full screen blijft enkel audio en op
     * achtergrond staat nogsteeds de lijst met episodes en de afbeelding" — the
     * cover art and the episode list are SIBLINGS of the picture column, they
     * are dropped on `theatre` and on nothing else, and with libVLC drawing
     * behind a transparent WebView anything still painting over that rectangle
     * is a card over the film. So where the page offers theatre and the
     * platform offers no fullscreen, theatre IS full screen: one way to
     * maximise on both screens, and the route's own `hidden={theatre}` rules
     * get to apply.
     */
    if (!FULLSCREEN_API && theatre !== undefined) { theatre.toggle(); return; }
    if (FULLSCREEN_API) {
      /* A rejection is the browser saying no (a sandboxed frame, a user-gesture
         rule). The picture still has somewhere to go. */
      try {
        await el.requestFullscreen();
        return;
      } catch { /* fall through to the box that always works */ }
    }
    setCssFull(true);
  }, [cssFull, theatre]);

  /**
   * Is this the big picture or a strip beside a list?
   *
   * Every control in this bar folded behind the cog is right for a 442px player
   * next to a channel list, where seven icons are a gauntlet a D-pad has to
   * walk. It is wrong for a bigger player, where subtitles, captions, theatre,
   * full screen and the small popup window belong on the bar itself.
   *
   * So it is the same bar and the room decides. Measured against the window
   * rather than assumed from a prop, because "big" happens four different ways —
   * fullscreen, the CSS box, theatre mode, and a film page whose player is
   * already 76% of the screen.
   */
  const [bigPicture, setBigPicture] = useState(false);
  useEffect(() => {
    const el = shellRef.current;
    if (el === null) return;
    const check = () => {
      const r = el.getBoundingClientRect();
      setBigPicture(r.width >= window.innerWidth * 0.7);
    };
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    window.addEventListener('resize', check, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, []);

  useEffect(() => {
    const onFs = () => setApiFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  /* Leaving the player leaves fullscreen with it: a fixed box over the whole
     screen with no stream behind it is a black screen with no way out. */
  useEffect(() => {
    if (onClose === undefined) return;
    return () => setCssFull(false);
  }, [onClose]);

  /**
   * Does the player own the arrow keys right now?
   *
   * It used to own them unconditionally, which is fine with a mouse and fatal with
   * a D-pad: on a TV every Down press meant "volume", so the channel list could not
   * be navigated at all. The arrows now belong to the player only when nothing else
   * has claimed them — it is fullscreen, or focus is inside it, or focus is nowhere
   * (which is the desktop case, and why the shortcut still works there). Every other
   * key stays global, because none of them collide with directional navigation.
   */
  const ownsArrows = useCallback(() => {
    const el = shellRef.current;
    const a = document.activeElement;
    // Focus nowhere: the arrows are nobody's, so the player may as well have them.
    if (!a || a === document.body) return true;
    if (el === null) return false;
    if (!el.contains(a)) return false;
    /*
      Focus is on a control INSIDE the player, and a control is never volume.

      This used to depend on the pointer: with a cursor the arrows stayed volume
      and seek even while focus sat on a button, on the reasoning that a desktop
      has Tab and a mouse to move with. That reasoning is wrong, and it is the
      whole of "when I go to the player, wherever I enter its navigation, I cannot
      navigate anywhere any more". Measured before this: focus on a button inside
      the player, then eight arrow presses in a row — right, right, up, left,
      down, left, left, up — every one of which left focus on the same button, at
      the same coordinates, because the player answered all eight with a volume
      change nobody could see.

      A keyboard is not a mouse. Arrows are how you get from one control to the
      next on every remote AND on every keyboard, and a surface that eats them
      while something is selected is a room with the door painted on.

      So the rule is the same everywhere and needs no device test: the player owns
      the arrows when nothing inside it is selected — focus on the picture itself
      (which is where a click on the video lands) or nowhere at all. The moment a
      control has focus, the arrows belong to navigation.
    */
    return a === el;
  }, []);

  /**
   * The remote, and the keyboard, through one table.
   *
   * This used to be an inline map of `k`, `f`, `m`, `c` — a keyboard map, on an
   * app whose whole point is televisions. A remote sends none of those: it sends
   * `MediaPlayPause`, `ChannelUp`, `Info` and a dedicated subtitle button, and on
   * a set-top handset some of them reach the WebView only because
   * `MainActivity.onKeyDown` forwards the raw keycode. `lib/remoteKeys.ts` owns
   * that translation and is tested; this owns what the intents DO.
   */
  const act = useCallback((intent: RemoteIntent) => {
    const snap = player.state;
    switch (intent) {
      case 'playPause': player.togglePlay(); return true;
      case 'play': if (snap.phase !== 'playing') player.togglePlay(); return true;
      case 'pause': if (snap.phase === 'playing') player.togglePlay(); return true;
      case 'stop': onClose?.(); return true;
      /* ±30s on a remote rather than the keyboard's ±10: a thumb on a rocker
         presses it repeatedly, and ten seconds a press makes an ad break a
         chore. Live has nowhere to go, so it changes channel instead. */
      case 'forward': if (snap.live) onNext?.(); else player.nudge(30); return true;
      case 'back': if (snap.live) onPrev?.(); else player.nudge(-30); return true;
      /*
        Chapter skip, which is what these two buttons are for on every remote that
        has them. When the container named its chapters they step between them;
        when it named none — which is every title on this panel — they fall back to
        a minute either way, because a coarse jump is honest and a dead button is
        not. What they never do is land on a time nobody knows anything about.
      */
      case 'skipForward': case 'skipBackward': {
        if (snap.live) { (intent === 'skipForward' ? onNext : onPrev)?.(); return true; }
        const dir = intent === 'skipForward' ? 1 : -1;
        const to = skipTo(chapters(snap.chapters), snap.currentTime, dir);
        if (to === null) player.nudge(60 * dir);
        else player.seek(to);
        return true;
      }
      case 'nextTrack': case 'channelUp': onNext?.(); return true;
      case 'prevTrack': case 'channelDown': onPrev?.(); return true;
      case 'volumeUp': player.setVolume(snap.volume + 0.05); return true;
      case 'volumeDown': player.setVolume(snap.volume - 0.05); return true;
      case 'mute': player.toggleMute(); return true;
      case 'fullscreen': void toggleFull(); return true;
      case 'aspect': player.setAspect(nextAspect(snap.aspect)); return true;
      case 'pip': if (pipAvailable) void player.togglePip(); return true;
      case 'live':
        /* Mirrors the bar's own LIVE/"Go live" pill — see the note beside it. */
        if (restarted) { onGoLive?.(); return true; }
        if (snap.live) {
          setTab((t) => (t === 'stream' ? null : 'stream'));
          wake(BUSY_MS);
        }
        return true;
      case 'faster': player.setUserRate(nextSpeed(snap.userRate, 1)); return true;
      case 'slower': player.setUserRate(nextSpeed(snap.userRate, -1)); return true;
      /* The hardware GUIDE key reaches the same place the bar's own Guide
         button does, channel and all, when the caller offers one; a plain
         film has no `onGuide` and this falls back to the bare page. */
      case 'guide': if (onGuide) onGuide(); else nav('/guide'); return true;
      /* INFO on a remote means "tell me what I am watching", and now there is a
         page that answers it: the menu's first section. With nothing to show
         there it falls back to holding the chrome open long enough to read,
         which is all it could ever do before. */
      case 'info':
        if (hasInfo) { setTab('info'); wake(BUSY_MS); return true; }
        wake(BUSY_MS);
        return true;

      /*
        The subtitle button, which is what this was asked for.

        One press advances to the next track and the last press turns them off,
        rather than opening a menu — a remote has one button for this and holding
        a list open on a television to choose from it is the slow way round. The
        menu is still there for anyone who wants to see the names.
      */
      case 'subtitles': {
        if (snap.subtitleTracks.length === 0) {
          if (allowCaptions) setTab((x) => (x === 'subs' ? null : 'subs'));
          return true;
        }
        player.setSubtitle(cycleTrack(snap.subtitleTracks, true));
        return true;
      }
      case 'audioTrack': {
        if (snap.audioTracks.length < 2) return true;
        player.setAudio(cycleTrack(snap.audioTracks, false));
        return true;
      }

      case 'exit':
        if (capOpen) { setCapOpen(false); return true; }
        if (tab) { setTab(null); return true; }
        if (document.fullscreenElement) { void document.exitFullscreen(); return true; }
        /* BACK out of the full-screen box before it closes the player: two
           different sizes of "leave", in the order a viewer means them. */
        if (cssFull) { setCssFull(false); return true; }
        if (onClose) { onClose(); return true; }
        return false;
      default: {
        const d = digitOf(intent);
        if (d === null) return false;
        /*
          On a film 1-9 are tenths of the runtime — the oldest convention in video
          playback and the one genuinely useful thing a number pad does to a
          two-hour film.

          On live they used to be a channel number, forwarded to the route, which
          drew a large "127 of 12,890" overlay and tuned on a timer. That is gone:
          this is a six-key app — D-pad, OK, Back — and a Samsung or Fire TV
          remote's digits are not something a feature may depend on. Nothing was
          lost that the channel list does not already do.
        */
        if (!snap.live) {
          const to = digitSeek(d, snap.duration);
          if (to !== null) { player.seek(to); return true; }
        }
        return false;
      }
    }
  }, [
    allowCaptions, cssFull, hasInfo, nav, onClose, onGoLive, onGuide, onNext, onPrev,
    pipAvailable, restarted, tab, toggleFull, wake,
  ]);

  /*
   * The menu's two columns, and the arrows that join them.
   *
   * The same hand-off the settings screen needed and for the same two reasons:
   * a sideways move must stay in its row, so Right from a section reaches
   * nothing when the section's first control is lower down; and a vertical move
   * escalates outwards when a column runs out, so Down at the end of the content
   * walked into the middle of the section list. Both are correct rules for a
   * channel rail and wrong for two columns side by side.
   */
  const menuNav = useRef<HTMLElement | null>(null);
  const menuPane = useRef<HTMLDivElement | null>(null);
  const openSection = useRef<HTMLButtonElement | null>(null);

  const menuArrow = useCallback((intent: RemoteIntent): boolean => {
    const el = document.activeElement;
    const nav = menuNav.current;
    const pane = menuPane.current;
    if (nav === null || pane === null) return false;
    const col = nav.contains(el) ? nav : pane.contains(el) ? pane : null;
    if (col === null) return false;
    /*
      A section whose content has nothing to press.

      WHAT IS ON is a page of text — no buttons at all — so `focusFirst` on it
      honestly returns false and Right did nothing, which reads as a dead key on
      the one section a viewer opens most. The pane itself is the focus target in
      that case (`tabIndex -1`, so navigation never lands there by geometry, only
      by this hand-off), and then Up and Down scroll it. That is what a remote
      does to a page of text everywhere else.
    */
    const onPane = document.activeElement === pane;
    const scroll = (by: number): boolean => {
      pane.scrollBy({ top: by, behavior: 'smooth' });
      return true;
    };

    switch (intent) {
      /* Consumed either end: a menu is a boundary, and the panel already
         declares `data-nav-contain` for the same reason. */
      case 'up':
        if (onPane) return scroll(-Math.round(pane.clientHeight * 0.4));
        return moveWithin('up', col) || true;
      case 'down':
        if (onPane) return scroll(Math.round(pane.clientHeight * 0.4));
        return moveWithin('down', col) || true;
      case 'right':
        if (moveWithin('right', col)) return true;
        if (col !== nav) return true;
        if (focusFirst(pane)) return true;
        pane.focus();
        return true;
      case 'left': {
        if (moveWithin('left', col)) return true;
        if (col === nav) return true;
        openSection.current?.focus();
        return true;
      }
      default: return false;
    }
  }, []);

  /**
   * The player's claim on the keyboard, as a layer rather than a listener.
   *
   * It used to be `window.addEventListener('keydown')` here, which had a
   * consequence nobody would choose: while the player was mounted it answered for
   * every key in the app, and while it was not, the remote buttons
   * `MainActivity` forwards reached NOTHING — the subtitle button did nothing on
   * the guide or the channel list because this was the only listener for it.
   * `lib/keys.ts` owns the listener now; this owns the top layer while there is a
   * picture on screen, and `handle` is the raw hook it needs for the two keys that
   * mean something different here (arrows are volume and seek, not focus).
   */
  const handle = useCallback((intent: RemoteIntent, e: KeyboardEvent | null): boolean => {
    /*
      The menu owns the arrows while it is open.

      Not by trapping them — `data-nav-contain` already keeps focus inside the
      panel — but because two columns need a rule the general geometry does not
      have: sideways must stay in its row, and vertical escalates outwards when a
      column runs out.

      FIRST, above everything else here, including the idle check below. The menu
      can be open with nothing playing — captions and the stream section exist
      before a channel does — and an open menu whose arrows are answered by
      general geometry is the two-column jumping this replaced.
    */
    if (tab !== null && ARROW_INTENTS.has(intent)
      && panelRef.current?.contains(document.activeElement) === true) {
      wake();
      return menuArrow(intent);
    }
    /*
      No stream, no claim.

      On /live this component is mounted before anything is playing, and a player
      showing nothing must not answer for the arrow keys — that would leave the
      channel list unnavigable on exactly the screen where navigation matters
      most, with Up and Down adjusting the volume of silence.
    */
    if (player.state.phase === 'idle') return false;
    /*
      On a remote, the first press wakes the controls and does nothing else.

      This is how every television behaves, and without it the control bar is
      unreachable by D-pad: it hides itself after a few seconds, and a hidden
      control is not a focus candidate, so there was no press that could bring it
      back. Deliberately not done with a cursor — a mouse has hover to wake it, and
      swallowing a keypress there would only feel broken.
    */
    /* Except LEFT out of the small picture beside a list, which is the way OUT
       and should not cost a press first — see `windowed` below. */
    if (shape.remote && !chromeVisible
      && (ARROW_INTENTS.has(intent) || intent === 'select')
      && !(intent === 'left' && !pictureFilled)
      && shellRef.current?.contains(document.activeElement) === true) {
      needChromeFocus.current = true;
      wake(6000);
      return true;
    }
    /*
      The bar that LOOKS like the way to scrub, made to actually scrub.

      "there is no forword and backword i think." The seek bar is a
      `role="slider"` with `tabIndex={0}`, so a D-pad walks onto it and it draws
      a focus ring — and it had no key handling whatsoever. Every arrow press
      while it was selected fell through to spatial navigation, which did the
      only thing it could and moved focus off the bar to the next button. So the
      one control on the screen whose entire job is choosing a position was, on a
      remote, a thing you could select and then leave. Pointer only, since it was
      written.

      Handled HERE rather than with an `onKeyDown` on the element: the player's
      key layer sits above spatial navigation (`lib/keys.ts`), and a React
      handler on the div fires in the bubble phase, by which time focus has
      already moved. Returning `true` is what keeps the selection on the bar, so
      the presses accumulate the way a scrub should — press right four times,
      move forty seconds, and still be on the bar.

      Left/right only. Up and down are how you LEAVE the bar for the buttons
      below and the picture above; a slider that ate all four would be the same
      dead end one step further in.
    */
    /*
      The small picture beside a list is a place you pass through, not a room
      you are shut in. Measured on /live with a channel playing: once focus was
      on the picture or on the live bar, LEFT never left the player — the
      picture answered it by waking the controls, the bar by scrubbing the live
      buffer back ten seconds — and the only way out was DOWN, then LEFT, onto
      a different channel. "I cannot go back to the sidebar."

      So while the picture is NOT filling the screen, LEFT on the picture, and
      LEFT/RIGHT on a live bar, belong to navigation. Full screen and theatre
      keep them: there the bar is the whole point and there is nowhere to go.
    */
    const windowed = !pictureFilled;
    if (isArrow(intent) && windowed) {
      const on = document.activeElement;
      if (intent === 'left' && on === shellRef.current) return false;
      /*
        UP from the bar of a windowed picture leaves for the header, on the tab
        that is open. Measured on the TV emulator: UP from the seek bar found the
        picture itself (a doorway) as the nearest thing above, which stepped back
        into the bar at Play — so UP bounced between Play and the bar for ever and
        the tabs could not be reached from a playing preview at all.
      */
      if (intent === 'up' && on instanceof HTMLElement && on.dataset.seekBar !== undefined) {
        const tab = document.querySelector<HTMLElement>('.app-tabs .is-on');
        if (tab !== null) { tab.focus(); return true; }
      }
      if ((intent === 'left' || intent === 'right') && player.state.live
        && on instanceof HTMLElement && on.dataset.seekBar !== undefined) return false;
    }
    if (isArrow(intent)) {
      const on = document.activeElement;
      const by = seekBarNudge(intent, on instanceof HTMLElement && on.dataset.seekBar !== undefined);
      if (by !== null) {
        player.nudge(by);
        wake();
        return true;
      }
    }
    if (isArrow(intent)) {
      if (!ownsArrows()) return false;
      if (e !== null && isTypingTarget(e.target)) return false;
      /*
        Doorway: focus is still on the picture surface — step into the bar.

        And if there is nothing to step into, DO NOT EAT THE PRESS. It used to
        return true either way, which turned the surface into the dead end the
        doorway exists to prevent: land on the picture of a channel that failed,
        and every arrow after that was answered with "wake the controls" when
        there were no controls to wake. Measured as eight presses, no movement.
        Returning false hands the key to navigation, which can leave.

        Remote always uses this doorway (first press into the bar). A keyboard
        does too while there is no picture yet — loading / error / stuck open —
        because Up/Down as volume of a black rectangle is useless, and the
        controls are the only way out. Once something is actually playing, a
        keyboard keeps arrows as volume/seek on the picture surface.
      */
      if (document.activeElement === shellRef.current
        && (shape.remote || nothingToCover.current)) {
        needChromeFocus.current = true;
        wake(6000);
        if (chromeVisible || nothingToCover.current) return focusPlayerChrome();
        return true;
      }
      /*
        Past the doorway the arrows are the player's, and on a channel that means
        the channel: up and down zap, volume moves sideways. `lib/playerArrows`
        holds the whole table and the reasoning — "U cant move up / down
        channels" was six buttons no television remote sends, with the four keys
        every remote DOES send bound to the volume of a channel the viewer could
        not leave.
      */
      const move = arrowAction(intent, player.state.live,
        onPrev !== undefined && onNext !== undefined);
      if (move.do === 'channel') (move.by > 0 ? onNext : onPrev)?.();
      else if (move.do === 'volume') player.setVolume(player.state.volume + move.by);
      else if (move.do === 'seek') player.nudge(move.by);
      wake();
      return true;
    }
    // Let focus handle activation: OK on a control means press that control.
    if (intent === 'select') return false;
    if (act(intent)) { wake(); return true; }
    return false;
  }, [act, menuArrow, onNext, onPrev, ownsArrows, tab, wake, shape.remote, chromeVisible,
    focusPlayerChrome, pictureFilled]);

  /**
   * What the coloured buttons do while something is playing.
   *
   * A remote's four colours have no fixed meaning, so every screen has to say —
   * and on a player the four things worth a single press are the two tracks, the
   * picture shape and "what am I watching". The rest of the list is published
   * WITHOUT an act: `handle` above already does the work, and these exist so the
   * legend along the bottom and the shortcuts sheet can name them.
   */
  /*
    Only while there is something on screen.

    The player is MOUNTED on /live whether or not a channel is open — it is the
    pane at the top of the page — so binding the colours unconditionally would
    take them away from the channel list for a screen that is showing nothing.
    Idle means the list's own bindings (RED is Favourite there) are the ones in
    force, which is also what the legend then says.
  */
  const live = s.phase !== 'idle';
  const bindings = useMemo((): Binding[] => (!live ? [] : [
    { intent: 'red', label: 'Subtitles', act: () => { act('subtitles'); wake(); } },
    { intent: 'green', label: 'Audio', act: () => { act('audioTrack'); wake(); } },
    { intent: 'yellow', label: 'Picture size', act: () => { act('aspect'); wake(); } },
    { intent: 'blue', label: 'What is on', act: () => { act('info'); wake(); } },
    { intent: 'playPause', label: s.phase === 'playing' ? 'Pause' : 'Play' },
    { intent: 'subtitles', label: 'Subtitles' },
    { intent: 'audioTrack', label: 'Audio' },
    ...(s.live
      ? [
        { intent: 'channelUp' as const, label: 'Next channel' },
        { intent: 'channelDown' as const, label: 'Previous' },
      ]
      : [
        { intent: 'forward' as const, label: 'Forward' },
        { intent: 'back' as const, label: 'Rewind' },
        /* Only advertised when the file has chapters to skip between, because a
           hint bar that lists a button which does nothing is worse than one that
           does not mention it. */
        ...(hasJump
          ? [
            { intent: 'skipForward' as const, label: 'Next chapter' },
            { intent: 'skipBackward' as const, label: 'Previous chapter' },
          ]
          : []),
      ]),
    { intent: 'fullscreen', label: pictureFilled ? 'Leave fullscreen' : 'Fullscreen' },
    { intent: 'aspect', label: 'Picture size' },
    { intent: 'exit', label: 'Back', quiet: true },
  ]), [live, act, wake, s.phase, s.live, pictureFilled, hasJump]);
  useKeyLayer(bindings, handle);

  /**
   * Press anywhere else and the panel goes away.
   *
   * It used to stay open through anything — scrolling the channel list, opening a
   * sheet, changing route — because the only ways to dismiss it were the toolbar
   * button that opened it and Escape. Every other menu in the app closes on a
   * press outside; this one is over the video, so it never got the backdrop the
   * others have.
   *
   * A backdrop is the wrong mechanism here: it would swallow the press, and a
   * press on the seek bar has to reach the seek bar. So it is a capture-phase
   * listener that only decides whether to close, and lets the press continue to
   * whatever it was aimed at. The control bar is excluded or the toggle buttons
   * would close and reopen in one press.
   */
  useEffect(() => {
    if (tab === null && !capOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t === null) return;
      if (panelRef.current?.contains(t) === true) return;
      if (capRef.current?.contains(t) === true) return;
      if (barRef.current?.contains(t) === true) return;
      /*
         Anything portalled out of the player — the shared `Popover`, which now
         leaves the subtree so it cannot be clipped — is still INSIDE the menu as
         far as the viewer is concerned. Closing the menu because somebody
         pressed an option in its own dropdown would be the worst kind of
         dismissal.
      */
      if ((t as Element).nodeType === 1 && (t as Element).closest('[data-nav-contain]') !== null) return;
      setTab(null);
      setCapOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
    /* `capOpen` as well as `tab`: the captions popover was never in this list,
       which is the whole of "the menus when I click away it doesn't work". */
  }, [tab, capOpen]);

  /**
   * Android back, routed through the same cascade the Escape key uses.
   *
   * `act('exit')` already answers "what does leaving mean here" — close the open
   * menu, else leave fullscreen, else close the player — and it returns false when
   * there is nothing left, which is exactly what the back stack needs to hear so
   * the press can fall through to the route below.
   */
  useEffect(() => pushBackHandler(() => act('exit')), [act]);

  /**
   * Keep the screen on while there is a picture.
   *
   * Android dims on its own timer regardless of what is playing, so a film
   * watched without touching anything went dark after thirty seconds. Asked for
   * here rather than in the native player because this is true of both engines —
   * the WebView path never touches the plugin otherwise.
   */
  useEffect(() => {
    const playing = s.phase === 'playing';
    void setScreenAwake(playing);
    return () => { if (playing) void setScreenAwake(false); };
  }, [s.phase]);

  /* Immersive follows FULLSCREEN, not playback: hiding the system bars while the
     player is a strip at the top of a list would take the clock away from a screen
     that is mostly not video. */
  useEffect(() => {
    void setImmersive(full);
    return () => { void setImmersive(false); };
  }, [full]);

  const objectFit = forceCover ? 'cover' : (s.aspect === 'cover' ? 'cover' : s.aspect === 'fill' ? 'fill' : 'contain');
  const forcedRatio = s.aspect === '16:9' ? '16 / 9' : s.aspect === '4:3' ? '4 / 3' : undefined;

  /* Idle draws no bar: a seek track and eight buttons under "pick a channel"
     are controls for a stream that does not exist. An open menu still shows.
     Loading and error MUST show the chrome — otherwise a spinner (or a failed
     open) covers the picture and there is nothing to press to go back. The
     comments on `nothingToCover` describe that trap; this is the gate they
     assumed was already open. */
  const showChrome = tab !== null
    || capOpen
    || s.phase === 'paused'
    || s.phase === 'loading'
    || s.phase === 'error'
    || (s.phase === 'playing' && chromeVisible);
  const seekable = !s.live && s.duration > 0;
  const liveWindow = s.live && s.buffered > s.bufferStart + 0.5;
  const catchingUp = s.rate > 1.005 && s.live;
  const capOn = cap.phase === 'live' || cap.phase === 'starting';
  /* Room for the direct controls: fullscreen either way, theatre, or a player
     that already fills most of the window. See `bigPicture`. */
  const roomy = full || bigPicture || theatre?.on === true;
  const hasFeeds = (variants?.length ?? 0) > 1;
  const hasLevels = s.levels.length > 1;
  const hasAudio = s.audioTracks.length > 1;
  const hasQuality = hasFeeds || hasLevels || (!s.live && subtitleContext != null);
  /*
   * The film's OWN tracks count, not only the online search.
   *
   * This was `subtitleContext != null` alone — the context that lets the menu go
   * looking for subtitles on the internet — so a film carrying three subtitle
   * tracks of its own showed no SUBTITLES section at all unless it also happened
   * to be a title the search could be run for. Measured on this catalogue: of
   * eight films sampled across the library, three carry embedded subtitles, and
   * every one of those is a track already downloaded with the film.
   */
  const hasSubs = !s.live
    && (subtitleContext != null || s.subtitleTracks.length > 0 || s.externalSubs.length > 0);
  /* The stream section is the old TUNING tab: live edge, buffer, decoder. It
     exists when any of the three can do something here. */
  const hasStream = s.live || s.transport === 'mpegts' || nativeAvailable;
  const sections: { id: Tab; label: string; Icon: typeof Info }[] = [
    ...(hasInfo ? [{ id: 'info' as const, label: 'WHAT IS ON', Icon: Info }] : []),
    ...(hasJump ? [{ id: 'jump' as const, label: 'CHAPTERS', Icon: ListOrdered }] : []),
    /* QUALITY only when there is a quality to choose — a channel's feeds or a
       stream's renditions. A film has neither, and a tab called QUALITY that
       held the speed was a tab that promised something it did not have. */
    ...(hasQuality ? [{
      id: 'quality' as const,
      label: hasFeeds || hasLevels || s.live ? 'QUALITY' : 'PLAYBACK',
      Icon: SlidersHorizontal,
    }] : []),
    ...(hasAudio ? [{ id: 'audio' as const, label: 'AUDIO', Icon: AudioLines }] : []),
    ...(hasSubs ? [{ id: 'subs' as const, label: 'SUBTITLES', Icon: Subtitles }] : []),
    /* DISPLAY holds the how-big-and-how-cropped controls that used to each be
       their own icon in the bar — crop, theatre, picture-in-picture. Always
       here: there is always a picture to crop. */
    { id: 'view' as const, label: 'DISPLAY', Icon: Proportions },
    ...(hasStream ? [{ id: 'stream' as const, label: 'STREAM', Icon: Gauge }] : []),
  ];

  useEffect(() => {
    if (tab === null) return;
    if (!sections.some((t) => t.id === tab)) setTab(sections[0]?.id ?? null);
  }, [tab, s.live, hasInfo, hasQuality, hasAudio, hasSubs, hasStream, hasJump]);

  /*
   * The menu's own countdown: none while it is open, a fresh one when it closes.
   *
   * `menuOpen` is what the hide timer consults, and it has to be true BEFORE the
   * panel can be read — hence an effect on `tab` rather than setting it wherever
   * a menu happens to be opened, of which there are several. Closing restarts the
   * dwell, because otherwise a bar that outlived its timer while the panel was up
   * would sit over the picture until something else woke it.
   */
  useEffect(() => {
    const open = tab !== null || capOpen;
    menuOpen.current = open;
    if (!open && chromeVisible) wake();
  }, [tab, capOpen, chromeVisible, wake]);



  /* cssFull: a fixed sheet over the page. Held in place — see the return. */
  const stageEl = (
    <div
      ref={shellRef}
      /* Arrows inside the player prefer to stay inside it, so moving along the
         control bar cannot walk off into the channel list mid-press. */
      data-nav-scope
      /*
       * The picture is itself a focus stop, and that is what makes the player
       * REACHABLE from the channel list.
       *
       * The controls live under a bar that is hidden and `pointer-events-none`
       * until something wakes it, so while it was down the whole right-hand pane
       * contained nothing focusable — a D-pad pressing RIGHT out of the list
       * found no candidate and simply did not move. Measured exactly that way:
       * focus sat on a channel row and three presses of RIGHT changed nothing,
       * which is "I cannot move to full screen options" and "going to the right
       * side is not very clear".
       *
       * Landing here wakes the chrome, so the controls appear and the next press
       * can reach them. Only while there is something on screen: an idle player
       * is a placeholder, and a focus stop on a placeholder is a dead end.
       */
      {...(s.phase !== 'idle' ? { tabIndex: 0 } : {})}
      /*
       * A doorway, not a room.
       *
       * The picture takes focus so that one press of RIGHT from the channel list
       * reaches the player at all — see the note above. But LANDING here and
       * staying here is its own bug, and it is the one people actually report:
       * "it selects the window instead of the buttons", and then nothing moves.
       * Measured on /live before this: with focus on the surface, four presses of
       * UP and two of LEFT all left focus exactly where it was. The surface is a
       * big rectangle with nothing in it, so every direction is a dead key.
       *
       * So arriving wakes the chrome and then hands focus straight on to the
       * first control. The doorway keeps working and there is nowhere to be
       * stranded. It only stays on the surface when there is genuinely nothing to
       * pass to, which is the idle case the `tabIndex` guard above already
       * excludes.
       *
       * `e.target === e.currentTarget` matters: focusing a child fires this again
       * as it bubbles, and without the guard the handoff would re-enter itself.
       */
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        /* The chrome parking focus here as it hides. Waking now would undo the
           hide and start the blink loop described on `homing`. */
        if (homing.current) return;
        needChromeFocus.current = true;
        wake(6000);
        if (chromeVisible) focusPlayerChrome();
      }}
      /* Only where a cursor is a person — see `hoverHolds`. A TV box with a
         parked pointer emits stray moves that would relight the bar for ever. */
      onMouseMove={() => { if (hoverHolds) wake(); }}
      /*
        Touch has no mousemove, so the chrome would never come back after its
        timeout: a tap on the surface has to be able to wake it. Excluding the
        video itself, because that tap is a TOGGLE (below) — waking here first
        would make it "show, then immediately hide".
      */
      onPointerDown={(e) => {
        if (shape.touch && e.target !== videoRef.current) wake();
      }}
      onMouseLeave={() => s.phase === 'playing' && setChromeVisible(false)}
      /*
        The picture carries the app's corner setting, and a call site that is
        full-bleed says `no-round`.

        It used to be the other way round — `no-round` here unconditionally — which
        made the one largest surface in the app the only thing that never followed
        the corner preference. "The picture's corners are not its decision" is
        right as a principle and wrong as a default: the common case is a box
        inside a page, and the exception is a band flush against a screen edge.
      */
      /*
        `shrink-0` is not decoration — without it the picture disappears.

        The default box is `aspect-video w-full`, which takes its HEIGHT from its
        width. Every pane layout puts it in a `flex flex-col overflow-y-auto`
        section above a detail panel, and a flex item shrinks by default: when the
        content is taller than the pane, the browser resolves the conflict by
        squeezing the one item whose height is derived rather than declared. On a
        1920x1080 TV there was room and it survived at 343px; on a 1280x720 TV —
        every older set-top box — it was measured at exactly 0px tall. A player
        with no height, no error, and a channel playing into it.
      */
      /* `cssFull` replaces the layout box entirely rather than growing it: the
         aspect-ratio box takes its height from its width, and a fixed sheet
         needs both from the viewport. z-40 is the shell's own header, so this
         sits one above it — the picture covers the app, which is the request. */
      /*
        `relative` is on the BOX branch only, and that is the whole of why
        fullscreen never worked.

        It used to sit in the static prefix, so the element carried `relative`
        AND `fixed` together — and Tailwind emits `.relative` after `.fixed` at
        equal specificity, so the later rule wins and the element stayed
        relative. "Fullscreen" then applied `inset-0 h-full w-full` to a
        relatively-positioned box still inside its column: the picture reflowed
        to the column's width, letterboxed itself, and the channel list and
        header stayed exactly where they were. Reported as "now when full
        screen, the whole player disapers", and measured on the TV emulator at
        442x454 inside a 960x540 screen. Held by `scripts/fullscreen-probe.mjs`.

        Nothing needs `relative` in the fullscreen branch: `fixed` is a
        positioned element too, so the video and the controls inside still
        resolve their `absolute inset-0` against this box.
      */
      /* `no-round` in the fullscreen branch: `.stage` carries the app's corner
         setting, which is right for a picture in a column and wrong for a sheet
         over the whole television — a 0.75rem radius there cuts four notches out
         of the screen with the room showing through them. */
      className={`stage group overflow-hidden bg-black ${
        cssFull
          ? 'no-round fixed inset-0 z-50 h-full w-full'
          : `relative shrink-0 ${className ?? 'aspect-video w-full'}`
      }`}
    >
      {/*
        The glow, beneath the picture.

        A preceding sibling with no `z-index` paints below the `<video>`'s `z-0`,
        so this needs no stacking of its own — and `.stage` is `overflow-hidden`,
        so the blur cannot spill onto the page. With `object-fit: contain` the
        only part of it anyone sees is the letterbox bars, which is exactly the
        intent: a 4:3 channel on a 16:9 screen gets lit side panels, and a film
        with no bars is untouched.

        `filter: blur()` on THIS element is safe — it makes itself a containing
        block for fixed descendants and it has none. It must never move to an
        ancestor of `.stage`, which is the mechanism behind "the whole player
        disapers"; see scripts/fullscreen-probe.mjs.

        The transition is what makes it read as light rather than as a slideshow:
        the sampler already smooths between reads, and 600ms of CSS on top means
        even a hard cut arrives as a wash.
      */}
      {shade !== null && !forceCover && (
        <div
          aria-hidden
          data-nav-skip
          className="pointer-events-none absolute inset-0 scale-110"
          style={{
            background: `radial-gradient(120% 100% at 50% 50%, ${shade} 0%, transparent 72%)`,
            filter: 'blur(48px) saturate(1.15)',
            opacity: 0.75,
            transition: 'background 600ms linear',
          }}
        />
      )}

      <video
        ref={holdVideo}
        playsInline
        crossOrigin="anonymous"
        /*
          Tapping the picture shows and hides the controls. It does NOT pause.

          It used to pause — on a cursor always, and on glass whenever the chrome
          happened to be up — which meant that reaching for the seek bar stopped
          the programme. There is a play/pause button in the middle of the screen
          now, so the picture does not need to be one as well: one gesture, one
          meaning, and no way to stop a film by accident.
        */
        onClick={() => {
          if (chromeVisible) {
            window.clearTimeout(hideTimer.current);
            setChromeVisible(false);
            const shell = shellRef.current;
            const active = document.activeElement;
            if (
              shell
              && active instanceof HTMLElement
              && shell.contains(active)
              && active !== shell
              && panelRef.current?.contains(active) !== true
            ) {
              shell.focus({ preventScroll: true });
            }
          } else {
            wake();
          }
        }}
        /* The gesture click-to-pause used to occupy, given to the thing a cursor
           actually wants from a video and cannot otherwise reach quickly. Not on
           touch, where a double tap is a zoom and a seek on other players. */
        onDoubleClick={shape.touch ? undefined : () => void toggleFull()}
        className="absolute inset-0 z-0 h-full w-full bg-black"
        style={{ objectFit, aspectRatio: forcedRatio }}
      />

      {/* `barVisible={showChrome}` — the low caption position shares ground
          with the control bar (see `captionLift` in lib/captionLayout.ts) and
          has to know when the bar is actually up, not just repeat the same
          `chromeVisible`/`tab`/`capOpen` logic a second time. */}
      <CaptionLines state={cap} onOpenTranscript={() => setTranscript(true)} barVisible={showChrome} />
      {transcript && <TranscriptSheet state={cap} onClose={() => setTranscript(false)} />}

      {/*
        No centre cluster. There was one — previous, back ten, play, forward ten,
        next — over the middle of the picture on touch glass, standing in for the
        same buttons in the bar. Many television boxes carry a virtual
        touchscreen and report a coarse pointer, so it also appeared on
        televisions, where a D-pad cannot reach the middle of the picture at all.
        "those controls that you show in the middle of the player, I think it's
        best to show them below, same in TV and so on — that way it's a lot easier
        to access using the remote". The bar carries all five everywhere now.
      */}
      {/*
        Idle draws NOTHING unless the surface around it says what idle means here.

        A player opened by pressing PLAY is idle only for the instant between mount
        and the first byte, and filling that instant with "select something to play"
        told the viewer to do the thing they had just done. Every one of those
        surfaces now calls `player.opening(title)` before it resolves a URL, so they
        go straight to "opening <title>" and never reach this branch at all.

        A standing pane — the live grid's preview, which is mounted with no channel
        chosen — is the one place where idle is a real state a viewer can sit in, and
        that surface passes a sentence saying so.
      */}
      {s.phase === 'idle' && idleHint !== undefined && (
        <div className="absolute inset-0 z-10 grid place-items-center px-6">
          <p className="max-w-[24rem] text-center text-sm text-ink-3">{idleHint}</p>
        </div>
      )}

      {s.phase === 'loading' && (
        /* Under the chrome (z-30), not over it — and no full-bleed scrim that
           fights the bar. Spinner + label only; Back and the bottom controls
           stay usable if the open never finishes. */
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6">
          <LoadingMark label={`opening ${s.label}`} />
        </div>
      )}

      {/*
        Trying again, rather than a dead end.

        Shown in place of the error panel while the player is still working
        through `AUTO_RETRY_MS`: the same quiet centre the panel uses, without
        the alert colour or the buttons, because nothing is being asked of
        anybody yet. The count is there because a picture that says only
        "reconnecting" for a minute is indistinguishable from one that has
        stopped trying.
      */}
      {s.phase === 'error' && s.error && !s.permanent && autoTry < AUTO_RETRY_MS.length && onRetry && (
        <div
          role="status"
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3
                     bg-black/85 p-6 text-center anim-fade"
        >
          <Loader2 className="h-5 w-5 animate-spin text-ink-2" aria-hidden />
          <p className="text-sm font-medium text-ink">Reconnecting…</p>
          <p className="max-w-prose text-xs leading-relaxed text-ink-2">
            {autoTry === 0
              ? 'The stream stopped. Trying again.'
              : `Trying again — attempt ${autoTry + 1} of ${AUTO_RETRY_MS.length}.`}
          </p>
        </div>
      )}

      {s.phase === 'error' && s.error && (s.permanent || autoTry >= AUTO_RETRY_MS.length || !onRetry) && (
        <div
          /*
           * A section, not a modal.
           *
           * This declared `data-nav-contain`, which is a hard boundary: focus
           * that enters cannot leave by any arrow. On a dialog that is the point.
           * Here it is a panel filling the player pane while the channel list sits
           * right beside it — and a channel that fails to open is precisely when
           * someone needs to get back to the list and try another one. Instead the
           * two buttons in this box became the only two things on the television.
           *
           * `data-nav-scope` says what is actually true: prefer to stay in here,
           * then escalate. RETRY and the rest are still reached first; LEFT out of
           * them still reaches the list.
           */
          data-nav-scope
          /* Centred, both ways.
             This was `justify-center` alone — vertically centred, and then every
             line left-aligned against the far edge of a 960px picture, which on
             a screenshot put the whole message in the left third with
             nothing beside it. `items-center` plus `text-center` centres the
             block; the children keep their own `max-w` so the lines stay short
             enough to read rather than stretching the width of a television. */
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3
                     overflow-y-auto bg-black/90 p-6 text-center anim-fade"
        >
          <div className="flex items-center gap-2 text-alert">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p className="text-sm font-medium text-ink">{diagnosis.title}</p>
          </div>
          {diagnosis.action && (
            <p className="max-w-prose text-xs leading-relaxed text-ink-2">
              {diagnosis.action}
            </p>
          )}
          {/* Raw engine lines and the attempt trail only when debug is on —
              living-room errors are a title, one tip, and Retry. */}
          {debug && (
            <div className="max-w-prose space-y-1 border-t border-rule pt-2 text-left font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
              <p>{diagnosis.code}</p>
              <p>{s.error.message}</p>
              {s.error.hint && <p>{s.error.hint}</p>}
              {s.error.trail !== undefined && s.error.trail.length > 0 && (
                <ol className="space-y-0.5">
                  {s.error.trail.map((line, i) => (
                    <li key={i} className="truncate">{line}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              onClick={() => { setAutoTry(0); onRetry(); }}
              className="mt-1 flex items-center gap-1.5 border border-tally px-3 py-1
                         font-mono text-[length:var(--t-xs)] text-tally transition-colors hover:bg-tally hover:text-ground"
            >
              <RotateCcw className="h-3 w-3" /> RETRY
            </button>
          )}
          {/* Deliberately beside RETRY rather than hidden behind the debug PIN:
              the reports that would explain a brand-specific failure never
              arrive, because nobody who needs one knows the panel exists. */}
          <button
            onClick={sendReport}
            disabled={reportState === 'sending' || reportState === 'sent'}
            className="flex items-center gap-1.5 border border-rule px-3 py-1
                       font-mono text-[length:var(--t-xs)] text-ink-2 transition-colors
                       hover:text-ink disabled:opacity-60"
          >
            <Send className="h-3 w-3" />
            {reportState === 'sending' ? 'SENDING…'
              : reportState === 'sent' ? 'REPORT SENT'
              : reportState === 'dropped' ? 'ALREADY SENT'
              : reportState === 'failed' ? 'COULD NOT SEND'
              : 'SEND REPORT'}
          </button>
          </div>
        </div>
      )}

      {/*
        A notice: something true about a stream that is PLAYING.

        Never a box over the picture — that is what `error` is for, and the one
        case this carries is a picture worth keeping (see `notice` on the
        snapshot). So: no scrim, nothing to focus, no pointer events, and placed
        below the top bar rather than on it, so BACK and the title stay readable
        while both are up. `role="status"` so a screen reader hears it once.
      */}
      {s.notice !== null && (s.phase === 'playing' || s.phase === 'paused')
        && (noticeFresh || showChrome) && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 anim-fade
                     top-[calc(max(0.5rem,var(--edge-t))+2.75rem)]"
        >
          <p className="flex max-w-[34rem] items-start gap-2 border border-rule bg-black/85 px-3 py-2
                        text-left text-[length:var(--t-xs)] leading-snug text-ink">
            {s.notice.kind === 'noSound'
              ? <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden />
              : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-hidden />}
            <span>{s.notice.message}</span>
          </p>
        </div>
      )}

      {/*
        The top bar: the way back, what is playing, and how it is going.

        This used to be three separate things — a floating black chip at the top
        left with the clock in it, another at the top right with the stats, and an
        X. The X was the report ("why does it have a close button instead of a back
        button"), and it was right: every player anyone has used puts BACK at the
        top left, and this app had it in a row of six icons at the bottom next to
        picture-in-picture. Three floating boxes over the picture is also just
        worse looking than one bar under a scrim.

        `pointer-events-none` while hidden matters twice: it stops an invisible bar
        eating clicks meant for the picture, and it is what makes `spatialNav`
        skip these controls when the chrome is down — it reads computed
        `pointer-events` and opacity rather than guessing.
      */}
      {s.phase !== 'idle' && (
        <div
          onFocusCapture={() => wake()}
          className={`absolute inset-x-0 top-0 z-30 flex items-start gap-2 bg-gradient-to-b
            from-black/85 via-black/45 to-transparent pb-8
            pt-[max(0.5rem,var(--edge-t))] pl-[max(0.5rem,var(--edge-l))] pr-[max(0.5rem,var(--edge-r))]
            transition-all duration-300
            ${showChrome ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0'}`}
        >
          {onClose && (
            <button
              type="button"
              onClick={() => { onClose(); }}
              aria-label="Back"
              className="pill flex shrink-0 items-center gap-1.5 border border-rule bg-black/80 px-2.5 py-1.5
                         font-mono text-[length:var(--t-2xs)] tracking-widest text-ink transition-colors
                         hover:border-tally hover:text-tally"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>BACK</span>
            </button>
          )}

          {/*
            The title, and only while nobody else on the page is showing it.

            This used to always carry a LIVE dot (or the elapsed/duration clock
            on a film) ahead of the name — a second "LIVE" on top of the pill
            the bar already has: "a top-left overlay that says LIVE a second
            time", photographed. The bar's pill is the one place that status
            lives now, so this is the title, nothing else.

            Gated on `pictureFilled` rather than always shown: Live's own
            heading (`NowNext`) and Catch-up's channel line sit right under the
            picture in the normal windowed layout and say the same name, so a
            second copy here would just be the LIVE dot's mistake again in a
            different shape. Theatre, the Fullscreen API and the CSS fallback
            sheet all remove or cover whatever the route was showing beside the
            player, and that is exactly when this needs to say it instead.

            `screenFilled` is the same case by a different door: MovieDetail's
            and SeriesDesk's own full-cover portals never touch theatre, the
            Fullscreen API or the CSS sheet, so `pictureFilled` stayed false
            while the player was already the entire screen — and unlike Live,
            these have no heading anywhere else on them to say what's playing.
          */}
          {(pictureFilled || screenFilled) && (
            <div className="mt-0.5 flex min-w-0 flex-1 flex-col justify-center">
              <span className="min-w-0 truncate text-[length:var(--t-sm)] text-ink">{s.label}</span>
              {/* The programme under the channel, with its hours — the line the
                  route's own heading was showing before fullscreen took it away. */}
              {nowPlaying && (
                <span className="min-w-0 truncate font-mono text-[length:var(--t-2xs)] text-ink-2">
                  <span className="text-tally">{nowPlaying.title}</span>
                  {clockSpan(nowPlaying.startTs, nowPlaying.stopTs) !== '' && (
                    <span className="ml-2 tabular-nums text-ink-3">
                      {clockSpan(nowPlaying.startTs, nowPlaying.stopTs)}
                    </span>
                  )}
                </span>
              )}
            </div>
          )}

          {/*
            Stream vitals — resolution, bitrate, lag, stalls. Only with debug on:
            on a living-room TV they read as an error banner over a working picture.
          */}
          {debug && showDiagnostics() && (s.phase === 'playing' || s.phase === 'paused') && s.stats.resolution && (
            <div className="mt-0.5 hidden shrink-0 gap-2 font-mono text-[length:var(--t-2xs)] text-ink-3 sm:flex">
              <span>{s.stats.resolution}</span>
              {s.stats.bitrateKbps && <span>{s.stats.bitrateKbps}k</span>}
              {s.stats.lagS !== null && <span>{s.stats.lagS.toFixed(1)}s behind</span>}
              {s.stats.stalls > 0 && <span>{s.stats.stalls} stalls</span>}
              {s.stats.droppedFrames > 0 && <span className="text-alert">{s.stats.droppedFrames} dropped</span>}
            </div>
          )}
        </div>
      )}

      {capOpen && allowCaptions && (
        <div
          role="dialog"
          aria-label="Live captions"
          data-nav-contain
          onMouseEnter={() => { if (hoverHolds) window.clearTimeout(hideTimer.current); }}
          onMouseLeave={() => { if (hoverHolds) wake(); }}
          /*
            Anchored at the bottom, so it grows UPWARDS — and it has to be told
            where to stop. With the look settings folded open this popover is
            taller than the picture, and the stage clips whatever leaves the top:
            the Off/On switch and the language select, which are the two things
            the popover exists for, went off the top of the screen and could not
            be pressed. So it is capped at the picture minus the control bar and
            scrolls inside that. Vertical is the safe axis here — focus drags a
            vertical scroller with it on every list in this app, which is exactly
            what a D-pad cannot do sideways.
          */
          ref={capRef}
          /* `glass-float sheet-panel` like every other panel in the app: this was
             a hand-rolled square box with its own shadow, which is what "its a
             different card and doesn't follow our layouts" was about. */
          className="glass-float sheet-panel absolute bottom-14 right-3 z-40 flex max-h-[calc(100%-4.5rem)]
                     w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-y-auto
                     border border-rule bg-panel anim-fade"
          style={barTop === null ? undefined : { bottom: barTop + 8, maxHeight: `calc(100% - ${barTop + 16}px)` }}
        >
          <CaptionControls />
        </div>
      )}

      {/*
        The settings panel: sections down the left, the open one on the right.
      */}
      {tab && (
        <div
          ref={panelRef}
          /* Named and announced. Seven separate icon buttons became this one
             panel, and it had no accessible identity at all — a screen reader met
             an unlabelled box, and the D-pad probe had to guess at it by class
             name. */
          role="dialog"
          aria-label="Player settings"
          /* A boundary while it is open. Pressing Down through the track list used
             to walk out of the panel, off the player and into the channel list —
             the panel's own close button was the only thing that ended it. */
          data-nav-contain
          onMouseEnter={() => { if (hoverHolds) window.clearTimeout(hideTimer.current); }}
          onMouseLeave={() => { if (hoverHolds) wake(); }}
          /* Clear of the control bar rather than over it: the bar is where the
             button that opened this lives, and a menu that covers its own switch
             is how a panel becomes impossible to close by pointing at it. */
          className="sheet-panel absolute inset-y-0 right-0 bottom-14 z-40 flex w-[min(34rem,100%)]
                     overflow-hidden border-l border-rule bg-panel anim-slide"
          style={barTop === null ? undefined : { bottom: barTop }}
        >
          <nav
            ref={menuNav}
            data-nav-group="playermenu"
            data-nav-memory
            className="no-round flex w-[8.5rem] shrink-0 flex-col overflow-y-auto border-r border-rule
                       bg-ground/40 py-1.5 tv:w-[12rem] tv:py-3"
          >
            {sections.map(({ id, label, Icon }) => {
              const on = id === tab;
              return (
                <button
                  key={id}
                  /* Where Left from the content comes back to. */
                  ref={on ? openSection : undefined}
                  onClick={() => setTab(id)}
                  aria-current={on ? 'page' : undefined}
                  className={`tap flex items-center gap-2 border-l-2 px-2.5 py-2 text-left
                    font-mono text-[length:var(--t-2xs)] tracking-wider transition-colors
                    tv:gap-3 tv:px-4 tv:py-3 tv:text-[length:var(--t-xs)]
                    ${on
                      ? 'border-tally bg-tally/10 text-tally'
                      : 'border-transparent text-ink-3 hover:bg-panel-2 hover:text-ink'}`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 tv:h-4 tv:w-4" />
                  <span className="min-w-0 truncate">{label}</span>
                </button>
              );
            })}

            {/*
              The way out, at the bottom of the list where the eye ends up.

              The old panel put it in the tab strip as an X, which on a remote is
              a target you have to travel sideways past every tab to reach. BACK
              still closes this and always did; this is for the viewer who is
              looking for the door rather than remembering the key.
            */}
            <button
              onClick={() => setTab(null)}
              className="tap mt-auto flex items-center gap-2 border-l-2 border-transparent
                         border-t border-t-rule px-2.5 py-2 text-left font-mono text-[length:var(--t-2xs)]
                         tracking-wider text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink
                         tv:gap-3 tv:px-4 tv:py-3 tv:text-[length:var(--t-xs)]"
            >
              <X className="h-3.5 w-3.5 shrink-0 tv:h-4 tv:w-4" />
              <span>CLOSE</span>
            </button>
          </nav>

          <div
            ref={menuPane}
            key={tab}
            data-nav-scope
            /* Focusable by hand-off only: -1 keeps it out of the geometry, so
               nothing ever lands on the container instead of on a control. */
            tabIndex={-1}
            className="anim-fade min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">

            {/*
              What is on, given by the route.

              The player knows the stream and nothing about the programme, so this
              is a node passed in — see the `info` prop. It used to be a button
              under the picture that unfolded a panel BELOW the video, which put
              half of "what am I watching" on the page and half in the player.
            */}
            {tab === 'info' && <div className="p-3">{info}</div>}

            {/*
              Where to jump to.

              A grid rather than a list, because on a television this is reached
              with a D-pad and a grid is two presses to the far end of a film where
              a column of fifteen rows is fifteen. Each cell is a real button, so
              `data-nav-contain` on the panel keeps the arrows inside it and the
              existing focus ring does the rest.

              Every row here came out of the file. The tab does not exist for a
              title whose container declared no chapters, which is currently all
              of them — see lib/chapters.ts.
            */}
            {tab === 'jump' && (
              <>
                <p className="menu-label">{stopList.length} CHAPTERS</p>
                <div className="grid grid-cols-3 gap-1 p-2 pt-0 sm:grid-cols-4">
                  {stopList.map((c, i) => (
                    <button
                      key={c.startS}
                      onClick={() => { player.seek(c.startS); setTab(null); }}
                      className={`border px-1.5 py-2 font-mono text-[length:var(--t-2xs)] tabular-nums transition-colors
                        ${i === stopHere
                          ? 'border-tally bg-tally/10 text-tally'
                          : 'border-rule text-ink-2 hover:border-tally hover:text-tally'}`}
                    >
                      <span className="block text-[length:var(--t-2xs)] text-ink-3">{i + 1}</span>
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="px-2 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
                  From the file itself. The remote's skip buttons step between them.
                </p>
              </>
            )}

            {tab === 'quality' && (
              <>
                {hasFeeds && variants && (
                  <>
                    <p className="menu-label">FEEDS OF THIS CHANNEL</p>
                    <button
                      onClick={() => onQualityMode?.()}
                      className={`menu-row ${qualityMode === 'auto' ? 'is-on' : ''}`}
                    >
                      <span className="dot" />
                      <span>Auto</span>
                      <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">
                        {qualityMode === 'auto'
                          ? (variants.find((v) => v.active)?.quality ?? 'connection speed')
                          : 'connection speed'}
                      </span>
                    </button>
                    {variants.map((v) => {
                      const locked = qualityMode !== 'auto';
                      const on = locked && (
                        v.quality === qualityMode
                        || (v.active && !variants.some((x) => x.quality === qualityMode))
                      );
                      /*
                       * A sibling feed is a CHANNEL, so it gets the channel rule.
                       *
                       * This row had a private one — a pipe prefix and nothing
                       * else — which is `displayName`'s oldest rule and about a
                       * fifth of it. Everything the panel decorates a live name
                       * with came through: "BE| VTM 4 ᴿᴬᵂ" reached this menu as
                       * "VTM 4 ᴿᴬᵂ", and a bracket tag or a dash prefix reached
                       * it whole. The `title` beside it was the raw name.
                       */
                      const label = displayName(v.name);
                      return (
                        <button
                          key={v.id}
                          onClick={() => onPickVariant?.(v.id)}
                          title={label}
                          className={`menu-row ${on ? 'is-on' : ''}`}
                        >
                          <span className="dot" />
                          <span>{v.quality}</span>
                          <span className="ml-auto truncate font-mono text-[length:var(--t-2xs)] text-ink-3">
                            {label}
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
                {hasLevels && (
                  <>
                    {hasFeeds && <p className="menu-label">IN-STREAM RENDITIONS</p>}
                    <TrackList
                      options={s.levels}
                      onPick={(id) => player.setLevel(id)}
                    />
                  </>
                )}
            {s.live && onLiveMode && liveMode !== undefined && (
                  <>
                    <p className="menu-label">TRANSPORT</p>
                    {LIVE_MODES.map(({ id, label, hint }) => (
                      <button
                        key={id}
                        onClick={() => onLiveMode(id)}
                        className={`menu-row ${id === liveMode ? 'is-on' : ''}`}
                      >
                        <span className="dot" />
                        <span>{label}</span>
                        <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">{hint}</span>
                      </button>
                    ))}
                    <p className="px-3 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
                      {liveMode === 'auto'
                        ? 'The fast path by default; a channel the raw feed cannot carry drops to '
                          + 'HLS on its own and stays there.'
                        : liveMode === 'lowLatency'
                          ? 'Raw MPEG-TS on every channel, ~1-3s behind live. Some channels will not play.'
                          : 'HLS on every channel: ~30s behind live, and the widest codec support.'}
                    </p>
                  </>
                )}
                {!s.live && (
                  <>
                    <p className="menu-label">SPEED</p>
                    <div className="flex flex-wrap gap-1 p-2 pt-0">
                      {SPEEDS.map((r) => (
                        <button
                          key={r}
                          onClick={() => player.setUserRate(r)}
                          className={`border px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
                            ${Math.abs(s.userRate - r) < 0.01
                              ? 'border-tally text-tally'
                              : 'border-rule text-ink-2 hover:text-ink'}`}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {tab === 'audio' && (
              <TrackList
                options={s.audioTracks}
                onPick={(id) => player.setAudio(id)}
              />
            )}

            {tab === 'subs' && hasSubs && (
              <SubtitleMenu
                key={`${subtitleContext?.title ?? ''}|${subtitleContext?.year ?? ''}|${subtitleContext?.season ?? ''}|${subtitleContext?.episode ?? ''}`}
                snap={s}
                context={subtitleContext ?? null}
              />
            )}

            {tab === 'view' && (
              <>
                <p className="menu-label">PICTURE</p>
                <AspectPicker value={s.aspect} />
                {(theatre || pipAvailable) && <p className="menu-label">LAYOUT</p>}
                {theatre && (
                  <button
                    onClick={() => { theatre.toggle(); }}
                    className={`menu-row ${theatre.on ? 'is-on' : ''}`}
                  >
                    <span className="dot" />
                    <span>{theatre.on ? 'Player fills the screen' : 'Player only (hide the list)'}</span>
                  </button>
                )}
                {pipAvailable && (
                  <button onClick={() => void player.togglePip()} className="menu-row">
                    <span className="dot" />
                    <span>Picture in picture</span>
                  </button>
                )}
              </>
            )}

            {tab === 'stream' && (
              <>
                {s.live && (
                  <>
                    <p className="menu-label">LIVE</p>
                    <button
                      type="button"
                      onClick={() => player.goLive()}
                      className="menu-row"
                    >
                      <span className="dot" />
                      <span>Go live</span>
                      {s.stats.lagS !== null && (
                        <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">
                          −{s.stats.lagS.toFixed(0)}s
                        </span>
                      )}
                    </button>
                    <p className="menu-label">LIVE EDGE</p>
                    <button
                      onClick={() => player.setChaseLiveEdge(!s.chaseLiveEdge)}
                      className={`menu-row ${s.chaseLiveEdge ? 'is-on' : ''}`}
                    >
                      <span className="dot" />
                      {s.chaseLiveEdge
                        ? 'On — plays slightly faster to close the gap'
                        : 'Off — stay where you are (use the delay bar)'}
                    </button>
                    <p className="px-3 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
                      Off by default. Drag the progress bar to choose how many
                      seconds or minutes behind live you sit — the stream keeps
                      downloading either way. Turn this on only if you want the
                      player to speed up by up to {Math.round((resolveBufferProfile(streamKey).maxRate - 1) * 100)}%
                      until it reaches the live edge.
                    </p>
                  </>
                )}
                {s.live && streamKey != null && streamKey !== '' && (
                  <>
                    <p className="menu-label">BUFFER</p>
                    <BufferChoiceControls
                      allowDefault
                      defaultLabel={bufferChoiceLabel(getGlobalBufferChoice())}
                      value={channelBuffer}
                      onChange={(next) => {
                        setChannelBufferChoice(streamKey, next);
                        setChannelBuffer(next);
                        onBufferChange?.();
                      }}
                    />
                    {s.stats.stalls > 2 && (
                      <p className="px-3 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
                        This stream has stalled a few times — a larger buffer will help.
                      </p>
                    )}
                  </>
                )}
                {/*
                  The decoder, chosen per stream and overridable.

                  Worth a control rather than being purely automatic: the whole
                  point of the native engine is the streams whose codec nothing
                  knows in advance, and the person holding the phone can see
                  "this channel is black" long before any heuristic can. Auto
                  escalates on a decode failure and remembers the answer.
                */}
                {nativeAvailable && (
                  <>
                    <p className="menu-label">DECODER</p>
                    {ENGINES.map(({ id, label, hint }) => (
                      <button
                        key={id}
                        onClick={() => { setEnginePref(id); setEngine(id); }}
                        className={`menu-row ${id === engine ? 'is-on' : ''}`}
                      >
                        <span className="dot" />
                        <span>{label}</span>
                        <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3">{hint}</span>
                      </button>
                    ))}
                    <p className="px-3 pb-2 font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
                      {engine === 'auto'
                        ? 'The browser plays what it can; anything it cannot decode switches to '
                          + 'the native player automatically, and stays there next time.'
                        : engine === 'native'
                          ? 'Everything through libVLC — HEVC, AC-3, E-AC-3, MP2 and MKV included. '
                            + 'Subtitles the page draws over the picture are unavailable while it owns the surface.'
                          : 'Browser only. Use this to check whether a problem is the native player.'}
                    </p>
                    <button
                      onClick={() => { forgetLearnedEngines(); setForgotten(true); }}
                      className="menu-row"
                    >
                      <span className="dot" />
                      <span>{forgotten ? 'Forgotten' : 'Forget learned decoders'}</span>
                    </button>
                  </>
                )}
                <p className="menu-label">DIAGNOSTICS</p>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 px-3 pb-2 font-mono text-[length:var(--t-2xs)] text-ink-3">
                  <dt>transport</dt><dd className="text-ink-2">{s.transport ?? '—'}</dd>
                  <dt>rate</dt><dd className="text-ink-2">{s.rate.toFixed(2)}×</dd>
                  <dt>behind head</dt>
                  <dd className="text-ink-2">{s.stats.lagS === null ? '—' : `${s.stats.lagS.toFixed(1)}s`}</dd>
                  {s.stats.latencyS !== null && (
                    <>
                      <dt>hls latency</dt><dd className="text-ink-2">{s.stats.latencyS.toFixed(1)}s</dd>
                    </>
                  )}
                  <dt>stalls</dt><dd className="text-ink-2">{s.stats.stalls}</dd>
                  <dt>dropped</dt><dd className="text-ink-2">{s.stats.droppedFrames}</dd>
                  {s.stats.codec && (<><dt>codec</dt><dd className="text-ink-2">{s.stats.codec}</dd></>)}
                  <dt>decoder</dt>
                  <dd className="text-ink-2">{s.transport === 'native' ? 'native (libVLC)' : 'browser'}</dd>
                </dl>
              </>
            )}
          </div>
        </div>
      )}

      {/* control bar */}
      <div
        ref={barRef}
        /* Arriving sideways from the list starts at Play/Pause — see
           `data-nav-entry-first` in lib/spatialNav.ts. */
        data-nav-entry-first
        /* Hold while the cursor is genuinely on the bar, and RESUME on the way
           out. The old handler cleared the timer and never replaced it, which is
           why the controls never went away again — see `hoverHolds`. */
        onMouseEnter={() => { if (hoverHolds) window.clearTimeout(hideTimer.current); }}
        onMouseLeave={() => { if (hoverHolds) wake(); }}
        onFocusCapture={() => wake()}
        className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/92 via-black/70 to-transparent
          pt-6 transition-all duration-300
          pb-[max(0.5rem,var(--edge-b))] pl-[max(0.75rem,var(--edge-l))] pr-[max(0.75rem,var(--edge-r))]
          ${showChrome ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0 pointer-events-none'}`}
      >
        {/* progress / buffer */}
        <div className="mb-2 flex items-center gap-2">
          {seekable ? (
            <>
              <span className="font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-2">{clock(s.currentTime)}</span>
              <SeekBar
                duration={s.duration}
                current={s.currentTime}
                buffered={s.buffered}
                held={s.heldSpans}
                frameAt={s.frameAt}
                stops={stopTimes}
                onSeek={(t) => player.seek(t)}
              />
              <span className="font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">{clock(s.duration)}</span>
            </>
          ) : liveWindow ? (
            <LiveDelayBar
              start={s.bufferStart}
              end={s.buffered}
              current={s.currentTime}
              onSeek={(t) => player.seek(t)}
            />
          ) : (
            /* The bar for a stream with no timeline yet (still opening).

               It was green while the seekable bar beside it was amber, which put
               two accent colours on one control and made the same bar look like a
               different feature depending on what was playing. Green is a STATUS
               here — the LIVE dot above earns it — and an accent is not a status.
               The difference between "you can seek this" and "you cannot" is
               carried by the shape instead: a full-width wash with no handle and
               no stops. */
            <div className="meter h-1 flex-1 overflow-hidden bg-rule">
              <div className={`h-full bg-gradient-to-r from-tally/40 to-tally/10 ${catchingUp ? 'w-full animate-pulse' : 'w-full'}`} />
            </div>
          )}
        </div>

        {/*
          The row, in two groups: what you do to the STREAM on the left, what
          you do to the PICTURE on the right, pushed into its own corner.
          ────────────────────────────────────────────────────────────────────
          "the player butons icons is in wrong order". It was one flat list with
          the volume control sitting in the middle of the transport buttons and
          the LIVE badge after it — which is the order they happened to be
          written in rather than an order anybody chose.

          ── LIVE moved OUT of its own spacer group, next to play/pause ──

          "live near play button and so on." There is no middle group any more:
          it existed to hold the LIVE pill (and the speed badge, its VOD
          equivalent) centred over the slack, and centred-over-the-slack is
          exactly the "floating in the middle" the pill was reported for. It
          now sits directly after play/pause instead, first thing in the left
          group, with Restart right beside it — Restart only exists because of
          the LIVE pill, so it lives where the pill lives.

          ── full screen is LAST, not first ──

          It used to lead the right-hand group on purpose: this player is
          driven by a remote, play/pause is always `data-nav-first`, and every
          button between play/pause and full screen used to be a press paid
          for. Convention wins anyway: full screen belongs at the end of the
          bar. Play/pause is still
          `data-nav-first`, so arriving from the channel list still costs the
          same one press it always has — what changed is how far full screen
          now sits from it along the bar, which is the trade being made here.

          ── and the row cannot scroll sideways any more ──

          It carried `overflow-x-auto`. On a remote that is not a scroller, it is
          a disappearance: a D-pad cannot scroll a horizontal container, so
          anything past the right edge is simply not there, and the first thing a
          viewer learns about it is that the button they are looking for is gone.
          It wraps now. On the 960x540 these boxes report there is room for all of
          it on one line — 908px of content in 941px, measured — so the wrap is a
          floor under a narrow player rather than the normal case.
        */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            {/*
              Play/pause is leftmost, and that is load-bearing.

              A sideways arrival into this bar is decided by geometry, so
              whatever is leftmost is what RIGHT out of the channel list lands
              on. `focusPlayerChrome` honours `data-nav-first` and lands on
              play/pause; a direct press lands on whatever is nearest. Those two
              paths have to agree or LEFT out of the bar becomes a two-press job,
              and it has already cost one round of "RIGHT lands on Previous".

            */}
            {(
              <button
                type="button"
                data-nav-first
                onClick={() => player.togglePlay()}
                aria-label="Play or pause"
                className="ctl"
              >
                {s.phase === 'playing' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
            )}

            {/*
              The LIVE pill, directly after play/pause — "live near play
              button" — and the film equivalent beside it: a speed badge,
              shown only while the rate is off 1×. The two never show together,
              so there is no order to argue about between them.

              This is also the one stop into the stream-settings tab (live edge,
              buffer, decoder) UNLESS a restart is in progress, in which case
              the pill IS the way back to live — see `restarted`/`onGoLive` on
              the component, wired from routes/Live.tsx.

              `restarted` has to be in this condition, not just in what the
              pill says: `onRestart` loads the archive with `live: false` —
              same as any other recording, and the same reason `Catchup.tsx`
              needs it — so `s.live` alone goes false the moment Restart is
              pressed and the pill would vanish rather than turn into "Go
              live". Measured: without this the LIVE pill disappeared, the
              speed badge (its `!s.live` neighbour) appeared in its place if
              the rate was off 1×, and there was no way back to live at all.
            */}
            {(s.live || restarted) && (
              <button
                type="button"
                onClick={() => {
                  if (restarted) { onGoLive?.(); return; }
                  setCapOpen(false);
                  setTab((t) => (t === 'stream' ? null : 'stream'));
                  wake(BUSY_MS);
                }}
                title={restarted ? 'Go live' : 'Stream settings — live edge, buffer, decoder'}
                aria-expanded={!restarted && tab === 'stream'}
                aria-haspopup={restarted ? undefined : 'dialog'}
                className={`flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] transition-colors
                  ${restarted || tab === 'stream' || (s.stats.lagS !== null && s.stats.lagS > 12)
                    ? 'border-tally text-tally'
                    : 'border-rule text-ink-2 hover:border-tally hover:text-tally'}`}
              >
                <Radio className="h-3 w-3" /> {restarted ? 'Go live' : 'LIVE'}
              </button>
            )}
            {/* `!restarted` keeps this the LIVE pill's mutually-exclusive
                other half in fact, not just in the comment above: a restarted
                archive also has `!s.live`, and without this a sped-up restart
                showed BOTH the "Go live" pill and this badge at once. */}
            {!s.live && !restarted && s.userRate !== 1 && (
              <button
                onClick={() => player.setUserRate(1)}
                className="border border-tally px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-tally"
                title="Back to normal speed"
              >
                {s.userRate}×
              </button>
            )}

            {/*
              Restart: play the current live programme again from its own
              start. Only when the caller can actually offer that — see
              `onRestart` on the component — which today means a live channel
              with an archive and a known "now", wired from routes/Live.tsx.
            */}
            {onRestart && (
              <button
                type="button"
                onClick={() => { onRestart(); wake(); }}
                aria-label="Restart"
                title="Restart — play this programme from the beginning"
                className="ctl"
              >
                <History className="h-4 w-4" />
              </button>
            )}

            {/*
              Back ten, forward ten — IN THE BAR, which is the half of this that
              was missing.
              ──────────────────────────────────────────────────────────────────
              "Also if possible add the feature to go few seconds back and forth
              like that, I think in controls in player."

              Both of those existed already and neither was reachable from a
              chair. The centre cluster over the picture has had them for a while,
              and it is `tabIndex -1` on a remote on purpose. Arrows nudge by ten
              as well, but only when focus is on the picture SURFACE, and on a
              remote the first arrow press steps into this bar instead, so that
              path is a cursor and keyboard feature. The handset's own FF/REW keys
              jump thirty and most boxes do not have them. Net effect, measured: a
              viewer holding a D-pad had no way to skip ten seconds at all.

              `seekable` is the gate rather than `!s.live`: a stream with no
              duration yet cannot be nudged, and a control that does nothing is
              worse than one that is absent..
            */}
            {seekable && (
              <button
                type="button"
                onClick={() => { player.nudge(-10); wake(); }}
                aria-label="Back 10 seconds"
                title="Back 10 seconds"
                className="ctl"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
            {seekable && (
              <button
                type="button"
                onClick={() => { player.nudge(10); wake(); }}
                aria-label="Forward 10 seconds"
                title="Forward 10 seconds"
                className="ctl"
              >
                <RotateCw className="h-4 w-4" />
              </button>
            )}

            {/*
              Previous and next, which a remote could not reach at all.

              They used to live only in a centre cluster over the picture — and that
              cluster is `tabIndex -1` on a remote on purpose, because a focus
              stop in the middle of a film is not somewhere a D-pad should walk.
              Correct, and it left a television with no way to change channel
              from inside the player: "navigate other channals and so on". So
              they are stops HERE too, after the rest of the transport rather
              than right beside play/pause now that LIVE/Restart sit there
              instead.

              ── and no longer gated on how big the picture is ──

              They also carried `roomy` — fullscreen, theatre, or a player
              already filling 70% of the window — which is every case except the
              one that needed them most. The series desk plays an episode in a
              column BESIDE the episode list, so the picture is under 70% and
              `roomy` was false, and the centre cluster over it is `tabIndex -1`
              on a remote by design: on that screen a D-pad had no route to the
              next episode at all. "there is no way playing prev and next in
              movies and seires."

              Nothing about a smaller picture makes a 33px button not fit. The
              row wraps (see its own note), so the floor under a narrow player is
              a second line rather than a button that disappears — which is the
              failure `roomy` was written to prevent, already solved somewhere
              better.
            */}
            {onPrev && (
              <button
                type="button"
                onClick={acted(onPrev)}
                aria-label={s.live ? 'Previous channel' : 'Previous'}
                title={s.live ? 'Previous channel' : 'Previous'}
                className="ctl"
              >
                <SkipBack className="h-4 w-4" />
              </button>
            )}
            {onNext && (
              <button
                type="button"
                onClick={acted(onNext)}
                aria-label={s.live ? 'Next channel' : 'Next'}
                title={s.live ? 'Next channel' : 'Next'}
                className="ctl"
              >
                <SkipForward className="h-4 w-4" />
              </button>
            )}

            {/*
              Mute and the slider, moved out of the picture-controls group: they
              change what you hear, not what you see, and the left group is
              otherwise everything the STREAM does.
            */}
            <button onClick={() => player.toggleMute()} aria-label="Mute" className="ctl">
              {s.muted || s.volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            {/*
              Never a D-pad stop. A focused `<input type="range">` eats Left/Right
              as "nudge the thumb", so the remote could not leave the volume area
              for the rest of the bar or the pane beside the player. Mute + the
              handset's volume keys cover the same job on a television.
            */}
            {!shape.remote && (
              <input
                type="range" min={0} max={1} step={0.02}
                value={s.muted ? 0 : s.volume}
                onChange={(e) => player.setVolume(Number(e.target.value))}
                aria-label="Volume"
                className="hidden h-1 w-16 cursor-pointer accent-tally min-[420px]:block"
              />
            )}
          </div>

          {/*
            The right group: everything that changes the PICTURE (or reaches a
            drawer that does), pushed into the far corner with `ml-auto` now
            that there is no middle group to do that job.
          */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            {roomy && hasSubs && (
              <button
                onClick={() => { setTab((t) => (t === 'subs' ? null : 'subs')); wake(BUSY_MS); }}
                aria-label="Subtitles"
                title="Subtitles — search, load, offset, look"
                className={`ctl ${tab === 'subs' ? 'text-tally' : ''}`}
              >
                <Subtitles className="h-4 w-4" />
              </button>
            )}
            {allowCaptions && (
              <button
                onClick={() => {
                  setCapOpen((v) => !v);
                  setTab(null);
                  wake(BUSY_MS);
                }}
                aria-label="Live captions"
                aria-expanded={capOpen}
                title="Live captions — transcribe what is being said"
                className={`ctl ${capOpen || capOn ? 'text-tally' : ''}`}
              >
                <ClosedCaption className="h-4 w-4" />
              </button>
            )}
            {/*
              ── the guide button is gone from this bar ──

              "that guide full screen or somethin, remove that from player
              please, bcs its below it anyways, and no need to redirect them."
              It is right: under the picture Live already draws what is on now,
              what is next and a way into the whole schedule, so a button here
              was a second door to a room the viewer is already standing in —
              and unlike everything else on this bar it took them OFF the
              picture they were watching.

              `onGuide` stays on the component and stays wired to the remote's
              GUIDE key (`case 'guide'` above), which is the one place a viewer
              asks for the schedule without having to see a control.
            */}
            {sections.length > 0 && (
              <button
                onClick={() => {
                  setCapOpen(false);
                  setTab((t) => (t === null ? (sections[0]?.id ?? 'view') : null));
                }}
                aria-label="Settings"
                title="Settings — quality, audio, subtitles, display"
                className={`ctl ${tab !== null ? 'text-tally' : ''}`}
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
            {roomy && theatre && (
              <button
                onClick={() => { theatre.toggle(); wake(1200); }}
                aria-label={theatre.on ? 'Show the list' : 'Player only'}
                title={theatre.on ? 'Show the list again' : 'Player only — hide the list'}
                className={`ctl ${theatre.on ? 'text-tally' : ''}`}
              >
                <Columns2 className="h-4 w-4" />
              </button>
            )}
            {roomy && pipAvailable && (
              <button
                onClick={() => { void player.togglePip(); wake(1200); }}
                aria-label="Small window"
                title="Small window — keep watching while you browse"
                className="ctl"
              >
                <PictureInPicture2 className="h-4 w-4" />
              </button>
            )}
            {/*
              Full screen, ALWAYS last — the far corner, convention's spot.
              See the note at the top of this bar for why it moved back here.
              Full screen, the CSS sheet and Live theatre are one idea to the
              viewer — the picture owns the screen — so the glyph flips to
              Minimize2 whenever any of those is on.
            */}
            <button
              onClick={() => void toggleFull()}
              aria-label={pictureFilled ? 'Leave fullscreen' : 'Fullscreen'}
              title={pictureFilled ? 'Leave fullscreen — back to the page' : 'Fullscreen'}
              className={`ctl ${pictureFilled ? 'text-tally' : ''}`}
            >
              {pictureFilled ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  /*
   * Returned in place, and that is not a style choice.
   *
   * This used to be `cssFull ? createPortal(stageEl, document.body) : stageEl`,
   * and switching a return value between a portal and a plain element changes
   * the shape of the tree at that position — so React UNMOUNTS the whole stage
   * and builds a new one in the new parent. Every DOM node in it is discarded,
   * including the `<video>`.
   *
   * That element is the one thing here that must survive: it holds the MediaSource
   * hls.js is feeding, and a detached media element goes on decoding. Measured on
   * the real page with the APK's fullscreen path forced: before the press the
   * element had `blob:http://…`, after it the visible element had `src: ""` and
   * the tagged original was gone. So pressing fullscreen left an orphan playing
   * audio behind a blank picture — "the video goes away and I will only hear
   * audio", now with a reason.
   *
   * The portal was there so a `position: fixed` stage could not be trapped inside
   * a Modern glass column. It is not needed for that: `scripts/fullscreen-probe.mjs`
   * measures `.stage` WHERE IT LIVES, walks every ancestor for a containing block,
   * and asserts the fullscreen rectangle is the whole viewport at the origin. That
   * probe is green, and it is what holds this.
   */
  return stageEl;
}

/** "20:00 – 20:45", in the viewer's own clock. Empty when a bound is missing. */
function clockSpan(startTs: number, stopTs: number | null): string {
  const at = (ts: number): string =>
    new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (stopTs === null) return at(startTs);
  return `${at(startTs)} – ${at(stopTs)}`;
}

function nextSpeed(current: number, dir: 1 | -1): number {
  const i = SPEEDS.findIndex((x) => Math.abs(x - current) < 0.01);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i === -1 ? 2 : i) + dir))];
  return next ?? 1;
}
