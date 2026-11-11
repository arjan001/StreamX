/**
 * One place where a key press becomes something happening.
 *
 * Before this there were nine `window.addEventListener('keydown')` calls in eight
 * files, and the consequences were exactly what you would predict:
 *
 *   * the player owned the whole keyboard whenever it was mounted, so the remote
 *     buttons `MainActivity` forwards did nothing at all on the guide, the
 *     channel list or the home page — the only listener for them was inside the
 *     player;
 *   * nothing owned the arrow keys, so a D-pad could not move focus anywhere;
 *   * and no screen could say what its buttons did, because there was nowhere to
 *     say it. The coloured buttons on a TV remote are useless without a legend,
 *     and a legend written separately from the handler is a legend that lies.
 *
 * So: screens register a LAYER while they are mounted. A layer is a list of
 * bindings — intent, label, what to do — and optionally a raw `handle` for the
 * cases where a screen needs the key before the table does (the player's arrows
 * are volume and seek, not focus movement). The topmost layer wins, which is the
 * same rule the back button already uses in `nativeBack.ts`.
 *
 * The bindings are also the legend. `HintBar` renders them, `Tooltip` shows them
 * on the control they belong to, and `Shortcuts` lists them — all from this
 * registry, so a button that does nothing cannot be advertised and a button that
 * does something cannot be a secret.
 */
import { useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import {
  digitOf, intentFor, intentForAndroidCode, keyIsTextInput, type RemoteIntent,
} from './remoteKeys.ts';
import {
  boundaryOpen, focusFirst, focusIsLoose, move, tabWithin, watchFocus, type Dir,
} from './spatialNav.ts';
import { getShape } from './formFactor.ts';
import { handleBack, pushBackHandler } from './nativeBack.ts';
import { logFieldKeydown } from './debugLog.ts';

export interface Binding {
  intent: RemoteIntent;
  /** What it does here, in two or three words. Shown on the button's chip. */
  label: string;
  act?: () => void;
  /**
   * Keep it out of the on-screen legend.
   *
   * For the ones everybody already knows — OK, Back, the arrows — which would
   * otherwise fill the bar and push the interesting buttons off the end.
   */
  quiet?: boolean;
}

/** A screen's claim on the keyboard, for as long as it is on screen. */
interface Layer {
  seq: number;
  bindings: Binding[];
  handle?: (intent: RemoteIntent, e: KeyboardEvent | null) => boolean;
}

let seq = 0;
const layers: Layer[] = [];
const subs = new Set<() => void>();
/** Bumped when the VISIBLE bindings change, so the bar re-renders and no more. */
let version = 0;

function notify(): void {
  version++;
  for (const fn of subs) fn();
}

/** Topmost first: the last layer to register is the one on top. */
function inOrder(): Layer[] {
  return layers.slice().sort((a, b) => b.seq - a.seq);
}

/**
 * Run an intent through the layers.
 *
 * `handle` before `act` within a layer: a raw handler exists precisely because it
 * needs to answer for keys the table would answer differently.
 */
/**
 * The four colours are per-screen, and an overlay covers the screen.
 *
 * With the display panel open, the legend still read "RED Favourite" and pressing
 * RED still favourited the channel behind the menu — an action nobody could see,
 * advertised by a bar that was describing a screen the viewer had left. Colours
 * are the only intents this applies to: they have no fixed meaning, so their
 * meaning belongs to whatever is in front. Transport, subtitles and the
 * destinations keep working, which is what every TV does with a menu open.
 */
const COLOURS = new Set<RemoteIntent>(['red', 'green', 'yellow', 'blue']);

function suppressed(intent: RemoteIntent): boolean {
  return COLOURS.has(intent) && boundaryOpen();
}

/**
 * The intents a HELD button should keep doing, and the rule for the rest.
 *
 * Android delivers a held key as auto-repeat every 30-50ms, and until now every
 * tick was a full dispatch: `act?: () => void` takes no arguments, so no binding
 * could tell a repeat from a press even though `dispatch` had the event in its
 * hand the whole time. Holding a destination button pushed one history entry
 * per tick — hundreds, so BACK could not get out of them; holding the favourite
 * button serialised the whole preferences store per tick and toggled the film on
 * and off; holding a dialog open re-opened it twenty-five times.
 *
 * The listed intents are the ones where repeating IS the behaviour a viewer
 * wants and expects from every television they have ever owned: the arrows,
 * volume, channel, seek and the digits. Everything else — a destination, a
 * dialog, a toggle, a track change — is a thing you meant once, however long
 * your thumb stayed down.
 *
 * `exit` is deliberately NOT decided here. It carries its repeat all the way to
 * `handleBack`, which needs it: holding BACK must not close the exit question
 * with the same press that opened it.
 */
const REPEATS = new Set<RemoteIntent>([
  'up', 'down', 'left', 'right',
  'volumeUp', 'volumeDown',
  'channelUp', 'channelDown',
  'forward', 'back', 'skipForward', 'skipBackward',
  'faster', 'slower',
]);

/** Auto-repeat on an intent that means one thing however long the key is held. */
function heldPastItsMeaning(intent: RemoteIntent, e: KeyboardEvent | null): boolean {
  if (e?.repeat !== true) return false;
  if (intent === 'exit') return false;
  if (REPEATS.has(intent)) return false;
  return /^digit[0-9]+$/.test(intent) === false;
}

export function dispatch(intent: RemoteIntent, e: KeyboardEvent | null = null): boolean {
  if (suppressed(intent)) return false;
  /*
    A repeat of a once-only intent is swallowed rather than ignored — but only
    where something is actually bound to it. Reporting it as handled when
    nothing is bound would take the press away from `fallback`, and that is
    where the arrows do their work.
  */
  if (heldPastItsMeaning(intent, e)) return isBound(intent);
  for (const layer of inOrder()) {
    if (layer.handle?.(intent, e) === true) return true;
    const hit = layer.bindings.find((b) => b.intent === intent && b.act !== undefined);
    if (hit) { hit.act?.(); return true; }
  }
  return false;
}

/** The legend: every intent bound right now, topmost label winning. */
export function activeBindings(): Binding[] {
  const seen = new Map<string, Binding>();
  for (const layer of inOrder()) {
    for (const b of layer.bindings) {
      if (seen.has(b.intent) || suppressed(b.intent)) continue;
      seen.set(b.intent, b);
    }
  }
  return Array.from(seen.values());
}

/** Is this intent bound to anything at all right now? */
export function isBound(intent: RemoteIntent): boolean {
  return layers.some((l) => l.bindings.some((b) => b.intent === intent));
}

/** The label this intent carries right now, for a tooltip on the control. */
export function labelOf(intent: RemoteIntent): string | null {
  for (const layer of inOrder()) {
    const hit = layer.bindings.find((b) => b.intent === intent);
    if (hit) return hit.label;
  }
  return null;
}

/**
 * Register a layer. Returns the function that removes it again.
 *
 * The non-React entry point, and the one the tests drive: the dispatch rules —
 * topmost first, `handle` before `act`, fall through when nothing binds — are the
 * part worth pinning, and they should not need a renderer to exercise.
 */
export function addLayer(
  bindings: Binding[],
  handle?: (intent: RemoteIntent, e: KeyboardEvent | null) => boolean,
): () => void {
  const layer: Layer = { seq: ++seq, bindings, handle };
  layers.push(layer);
  notify();
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    notify();
  };
}

