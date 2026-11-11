import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, ScrollText, X } from 'lucide-react';
import {
  CAPTION_LANGS, acceptCaptionsNotice, captions, captionsNoticeAccepted, type CaptionState,
} from '../lib/liveCaptions';
import { BRAND } from '../brand';
import {
  captionBottomPct, captionBoxStyle, captionFontRem, captionLift, overlayCaptionRows,
} from '../lib/captionLayout';
import { useShape, type FormFactor } from '../lib/formFactor';
import { player } from '../lib/playerCore';
import { apiUrl } from '../lib/api';
import { setPrefs, usePrefs, type CaptionPrefs } from '../lib/prefs';
import { Select } from './ui';

/**
 * Live captions drawn over the video.
 *
 * Layout (size, plate, how many previous lines) comes from caption prefs so the
 * settings panel and the picture agree.
 */
/**
 * The last element, without `Array.prototype.at`.
 *
 * `.at(-1)` reads better and is Chrome 92. This app renders inside the device's
 * SYSTEM WebView on Android — frozen at whatever shipped, on the TV boxes this is
 * built for — and a missing method is not a graceful degradation, it is
 * `TypeError: x.at is not a function` and a blank screen with no console to ask.
 * A build target cannot help: transpilers rewrite syntax, not library calls.
 * `scripts/bundle-floor.mjs` is what reports these.
 */
function last<T>(xs: T[]): T | undefined {
  return xs.length === 0 ? undefined : xs[xs.length - 1];
}

function CaptionStack({
  rows,
  spoken,
  style,
  ff,
  onOpenTranscript,
}: {
  rows: string[];
  spoken?: string;
  style: CaptionPrefs;
  ff: FormFactor;
  onOpenTranscript?: () => void;
}) {
  const box = captionBoxStyle(style);
  return (
    <button
      type="button"
      onClick={() => onOpenTranscript?.()}
      title="Open the full transcript"
      className="w-full max-w-3xl cursor-pointer space-y-1 px-2.5 py-1.5 text-center"
      style={box}
    >
      {rows.map((text, i) => {
        const newest = i === rows.length - 1;
        return (
          <p
            key={`${i}:${text.slice(0, 24)}`}
            dir="auto"
            className="break-words leading-snug"
            style={{
              fontSize: captionFontRem(style.size, newest, ff),
              opacity: newest ? 1 : 0.82,
            }}
          >
            {text}
          </p>
        );
      })}
      {spoken && (
        <p
          dir="auto"
          className="break-words font-mono leading-snug opacity-70"
          style={{ fontSize: captionFontRem(style.size, false, ff) }}
        >
          {spoken}
        </p>
      )}
    </button>
  );
}

export function CaptionLines({
  state, onOpenTranscript, barVisible = false,
}: {
  state: CaptionState;
  onOpenTranscript?: () => void;
  /**
   * Is the control bar up right now?
   *
   * Only `low` ever shares ground with it (see `captionLift`), and only while
   * it is showing — `VideoPlayer.tsx` already computes exactly this as
   * `showChrome` for the bar's own visibility, so it costs that one call a
   * prop to hand the same answer down here rather than a second notion of
   * "is the bar up" drifting from the first.
   */
  barVisible?: boolean;
}) {
  const [prefs] = usePrefs();
  /* Subscribed, not read once: the caption ladder differs between a television
     and a desk, and a window that is resized across that line has to repaint the
     captions with it — see `captionFontRem`. */
  const { ff } = useShape();
  const style = prefs.captions;
  if (state.phase === 'off') return null;
  const rows = overlayCaptionRows(state.lines, style.lines);
  const spoken = state.showOriginal && state.target !== 'off'
    ? last(state.spokenLines.filter((l) => l.orig.trim() !== ''))
    : undefined;

  return (
    <div
      className="absolute inset-x-0 z-20 flex flex-col items-center gap-1 px-[6%] transition-transform duration-300"
      style={{ bottom: captionBottomPct(style.position), transform: captionLift(style.position, barVisible) }}
    >
      {state.phase === 'starting' && (
        <span className="pointer-events-none flex items-center gap-1.5 bg-black/70 px-2 py-1 font-mono text-[length:var(--t-2xs)] text-ink-2">
          <Loader2 className="h-3 w-3 animate-spin" /> starting captions…
        </span>
      )}
      {state.phase === 'error' && (
        <span className="pointer-events-none max-w-2xl bg-black/80 px-2 py-1 text-center font-mono text-[length:var(--t-2xs)] leading-relaxed text-alert">
          {state.error}
        </span>
      )}

      {(rows.length > 0 || spoken) && (
        <CaptionStack
          rows={rows.map((r) => r.orig)}
          spoken={spoken?.orig}
          style={style}
          ff={ff}
          onOpenTranscript={onOpenTranscript}
        />
      )}
    </div>
  );
}

