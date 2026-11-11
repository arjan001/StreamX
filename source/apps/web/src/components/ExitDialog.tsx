import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Power, X } from 'lucide-react';
import { BRAND } from '../brand';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import { pushBackHandler } from '../lib/nativeBack';
import { deviceInfo } from '../lib/deviceInfo';
import { exitTizenApp } from '../lib/tizenKeys';
import { persistPrefs } from '../lib/prefs';
import { dlog } from '../lib/debugLog';

/**
 * "Are you sure you want to exit?" — where the three-press BACK gesture ends.
 *
 * Asked for as the most important thing: "when they go back like three times it
 * should show a dialog Are you sure you want to exit and when they say yes you
 * force to stop the whole app so it's out of the memory and doesn't clog the
 * memory". `lib/nativeBack.ts` counts the presses and consumes the third instead
 * of letting Android background the app, `main.tsx` mounts this when told, and
 * the "press BACK N more times" hint in `Chrome.tsx` is already gone by then,
 * because the same count told it the gesture was complete. One count, and both
 * things on screen take their cue from it.
 *
 * Only under the Android wrapper. A browser tab is not the page's to close, so
 * there is no Exit a browser could honestly offer — see the mount in `main.tsx`.
 *
 * ── the television rules, which are AddAccountDialog's ──
 *
 * The same scrim, card and z-[70], `data-nav-contain` so the arrows cannot walk
 * out onto the shell, `focusFirst` on open so the first OK cannot land on
 * whatever the scrim is covering, and BACK and Escape both close it — BACK through
 * `pushBackHandler`, where it sits above everything else while it is open. The
 * same layer is enough because nothing else on it can be open at the same time:
 * every sheet and dialog there closes on BACK before a press can count towards
 * this, and the welcome door is never asked over (see `main.tsx`). What ignores
 * the stack sits lower — the PIN prompt is z-[60] — and `main.tsx` renders this
 * after the shell, so a tie would go to the question anyway.
 *
 * ── where focus lands, and why it is Cancel ──
 *
 * Getting here took three presses of BACK inside three seconds, which sounds like
 * somebody who has made up their mind. It is weaker evidence than it looks. BACK
 * is the key people press over and over when they want out of SOMETHING — a menu,
 * the player, a screen — and every press that found nothing left to close was
 * counted towards this. And the two mistakes do not cost the same: Cancel by
 * accident costs one more press; Exit by accident costs the channel that was on,
 * and a cold start on a set-top box to get back to it.
 *
 * So OK, the press most likely to follow by reflex, lands on the harmless answer,
 * and Exit is one deliberate press of DOWN away — a move nobody makes on the way
 * to something else, which is the whole of what a confirmation is for.
 */