/**
 * Register a layer for as long as the component is mounted.
 *
 * The bindings array is replaced on every render rather than being a dependency:
 * the acts are closures over fresh props and must not go stale, and re-subscribing
 * on every render would be both wasteful and a source of ordering churn. Only a
 * change to what is DISPLAYED notifies subscribers.
 */
export function useKeyLayer(
  bindings: Binding[],
  handle?: (intent: RemoteIntent, e: KeyboardEvent | null) => boolean,
): void {
  const layer = useRef<Layer | null>(null);
  if (layer.current === null) layer.current = { seq: ++seq, bindings };
  layer.current.bindings = bindings;
  layer.current.handle = handle;

  useEffect(() => {
    const mine = layer.current;
    if (mine === null) return;
    layers.push(mine);
    notify();
    return () => {
      const i = layers.indexOf(mine);
      if (i >= 0) layers.splice(i, 1);
      notify();
    };
  }, []);

  // The signature of what a legend would draw. Changing a label re-renders the
  // bar; changing a closure does not.
  const sig = bindings.map((b) => `${b.intent}:${b.label}:${b.quiet === true ? 'q' : ''}`).join('|');
  useEffect(notify, [sig]);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** The legend, as a subscribable value. */
export function useBindings(): Binding[] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return activeBindings();
}

