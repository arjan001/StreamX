/**
 * The frame at a moment of the film, decoded on the device.
 *
 *     and why no thumbnails?
 *
 * They came from our box, and films no longer do — so they stopped. This is
 * the same picture, made in the page.
 *
 * ── what comes back ──
 *
 * `readKeyframe(t)` returns a **JPEG**: libav.js decodes and scales the frame in
 * its worker, and `libavThumb.ts` encodes the pixels with the browser's own
 * canvas. A file an `<img>` takes. The decoding happens in WebAssembly, which is
 * why it works on films whose picture this browser could never play.
 *
 * ── why a thumbnailer rather than the remuxer ──
 *
 * The remuxer could do it, and doing it would be a bug: a keyframe preview
 * seeks BACKWARD on the input, and an output muxer cannot follow that. Asking
 * the playing film for a preview would damage the film.
 * A thumbnailer has no muxer to damage — no encoder, no stream map, no header.
 *
 * ── and why it is allowed to exist at all ──
 *
 * A second reader on a line that allows one stream is a refusal, and the seek
 * bar used to say so in as many words: "a true frame of a moment nobody has
 * downloaded can only come from reading the film at that moment, which is a
 * second connection". That was true of two readers running at once. It stopped
 * being true when both were put behind `filmLine.ts`, which lets exactly one
 * read touch the panel at a time. The preview waits for the film's read; it
 * never races it.
 *
 * So the seek bar can now show the real frame at a place nobody has downloaded
 * — which is the thing that was asked for, twice.
 */
import { createLibav, readRange } from './deviceFilm.ts';
import { onTheLine } from './filmLine.ts';
import type { Thumbnailer } from './libavThumb.ts';

/** Smaller reads than the film's: a keyframe is not a fragment. */
const READ_BYTES = 1024 * 1024;

const READ_TIMEOUT_MS = 20_000;

/**
 * One frame per this many seconds.
 *
 * A pointer crossing a two-hour bar fires dozens of times a second, and every
 * distinct second asked for is a decode and a read. Snapping to a grid means a
 * slow drag asks for the same frame over and over and gets it from the cache —
 * the same reason the server's tiles were on a five-second grid.
 */
const EVERY_S = 10;

/**
 * How many frames to keep.
 *
 * Each is about 30 KB, so this is roughly two megabytes — worth it, because
 * scrubbing goes back and forth over the same stretch and the alternative is
 * reading the panel again for a frame we just threw away.
 */
const KEEP = 64;

/** Snap to the grid, so a drag asks for one frame rather than four hundred. */
export function frameSecond(t: number): number {
  return Math.max(0, Math.floor(t / EVERY_S) * EVERY_S);
}

export class DevicePreview {
  private readonly url: string;

  private readonly length: number;

  private thumb: Thumbnailer | null = null;

  private opening: Promise<Thumbnailer | null> | null = null;

  private closed = false;

  /** Frames already made, newest last, as object URLs. */
  private readonly frames = new Map<number, string>();

  /** Seconds that have already answered with nothing, so they are not retried. */
  private readonly barren = new Set<number>();

  /** One decode at a time, and the last thing asked for wins. */
  private busy: Promise<unknown> = Promise.resolve();

  /**
   * `make` is how the tests get in.
   *
   * The real one loads several megabytes of WebAssembly into a worker, which no
   * test should do and no test can do in Node. Everything worth asserting here
   * is what surrounds that call — the grid, the cache, the queue, and what
   * happens to a second nothing can be decoded at — so it is a parameter.
   */
  constructor(url: string, length: number, make?: () => Promise<Thumbnailer | null>) {
    this.url = url;
    this.length = length;
    if (make !== undefined) this.make = make;
  }

  private readonly make: (() => Promise<Thumbnailer | null>) | null = null;

  /** One ranged read of the film, taking its turn on the line. */
  private read(offset: number, size: number): Promise<ArrayBuffer> {
    /* `readRange`, for the reason written there: a refusal answered with a 200
       and a sentence is not a frame of the film, and must never reach ffmpeg
       as one. */
    const end = Math.min(offset + size, this.length);
    return onTheLine(() => readRange(this.url, offset, Math.max(0, end - offset), { timeoutMs: READ_TIMEOUT_MS }));
  }

  private open(): Promise<Thumbnailer | null> {
    this.opening ??= (async () => {
      try {
        if (this.make !== null) {
          const made = await this.make();
          if (made === null || this.closed) return null;
          this.thumb = made;
          return made;
        }
        const { makeThumbnailer } = await import('./libavThumb.ts');
        /* Versioned inside `createLibav`, for the reason in `deviceFilm.ts`:
           the address is fixed and was cached for a day. */
        const libav = await createLibav(window.location.origin);
        if (this.closed) { void Promise.resolve(libav.terminate?.()).catch(() => undefined); return null; }
        const t = await makeThumbnailer({
          libav,
          length: this.length,
          bufferSize: READ_BYTES,
          read: (offset: number, size: number) => this.read(offset, size),
        });
        try {
          await t.init();
        } catch (e) {
          void Promise.resolve(t.destroy()).catch(() => undefined);
          throw e;
        }
        if (this.closed) { void t.destroy(); return null; }
        this.thumb = t;
        return t;
      } catch {
        /* A film whose picture cannot even be decoded here still plays, and a
           seek bar with no pictures is the state this replaced. Silent. */
        return null;
      }
    })();
    return this.opening;
  }

  /**
   * The frame at `t`, or null if there is not one.
   *
   * Never throws: a seek bar is not a place to report that a decoder did not
   * like a keyframe.
   */
  async frameAt(t: number): Promise<string | null> {
    if (this.closed) return null;
    const at = frameSecond(t);
    const had = this.frames.get(at);
    if (had !== undefined) {
      /* Touch it, so the ones being scrubbed over are the ones kept. */
      this.frames.delete(at);
      this.frames.set(at, had);
      return had;
    }
    if (this.barren.has(at)) return null;
    const mine = this.busy.then(() => this.decode(at), () => this.decode(at));
    this.busy = mine.then(() => undefined, () => undefined);
    return mine;
  }

  private async decode(at: number): Promise<string | null> {
    if (this.closed) return null;
    const had = this.frames.get(at);
    if (had !== undefined) return had;
    const t = this.thumb ?? await this.open();
    if (t === null || this.closed) return null;
    let image: ArrayBuffer | null = null;
    try {
      image = await t.readKeyframe(at);
    } catch {
      image = null;
    }
    if (image === null || image.byteLength === 0 || this.closed) {
      this.barren.add(at);
      return null;
    }
    const url = URL.createObjectURL(new Blob([image], { type: 'image/jpeg' }));
    this.frames.set(at, url);
    while (this.frames.size > KEEP) {
      const oldest = this.frames.keys().next();
      if (oldest.done === true) break;
      const gone = this.frames.get(oldest.value);
      this.frames.delete(oldest.value);
      if (gone !== undefined) URL.revokeObjectURL(gone);
    }
    return url;
  }

  /** Give back the worker and every frame it made. */
  close(): void {
    this.closed = true;
    for (const url of this.frames.values()) URL.revokeObjectURL(url);
    this.frames.clear();
    this.barren.clear();
    const t = this.thumb;
    this.thumb = null;
    this.opening = null;
    if (t !== null) void Promise.resolve(t.destroy()).catch(() => undefined);
  }
}
