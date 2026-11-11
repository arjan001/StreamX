/**
 * Priority in front of the panel client's queue.
 *
 * `XtreamClient` serialises every request with a 250ms gap, which is the right
 * flood-protection discipline and the wrong scheduling policy: it is strictly
 * FIFO and has no cancel. Open the guide over 200 channels and the guide's own
 * top-up sits 200 jobs deep — so pressing a channel puts a request the viewer is
 * actually waiting for fifty seconds behind work nobody asked for.
 *
 * On a device every request either has someone looking at it or does not, and
 * that difference is the whole policy:
 *
 *   foreground  the channel on screen, the film someone just opened
 *   visible     guide rows currently in the viewport
 *   background  prefetch, refresh, anything speculative
 *
 * Two rules that matter more than the bands:
 *
 *   · `visible` is a STACK and it is cleared on scroll and on navigation. A
 *     queue would serve the rows someone scrolled past three screens ago before
 *     the ones under their eyes.
 *   · a job re-requested at a higher band is PROMOTED, not duplicated. The panel
 *     counts requests, not intentions.
 *
 * Nothing is cancelled once it is in flight. There is no abort hook on the client
 * and there should not be one: the answer still lands in the cache, and a
 * half-finished request costs the panel exactly as much as a finished one.
 */
export type Band = 'foreground' | 'visible' | 'background';

const ORDER: Band[] = ['foreground', 'visible', 'background'];

interface Job {
  key: string;
  band: Band;
  run: () => Promise<unknown>;
  /** Everyone waiting on this key. One request, many callers. */
  waiters: { resolve: (v: never) => void; reject: (e: unknown) => void }[];
}

export class Scheduler {
  private readonly queues: Record<Band, Job[]> = { foreground: [], visible: [], background: [] };
  private readonly pending = new Map<string, Job>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private running = false;

  /**
   * Submit work, or join work already submitted for the same key.
   *
   * The key is the deduplication identity — one channel's guide, one film's
   * detail. Two screens asking for the same thing must cost one request, so a
   * second caller joins the first rather than queueing beside it.
   */
  submit<T>(key: string, band: Band, run: () => Promise<T>): Promise<T> {
    const live = this.inflight.get(key);
    if (live !== undefined) return live as Promise<T>;

    const queued = this.pending.get(key);
    if (queued !== undefined) {
      if (ORDER.indexOf(band) < ORDER.indexOf(queued.band)) this.promote(queued, band);
      return new Promise<T>((resolve, reject) => {
        queued.waiters.push({ resolve: resolve as (v: never) => void, reject });
      });
    }

    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        key, band, run: run as () => Promise<unknown>,
        waiters: [{ resolve: resolve as (v: never) => void, reject }],
      };
      this.pending.set(key, job);
      this.queues[band].push(job);
      void this.drain();
    });
  }

  private promote(job: Job, band: Band): void {
    const from = this.queues[job.band];
    const at = from.indexOf(job);
    if (at >= 0) from.splice(at, 1);
    job.band = band;
    this.queues[band].push(job);
  }

  /** Drop everything speculative in a band. In flight work is left alone. */
  clear(band: Band): void {
    for (const job of this.queues[band].splice(0)) {
      this.pending.delete(job.key);
      /* Resolving rather than rejecting: a dropped guide row is not an error,
         it is a row nobody is looking at any more. Callers read `null` as
         "not known yet", which is exactly true. */
      for (const w of job.waiters) w.resolve(null as never);
    }
  }

  get depth(): number {
    return ORDER.reduce((n, b) => n + this.queues[b].length, 0) + this.inflight.size;
  }

  private next(): Job | undefined {
    for (const band of ORDER) {
      const job = this.queues[band].shift();
      if (job !== undefined) return job;
    }
    return undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.next();
        if (job === undefined) return;
        this.pending.delete(job.key);
        const p = job.run();
        this.inflight.set(job.key, p);
        try {
          const value = await p;
          for (const w of job.waiters) w.resolve(value as never);
        } catch (e) {
          for (const w of job.waiters) w.reject(e);
        } finally {
          this.inflight.delete(job.key);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** One per app: the panel counts requests per account, not per component. */
export const scheduler = new Scheduler();
