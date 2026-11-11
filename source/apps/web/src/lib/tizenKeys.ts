/**
 * Samsung Tizen TV: the platform the Android keymap has no idea exists.
 *
 * A Tizen TV runs this same web app in a Chromium-based WebView, so the arrows,
 * Enter and the digits already work — Samsung's own docs call those "detected
 * automatically" and `BY_KEY` in `remoteKeys.ts` already covers them by name.
 * Everything else on the remote — the four colour buttons, the media transport
 * keys, channel and volume, Info — is invisible to a Tizen app until it asks for
 * each one BY NAME through `tizen.tvinputdevice.registerKey`. Skip that and the
 * app is not broken in any way a devtools console would show: the button is
 * simply never delivered, `keydown` never fires, and the screen just sits there.
 * That is the one Samsung-specific fact this whole file exists to act on.
 *
 * The Return key is the other half of the job. It needs no registration — it is
 * one of the "detected automatically" keys — and it must land on the exact same
 * `exit` intent, run through the exact same `handleBack` stack, that Android's
 * BACK button already drives (see `nativeBack.ts`). The three-press gesture, the
 * home/back/exit decision in `resolveBack`, the exit confirmation — none of that
 * is reimplemented here; it would be a second copy of a decision this app has
 * already gotten wrong once (see the header of `nativeBack.ts`). This file's own
 * job stops at turning a Tizen keyCode into an intent and handing it to the same
 * `dispatch`/`fallback` pair `keys.ts` already drives everything else through.
 *
 * ── what actually ends the app on Tizen ──
 *
 * Samsung's own termination guide (developer.samsung.com/smarttv, "Terminating
 * Applications") states the policy this app already followed by instinct: a
 * single Return on a detail page goes back, a single Return on the home page
 * shows an exit confirmation built from the app's own HTML (Samsung: "You must
 * make the application exit confirmation popup independently"), and only a
 * CONFIRMED exit should end the process — via `tizen.application
 * .getCurrentApplication().exit()`. That is precisely the shape of
 * `resolveBack` + `ExitDialog` already built for Android. What is NOT precisely
 * the same is the last step: Android's confirmed exit calls a native
 * `StreamixDevice.exitApp()` plugin (see `ExitDialog.tsx` / `deviceInfo.ts`),
 * and nothing in THIS file's ownership wires an equivalent Tizen call — that
 * bridge belongs with `ExitDialog`/`deviceInfo.ts`, which this task did not
 * include. Until something adds it, a confirmed "Exit" on a Tizen build reaches
 * the same dialog and the same "could not close" message Android shows when its
 * own plugin fails to answer — see this file's report for the flag on that gap.
 * Also deliberately NOT done here: registering the Return key's long-press.
 * Samsung's guide says plainly "Do not register the 'Return/Exit' key
 * long-press" — a long hold force-terminates the app at the platform level
 * regardless of anything a web app does, and registering it would only fight
 * that.
 */
import { dispatch, fallback } from './keys.ts';
import { intentFor, intentForTizenCode } from './remoteKeys.ts';

/**
 * The sliver of the Tizen Web Device API this file touches, typed by hand.
 *
 * There is no `@types` package for it in this repo (nothing else here runs on
 * Tizen yet), and pulling one in for four methods would be a dependency to
 * research on its own. Shaped from the same Samsung documentation cited above
 * `BY_TIZEN_CODE` in `remoteKeys.ts`.
 */
interface TizenTVInputDevice {
  registerKey(keyName: string): void;
  /** Since 2016 models — Samsung's docs recommend it to cut launch-time cost of
   *  registering keys one at a time. Older models simply do not have it. */
  registerKeyBatch?(keyNames: string[]): void;
}
interface TizenApplication {
  /** Ends this app. The Tizen equivalent of `StreamixDevice.exitApp`. */
  exit(): void;
}
interface TizenApplicationManager {
  getCurrentApplication(): TizenApplication;
}
interface TizenGlobal {
  tvinputdevice?: TizenTVInputDevice;
  application?: TizenApplicationManager;
}
declare global {
  // eslint-disable-next-line no-var
  var tizen: TizenGlobal | undefined;
}

/**
 * Is this actually running on a Tizen device — the `tizen` global itself, not a
 * user-agent guess. A user-agent string is copied, spoofed by devtools device
 * emulation, and missing entirely in plenty of legitimate embedded WebViews; the
 * `tizen` global is put there by the platform and nothing else has a reason to.
 * Checking for `registerKey` specifically (not just `typeof tizen`) is the same
 * discipline `direct.ts` uses for `Capacitor.isNativePlatform()`: ask the thing
 * that has to actually work, not a weaker proxy for it.
 */
export function isTizen(): boolean {
  return typeof globalThis.tizen?.tvinputdevice?.registerKey === 'function';
}

/**
 * The key NAMES `tizen.tvinputdevice.registerKey` expects — not the numeric
 * codes `BY_TIZEN_CODE` maps FROM. Every name here has a matching entry in that
 * table; this list is what stops that table from documenting a button the app
 * never actually asked the TV to deliver.
 *
 * Left out on purpose: `'Return'` / `'Exit'`, because Samsung's docs say the
 * Return key is delivered without registration at all, and `'Menu'`, because
 * every source consulted for this file disagreed with itself on its keyCode —
 * see the comment above `BY_TIZEN_CODE` — and this app has no bound `menu`
 * legend on the intent that name would map to.
 */
