/**
 * One resolved answer to "what kind of screen is this?", for the whole app.
 *
 * The four targets are not four widths. A 1280px window on a laptop and a 1280px
 * Android TV browser are the same number and want opposite layouts: one has a
 * cursor and can hover, the other has a D-pad, sits three metres away, and loses
 * its outer 2.5% to overscan. So the decision is made from THREE signals —
 * viewport size, input capability (`pointer` / `hover`), and a TV user-agent —
 * and published once, as data attributes on <html> plus a subscribable value.
 *
 * Why one module rather than Tailwind breakpoints everywhere:
 *
 *   1. Two of the four targets are not width-detectable at all (TV, touch-laptop).
 *   2. Layout swaps here are structural — three resizable panes become one stacked
 *      column — and that is a component-tree decision, not a class-list decision.
 *   3. Electron and Capacitor need the same answer in JS (window sizing, back
 *      button, orientation) as CSS gets. One source, no drift.
 *
 * CSS still does the fine work: `data-ff` / `data-pointer` / `data-orient` on the
 * root element back the `phone:` `tablet:` `tv:` `touch:` variants in index.css,
 * so a component can adjust padding without importing anything.
 */
import { useEffect, useState } from 'react';
import { kv } from './kv.ts';

export type FormFactor = 'phone' | 'tablet' | 'desktop' | 'tv';
/** What the user picked in display settings. `auto` means trust detection. */
export type LayoutPref = 'auto' | FormFactor;

export interface Shape {
  /** The form factor in force — the override if there is one, else `detected`. */
  ff: FormFactor;
  /** What the environment looks like, ignoring any override. */
  detected: FormFactor;
  pref: LayoutPref;
  orientation: 'portrait' | 'landscape';
  /** `none` is the D-pad case: TVs and set-top boxes report it. */
  pointer: 'fine' | 'coarse' | 'none';
  hover: boolean;
  width: number;
  height: number;
  /**
   * Side-by-side resizable panes, or one column at a time?
   *
   * The gate is real estate, not form factor: a phone never has it, a TV always
   * does, and a tablet has it only in landscape. Every multi-pane route branches
   * on this one boolean so they cannot disagree with each other.
   */
  panes: boolean;
  /** Touch or D-pad: hover-only affordances must not be the only way to do a thing. */
  touch: boolean;
  /**
   * A phone or a tablet in the hand, or null — and null is every television and
   * every desktop browser, which keep the television layout exactly as it is.
   *
   * The app is built for a television and stays that way; this is the add-on
   * that lets the same app be used on glass. It never replaces `ff` (which stays
   * 'tv' everywhere, so every television rule still applies): it publishes
   * `data-touch-screen` on <html>, and the phone/tablet adjustments in
   * index.css and the few components that need one are keyed on that alone.
   * See `touchScreenOf` for how a device earns it.
   */
  touchScreen: TouchScreen | null;
  /**
   * Driven by a remote control rather than a cursor or a fingertip.
   *
   * The question a dozen components need to ask, and asking it in a dozen places
   * is how they end up disagreeing: a screen where search is a button but the
   * filter bar still has a text field is worse than either choice made
   * consistently. It decides whether text is typed on the app's own keyboard,
   * whether a tooltip shows a remote button or a key cap, whether the legend
   * along the bottom is drawn, and where focus goes when a page opens.
   *
   * A TV user agent counts even when the browser claims a fine pointer, which
   * several TV Chromium builds do — the user agent is the stronger signal, and
   * the cost of being wrong is asymmetric: an on-screen keyboard on a device that
   * has a real one is an inconvenience, while a text field on a device that does
   * not is a dead end.
   */
  remote: boolean;
}

/**
 * Breakpoints, in px, and why these numbers.
 *
 * `PHONE` is 640 to match Tailwind's `sm` — one number, so a `phone:` variant and
 * a `max-sm:` variant can never disagree. `TABLET` is 1024 because that is where
 * the three-pane layout (232px rail + list + 520px player) stops being a lie:
 * below it the list pane gets under 300px and truncates every channel name.
 */
const PHONE = 640;
const TABLET = 1024;
/** A TV-sized window that also has a cursor is still a desktop. */
const TEN_FOOT = 1280;

