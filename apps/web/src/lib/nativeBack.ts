/**
 * The Android back button, and what it should mean here.
 *
 * Nothing handled it. On Android the hardware back is not a nicety — it is how
 * people leave things, and a WebView app that ignores it either does nothing at
 * all or exits the app from three screens deep. Both were happening: `MainActivity`
 * passed BACK straight to the system.
 *
 * The rule everywhere on Android: back closes the topmost thing that is open,
 * and if nothing is open it goes back a page, and if there is no page to go back
 * to it backgrounds the app rather than killing it. So this is a stack: whatever
 * opened last is asked first, and the native side backgrounds the app only when
 * every handler has declined.
 *
 * A stack rather than one global handler because the things that need to close are
 * independent and nest — a sheet over the player over a route — and each already
 * knows how to close itself. Ordering by registration is exactly the LIFO the
 * question needs.
 */

/**
 * Told whether the press is the remote auto-repeating a held BACK.
 *
 * Every handler that predates the exit dialog ignores it, and should: holding
 * BACK to close three layers at once is a reasonable thing to do. It exists for
 * the one control that must not be closed by the same hold that opened it — see
 * `ExitDialog`.
 */
type BackHandler = (repeat: boolean) => boolean;

const stack: BackHandler[] = [];

/**
 * How this module gets from one route to another.
 *
 * It used to write `location.hash = '#/home'`, which is a real navigation under
 * the hash router the APK is built with (`VITE_ROUTER=hash`) and NOTHING under
 * the path router the website runs — and worse than nothing: measured on
 * `/live`, one BACK left the address at `/live?markets=USF#/home` with the page
 * unmoved, and `currentPath()` then read that stray fragment as the route, so
 * every later BACK resolved to "at home, leave" and the app backgrounded itself
 * from a screen it had never left. One router-shaped assumption, two failures.
 *
 * So the shell lends its own navigator (`Chrome.tsx`), which is correct in both
 * builds and, unlike a hash write, actually re-renders the route.
 */
let navigate: ((to: string) => void) | null = null;

/*
 * Leaving takes three presses, and the app says so.
 *
 * BACK at Home used to decline on the first press, and the native side answers a
 * decline with `moveTaskToBack` — so one stray press from the top level put the
 * app on the launcher. On a remote that is a very easy press to make by
 * accident, usually while trying to get out of something else, and the app has
 * a catalogue in memory that it then has to rebuild.
 *
 * "On going back multiple times, ask them to press 3 times to exit." So the
 * first two presses at Home are consumed and announced. The count resets after
 * three seconds, which is what makes it read as a deliberate gesture rather than
 * a tally the app is keeping about you.
 *
 * Announced through a subscription rather than an alert: the shell owns what the
 * screen looks like, and this file must stay testable without a DOM.
 *
 * ── the third press asks, wherever something can ask ──
 *
 * The third press used to decline as well, and Android backgrounded the app —
 * which left all of it resident: the WebView, the catalogue in its heap, libVLC
 * paused but never released. Asked for as the most important thing: "when they
 * go back like three times it should show a dialog Are you sure you want to exit
 * and when they say yes you force to stop the whole app so it's out of the memory
 * and doesn't clog the memory".
 *
 * So the third press is consumed too, and whoever registered with `onExitAsk`
 * puts the question — `components/ExitDialog.tsx`, whose Exit ends the process
 * and whose Cancel leaves everything exactly as it was. That is a departure from
 * the Android rule at the top of this file, made on the owner's word, and it is
 * only ever reached through the gesture and a yes.
 *
 * Nobody registered means nobody can ask, and then the third press declines the
 * way it always did. Three cases, all deliberate: a browser, where there is no
 * process to end and the dialog is never mounted (see `main.tsx`); the first-run
 * door, which cannot be dismissed and must not have a second sheet put over it;
 * and a moment with no shell at all, such as the retired-build screen. A question
 * nobody can put must not turn BACK into a button that never leaves.
 *
 * ── and a held BACK is one press ──
 *
 * Android auto-repeats a held key: one event on the press, then after half a
 * second one every 50ms (`ViewConfiguration`'s repeat timeout and delay), and
 * `MainActivity` hands every one of them to this file. Counted, a single hold
 * would finish the gesture a little over half a second in — and with a question
 * at the end of it the next repeat would close the dialog, the three after that
 * would open it again, and the viewer would let go of a screen strobing between
 * the two. That is derived from the mechanism, not watched on a set, and it is
 * cheap to rule out: only a fresh press counts. It is also what makes a hold that
 * walks back out of a deep screen stop at Home instead of running on into the
 * exit.
 */
