/**
 * One ranged read at a time, across everything on this page that reads a film.
 *
 *     max_connections: 1
 *
 * That is the owner's own subscription, and it is what turned the film player
 * into a week of work: a second reader is not slower, it is REFUSED —
 *
 *     GET .../movie/... 509
 *     GET .../movie/... 200 "MAX CONNECTIONS REACHED"
 *
 * — and the refusal lands on whichever request happens to be second, which is
 * as often the film as the thing that interrupted it. Two readers is not a
 * performance question on such a line. It is a broken film.
 *
 * There are two readers: the remuxer feeding the picture (`deviceFilm.ts`) and
 * the thumbnailer answering the seek bar (`devicePreview.ts`). They are
 * separate workers with separate file handles and neither can see the other,
 * so the only place their reads can be made to take turns is here, in the page
 * that owns them both.
 *
 * A queue rather than a lock, because the alternative — refusing a preview
 * while the film is reading — is what the seek bar did before, and it meant no
 * preview ever appeared during the only moments anybody scrubs.
 *
 * ── what this does not do ──
 *
 * It does not make reads slower than they were: the film's reader sleeps
 * whenever it is far enough ahead of the playhead, so the queue is empty
 * almost all of the time. What it costs is the wait for at most one read in
 * flight — 2.5 MB — before a preview's own read begins.
 *
 * It is deliberately not per-URL. Two different films read at once is two
 * connections whatever their addresses, and this line allows one.
 */

/** The tail of the queue. Everything waits on whatever is already in it. */
let tail: Promise<unknown> = Promise.resolve();

/** Whether anything is waiting, which only the tests and the probes ask. */
let waiting = 0;

/** How many reads have gone through, so a probe can prove they took turns. */
let served = 0;

/**
 * Run `job` when the line is free, and give back what it gives back.
 *
 * A job that throws still lets the next one through: the queue carries no
 * result and no failure forward, only the turn.
 */
export function onTheLine<T>(job: () => Promise<T>): Promise<T> {
  waiting += 1;
  const mine = tail.then(job, job);
  /* `.then(job, job)` and not `.finally`: the NEXT job runs whether this one
     answered or failed, and a line that stops after one refusal is a film that
     stops with it. */
  tail = mine.then(() => undefined, () => undefined);
  return mine.then(
    (v) => { waiting -= 1; served += 1; return v; },
    (e) => { waiting -= 1; served += 1; throw e; },
  );
}

/** How many reads are queued or running, for a test that has to see it. */
export function onTheLineNow(): { waiting: number; served: number } {
  return { waiting, served };
}