/**
 * The whole session's transcript, in a sheet.
 *
 * Captions scroll away in seconds; this is where you go to read what was actually
 * said. It follows the newest line unless the reader has scrolled up, because
 * yanking someone back to the bottom mid-sentence defeats the purpose.
 */
export function TranscriptSheet({
  state, onClose,
}: {
  state: CaptionState;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (!follow) return;
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.lines, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [which, setWhich] = useState<'display' | 'spoken'>('display');
  const source = which === 'spoken' ? state.spokenLines : state.lines;
  const lines = source.filter((l) => l.orig.trim() !== '');
  const canSwitch = state.target !== 'off' && state.spokenLines.length > 0;

  return (
    <div
      data-nav-contain
      className="absolute inset-0 z-50 flex flex-col bg-ground anim-fade"
    >
      <div className="flex items-center justify-between border-b border-rule px-3 py-2">
        <span className="flex items-center gap-1.5 font-mono text-[length:var(--t-xs)] tracking-widest text-ink-3">
          <ScrollText className="h-3.5 w-3.5" /> TRANSCRIPT
          <span className="text-ink-3/70">{lines.length} lines</span>
        </span>
        <div className="flex items-center gap-2">
          {canSwitch && (
            <div className="flex">
              {(['display', 'spoken'] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => setWhich(w)}
                  className={`border px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] ${
                    which === w ? 'border-tally text-tally' : 'border-rule text-ink-3 hover:text-ink'
                  }`}
                >
                  {w === 'display' ? state.target.toUpperCase() : 'SPOKEN'}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => void copyTranscript(state, which)}
            className="border border-rule px-2 py-0.5 font-mono text-[length:var(--t-2xs)] text-ink-3 hover:border-tally hover:text-tally"
          >
            copy
          </button>
          <button onClick={onClose} aria-label="Close transcript" className="text-ink-3 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
      >
        {lines.length === 0 ? (
          <p className="font-mono text-[length:var(--t-xs)] text-ink-3">
            Nothing transcribed yet. Lines appear here as they are spoken.
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id === -1 ? 'live' : l.id} dir="auto" className="border-l-2 border-rule pl-2">
              {l.speaker && (
                <span className="mr-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-tally">
                  spk {l.speaker}
                </span>
              )}
              <span className="text-[length:var(--t-md)] leading-relaxed text-ink">{l.orig}</span>
            </div>
          ))
        )}
      </div>

      {!follow && (
        <button
          onClick={() => setFollow(true)}
          className="border-t border-rule bg-panel px-3 py-1.5 font-mono text-[length:var(--t-2xs)] text-tally"
        >
          ↓ jump to the newest line
        </button>
      )}
    </div>
  );
}

async function copyTranscript(state: CaptionState, which: 'display' | 'spoken'): Promise<void> {
  const text = (which === 'spoken' ? state.spokenLines : state.lines)
    .filter((l) => l.orig.trim() !== '')
    .map((l) => l.orig)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked without a user gesture in some contexts */
  }
}

/**
 * A pick-one row, drawn for a remote.
 *
 * Chips rather than a slider, and a stepper rather than a slider, because a
 * slider on a D-pad is a trap: `<input type="range">` eats Left and Right as
 * "nudge the thumb", so a viewer who lands on one cannot get off it again —
 * which is exactly why the volume slider next door is hidden on a remote. Every
 * control in this panel is a plain button, so every press is a stop on the way
 * down and BACK always works.
 */
