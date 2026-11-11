/**
 * One place asks for a subscription, and this is the switch that opens it.
 *
 * A photograph from the owner's television showed two of them at once: the
 * centred "Welcome to Streamix" dialog, and behind it the settings drawer with
 * its own inline ADD A SUBSCRIPTION form underneath the accounts list. Two live
 * copies of the same question, stacked, both able to take the same credentials —
 * and the instruction was to stop the settings surfaces from holding a form at
 * all: "fix that duplicate adding user thing, even in the sheet or settings if
 * they want to add new account, just add a buttton to show the dialog to add,
 * instead of there".
 *
 * So the form lives in exactly one component now (`AddAccountDialog`), mounted
 * once beside the welcome sheet in `main.tsx`, and everywhere that used to grow
 * its own copy asks for it through here instead.
 *
 * ── why a module store rather than a prop or a context ──
 *
 * The asking and the answering are on opposite sides of the tree and have to
 * stay there. The button is inside `AccountsPanel`, which renders BOTH inside
 * the shell's accounts drawer and inside `/more?s=accounts`; the dialog has to
 * sit above the shell, because the whole bug was a form inside a drawer with
 * another form on top of it. Threading a callback from one to the other means
 * every surface that ever wants to add a line has to be handed one, which is how
 * the second copy appeared in the first place.
 *
 * The publish/subscribe shape is `lib/firstRun.ts`'s door, deliberately and
 * line for line: that is the same problem — something outside React deciding a
 * full-screen question belongs on screen — and two different answers to one
 * problem in one app is how the two of them drift apart.
 */

let open = false;
const subs = new Set<() => void>();

/** Should the add-a-subscription dialog be on screen? */
export function addAccountOpen(): boolean {
  return open;
}

/** Told when that answer changes. Returns the unsubscribe. */
export function subscribeAddAccount(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function say(next: boolean): void {
  open = next;
  /* Over a copy: a subscriber is free to unsubscribe while it is being told —
     the dialog does exactly that on its way out — and dropping an entry from a
     Set that is mid-iteration skips whoever was next in it. */
  for (const fn of [...subs]) fn();
}

/**
 * Ask for the dialog.
 *
 * It does not ask whether the welcome door is open, and it must not: the one
 * place that can answer that is the mount in `main.tsx`, which shows the welcome
 * sheet and keeps this one shut while it is up. A store that reached into
 * `firstRun` to decide would be a second opinion on which screen wins.
 */
export function openAddAccount(): void { say(true); }

/** Put it away — the dialog's own way out, and the shell's on the door reopening. */
export function closeAddAccount(): void { say(false); }