/* ── keys in use ────────────────────────────────────────────────────────────
   Whether to show the legend at all is a question about the person, not the
   screen: a TV always needs it, a phone never does, and a desktop needs it from
   the moment someone reaches for a key. So the fact that a directional or
   media key has been pressed is itself a piece of state. */

let keysUsed = false;
const keySubs = new Set<() => void>();

function markKeysUsed(): void {
  if (keysUsed) return;
  keysUsed = true;
  for (const fn of keySubs) fn();
}

export function useKeysInUse(): boolean {
  return useSyncExternalStore(
    (fn) => { keySubs.add(fn); return () => { keySubs.delete(fn); }; },
    () => keysUsed,
    () => false,
  );
}

/* ── the one listener ───────────────────────────────────────────────────── */

/**
 * Text fields eat keys; range sliders must not, or seek and volume die after a
 * click — and a field somebody has merely LANDED on must not either.
 *
 * `data-ok-to-type="idle"` is a field parked under the rule in `lib/okToType.ts`:
 * focused, `readOnly`, keyboard not raised. Its arrows belong to the page, not
 * to a caret, or walking down a column would stop dead on every search box.
 */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset['okToType'] === 'idle') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
}

/**
 * Does this keydown mean "go" — a real Enter, or the IME's own action key —
 * rather than a character still being composed?
 *
 * Reported as "when the keyboard opens and you press OK... instead of
 * pressing enter it presses a number or a character": the platform's own
 * on-screen keyboard is a grid a D-pad drives, and OK activates whatever key
 * is highlighted. If that happens to be a letter or a digit, the page never
 * sees "Enter" at all — it sees an ordinary character, correctly, because
 * that IS what was pressed. There is nothing to fix in that case; the field's
 * own `onChange` already takes it. This function is only for the OTHER case,
 * where the highlighted key really was the action key and the field has to
 * decide what a genuine "go" does.
 *
 * `isComposing` is the modern signal that an IME is still mid-composition —
 * a CJK input's own Enter confirms a candidate and must reach the field, not
 * this. `keyCode 229` is what an older WebView (Chrome 83-90, the range this
 * app still supports on an actual Android TV box) reports for EVERY key while
 * composing, Enter included, so it is checked the same way.
 */
export function isFieldSubmit(key: string, isComposing: boolean, keyCode: number): boolean {
  return key === 'Enter' && !isComposing && keyCode !== 229;
}

const ARROWS: Record<string, Dir> = { up: 'up', down: 'down', left: 'left', right: 'right' };

/**
 * Triple-left gesture: press LEFT three times within 1 second to exit the app.
 *
 * On a TV with no home button or task switcher, the only way to close the APK
 * is this gesture. The timer resets on each press, so the three presses must
 * come within a 1-second window.
 */
let leftPressCount = 0;
let leftPressTimer: ReturnType<typeof setTimeout> | null = null;

function handleTripleLeft(): void {
  leftPressCount++;
  if (leftPressTimer !== null) clearTimeout(leftPressTimer);
  leftPressTimer = setTimeout(() => { leftPressCount = 0; leftPressTimer = null; }, 1000);
  if (leftPressCount >= 3) {
    leftPressCount = 0;
    if (leftPressTimer !== null) { clearTimeout(leftPressTimer); leftPressTimer = null; }
    /* Close the app — on Android TV this asks the system to finish. */
    if (typeof window !== 'undefined' && (window as any).__streamixExit) {
      (window as any).__streamixExit();
    } else {
      /* Fallback: navigate away or close the window. */
      window.close();
    }
  }
}

/**
 * What happens when nobody claims the key.
 *
 * The arrows move focus and OK activates it — the two halves of a D-pad. The
 * important part is the order: layers get the key FIRST, so the player can keep
 * Up for volume while it is the thing being used, and the moment it is not, the
 * same press moves focus through the channel list.
 *
 * Exported so `keys.test.ts` can pin the one thing this file cannot cover
 * without a DOM: that `repeat` survives the trip into `handleBack`.
 */