export function ExitDialog({ onCancel }: { onCancel: () => void }) {
  const modern = useSkin().shell === 'modern';
  const panel = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: 'asking' });
  const alive = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /* On every phase, because each one replaces the controls: the entry point while
     asking, the one button when stuck, and the panel itself while closing, when
     there is nothing to press and a highlight left on a vanished button is a ring
     on nothing. */
  useEffect(() => {
    const el = panel.current;
    if (el !== null && !focusFirst(el)) el.focus();
  }, [phase.at]);

  /*
   * Nothing dismisses it once it is closing.
   *
   * By then the picture is torn down and the store written out; a Cancel in that
   * moment would hand back an app with its channel taken away and nothing to say
   * why. If the exit then fails, `stuck` says so and BACK works again.
   */
  const closing = phase.at === 'leaving';
  const dismiss = useCallback(() => { if (!closing) onCancel(); }, [closing, onCancel]);

  /* A repeat is the hold that opened this, still going: Android sends one every
     50ms, and closing on it would snap the question shut under the viewer's thumb.
     Only a fresh press answers it. */
  useEffect(() => pushBackHandler((repeat) => {
    if (!repeat) dismiss();
    return true;
  }), [dismiss]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.repeat) { e.stopPropagation(); dismiss(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const exit = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setPhase({ at: 'leaving' });
    void leave().then((why) => {
      if (!alive.current) return;
      started.current = false;
      setPhase({ at: 'stuck', why });
    });
  }, []);

  /* AddAccountDialog's card, for the same reason it is Welcome's: one shape of
     question over the launcher, measured once — including the near-solid fill the
     modern shell gives `.welcome-card`, so no tile shows through the words. */
  const panelClass = modern
    ? 'welcome-card glass-float tally-glow is-on w-full max-w-[25rem] p-5 tv:max-w-[26rem] tv:p-6'
    : 'card w-full max-w-[25rem] border border-rule bg-panel p-5 shadow-lg tv:max-w-[26rem] tv:p-6';
  const choice = 'card card-hover tap mt-3 flex w-full items-center justify-center gap-3'
    + ' border border-rule px-4 py-3 text-center tv:py-3.5';
  const label = 'text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]';

  return (
    <div
      data-nav-contain
      role="dialog"
      aria-modal="true"
      aria-labelledby="exit-title"
      aria-describedby="exit-detail"
      className="anim-fade fixed inset-0 z-[70] flex items-center justify-center
                 bg-black/35 px-4 py-6 tv:px-8"
    >
      {/* Full-screen catcher, and deliberately not a dismiss button — the shell
          underneath stays visible, never interactive. */}
      <div className="absolute inset-0" aria-hidden />

      <div
        ref={panel}
        tabIndex={-1}
        /* Holds focus only while closing, and is not a control: a ring round the
           whole card would read as something to press. Inline because the TV ring
           is an attribute-scoped rule no utility class outranks. */
        style={{ outline: 'none' }}
        className={`relative z-10 ${panelClass}`}
      >
        <h1
          id="exit-title"
          className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]"
        >
          {phase.at === 'stuck' ? `${BRAND.name} could not close` : 'Are you sure you want to exit?'}
        </h1>
        <p id="exit-detail" className="mt-1.5 text-[length:var(--t-sm)] leading-relaxed text-ink-2">
          {phase.at === 'stuck'
            ? phase.why
            : `${BRAND.name} will close completely, rather than keep running in the background.`}
        </p>

        {phase.at === 'asking' && (
          <div className="mt-5">
            <button data-nav-first type="button" onClick={onCancel} className={choice}>
              <X className="h-5 w-5 shrink-0 text-ink-3" aria-hidden />
              <span className={label}>Cancel</span>
            </button>
            <button type="button" onClick={exit} className={choice}>
              <Power className="h-5 w-5 shrink-0 text-alert" aria-hidden />
              <span className={label}>Exit {BRAND.name}</span>
            </button>
          </div>
        )}

        {phase.at === 'leaving' && (
          <p aria-live="polite" className="mt-5 flex items-center justify-center gap-3 py-3 tv:py-3.5">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-ink-3" aria-hidden />
            <span className={label}>Closing…</span>
          </p>
        )}

        {phase.at === 'stuck' && (
          <button data-nav-first type="button" onClick={onCancel} className={`${choice} mt-5`}>
            <span className={label}>OK</span>
          </button>
        )}
      </div>
    </div>
  );
}

type Phase =
  | { at: 'asking' }
  | { at: 'leaving' }
  | { at: 'stuck'; why: string };

/**
 * What the viewer is told when the app is still here. One sentence for every
 * branch, because none of them is theirs to fix; which branch it was goes to the
 * debug log, where a report can say.
 */
const STILL_OPEN = 'Press HOME to leave it running in the background instead.';

/**
 * How long a pause gets to be reported before the shutdown carries on without it.
 *
 * A bound, not a measurement: the native engine reports a pause inside
 * `togglePlay` and the WebView's `<video>` on its next task. This only stops a
 * wedged player from holding the exit hostage.
 */
const PAUSE_WAIT_MS = 600;

/** How long the native side gets to accept, before the page says it did not. */
const ANSWER_MS = 3_000;

/**
 * How long a page that was told "yes, leaving" keeps waiting to be ended.
 *
 * The plugin answers and then kills the process within the same trip through the
 * UI thread, so on a working build this page never reaches the end of the wait.
 * Reaching it is the only evidence the page can have that the kill did not happen.
 */
const STILL_HERE_MS = 4_000;

