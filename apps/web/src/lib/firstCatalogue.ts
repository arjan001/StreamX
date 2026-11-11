/**
 * "The catalogue is being built, and there is nothing to look at yet."
 *
 * ── why this is its own flag rather than a look at the status ──
 *
 *     when they sign in you have to show a proper loading screen till
 *     everything is loaded Right now it's so bad
 *
 * It was. Signing in showed a one-line dialog — "it carries on in the
 * background" — and dropped the viewer into an app whose every list was empty,
 * with a thin bar at the top counting megabytes. On the owner's own line that
 * is 159MB and 308,270 titles, so "the background" is a minute or more of a
 * television that looks broken.
 *
 * The obvious trigger is `status.state === 'loading' && builtAt === null`, and
 * it is wrong twice over: a device that already holds the free channels HAS a
 * `builtAt`, so a first subscription build would not show; and a weekly refresh
 * of an existing catalogue WOULD, covering an app that is perfectly usable.
 *
 * So the moment is named explicitly, by the only code that knows it: the
 * sign-in that just succeeded and started a build. It clears when the build
 * lands, fails, or the viewer dismisses it — and it never survives a reload,
 * because a catalogue half-built at the moment the page went away is resumed
 * quietly and is no longer the only thing on the screen.
 */
let preparing = false;
const listeners = new Set<(v: boolean) => void>();

function publish(): void {
  for (const fn of [...listeners]) fn(preparing);
}

/** A subscription has just been added and its catalogue is being built. */
export function startPreparing(): void {
  if (preparing) return;
  preparing = true;
  publish();
}

/** Built, failed, or waved away. */
export function stopPreparing(): void {
  if (!preparing) return;
  preparing = false;
  publish();
}

export function isPreparing(): boolean {
  return preparing;
}

export function subscribePreparing(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