const EXIT_PRESSES = 3;
/** The gesture's window. Exported so the hint lives exactly as long as the count. */
export const EXIT_WINDOW_MS = 3_000;
let exitAt = 0;
let exitPresses = 0;
const exitWatchers = new Set<(pressesLeft: number) => void>();
const askWatchers = new Set<() => void>();

/**
 * What one press did to the gesture.
 *
 *   counted  the first or second press: consumed, and the prompt told what is left
 *   ask      the third, with something to ask: consumed, and the question is up
 *   leave    the third, with nothing to ask: declined, so the host's own BACK has it
 */
export type ExitStep = 'counted' | 'ask' | 'leave';

/** Told how many more presses are needed; 0 means the gesture is complete. */
export function onExitPrompt(fn: (pressesLeft: number) => void): () => void {
  exitWatchers.add(fn);
  return () => { exitWatchers.delete(fn); };
}

/**
 * Told when the third press wants the exit question put. Returns the unregister.
 *
 * Registering is a claim that the question CAN be put here — that there is a
 * dialog to show and a way to carry out its answer — which is why the shell makes
 * it only under the Android wrapper.
 */
export function onExitAsk(fn: () => void): () => void {
  askWatchers.add(fn);
  return () => { askWatchers.delete(fn); };
}

/** For tests, and for a screen that wants the count to start again. */
export function forgetExitPresses(): void {
  exitPresses = 0;
  exitAt = 0;
}

/**
 * Count a press against the exit gesture.
 *
 * Pure apart from the clock and the watchers, so `nativeBack.test.ts` can drive
 * it with an injected `now`.
 */
export function countExitPress(now = Date.now()): ExitStep {
  if (now - exitAt > EXIT_WINDOW_MS) exitPresses = 0;
  exitAt = now;
  exitPresses += 1;
  const left = EXIT_PRESSES - exitPresses;
  for (const fn of exitWatchers) fn(Math.max(0, left));
  if (left > 0) return 'counted';
  /* Complete, whatever happens next — so a Cancel comes back to a fresh gesture
     of three presses, not to a single press away from the same question. */
  exitPresses = 0;
  let asked = false;
  for (const fn of askWatchers) {
    try {
      fn();
      asked = true;
    } catch {
      // The stack's rule, for the same reason: a watcher that throws must not
      // trap the user on the screen.
    }
  }
  return asked ? 'ask' : 'leave';
}

/** Register the shell's router. Returns the function that unregisters it. */
export function setBackNavigator(fn: (to: string) => void): () => void {
  navigate = fn;
  return () => { if (navigate === fn) navigate = null; };
}

/**
 * Register a handler. Returns the unregister function.
 *
 * Return `true` from the handler if it consumed the press. Returning `false` (or
 * throwing) passes the press on to whatever registered before it.
 */
export function pushBackHandler(fn: BackHandler): () => void {
  stack.push(fn);
  return () => {
    const at = stack.lastIndexOf(fn);
    if (at >= 0) stack.splice(at, 1);
  };
}

/**
 * Run the stack, most recent first.
 *
 * Exposed on `window` because the native side calls it through
 * `evaluateJavascript`, which can only reach globals. Returns a boolean the Java
 * side reads as a string. `repeat` comes from `KeyEvent.getRepeatCount()`; the
 * DOM path in `keys.ts` does not pass it, and an older APK does not either, so
 * absent means a fresh press — which is exactly what BACK meant before it existed.
 */