/**
 * Shut the page down, then ask Android to end it. Resolves only if it is still
 * alive afterwards, with what to tell the viewer.
 *
 * ── leaving cleanly, then leaving ──
 *
 * The native side kills the process, and nothing written after that exists. So
 * the page shuts itself down first, in the order the app's own writers need.
 *
 *   1. Pause, and wait to be told. Both playhead writers — continue-watching in
 *      `watch.ts` and the resume mark in `resume.ts` — throttle themselves while a
 *      film or an episode plays (four and five seconds) and write at once on a
 *      pause. Without it the resume mark can be five seconds behind the picture.
 *      A channel has no playhead to keep; pausing it first costs nothing.
 *   2. `pagehide`, the event the app already closes on. `watch.ts` flushes on it
 *      in the capture phase and `playerCore` tears the engine down on it in the
 *      bubble phase, in that order because a teardown zeroes the playhead — see
 *      the header of `watch.ts`. Sent, rather than calling `teardown()` here, for
 *      that reason: the flush is private to the hook and this is the door it
 *      listens at.
 *   3. `persistPrefs()`: the whole store — profiles, favourites, history, the
 *      resume mark — through `kv` once more, so the durable copy is the one in
 *      memory.
 *   4. One task's pause. Capacitor posts a plugin call to Android a microtask or
 *      two after it is made (`registerPlugin` goes through a `.then`), and every
 *      write above has to be on its way before the exit is.
 *
 * Then `StreamixDevice.exitApp`, which waits for those writes to reach the disk
 * before it ends anything — see the plugin for why that wait is certain.
 */
async function leave(): Promise<string> {
  try {
    await shutDown();
  } catch (err) {
    /* Nothing here may keep the app from leaving; a writer that throws has
       already done whatever it was going to manage. */
    dlog.warn('exit', `shutdown threw, leaving anyway: ${String(err)}`);
  }

  /*
    Tizen first, because on a Samsung there is no plugin to ask.
    
    `deviceInfo()` resolves the Capacitor plugin, which a .wgt build does not
    have, so without this the Tizen path falls straight through to "this build
    cannot end itself" and the viewer is left on a dialog that did nothing.
    `exitTizenApp` reports whether it really exited, and answers false
    everywhere else, so the Android path below is untouched.
  */
  if (exitTizenApp()) {
    await sleep(STILL_HERE_MS);
    dlog.warn('exit', `tizen exit accepted, and the page was still running ${STILL_HERE_MS}ms later`);
    return STILL_OPEN;
  }

  const device = await within(deviceInfo(), ANSWER_MS);
  if (device === TIMED_OUT || device === null) {
    dlog.warn('exit', device === null
      ? 'no StreamixDevice plugin answered — this build cannot end itself'
      : `StreamixDevice did not answer within ${ANSWER_MS}ms`);
    return STILL_OPEN;
  }

  const accepted = await within(
    device.exitApp().then(() => true, (err: unknown) => {
      dlog.warn('exit', `exitApp refused: ${String(err)}`);
      return false;
    }),
    ANSWER_MS,
  );
  if (accepted !== true) {
    if (accepted === TIMED_OUT) dlog.warn('exit', `exitApp did not answer within ${ANSWER_MS}ms`);
    return STILL_OPEN;
  }

  await sleep(STILL_HERE_MS);
  dlog.warn('exit', `exitApp accepted, and the page was still running ${STILL_HERE_MS}ms later`);
  return STILL_OPEN;
}

async function shutDown(): Promise<void> {
  /* Dynamic, the way `resume.ts` and `watch.ts` reach it: the engine stays out of
     the import graph of anything that does not play. */
  const { player } = await import('../lib/playerCore');

  if (player.state.phase === 'playing') {
    await new Promise<void>((done) => {
      let finish = (): void => {};
      const off = player.subscribe((s) => { if (s.phase !== 'playing') finish(); });
      const timer = window.setTimeout(() => finish(), PAUSE_WAIT_MS);
      finish = () => { window.clearTimeout(timer); off(); done(); };
      if (player.state.phase === 'playing') player.togglePlay();
      else finish();
    });
  }

  window.dispatchEvent(
    typeof PageTransitionEvent === 'function'
      ? new PageTransitionEvent('pagehide', { persisted: false })
      : new Event('pagehide'),
  );

  persistPrefs();

  await sleep(0);
}

const TIMED_OUT = Symbol('timed out');

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([p, sleep(ms).then((): typeof TIMED_OUT => TIMED_OUT)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => { window.setTimeout(done, ms); });
}