const REGISTER_NAMES = [
  'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'MediaPlayPause',
  'MediaTrackPrevious', 'MediaTrackNext',
  'ChannelUp', 'ChannelDown',
  'VolumeUp', 'VolumeDown', 'VolumeMute',
  'Info',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
] as const;

/**
 * Ask the TV to start delivering the buttons above. Safe to call whether or not
 * this is Tizen at all — it checks for itself and does nothing off-platform.
 *
 * One model refusing one name (`registerKey` throws a `WebAPIException` for a
 * key the remote does not have) must not cost the other seventeen, which is why
 * this is try/caught per key rather than once around the batch call.
 */
export function registerTizenKeys(): void {
  const dev = globalThis.tizen?.tvinputdevice;
  if (dev === undefined) return;

  if (typeof dev.registerKeyBatch === 'function') {
    try {
      dev.registerKeyBatch(REGISTER_NAMES as unknown as string[]);
      return;
    } catch {
      // Fall through to one at a time — a batch call is documented to reject
      // the whole batch if any one name in it is unsupported on this model.
    }
  }
  for (const name of REGISTER_NAMES) {
    try {
      dev.registerKey(name);
    } catch {
      // This model does not carry that button. The rest still register.
    }
  }
}

/**
 * One Tizen `keydown` handler, doing exactly what the Android bridge in
 * `keys.ts` does for its own raw codes: resolve an intent, then hand it to the
 * same `dispatch`/`fallback` pair every other input source goes through. No
 * screen, layer or the exit gesture can tell the difference between a press
 * that arrived this way and one that arrived as an ordinary DOM key.
 *
 * ── why this does not double-dispatch the arrows, Enter or the digits ──
 *
 * Those already reach `BY_KEY` through `e.key` on a Tizen WebView exactly like
 * on any browser — Samsung's own docs call them "detected automatically" — and
 * `keys.ts`'s own top-level `keydown` listener already claims them. If this
 * handler processed them too, off the numeric `keyCode` instead, a single
 * physical press would run through `dispatch`/`fallback` TWICE. Two guards stop
 * that, and they are independent on purpose because listener registration order
 * between this file and `keys.ts` is not something to rely on:
 *
 *   `e.defaultPrevented` — if the other listener already claimed this event
 *   (called `preventDefault`), there is nothing left for this one to do.
 *
 *   `intentFor(e.key) !== null` — even if this listener somehow ran FIRST, a key
 *   that `BY_KEY` already recognises by name is not this file's to answer for;
 *   `BY_TIZEN_CODE` is deliberately only the buttons that arrive with no useful
 *   `e.key` at all.
 *
 * Exported (rather than kept as an anonymous listener) so the mapping and the
 * dispatch can be pinned in `tizenKeys.test.ts` without a DOM.
 */
export function handleTizenKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (intentFor(e.key) !== null) return;
  const intent = intentForTizenCode(e.keyCode);
  if (intent === null) return;
  if (dispatch(intent, e)) { e.preventDefault(); return; }
  if (fallback(intent, e.repeat)) e.preventDefault();
}

let installed = false;

/**
 * Register the buttons and start listening. Called once, from `main.tsx`.
 *
 * A no-op — silently, never a thrown error — everywhere this is not Tizen: a
 * plain browser, the Android APK, a Vitest/Node run with no `tizen` global at
 * all. `isTizen()` is the only branch; there is deliberately no user-agent
 * fallback path to keep in step with it.
 */
export function installTizenKeys(): void {
  if (installed || !isTizen()) return;
  installed = true;
  registerTizenKeys();
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleTizenKeyDown);
  }
}

/** For tests: undo the one-shot guard so a fresh Tizen simulation can install again. */
export function forgetTizenInstallForTest(): void {
  installed = false;
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleTizenKeyDown);
  }
}

/**
 * Close the app, on a television where nothing else can.
 *
 * `ExitDialog` ends the app through `StreamixDevice.exitApp`, an Android plugin
 * that does not exist here — so without this, answering "yes, leave" on a Tizen
 * build reaches the "this build cannot end itself" fallback and the app simply
 * stays open. Samsung's own answer is
 * `tizen.application.getCurrentApplication().exit()`.
 *
 * Reports whether it actually did anything, so the caller can fall through to
 * the Android path rather than assume: this returns false in a browser, false
 * in the APK, and false on a Tizen build old enough to lack the application
 * API, and every one of those must still try what it has.
 *
 * Long-pressing Return force-terminates the app at the platform level whatever
 * a web app does — which is why `REGISTER_NAMES` deliberately leaves that
 * long-press alone — so this path is the polite exit, never the only one.
 */
export function exitTizenApp(): boolean {
  const app = globalThis.tizen?.application;
  if (app === undefined || typeof app.getCurrentApplication !== 'function') return false;
  try {
    app.getCurrentApplication().exit();
    return true;
  } catch {
    /* A platform that refuses has not exited, and saying so lets the caller
       tell the viewer the truth rather than leave them on a dead dialog. */
    return false;
  }
}