/**
 * TV browsers, by user agent.
 *
 * `AFT*` is Fire TV's device-code family (AFTB, AFTS, AFTMM…), `VIDAA` is
 * Hisense, `NetCast` is pre-webOS LG. This is a positive-identification list on
 * purpose: guessing "TV" from size alone would put every desktop at 1920 into a
 * 10-foot layout.
 */
const TV_UA =
  /\b(?:tizen|web0s|webos|smart-?tv|smarttv|hbbtv|netcast|vidaa|bravia|aquos|philips[^;]*tv|googletv|android\s?tv|crkey|roku|aft[a-z]{1,3})\b/i;

/**
 * Televisions that run something other than Android, and so can never install
 * the APK — no matter which file, how it was downloaded, or how much room is
 * free on it.
 *
 * Tizen is Samsung, webOS and NetCast are LG, VIDAA is Hisense's own OS, and
 * Roku is Roku. None of them has an Android package installer, so an `.apk`
 * handed to one is not a bad download, it is a file the system has no idea what
 * to do with. That matters because of what it SAYS when it fails: the message
 * is Android's own "there was a problem parsing the package" — in Spanish, "no
 * se ha podido analizar el paquete" — which reads exactly like a corrupt or
 * truncated download and sends everyone off to re-download the file, again, on
 * a set that will never take it.
 *
 * Two of those conversations reached us before this existed. The second came
 * with the model number, and the model number was the whole answer: a Samsung
 * TU8075. The download page can tell on its own, so it should.
 *
 * Deliberately NOT `TV_UA`: Fire TV, Google TV, Bravia and the Android boxes
 * are televisions too and install the APK perfectly well. This is a positive
 * list of the ones that cannot.
 */
/* No trailing word boundary: Roku puts its model straight after the name
   (`Roku4640X/DVP-7.70`), so `\broku\b` misses every actual Roku. */
const NO_APK_UA = /\b(?:tizen|web0s|webos|netcast|vidaa|roku)/i;

/**
 * Can this browser's device install an Android app at all?
 *
 * Answered from the user agent because it is asked on the download page, where
 * the whole question is what to offer somebody before they try.
 */
export function cannotInstallApk(userAgent: string): boolean {
  return NO_APK_UA.test(userAgent);
}

export type TouchScreen = 'phone' | 'tablet';
/** The viewer's own answer, kept on this device only. */
export type ScreenPref = 'auto' | 'tv' | 'touch';

/**
 * Is this a phone or a tablet? Positive identification only.
 *
 * "make sure it doesn't affect the layout for the televisions, that will be a big
 * mess". So the default is the television layout, and a device leaves it only on
 * evidence that it is held in a hand:
 *
 *   - the APK asked Android and Android said LEANBACK (a television) → never;
 *   - a television browser by user agent → never;
 *   - the primary pointer is COARSE and the screen reports touch points →
 *     a finger on glass. Set-top boxes report `none` (a D-pad) or `fine` (an
 *     air-mouse remote) and no touch points; desktop browsers report `fine`.
 *
 * Phone or tablet by the SHORT side, because the app always runs sideways: under
 * 600 CSS px it is a phone (a landscape phone is 360–430 tall), otherwise a
 * tablet. A viewer can overrule it either way in Settings → Appearance, on this
 * device only — the profile's own old `layout` field is synced between devices
 * and must not carry a television's answer onto a phone.
 */
export function touchScreenOf(e: {
  width: number;
  height: number;
  pointer: Shape['pointer'];
  maxTouchPoints: number;
  userAgent: string;
  hostTv: boolean | null;
  pref: ScreenPref;
}): TouchScreen | null {
  const size = (): TouchScreen => (Math.min(e.width, e.height) < 600 ? 'phone' : 'tablet');
  if (e.pref === 'tv') return null;
  if (e.pref === 'touch') return size();
  if (e.hostTv === true) return null;
  if (TV_UA.test(e.userAgent)) return null;
  if (e.pointer !== 'coarse' || e.maxTouchPoints < 1) return null;
  return size();
}

const SCREEN_KEY = 'iptv.screen.v1';

