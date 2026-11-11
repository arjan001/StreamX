/**
 * Pictures take turns on the television — three at a time.
 *
 * "Takes 20 seconds to start streaming … to move left menu to middle 14
 * seconds … like old Windows." In the TV app every picture is answered by the
 * app's own native layer (`MainActivity.nativeImage`, the poster cache): a
 * picture that is not on the device yet is fetched right there, inside
 * WebView's request handler. That handler runs on a small pool of threads, and
 * the SAME pool answers every other request the page makes — its own script
 * chunks, the panel's API, the stream. Measured on the TV emulator: forty
 * pictures from hosts that never answer, one screen of a channel list on a line
 * full of dead picon hosts, and the next ordinary request waited 7.2 seconds
 * instead of 0.1. Every screen change, every channel start, queued behind
 * logos.
 *
 * So the page never has more than `MAX` pictures in flight there. A tile asks
 * for its turn when it comes on screen and gives it back when its picture has
 * arrived, failed, or scrolled away; the rest wait, drawn as the shimmer they
 * already are. Pictures the device already holds answer in milliseconds, so a
 * list of cached logos does not notice the queue; a dead host now costs three
 * threads for a few seconds instead of all of them for as long as it likes.
 * `lib/deadArt.ts` still retires the host after its first failure, which is
 * what empties the queue quickly.
 *
 * The website is not rationed: a browser fetches pictures on its own network
 * threads, and nothing of the page's waits behind them.
 */
import { isNativeShell } from './direct.ts';

export const MAX_TURNS = 3;

let active = 0;
const waiting: { start: () => void; live: boolean }[] = [];

function next(): void {
  while (active < MAX_TURNS && waiting.length > 0) {
    const w = waiting.shift()!;
    if (!w.live) continue;
    active += 1;
    w.start();
  }
}

/**
 * Ask for a turn; `start` runs when it is granted (at once, if a turn is free).
 * Returns the release — call it when the picture has loaded or failed, or the
 * tile has gone. Releasing a turn that was never granted just leaves the queue.
 */
export function takeTurn(start: () => void): () => void {
  const entry = { start, live: true };
  let granted = false;
  entry.start = () => { granted = true; start(); };
  waiting.push(entry);
  next();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    entry.live = false;
    if (granted) {
      active -= 1;
      next();
    }
  };
}

/** Whether pictures are rationed here at all: only in the TV app. */
export function turnsApply(): boolean {
  return isNativeShell();
}

/** For tests. */
export function turnsInUse(): { active: number; waiting: number } {
  return { active, waiting: waiting.filter((w) => w.live).length };
}
