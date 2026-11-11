/**
 * The first visit: an empty app with one question, "add your source".
 *
 * Nothing is built in and nothing is downloaded until the viewer adds a source
 * of their own, so a new device opens on the add-your-source sheet and waits.
 */
import { forgetOnboarding, isOnboarded, markOnboarded } from './session.ts';
import { getSession } from './session.ts';

/**
 * Should the door be open?
 *
 * ── why this is storage and not a module variable ──
 *
 * A module variable does not survive a reload, and a WebView on a television
 * reloads — on a memory trim, on coming back from the launcher, on an update. So
 * the door is open until it is CLOSED, and closing it is an answer written to
 * storage by the sheet itself (`markOnboarded(WELCOME_KEY)`). Nothing else can
 * close it: not a reload, not a route change.
 *
 * `closeDoorForExistingInstall` is the one-time migration that keeps a device
 * upgrading from an older build from being welcomed on a library it already has.
 */
export const WELCOME_KEY = 'welcome';

/**
 * A device that has been used before must never see the door.
 *
 * Called once from the boot, before anything downloads. "Used before" is a
 * session — it means somebody has already got past a question this build had
 * not written yet.
 */
export function closeDoorForExistingInstall(): void {
  if (isOnboarded(WELCOME_KEY)) return;
  if (getSession() !== null) markOnboarded(WELCOME_KEY);
}

/** Is the first-run door still unanswered? Durable, and the only test for it. */
export function doorOpen(): boolean {
  return !isOnboarded(WELCOME_KEY) && getSession() === null;
}

const doorSubs = new Set<() => void>();

/** Told when the door is put back, so a shell already on screen can show it. */
export function subscribeDoor(fn: () => void): () => void {
  doorSubs.add(fn);
  return () => doorSubs.delete(fn);
}

/**
 * Put the door back, because there is nothing behind it any more.
 *
 * The marker is deliberately durable and deliberately one-way — see above:
 * nothing that merely HAPPENS may close the door, or it closes itself before
 * anybody answers. But removing the last subscription is not something that
 * happens, it is something a person did, and it leaves the app in the one state
 * it has no screen for: signed out, no library, and a welcome sheet that can
 * never come back because it was answered once months ago. What the viewer sees
 * is an app with empty pages and no way to sign in again.
 *
 * So this is the single explicit way back, called from the one control that can
 * empty the list. It does NOT erase preferences, favourites or history — the
 * same rule `signOut` follows: this is "ask me again", not "wipe the device".
 */
export function reopenDoor(): void {
  forgetOnboarding(WELCOME_KEY);
  for (const fn of doorSubs) fn();
}