function readScreenPref(): ScreenPref {
  try {
    const v = kv.get(SCREEN_KEY);
    return v === 'tv' || v === 'touch' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Everything the decision depends on, as plain data — see `classify`. */
export interface Env {
  width: number;
  height: number;
  pointer: Shape['pointer'];
  userAgent: string;
  pref: LayoutPref;
}

export interface Verdict {
  ff: FormFactor;
  detected: FormFactor;
  orientation: 'portrait' | 'landscape';
  panes: boolean;
}

function mq(q: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(q).matches
    : false;
}

function readPointer(): Shape['pointer'] {
  if (mq('(pointer: none)')) return 'none';
  if (mq('(pointer: coarse)')) return 'coarse';
  return 'fine';
}

/**
 * The detection ladder. Order matters — each rung assumes the ones above failed.
 *
 * 1. A TV user agent is a TV, whatever it reports for size.
 * 2. `pointer: none` on a big screen is a D-pad on a big screen, i.e. a TV or a
 *    set-top box whose UA we do not recognise.
 * 3. Below the phone breakpoint is a phone regardless of input — a 500px desktop
 *    window wants the phone layout too, which is exactly what makes this testable
 *    without a device.
 * 4. A coarse pointer under the tablet breakpoint is a tablet. Over it, with no
 *    cursor, it is a large tablet in landscape rather than a desktop.
 * 5. Everything else is a desktop.
 */
/**
 * Exported for its tests, not for callers.
 *
 * `classify` pins its answer to `tv`, so these rules are not what the app runs
 * under — they stay here so a future reopen is one line, and so the ladder cannot
 * silently rot. Tests cover `detect` for the rules and `classify` for the pin.
 */
export function detect(width: number, pointer: Shape['pointer'], userAgent: string): FormFactor {
  if (TV_UA.test(userAgent)) return 'tv';
  if (pointer === 'none' && width >= TEN_FOOT) return 'tv';
  if (width < PHONE) return 'phone';
  // A primary coarse pointer is a real touch device. Touch-screen laptops report
  // `pointer: fine` for the mouse and only `any-pointer: coarse` for the glass,
  // so they correctly fall through to desktop.
  if (pointer === 'coarse') return 'tablet';
  return 'desktop';
}

/**
 * The whole decision, as a pure function of plain data.
 *
 * Extracted so it can be tested without a browser: every interesting case here is
 * a device nobody has on their desk (a 1080p TV reporting `pointer: none`, a
 * foldable that changes width mid-session, an iPad that is 1024px wide in
 * landscape and 768px in portrait), and a rule you cannot exercise is a rule that
 * quietly rots. `measure()` below is the only impure part: it reads the window.
 */
export function classify(e: Env): Verdict {
  const detected = detect(e.width, e.pointer, e.userAgent);
  /*
    Television layout only.

    Other form factors were removed from the product: every screen is the ten-foot
    layout. `detect()` and the preference field stay so settings can still report
    what the device looks like, and so reopening a branch is one line.
  */
  const ff: FormFactor = 'tv';
  void detected;
  void e.pref;
  const orientation = e.height > e.width ? 'portrait' : 'landscape';
  /**
   * Three panes on the television layout.
   *
   * Width used to gate this, and sets that report ~960 CSS px fell into the
   * stacked phone layout — no country rail, no EPG under the picture. Overflow
   * is handled by the Live pane clamps (`live.rail3` / `live.player3`), not by
   * hiding the layout the product is built around.
   */
  const panes = true;
  return { ff, detected, orientation, panes };
}

/** What the APK's Android said about itself — null until asked, and on the web. */
let hostTv: boolean | null = null;
let screenPref: ScreenPref = readScreenPref();

function measure(pref: LayoutPref): Shape {
  const width = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const height = typeof window === 'undefined' ? 900 : window.innerHeight;
  const pointer = readPointer();
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const touchScreen = touchScreenOf({
    width, height, pointer, userAgent, hostTv, pref: screenPref,
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0,
  });
  const v = classify({
    width,
    height,
    pointer,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    pref,
  });

  return {
    ff: v.ff,
    detected: v.detected,
    pref,
    orientation: v.orientation,
    pointer,
    hover: mq('(hover: hover)'),
    width,
    height,
    panes: v.panes,
    touchScreen,
    touch: v.ff === 'tv' ? true : pointer !== 'fine',
    /* A finger types on its own keyboard and needs no remote legend. */
    remote: touchScreen === null && (v.ff === 'tv' || pointer === 'none'),
  };
}

/**
 * Density is a consequence of form factor, not a separate switch.
 *
 * Every size in this app is in rem, so the root font-size is the whole scale.
 * `data-density` stays the attribute index.css keys on — it predates this module
 * and the CSS reads better for it — but nothing else sets it any more.
 */
function densityFor(ff: FormFactor): 'desk' | 'tv' {
  // Only TV moves the root font size. Phones and tablets keep the type where it
  // is — a phone is held closer than a monitor, so the angular size is already
  // right — and grow their HIT TARGETS instead, which is what `data-pointer`
  // drives in index.css. Scaling type up on a 390px screen only costs rows.
  return ff === 'tv' ? 'tv' : 'desk';
}

let pref: LayoutPref = 'auto';
let shape: Shape = measure(pref);
const subs = new Set<(s: Shape) => void>();

function publish(): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset['ff'] = shape.ff;
    root.dataset['density'] = densityFor(shape.ff);
    root.dataset['pointer'] = shape.pointer;
    root.dataset['orient'] = shape.orientation;
    root.dataset['panes'] = String(shape.panes);
    /* Absent, not empty, on a television or a desktop: nothing keyed on it can
       match there, so the television layout is untouched by construction. */
    if (shape.touchScreen === null) delete root.dataset['touchScreen'];
    else root.dataset['touchScreen'] = shape.touchScreen;
  }
  for (const fn of subs) fn(shape);
}

