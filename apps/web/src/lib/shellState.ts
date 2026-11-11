/**
 * Whether the shell's header may be on screen, and how.
 *
 * Two small switches the player surfaces set and Chrome reads. They lived in
 * presence.ts, beside the heartbeat that told the server what was playing, only
 * because both started as "what is this screen doing right now"; the heartbeat
 * is gone and these stay, on their own, with nothing to do with the network.
 */
/*
 * Film/series detail mounts its own player stage above the hero. The shell
 * header must leave overlay mode for that whole time — not only while a stream
 * is up. `opening…` can sit for seconds before anything is playing (or after an
 * intervening teardown), and an absolute bar over the black stage is exactly
 * "the player goes under the header".
 */
let detailPlayer = false;
const detailWatchers = new Set<() => void>();

export function subscribeDetailPlayer(fn: () => void): () => void {
  detailWatchers.add(fn);
  return () => { detailWatchers.delete(fn); };
}

export function isDetailPlayerOpen(): boolean { return detailPlayer; }

export function noteDetailPlayer(open: boolean): void {
  if (detailPlayer === open) return;
  detailPlayer = open;
  for (const fn of detailWatchers) fn();
}

/*
 * Reasons the shell header must not be on screen at all — Live/Series theatre,
 * the player's CSS/API fullscreen, a film that opens as a fixed full-bleed stage.
 * Distinct from `noteDetailPlayer`, which only stops the hero-overlay treatment
 * (series desk needs the header in flow the whole time).
 */
const shellHide = new Set<string>();
const shellHideWatchers = new Set<() => void>();

function notifyShellHide(): void {
  for (const fn of shellHideWatchers) fn();
}

export function subscribeShellHidden(fn: () => void): () => void {
  shellHideWatchers.add(fn);
  return () => { shellHideWatchers.delete(fn); };
}

export function isShellHidden(): boolean { return shellHide.size > 0; }

export function noteShellHide(reason: string, on: boolean): void {
  const before = shellHide.size;
  if (on) shellHide.add(reason);
  else shellHide.delete(reason);
  if (shellHide.size !== before) notifyShellHide();
}
