/**
 * A turn for everything else the page has to do — input first.
 *
 * Background work on this app (the logo list, the guide, the library walk)
 * runs on the same thread as the remote's presses. It hands the thread back
 * here between slices: `scheduler.yield()` where the WebView has it, which
 * puts pending input ahead of the rest of the job, else a zero timeout.
 */
export function breather(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof s?.yield === 'function') return s.yield();
  return new Promise((r) => { setTimeout(r, 0); });
}