export function fallback(intent: RemoteIntent, repeat = false): boolean {
  const dir = ARROWS[intent];
  if (dir !== undefined) {
    /* On TV, track triple-left presses for app exit. */
    if (intent === 'left' && onTelevision()) handleTripleLeft();
    return move(dir);
  }
  /*
    Escape asks the same question BACK does, so it gets the same answer —
    including what a HELD one means.

    `nativeBack` already holds a stack of "what does leaving mean here" — the
    shell's sheets, the player's cascade, the on-screen keyboard — and Android's
    BACK button walks it. Escape did not, so on a desktop the display panel could
    only be closed by clicking, while on a TV the same panel closed with BACK.
    One stack, two keys, no drift.

    `repeat` rides along for the same reason: `nativeBack.ts` already has the
    rule for a held key — it does not count towards the three-press exit
    gesture, and it does not close `ExitDialog` under the hold that opened it —
    but only because `handleBack` is TOLD about the repeat. Calling it bare
    (`handleBack()`, always a fresh press) would race a held Escape through the
    gesture and dismiss the dialog under its own hold, exactly what a held
    remote BACK does not do. The keydown listener below reads
    `KeyboardEvent.repeat` off the real event and passes it on;
    `streamix:remotekey` carries no such field, so that path is left at the
    default — a fresh press, same as `handleBack` itself assumes when nothing
    says otherwise.
  */
  if (intent === 'exit') return handleBack(repeat);
  if (intent === 'select') {
    // OK with focus nowhere is the TCL "the centre button does not click" report:
    // there was nothing focused for it to activate. Give it something.
    return focusIsLoose() ? focusFirst() : false;
  }
  return false;
}

let installed = false;

/**
 * Install the listener. Called once, from `main.tsx`.
 *
 * Two sources, one path: DOM key events, and the raw Android keycodes
 * `MainActivity` forwards on `streamix:remotekey` for the buttons Chromium drops.
 * Those used to reach the player only — so the subtitle button on a set-top
 * handset did nothing anywhere else in the app.
 */
/**
 * Is this field still the one a BACK press should close the keyboard for?
 *
 * Split out of the handler in `installKeys` so the rule can be tested without a
 * document. Both halves matter: `isConnected` catches the field that was
 * removed from the page while focused, and the `active` comparison catches the
 * field that lost focus without a `blur` reaching us for any other reason.
 * Either way the answer is the same — this registration is stale and must not
 * answer for a field the viewer has left.
 */
export function stillTyping(el: Element, active: Element | null): boolean {
  return el.isConnected && active === el;
}



/** A television — the form factor `lib/formFactor` stamps on the root. */
function onTelevision(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset['ff'] === 'tv';
}

/* See the keydown listener: true from an arrow move until the frame after it
   has been drawn. The timeout is a floor for a page that is not drawing at all
   (hidden), where the frame would never come. */
let moveInFlight = false;
function holdForFrame(): void {
  moveInFlight = true;
  const clear = (): void => { moveInFlight = false; };
  const floor = window.setTimeout(clear, 250);
  requestAnimationFrame(() => window.setTimeout(() => { window.clearTimeout(floor); clear(); }, 0));
}

