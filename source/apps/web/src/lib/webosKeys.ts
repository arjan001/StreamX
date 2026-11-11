/**
 * The one button an LG remote sends that nobody else does.
 *
 * Almost all of a webOS remote already works: the arrows, OK and the digits
 * arrive as ordinary `e.key` values that `keys.ts` claims, and the transport
 * buttons send the standard media keycodes the Tizen table already carries —
 * 415 play, 19 pause, 413 stop, 412 and 417 for rewind and fast-forward. Back
 * is the exception. Samsung sends 10009, LG sends **461**, and it arrives with
 * no useful `e.key` at all.
 *
 * ── why it cannot simply be left alone ──
 *
 * `appinfo.json` sets `disableBackHistoryAPI`, which stops webOS itself closing
 * the app the moment Back is pressed. That is the right setting — this app has
 * screens worth going back through, and a viewer who presses Back inside the
 * guide means "up one level", not "quit". But it hands the responsibility over
 * completely: without this file, Back on a webOS television does **nothing**,
 * and a viewer who opens a film has no way out of it. The manifest setting and
 * this listener only make sense as a pair.
 *
 * ── why a separate file from tizenKeys.ts ──
 *
 * Same shape, different platform test and no key registration: Tizen makes an
 * app call `tizen.tvinputdevice.registerKey` before most buttons reach the page
 * at all, and webOS has no equivalent — the keys simply arrive. Folding the two
 * together would mean one file with a platform branch in every function, to
 * save about fifteen lines.
 *
 * Researched, not measured: nobody who has touched this file has pressed Back
 * on an LG television. The same caveat the Tizen table carries.
 */
import { dispatch, fallback } from './keys.ts';
import { intentFor, intentForWebosCode } from './remoteKeys.ts';

/**
 * Is this actually webOS?
 *
 * `window.webOS` is the platform's own injected object, present in a packaged
 * webOS app and nowhere else. The user-agent string is deliberately not
 * consulted: a second way to answer the same question is a second thing to keep
 * in step, and this one cannot be spoofed by a desktop browser pretending.
 */
export function isWebos(): boolean {
  return typeof window !== 'undefined'
    && (window as { webOS?: unknown }).webOS !== undefined;
}

/**
 * Exported rather than kept anonymous so the mapping and the dispatch can be
 * pinned without a DOM — and it carries the same two independent guards
 * `handleTizenKeyDown` does, for the same reason: listener order between this
 * file and `keys.ts` is not something to rely on, so a key that `keys.ts`
 * already answers for must not be answered twice.
 */
export function handleWebosKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (intentFor(e.key) !== null) return;
  const intent = intentForWebosCode(e.keyCode);
  if (intent === null) return;
  if (dispatch(intent, e)) { e.preventDefault(); return; }
  if (fallback(intent, e.repeat)) e.preventDefault();
}

let installed = false;

/** Start listening. Called once from `main.tsx`; a silent no-op anywhere else. */
export function installWebosKeys(): void {
  if (installed || !isWebos()) return;
  installed = true;
  window.addEventListener('keydown', handleWebosKeyDown);
}

/** For tests: undo the one-shot guard so a fresh simulation can install again. */
export function resetWebosKeysForTest(): void {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', handleWebosKeyDown);
  installed = false;
}