function remeasure(): void {
  const next = measure(pref);
  // Object identity is the render trigger, so only replace it on a real change.
  const same =
    next.ff === shape.ff &&
    next.detected === shape.detected &&
    next.orientation === shape.orientation &&
    next.pointer === shape.pointer &&
    next.hover === shape.hover &&
    next.panes === shape.panes &&
    next.remote === shape.remote &&
    next.touchScreen === shape.touchScreen &&
    next.width === shape.width &&
    next.height === shape.height;
  if (same) return;
  shape = next;
  publish();
}

/** Called by prefs when the display-settings override changes. */
export function setLayoutPref(next: LayoutPref): void {
  pref = next;
  remeasure();
}

export function getShape(): Shape {
  return shape;
}

/**
 * The APK's answer to "is this a television?" (Android's LEANBACK feature),
 * asked once at boot before the first render. `true` pins the television layout
 * whatever the screen claims.
 */
export function setHostTv(tv: boolean | null): void {
  hostTv = tv;
  remeasure();
}

export function getScreenPref(): ScreenPref {
  return screenPref;
}

/** Settings → Appearance → Screen. This device only. */
export function setScreenPref(next: ScreenPref): void {
  screenPref = next;
  try {
    if (next === 'auto') kv.remove(SCREEN_KEY);
    else kv.set(SCREEN_KEY, next);
  } catch { /* private mode: holds for this session */ }
  remeasure();
}

/** Re-read after the durable store is installed — see `reloadPrefs`. */
export function reloadScreenPref(): void {
  screenPref = readScreenPref();
  remeasure();
}

if (typeof window !== 'undefined') {
  /**
   * Width comes from `resize`, capability from `matchMedia`.
   *
   * A plugged-in mouse or a fold flips `pointer`/`hover` without any resize, and
   * a soft keyboard fires resize without changing anything that matters here — so
   * both sources are needed and both go through the same equality gate.
   */
  window.addEventListener('resize', remeasure, { passive: true });
  window.addEventListener('orientationchange', remeasure);
  for (const q of ['(pointer: coarse)', '(pointer: none)', '(hover: hover)']) {
    const list = window.matchMedia(q);
    // Safari < 14 has no addEventListener on MediaQueryList.
    if (typeof list.addEventListener === 'function') list.addEventListener('change', remeasure);
    else list.addListener(remeasure);
  }
  publish();
}

/** Subscribe a component to the resolved shape. */
export function useShape(): Shape {
  const [s, setS] = useState(shape);
  useEffect(() => {
    subs.add(setS);
    setS(shape);
    return () => {
      subs.delete(setS);
    };
  }, []);
  return s;
}