export function installKeys(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  /* Focus that vanishes when its element unmounts, restored — see `watchFocus`.
     Asked with a callback rather than an import so `spatialNav` stays free of the
     form-factor module, which is the thing everything else already depends on. */
  watchFocus(() => getShape().remote);

  /*
    BACK while the keyboard is open, for the button that never reaches the
    listener below.

    A remote's physical BACK is `KEYCODE_BACK`, and `MainActivity.onKeyDown`
    answers it straight from Java — over `window.__streamixBack`, which is
    `nativeBack.ts`'s own `handleBack` — before Chromium turns it into a DOM
    event at all. So the `intent === 'exit'` handling further down, which only
    ever sees a DOM `keydown`, cannot be where this is fixed; the real remote
    never sends it one.

    `nativeBack.ts`'s stack is built for exactly this: a handler that answers
    for as long as something specific is true, asked most-recent-first. So a
    handler is pushed the moment a field gains focus and popped the moment it
    blurs — by this, by a route change unmounting it, by a tap elsewhere — and
    while it is on the stack it answers BACK by closing the keyboard (there is
    no other way to ask a WebView to do that without also taking focus) and
    stopping there. Pushed on `focusin` rather than once at boot, so it sits
    ABOVE whatever sheet or panel the field happens to be inside: a field only
    gains focus after its container is already open, so this is always the
    most recent registration and is asked before the container's own.

    The result is the two-stage press Android viewers already expect: the
    first BACK lands here and only closes the keyboard; nothing is focused for
    the second one to find, so it falls through to whatever is next — the
    panel, the sheet, or the route.
  */
  document.addEventListener('focusin', (e) => {
    if (!isTypingTarget(e.target)) return;
    const el = e.target as HTMLElement;
    /*
      The handler retires itself rather than trusting the `blur` below.

      Today that blur does arrive: Chromium fires `blur` and `focusout` when a
      focused element is removed from the document — measured, not assumed —
      and has done for years, so it holds on the old WebViews this app runs on.
      But Chromium is the ONLY engine that does. The HTML spec sides with
      Firefox and WebKit, which fire nothing, and Chromium has a live intent to
      deprecate and remove the behaviour as part of cutting the synchronous side
      effects of DOM removal.

      That is a thin thing for this particular registration to stand on. It is
      pushed on every `focusin` into a text field, and a field is removed while
      still focused whenever a viewer presses a button that jumps to another
      screen with the cursor still in the search box. If the blur ever stops
      coming, the handler is stranded — and stranded is far worse than leaked:
      `handleBack` walks the stack most recent first, and this one answered
      `true` unconditionally, so it would swallow every BACK press for the rest
      of the session, with nothing on screen to explain why.

      Asking it whether it is still the field the viewer is typing in costs one
      comparison per press and depends on no event at all. Nothing here is
      fixing an observed failure — BACK works — which is exactly why it is worth
      not leaving it to a behaviour its own vendor has announced it wants gone.
    */
    const off = pushBackHandler(() => {
      if (!stillTyping(el, document.activeElement)) { off(); return false; }
      el.blur();
      return true;
    });
    el.addEventListener('blur', () => off(), { once: true });
  });

  window.addEventListener('keydown', (e) => {
    /*
      Evidence for the report a viewer cannot type: "OK types a character
      instead of pressing Enter". Nothing here can see the platform's own
      on-screen keyboard or which of ITS keys was highlighted — only the
      keydown it leaves behind. Logged first, before anything below decides
      what the key means or calls `preventDefault`, and for every field, not
      only the one somebody happens to be on when this is read: the report
      never says which field it happened on.
    */
    /* Guarded, because a diagnostic has no business deciding whether a remote
       works. It threw on every keypress in every text field — see
       `logFieldKeydown` — and took the whole rest of this listener with it,
       including the rule below that lets BACK out of a text field. Nothing
       written to gather evidence gets to do that. */
    try {
      if (isTypingTarget(e.target)) logFieldKeydown(e);
    } catch { /* never at the cost of the key itself */ }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    /*
      Tab, but only when an overlay is open.

      The browser's Tab order knows nothing about overlays, so it walks straight
      out of an open panel and onto the page behind — the same escape the arrow
      keys had, through a different door, and the reason the report described it
      as "like the tab on the keyboard". Outside an overlay, Tab is left entirely
      alone: it is the browser's own affordance and works correctly there.
    */
    if (e.key === 'Tab' && tabWithin(e.shiftKey)) { e.preventDefault(); return; }
    /*
      Something closer to the action has already answered.

      The pane splitters (since removed) resized on Left/Right and called `preventDefault`; without
      this line the same press would resize the pane AND move focus off the
      splitter, so a remote could nudge a divider exactly once. A control that
      consumes a key owns it.
    */
    if (e.defaultPrevented) return;
    const intent = intentFor(e.key);
    if (intent === null) return;
    /*
      Leaving is never something a text field gets to swallow.

      A focused field keeps the keys it could plausibly want — letters, arrows,
      Enter — and `keyIsTextInput` counts Escape among them, which is right for a
      field that wants to cancel its own editing and wrong for everything else:
      with the cursor in a username box, BACK and Escape reached nothing at all,
      so a remote could enter a sign-in form and never get out of it. Found by the
      first-run probe, and it is not hypothetical on a television, where a text
      field is where a D-pad is most likely to be stuck.

      So `exit` is taken first, and the field is blurred on the way past — and
      the press STOPS there. It used to fall through to `dispatch`/`fallback`
      in the same press, on the theory that Android already dismisses its
      keyboard on a first BACK and this was only ever seeing the second —
      which is true for the real remote (it never reaches this DOM listener at
      all; see the `focusin`-pushed handler above) but was never true for
      Escape on a desktop keyboard or `BrowserBack`, neither of which any
      platform intercepts first. Both blurred the field AND navigated in one
      press — closing the keyboard and leaving the screen at once, which is
      not what BACK does anywhere else in this app: one press closes the
      topmost thing, and the screen behind it is still there to look at
      afterwards. A second, separate press now does that navigating.
    */
    if (intent === 'exit' && isTypingTarget(e.target)) {
      /*
        Backspace on a keyboard is "delete the character", not "leave the page".

        It is mapped to `exit` so a remote that sends Backspace for BACK still
        has a way out — but a PC (and an on-screen keyboard) uses the same key
        to edit the focused field. Taking it as navigation left the search box
        unable to erase a letter: every press blurred the field and walked
        history instead. Escape / BrowserBack still leave.
      */
      if (e.key === 'Backspace' || e.key === 'Delete') return;
      (e.target as HTMLElement).blur();
      e.preventDefault();
      markKeysUsed();
      return;
    } else if (isTypingTarget(e.target) && keyIsTextInput(e.key)) {
      /*
        Up and Down leave a single-line field. Everything else it keeps.

        A field owns the keys it can plausibly want — letters, Left, Right,
        Home, End, Backspace, Enter — and `keyIsTextInput` counted the vertical
        arrows among them, which is right for a textarea and strands a REMOTE in
        a one-line input: there is no caret to move up, so the press did nothing
        at all, and the only way out was BACK. On a screen whose first control is
        a search box — the search page, the country list, the package list —
        that is the whole screen unreachable by D-pad.

        Measured on `/organise`: Right entered the pane, landed on the search
        field, and Down did nothing; the 179 countries under it could not be
        reached with a remote at all.

        A textarea and a contenteditable keep both, because there the vertical
        arrows really are the caret.
      */
      const vertical = intent === 'up' || intent === 'down';
      const multiline = e.target instanceof HTMLTextAreaElement
        || (e.target instanceof HTMLElement && e.target.isContentEditable);
      // A dedicated media or TV button on a remote is never someone typing.
      if (!vertical || multiline) return;
    }
    /*
      A slider is not a text field, but the arrows are still its own.

      `isTypingTarget` deliberately says no to `input[type=range]` — the media
      shortcuts have to keep working after someone clicks the volume bar. That
      leaves the slider itself unusable from a D-pad, since the arrow that should
      nudge it would move focus off it instead. The browser already adjusts a
      focused range input natively, so the honest answer is to stay out of the way.
    */
    if (ARROWS[intent] !== undefined
      && e.target instanceof HTMLInputElement && e.target.type === 'range') return;
    if (digitOf(intent) === null) markKeysUsed();
    /*
      A held arrow moves once per DRAWN frame, never more.

      A remote repeats a held key about twenty times a second whether or not
      the box has drawn the last move, and every repeat did a whole move —
      focus, keyline scroll, the rows it brings in. On a box that needs longer
      than 50 ms a frame, the repeats queued behind each other and the list
      kept sliding after the thumb came off. So while a move is still on its
      way to the screen, a REPEAT is dropped (and swallowed, so the browser
      does not scroll on its own). A first press is never held back.
    */
    if (ARROWS[intent] !== undefined) {
      if (e.repeat && moveInFlight) { e.preventDefault(); return; }
      holdForFrame();
    }
    if (dispatch(intent, e) || fallback(intent, e.repeat)) {
      e.preventDefault();
      markKeysUsed();
    } else if (ARROWS[intent] !== undefined && (intent === 'left' || intent === 'right' || onTelevision())) {
      /*
        Nowhere to go is an answer, and the answer is "stay".

        Left unclaimed, an arrow press reaches the WebView's OWN spatial
        navigation — Android TV switches it on for a WebView on a device with no
        touchscreen — which knows none of this app's rules. Measured on /sports
        with nothing playing: RIGHT from a channel row found nothing in the empty
        player pane (correctly), and the WebView then moved focus to the header's
        Search icon by itself; LEFT from there walked the header, and the rail
        was out of reach. Sideways is claimed everywhere (a page here never
        scrolls sideways), and up/down too on a television; with a cursor an
        unclaimed up/down still scrolls the page the way a browser does.
      */
      e.preventDefault();
    }
  });

  window.addEventListener('streamix:remotekey', ((e: Event) => {
    const code = (e as CustomEvent<{ keyCode?: number }>).detail?.keyCode;
    if (typeof code !== 'number') return;
    const intent = intentForAndroidCode(code);
    if (intent === null) return;
    markKeysUsed();
    if (!dispatch(intent, null)) fallback(intent);
  }) as EventListener);
}

/** For tests and for the probe: the number of layers currently registered. */
export function layerCount(): number {
  return layers.length;
}