function PickRow<T extends string>({
  label, value, options, onPick,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="font-mono text-[length:var(--t-2xs)] tracking-wider text-ink-3 tv:text-[length:var(--t-xs)]">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onPick(id)}
            className={`tap border px-2 py-1 font-mono text-[length:var(--t-2xs)] transition-colors
              tv:px-3 tv:py-1.5 tv:text-[length:var(--t-sm)] ${
              value === id
                ? 'border-tally bg-tally/10 text-tally'
                : 'border-rule text-ink-2 hover:border-tally hover:text-tally'}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Minus / value / plus. Two stops, both of them buttons. See `PickRow`. */
function StepRow({
  label, text, onLess, onMore, lessLabel, moreLabel, atMin, atMax,
}: {
  label: string;
  text: string;
  onLess: () => void;
  onMore: () => void;
  lessLabel: string;
  moreLabel: string;
  atMin: boolean;
  atMax: boolean;
}) {
  const btn = `tap flex h-8 w-8 items-center justify-center border border-rule font-mono
    text-[length:var(--t-sm)] text-ink-2 transition-colors hover:border-tally hover:text-tally
    disabled:opacity-30 tv:h-10 tv:w-10 tv:text-[length:var(--t-md)]`;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[length:var(--t-2xs)] tracking-wider text-ink-3 tv:text-[length:var(--t-xs)]">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" aria-label={lessLabel} disabled={atMin} onClick={onLess} className={btn}>−</button>
        <span className="min-w-[3rem] text-center font-mono text-[length:var(--t-sm)] tabular-nums text-ink
                         tv:text-[length:var(--t-md)]">
          {text}
        </span>
        <button type="button" aria-label={moreLabel} disabled={atMax} onClick={onMore} className={btn}>+</button>
      </div>
    </div>
  );
}

/** Fixed sample lines for the settings preview. */
const SAMPLE = [
  'You know, because it is really going to be a success.',
  "So, I'm delighted to talk.",
] as const;

const SIZES = [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] as const;
const PLACES = [['low', 'Low'], ['mid', 'Middle'], ['high', 'High']] as const;
const PLATES = [['black', 'Black'], ['navy', 'Navy'], ['green', 'Green'], ['white', 'White']] as const;

/**
 * How the captions look — size, plate, place, and how many lines stay up.
 *
 * ── why it went, and why it is back ──
 *
 * Every one of these settings existed and was deleted on purpose. The owner asked
 * for "the CC that we have can you make it with least settings like small no
 * background and like really below area and two lines by default", and then "CC
 * will be a small like popover not a whole menu" — so the panel went and the
 * defaults it used to set became the only answer. That was the right call for the
 * common case and it is still the shape of this control: turning captions on or
 * off, and choosing what language to show them in, is the whole popover and it
 * is as short as it ever was.
 *
 * What it cost was everything else: "subtitles settings are gone i mean i awas
 * able to change size and bg and so on". A default is not a preference. So the
 * settings come back UNDER A PRESS — one row that says LOOK, and nothing below it
 * until somebody asks — which keeps the popover a popover and still gives a
 * viewer with a hard-of-hearing parent, or a bright window, or a white-on-snow
 * football match, a way to change it.
 *
 * Writes land straight on `CaptionPrefs`, which is what the overlay renders from,
 * so the picture behind this panel changes on the press. The sample below is for
 * the other case — choosing the look with captions switched off, where there is
 * nothing on the picture to watch change.
 */
export function CaptionLook({
  label = 'Look', note, startOpen = false,
}: {
  /** What the opener row says. The subtitles tab names the thing it styles. */
  label?: string;
  /** One line, shown once opened, where the host needs to say what this covers. */
  note?: string;
  startOpen?: boolean;
}) {
  const [prefs] = usePrefs();
  const { ff } = useShape();
  const [open, setOpen] = useState(startOpen);
  const style = prefs.captions;

  function patch(p: Partial<CaptionPrefs>): void {
    setPrefs({ captions: { ...style, ...p } });
  }

  const sample = SAMPLE.slice(-Math.min(style.lines, SAMPLE.length));

  return (
    <div className="border-t border-rule/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="menu-row"
      >
        <span className="dot" />
        <span>{label}</span>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          {note !== undefined && (
            <p className="font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3 tv:text-[length:var(--t-xs)]">
              {note}
            </p>
          )}

          {/* The look, on a strip of picture. Kept small on purpose — it is a
              reminder of what was chosen, not a second television. */}
          <div className="flex min-h-[4.5rem] items-end justify-center bg-ground/80 px-2 py-2" aria-hidden>
            <div className="w-full space-y-1 px-2.5 py-1.5 text-center" style={captionBoxStyle(style)}>
              {sample.map((text, i) => (
                <p
                  key={text}
                  className="break-words leading-snug"
                  style={{
                    fontSize: captionFontRem(style.size, i === sample.length - 1, ff),
                    opacity: i === sample.length - 1 ? 1 : 0.82,
                  }}
                >
                  {text}
                </p>
              ))}
            </div>
          </div>

          <PickRow label="SIZE" value={style.size} options={SIZES} onPick={(v) => patch({ size: v })} />
          <PickRow label="POSITION" value={style.position} options={PLACES} onPick={(v) => patch({ position: v })} />

          <StepRow
            label="LINES ON SCREEN"
            text={String(style.lines)}
            lessLabel="Fewer caption lines"
            moreLabel="More caption lines"
            atMin={style.lines <= 1}
            atMax={style.lines >= 5}
            onLess={() => patch({ lines: Math.max(1, style.lines - 1) })}
            onMore={() => patch({ lines: Math.min(5, style.lines + 1) })}
          />

          <button
            type="button"
            aria-pressed={style.bg}
            onClick={() => patch({ bg: !style.bg })}
            className={`menu-row -mx-3 ${style.bg ? 'is-on' : ''}`}
          >
            <span className="dot" />
            <span>Background plate</span>
            <span className="ml-auto font-mono text-[length:var(--t-2xs)] text-ink-3 tv:text-[length:var(--t-xs)]">
              {style.bg ? 'on' : 'off'}
            </span>
          </button>

          {/* Only when there is a plate to colour: four dead controls under an
              "off" switch is how a menu teaches people not to read it. */}
          {style.bg && (
            <>
              <PickRow
                label="PLATE COLOUR"
                value={style.bgColor}
                options={PLATES}
                onPick={(v) => patch({ bgColor: v })}
              />
              <StepRow
                label="PLATE OPACITY"
                text={`${style.bgOpacity}%`}
                lessLabel="More transparent"
                moreLabel="More opaque"
                atMin={style.bgOpacity <= 10}
                atMax={style.bgOpacity >= 100}
                onLess={() => patch({ bgOpacity: Math.max(10, style.bgOpacity - 5) })}
                onMore={() => patch({ bgOpacity: Math.min(100, style.bgOpacity + 5) })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Start/stop and display language — compact popover over the picture. */
export function CaptionControls() {
  const [state, setState] = useState<CaptionState>(captions.snapshot);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [muted, setMuted] = useState(false);
  /* The first-time notice, shown instead of starting until it has been answered. */
  const [notice, setNotice] = useState(false);

  useEffect(() => captions.subscribe(setState), []);
  useEffect(() => player.subscribe((p) => setMuted(p.muted || p.volume === 0)), []);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl('/api/captions/health'))
      .then((r) => r.json())
      .then((j: { available?: boolean }) => alive && setAvailable(j.available === true))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, []);

  /* Spoken language is always auto-detect — the popover only picks what to show. */
  useEffect(() => {
    if (state.source !== 'auto') captions.configure({ source: 'auto' });
  }, [state.source]);

  const on = state.phase === 'live' || state.phase === 'starting';
  const showAs = CAPTION_LANGS.filter((l) => l.id !== 'off');

  async function toggle() {
    if (on) {
      await captions.stop();
      return;
    }
    if (!captionsNoticeAccepted()) { setNotice(true); return; }
    const el = player.element;
    if (!el) return;
    await captions.start(el, state.target === 'off' ? 'en' : state.target, 'auto');
  }

  function acceptNotice() {
    acceptCaptionsNotice();
    setNotice(false);
    void toggle();
  }

  function setLocale(target: string) {
    captions.configure({ target, source: 'auto' });
    if (on) {
      const el = player.element;
      if (el) void captions.start(el, target, 'auto');
    }
  }

  return (
    <div className="space-y-3 p-3" onClick={(e) => e.stopPropagation()}>
      {available === false && (
        <p className="font-mono text-[length:var(--t-2xs)] leading-snug text-ink-3">
          Caption service unavailable.
        </p>
      )}

      {notice && (
        <div role="dialog" aria-label="Live captions" className="space-y-2 border border-rule p-3">
          <p className="text-[length:var(--t-sm)] font-medium text-ink">Live captions</p>
          <p className="font-mono text-[length:var(--t-2xs)] leading-snug text-ink-2">
            Captions turn the sound of what is playing into subtitles. While they are
            on, the sound is sent to our speech-recognition provider. Nothing is stored
            by us. On Android you will be asked to allow audio capture; this captures
            only {BRAND.name}&rsquo;s own sound, not your microphone.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={acceptNotice}
              className="tap border border-tally bg-tally/15 px-2.5 py-1 font-mono text-[length:var(--t-2xs)] tracking-widest text-tally hover:bg-tally/25"
            >
              Turn on
            </button>
            <button
              type="button"
              onClick={() => setNotice(false)}
              className="tap border border-rule px-2.5 py-1 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-2 hover:text-ink"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-[length:var(--t-sm)] text-ink">Closed captions</span>
        <div className="flex shrink-0 border border-rule">
          <button
            type="button"
            aria-pressed={!on}
            disabled={available === false}
            onClick={() => { if (on) void toggle(); }}
            className={`px-2.5 py-1 font-mono text-[length:var(--t-2xs)] tracking-widest
                        disabled:opacity-40
                        ${!on ? 'bg-panel text-ink' : 'text-ink-3 hover:text-ink'}`}
          >
            Off
          </button>
          <button
            type="button"
            aria-pressed={on}
            disabled={available === false}
            onClick={() => { if (!on) void toggle(); }}
            className={`border-l border-rule px-2.5 py-1 font-mono text-[length:var(--t-2xs)] tracking-widest
                        disabled:opacity-40
                        ${on ? 'bg-tally/15 text-tally' : 'text-ink-3 hover:text-ink'}`}
          >
            On
          </button>
        </div>
      </div>

      {state.phase === 'error' && state.error !== '' && (
        <p className="font-mono text-[length:var(--t-2xs)] leading-snug text-alert">
          {state.error}
        </p>
      )}

      {/* The one thing that can move the picture to the other engine, and it is
          a press. Nothing in the caption engine reloads anything by itself:
          which engine plays a channel is the viewer's, not a side effect of
          switching subtitles on. */}
      {state.offer && (
        <button
          type="button"
          onClick={() => { captions.useBrowserEngine(); }}
          className="menu-row w-full border border-rule px-2.5 py-1.5 text-left font-mono
                     text-[length:var(--t-2xs)] tracking-wide text-tally hover:bg-tally/10"
        >
          Play this channel in the browser engine
        </button>
      )}

      {state.tap === 'native' && on && (
        <p className="font-mono text-[length:var(--t-2xs)] leading-snug text-ink-3">
          This channel is playing on the television&rsquo;s own engine, so the app is
          listening to its own sound to write the subtitles. Nothing from the
          microphone is used, and nothing leaves this device except the words.
        </p>
      )}

      {/* Meaningless while the app is recording its own output: that sound is
          taken before the speakers, so muting them changes nothing. */}
      {muted && on && state.tap !== 'native' && (
        <p className="font-mono text-[length:var(--t-2xs)] leading-snug text-tally">
          Unmute to transcribe.
        </p>
      )}

      {on && (
        <Select
          label="Show as"
          fullWidth
          value={state.target === 'off' ? 'en' : state.target}
          onChange={setLocale}
          options={showAs.map((l) => ({ value: l.id, label: l.label }))}
        />
      )}

      {/*
        The look, folded away.

        Last and closed, so the popover still reads as two decisions — on or off,
        and in what language — which is the whole reason it was cut down to that.
        One press opens the rest; nothing above it moved.
      */}
      <div className="-mx-3 -mb-3">
        <CaptionLook />
      </div>
    </div>
  );
}