export function handleBack(repeat = false): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i]?.(repeat) === true) return true;
    } catch {
      // A handler that throws must not trap the user on the screen.
    }
  }
  /*
   * Nothing claimed it, so this is navigation. The rule people expect on a TV:
   *
   *   at a deep screen  → go back a page
   *   at a top-level tab → go to Home first (Live/Movies/Series/Guide all lead
   *                        back to Home, the way every set-top app works)
   *   at Home            → leave, and only on purpose: three presses, then the
   *                        exit question (see `countExitPress`). Declining is
   *                        now the fallback for when nothing can ask, and the
   *                        native side answers it with `moveTaskToBack`.
   *
   * This replaces "history.length > 1 → history.back()", which never ended: a
   * hash-router session's history only grows, so back walked backwards for ever
   * and the app could not be left at all ("how do I exit? LOL").
   */
  switch (resolveBack(currentPath())) {
    case 'exit':
      /* A repeat is consumed without counting — see "a held BACK is one press".
         Consumed rather than declined: declining is the thing that leaves. */
      if (repeat) return true;
      return countExitPress() !== 'leave';
    case 'home':
      if (navigate !== null) { navigate('/home'); return true; }
      /* No shell mounted — the splash, or a page that failed to render. The
         fragment is the only navigation available without a router, and it is
         the right one in the build that has no router to lend: `file://` and the
         wrapper both run the hash router. */
      location.hash = '#/home';
      return true;
    case 'back': {
      /* Walk back only when this app put an earlier page behind us. A screen
         that was the FIRST one (a link from the first-run door, a deep link, a
         reload) has nothing to go back to: declining there made the native side
         background the whole app from a legal page. Go to its parent instead. */
      if (hasPageBehind()) {
        history.back();
        return true;
      }
      const to = parentOf(currentPath());
      if (navigate !== null) { navigate(to); return true; }
      if (typeof location !== 'undefined') { location.hash = `#${to}`; return true; }
      return false;
    }
  }
}

/** Whether the router has an earlier entry of its own (`state.idx` counts them). */
function hasPageBehind(): boolean {
  if (typeof history === 'undefined') return false;
  const idx = (history.state as { idx?: number } | null)?.idx;
  return typeof idx === 'number' ? idx > 0 : history.length > 1;
}

/**
 * Where a deep screen belongs when there is no page behind it: the list it
 * opens from, or Home.
 */
export function parentOf(path: string): string {
  if (path.startsWith('/legal/')) return '/more?s=legal';
  if (path.startsWith('/movie/')) return '/movies';
  if (path.startsWith('/series/')) return '/series';
  return '/home';
}

/** The top-level tabs — the destinations the shell's nav offers. */
const TAB_ROOTS = new Set(['/movies', '/series', '/guide', '/catchup']);

/**
 * What back means at a given route, as a pure decision so it can be tested.
 *
 *   home / live → 'exit'  (three presses, then "are you sure you want to exit")
 *   other top-level tabs → 'home'
 *   anything deeper → 'back' (walk one page back)
 *
 * Live is exit, not home: leaving for Home unmounts the player and stops the
 * picture. BACK on Live keeps the channel on; only the three-press gesture, and a
 * yes to the question it ends in, takes the picture away.
 */
export function resolveBack(path: string): 'exit' | 'home' | 'back' {
  if (path === '/' || path === '/home' || path === '/live') return 'exit';
  if (TAB_ROOTS.has(path)) return 'home';
  return 'back';
}

/** The current route, from the hash router in the app and the path on the web. */
function currentPath(): string {
  if (typeof location === 'undefined') return '/';
  const h = location.hash || '';
  if (h.startsWith('#')) {
    const p = (h.slice(1).split('?')[0] || '/');
    return p === '' ? '/' : p;
  }
  return location.pathname || '/';
}

declare global {
  interface Window {
    __streamixBack?: (repeat?: boolean) => boolean;
  }
}

if (typeof window !== 'undefined') {
  window.__streamixBack = handleBack;
}
