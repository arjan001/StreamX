/**
 * A film taken apart on the device, so nothing about it touches our box.
 *
 *     everything on clients own device, server is just logger and notifier of
 *     updates thats it
 *
 * No browser demuxes Matroska, and none decodes AC-3, E-AC-3 or DTS. That is
 * why films were being unwrapped on the server — untouched video, untouched or
 * re-encoded audio, repacked into something a `<video>` element takes. This
 * does the same work in the page, with ffmpeg compiled to WebAssembly (libav.js,
 * see `libavRemux.ts`), and feeds the result to a Media Source.
 *
 * ── measured before any of it was written ──
 *
 * Against the owner's own panel, in a plain browser with no special headers:
 *
 *   - the panel answers `Access-Control-Allow-Origin: *` with byte ranges, so
 *     a browser MAY read the film itself — the one thing that could have made
 *     this impossible, checked first;
 *   - 4.62 GB Matroska, H.264/AAC: buffered 53s, played, `seek(600)` in
 *     **131 ms**, having fetched 16.9 MB over nine ranged reads;
 *   - 6.11 GB Matroska, one six-channel **E-AC-3** soundtrack: re-encoded to
 *     AAC on the device and played;
 *   - 4.29 GB Matroska, **DTS**: the same, 32.9s buffered.
 *
 * ── the thing this fixes that the server could not ──
 *
 * The reason a film seeked badly was never the unwrapping; it was WHO fetches.
 * A `<video>` element pointed at a panel issues a fresh ranged request per
 * seek and the superseded connection lingers — fifteen to twenty-four seconds,
 * measured by tuliprox (issue 866) — so a subscription allowing one stream
 * refuses the new one. The owner watched that happen the moment films went
 * direct:
 *
 *     GET .../live/play/... 509
 *     GET .../live/play/... net::ERR_CONTENT_LENGTH_MISMATCH 206
 *
 * ffmpeg on the server was no better: one seeking pass there costs four
 * upstream connections with two open at once, measured.
 *
 * Here, NOTHING fetches except `read` below — one range at a time, from one
 * caller, with no element and no ffmpeg opening sockets of their own. A seek
 * is the remuxer asking for a different offset on the next read. That is why
 * it costs 131 ms instead of a refusal.
 */
import { aheadOf, holds, type Span } from './filmBuffer.ts';
import { onTheLine } from './filmLine.ts';
import { fragmentStart, trackTimescales } from './mp4Time.ts';
import { cueText, dialogueKey, trackLang, type FilmDialogue } from './filmSubs.ts';
import type { LibAV, Remuxer, RemuxChunk } from './libavRemux.ts';

/** Where libav.js's files are served from — copied there by `scripts/libav-assets.mjs`. */
const LIBAV_BASE = '/libav/';

/**
 * The libav.js worker's address, with this build stamped into it.
 *
 * `/libav/…` is a FIXED address, copied in under its own name and not
 * content-hashed like everything else Vite makes, so a browser that fetched it
 * once may not ask again for a day — and a fixed worker is the one file whose
 * stale copy shows up as a film that will not open after a release.
 *
 * Two halves, because one is not enough. The server sends `no-cache` for
 * `/libav/`, which fixes it for ever — but only on the NEXT fetch, and the point
 * of a day-long cache is that there is no next fetch. A version in the query is
 * a different address, so a browser holding a stale copy asks for this one at
 * once.
 *
 * The wasm itself is not versioned: it is several megabytes that did not change,
 * and `no-cache` makes the browser ask whether it did.
 */
const BUILD = (import.meta.env?.VITE_APP_BUILD as string | undefined)
  ?? (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? 'dev';

export function libavWorkerUrl(origin: string, build = BUILD): string {
  return `${new URL(`${LIBAV_BASE}libav-streamix.wasm.mjs`, origin).toString()}?v=${encodeURIComponent(build)}`;
}

/**
 * Start libav.js: its front end here, its worker and wasm where the page keeps
 * them. Every call after this is made in the worker, so nothing it does can
 * hold up the page.
 *
 * `import()` of a computed address, because the files are copied into
 * `public/libav/` and not bundled: the build cannot know them, and a packaged
 * build does not carry them at all.
 */
export async function createLibav(origin: string, build = BUILD): Promise<LibAV> {
  const front = new URL(`${LIBAV_BASE}libav-streamix.mjs`, origin).toString();
  const mod = await import(/* @vite-ignore */ `${front}?v=${encodeURIComponent(build)}`) as { default: LibAV };
  return mod.default.LibAV({
    toImport: libavWorkerUrl(origin, build),
    wasmurl: new URL(`${LIBAV_BASE}libav-streamix.wasm.wasm`, origin).toString(),
  }) as Promise<LibAV>;
}

/**
 * How much to ask for in one read.
 *
 * The library's own default. Larger reads mean fewer requests and fewer
 * chances for a line to refuse one, which matters more here than throughput.
 */
const READ_BYTES = 2.5 * 1024 * 1024;

/** Give up on a read that has not answered — a panel refusing goes quiet. */
const READ_TIMEOUT_MS = 30_000;

/**
 * How many times to go back for the rest of a read that came up short.
 *
 * Four, not one: a content edge that drops at forty megabytes will often drop
 * again, and a read that gives up silently hands ffmpeg a truncated buffer it
 * reads as a corrupt file. Bounded, because a line answering nothing must not
 * become an endless loop — `piece.byteLength === 0` stops it at once anyway.
 */
const SHORT_READ_TRIES = 4;

/**
 * How long one network read should take, and the least it asks for.
 *
 * ffmpeg asks for READ_BYTES at a time, and a read that answers with less is
 * legal — it asks again for the rest (only ZERO bytes means the end of the
 * file). So the size of a REQUEST is ours to choose, and it is chosen from the
 * line's own measured speed: about a second and a half of it. A fast line still
 * reads 2.5 MB at a time; the owner's measured 300 kB/s reads about 450 kB, so
 * a seek never waits eight seconds behind a read it no longer wants.
 */
const READ_SECONDS = 1.5;
const MIN_READ = 256 * 1024;
/**
 * While a seek is waiting for the pass it replaces to finish, that pass reads
 * in sips — it only needs enough to close the fragment it is on.
 */
const HURRY_BYTES = 64 * 1024;
/**
 * How long to keep going back to a door that refused a read.
 *
 * A panel refuses a range while it still counts the connection before it as
 * open — measured by tuliprox at fifteen to twenty-four seconds — and it says
 * so with a 509, or, XUI's way, with a 200 and a sentence. Either way the slot
 * comes back; asking again after a pause gets the film, asking again at once
 * is a storm (seven hundred requests in three seconds, measured on the rig).
 */
const REFUSED_WAIT_MS = 25_000;

/** Seconds of film to keep ahead of the playhead before pausing the reader. */
const FORWARD_S = 60;
/** And behind it, when the browser demands room. */
const BACK_S = 120;

export interface DeviceFilmOpts {
  /** The film itself, at the panel. Never proxied. */
  url: string;
  /** Progress and reasoning, into the same debug trail as everything else. */
  note: (text: string, level?: 'info' | 'warn' | 'error') => void;
  /**
   * Bytes of the film just arrived.
   *
   * The player's door watchdog decides whether a server is answering from
   * `lastByteAt`, which is the ELEMENT's `progress` event — and on this path
   * the element loads nothing, the page does. So the watchdog saw a door that
   * had said nothing, walked to the next one, and killed the worker four
   * seconds in; three doors later the viewer was told "Nothing arrived from
   * the server" while megabytes were arriving. Measured against the owner's
   * own line on 2026-09-23: the remuxer read 7.5 MB and opened a 2.38 GB film
   * perfectly on the very doors the app was calling dead.
   *
   * "if its downloading dont change to another server" — the rule was already
   * written, on `doorIsAnswering`. This is how this path obeys it.
   */
  onBytes: () => void;
  /**
   * This door REFUSED the film — it did not merely fail to answer.
   *
   * 403 on `/movie/`, 400 from the content edge, 521 from a door behind
   * Cloudflare: none of those get better by waiting, and the player's door
   * watchdog waits nine seconds before it will try another. Measured on the
   * owner's line, a single press walked four doors and spent most of a minute
   * doing it, because every dead one cost the same nine seconds as a slow one.
   *
   * Said the moment the status is known, so the player hops at once and the
   * wait is spent only where something is actually arriving.
   */
  onRefused: (status: number) => void;
  /** Held ranges changed, so the seek bar can redraw what is downloaded. */
  onRanges: (spans: Span[]) => void;
  /** The film's real length, once the container has said. */
  onDuration: (seconds: number) => void;
  /**
   * The soundtracks and text subtitle tracks the container carries, once they
   * are known, and again whenever the soundtrack playing changes.
   *
   * `audioIndex` is the stream actually muxed: the one asked for, or — before
   * anything was asked — the file's first, which is the library's default and
   * the file's own choice. Subtitles start off; the viewer turns one on.
   */
  onTracks: (tracks: DeviceTracks) => void;
  /**
   * This cannot be done here — the file carries a picture no browser decodes.
   *
   * MPEG-2, MPEG-4 part 2, Theora and VC-1 have no decoder in any browser and
   * cannot be re-encoded in a page at any sane cost, so they are the one class
   * of film that genuinely needs the television app.
   */
  onImpossible: (why: string) => void;
}

/** One track of the film, as the container names it. */
export interface DeviceTrack { index: number; language: string; title: string }

export interface DeviceTracks {
  audio: DeviceTrack[];
  audioIndex: number | null;
  subtitles: DeviceTrack[];
  subtitleIndex: number | null;
}

/** A read the panel turned down, as opposed to one that failed. */
class Refused extends Error {}

/**
 * One ranged read of a film, straight from the panel — up to `size` bytes,
 * possibly fewer, never bytes that are not the film's.
 *
 * ── what this refuses to hand back ──
 *
 *     [mov,mp4,m4a] Packet corrupt (stream = 0, dts = 124416).
 *     [h264] Invalid NAL unit size (31548 > 29719).
 *     [mov,mp4,m4a] stream 1, offset 0x280755: partial file
 *
 * A read used to take whatever answered with 200 or 206. XUI turns down an
 * over-limit request with a **200 and `MAX CONNECTIONS REACHED`** — so those
 * twenty-four bytes of English went to ffmpeg as the film at that offset, the
 * rest of the read was retried the same way, and the demuxer reported the file
 * as corrupt. Only a 206 is the range that was asked for; a 200 is the whole
 * file from byte 0 (usable only when 0 is what was asked for) or a refusal.
 * Refusals and the transient statuses wait and ask again; see REFUSED_WAIT_MS.
 */
export async function readRange(
  url: string,
  offset: number,
  size: number,
  opts: { timeoutMs?: number; onBytes?: () => void; onRate?: (bytes: number, ms: number) => void } = {},
): Promise<ArrayBuffer> {
  const giveUp = Date.now() + REFUSED_WAIT_MS;
  for (let wait = 400; ; wait = Math.min(wait * 2, 5000)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await rangeOnce(url, offset, size, opts);
    } catch (e) {
      if (!(e instanceof Refused) || Date.now() + wait > giveUp) throw e;
      // eslint-disable-next-line no-await-in-loop
      await sleep(wait);
    }
  }
}

async function rangeOnce(
  url: string,
  offset: number,
  size: number,
  opts: { timeoutMs?: number; onBytes?: () => void; onRate?: (bytes: number, ms: number) => void },
): Promise<ArrayBuffer> {
  const t0 = performance.now();
  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + size - 1}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? READ_TIMEOUT_MS),
    /* No cookies, and no preflight: a simple GET with a Range header is
       what every player sends and what the panel already answers. */
    credentials: 'omit',
    mode: 'cors',
  });
  const type = res.headers.get('content-type') ?? '';
  const refusal = res.status === 509 || res.status === 429 || res.status === 503
    || (res.status === 200 && (offset > 0 || /^text\//i.test(type)));
  if (refusal) {
    /* Read to the end — it is a sentence — so the connection stays reusable
       and is not one more the panel has to notice closing. */
    await res.arrayBuffer().catch(() => undefined);
    throw new Refused(`the line refused the read (${res.status})`);
  }
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`the line answered ${res.status}`);
  }
  /*
   * Read it in pieces, and say so on every piece.
   *
   * ── why `arrayBuffer()` was wrong ──
   *
   * The door watchdog asks "has anything arrived lately", and for the
   * element that is the `progress` event, which fires CONTINUOUSLY as
   * bytes land. `arrayBuffer()` resolves once, at the end, so this told it
   * a single time per read — and a read is 2.5 MB. Measured on the owner's
   * connection: 2,622 kB in 8.74s, against a nine-second deadline. The
   * player gave up a door that was downloading perfectly, hopped, started a
   * fresh worker, and pulled the same 2.5 MB again:
   *
   *   backup.example.com -> 206  2,622 kB  8.74 s
   *   edge.example.com    -> 206  2,622 kB  7.09 s
   *   stream.example.com    -> 206  2,185 kB  7.49 s
   *
   * Three doors, three downloads, one film, nothing played — and on a line
   * that allows one connection each hop is also fighting the last one.
   * Reported as "i think it downloads and then just jumps to another
   * server", which is exactly what it does.
   *
   * A stream gives the same signal the element gives, at the same rate.
   */
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const whole = await res.arrayBuffer();
    if (whole.byteLength > 0) opts.onBytes?.();
    return whole.byteLength > size ? whole.slice(0, size) : whole;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done === true) break;
    if (value === undefined || value.byteLength === 0) continue;
    parts.push(value);
    total += value.byteLength;
    /* Said on arrival, not on completion: a refusal answers instantly with
       nothing and reaches neither branch. */
    opts.onBytes?.();
    /* A 200 is the whole film from byte 0: take what was asked for and let
       the rest go. Rare — a panel that ignores Range — and the only case
       where a body is abandoned on purpose. */
    if (total >= size && res.status === 200) {
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  opts.onRate?.(total, performance.now() - t0);
  /* One fresh buffer, which is what the library requires — it transfers
     what it is given, so a view onto something we keep would be detached
     under us. */
  const out = new Uint8Array(Math.min(total, size));
  let at = 0;
  for (const part of parts) {
    if (at >= out.length) break;
    const take = part.subarray(0, out.length - at);
    out.set(take, at);
    at += take.byteLength;
  }
  return out.buffer;
}

/** What the remuxer hands back for one fragment. */
type Chunk = RemuxChunk;

/**
 * Does the worker take `{ type: 'module' }`?
 *
 * The remuxer's worker is an ES module, and a browser that does not support
 * module workers IGNORES the option rather than refusing it: it loads the file
 * as a classic script, the first `import` inside it is a syntax error, and
 * what reaches us is a worker that never answers. Chromium gained them in 80,
 * Firefox in 114, Safari in 15 — and the 2020 Tizen and webOS sets run
 * Chromium 68-69, which is exactly the fleet this has to be right about.
 *
 * Detected by whether the option is READ. A browser that supports module
 * workers looks at `type`; one that does not never touches the getter. The
 * worker is torn down immediately either way, and the empty `data:` URL means
 * nothing is fetched.
 */
function moduleWorkersWork(): boolean {
  let read = false;
  try {
    const w = new Worker('data:text/javascript,', {
      get type(): WorkerType { read = true; return 'module'; },
    } as WorkerOptions);
    w.terminate();
  } catch {
    return false;
  }
  return read;
}

let moduleWorkers: boolean | null = null;

/**
 * Is there any chance this browser can run it?
 *
 * ── the packaged builds ──
 *
 * `VITE_PACKAGED` means Tizen, webOS or the Android app, and none of them
 * carries the megabytes of WebAssembly — `scripts/libav-assets.mjs`
 * drops it from those bundles on purpose, because on a television the picture
 * is decoded by the set or by libVLC. Without this line the packaged app would
 * CHOOSE this path, fail to import a chunk that is not there, and tell a
 * viewer sitting in front of a television that the film "needs the TV app".
 */
export function deviceFilmPossible(): boolean {
  if (import.meta.env?.VITE_PACKAGED === '1') return false;
  if (typeof WebAssembly !== 'object') return false;
  if (typeof MediaSource === 'undefined') return false;
  if (typeof Worker !== 'function') return false;
  moduleWorkers ??= moduleWorkersWork();
  return moduleWorkers;
}

export class DeviceFilm {
  private video: HTMLVideoElement | null = null;

  private ms: MediaSource | null = null;

  private sb: SourceBuffer | null = null;

  private remuxer: Remuxer | null = null;

  private objectUrl = '';

  private closed = false;

  /** Bumped by every open and every seek, so a stale loop stops appending. */
  private epoch = 0;

  private reading = false;

  /** An epoch that asked to read while another loop held the door. */
  private wanted = 0;

  private ranges: Span[] = [];

  /** What `measure` found, kept so the seek bar's frames need not ask again. */
  private length = 0;

  /** The status a door refused with, if one did. */
  private refused = 0;

  /** The line's measured speed, bytes a second; 0 until a read has said. */
  private rate = 0;

  /**
   * The one remuxer call in flight, and how many seeks are waiting behind it.
   *
   * A remuxer that cancels whatever it is running the moment it is handed
   * something new turns a cancelled read into ZERO bytes for ffmpeg — the end
   * of the file, halfway through a packet. Every seek during a download did
   * that, which is the console the owner sent: "Packet corrupt", "Invalid NAL
   * unit size", "partial file", on every move of the progress bar. And each
   * step of a drag still downloaded its own read to the end before the next
   * could start: six steps, fifty-eight seconds, measured on the rig at a real
   * line's speed.
   *
   * So calls wait their turn here instead of cancelling each other, a seek that
   * has been overtaken by a newer one never runs at all, and while a seek waits
   * the call ahead of it reads in sips (HURRY_BYTES) to finish sooner.
   */
  private inflight: Promise<unknown> | null = null;

  private seeksWaiting = 0;

  /** Units per second for each track, read out of the init segment. */
  private scales: Map<number, number> = new Map();

  /** What is currently being added to every frame as it is taken in. */
  private shift = 0;

  /**
   * The soundtrack the viewer asked for, or undefined for the file's first.
   *
   * A soundtrack is chosen when the remuxer is MADE (`audioStreamIndex`), so
   * changing it is a new remuxer at the same second — and a new source buffer,
   * because the two tracks need not share a codec: measured on the test film,
   * AAC French and AC-3 English, the second re-encoded to AAC on the way out.
   */
  private audioIndex: number | undefined = undefined;

  private audio: DeviceTrack[] = [];

  /**
   * One `<track>` per text subtitle stream, kept across a soundtrack change.
   *
   * A `<track>` with no file behind it fails to load, and a cue added to it
   * before the failure is thrown away — measured: two cues in, one left. So
   * each starts from an empty WebVTT file and takes cues only once it has
   * loaded; lines that arrive sooner wait in `pending`.
   */
  private subs = new Map<number, {
    info: DeviceTrack;
    el: HTMLTrackElement;
    url: string;
    ready: boolean;
    pending: FilmDialogue[];
    seen: Set<string>;
  }>();

  private subtitleIndex: number | null = null;

  private readonly opts: DeviceFilmOpts;

  constructor(opts: DeviceFilmOpts) {
    this.opts = opts;
  }

  get held(): Span[] { return this.ranges; }

  /** How many bytes the film is, once it has been asked for. */
  get bytes(): number { return this.length; }

  /**
   * One ranged read of the film, straight from the panel.
   *
   * The ONLY thing in this class that touches the network, deliberately: it is
   * what makes "one connection at a time" a property of the design rather than
   * a hope. The buffer is transferred to the worker rather than copied, which
   * the library requires — a `fetch(...).arrayBuffer()` is a fresh buffer every
   * time, so nothing here has to think about it.
   */
  /**
   * A whole ranged read, finishing it if the line hands back less than it was
   * asked for.
   *
   * ── why this is not optional ──
   *
   *     [mov,mp4,m4a] stream 0, offset 0x2800221: partial file
   *     [mov,mp4,m4a] Packet corrupt (stream = 1, dts = 7175144)
   *     [mov,mp4,m4a] reached eof, corrupted STTS atom
   *
   * Forty megabytes into the owner's film. A content edge closed a connection
   * early, the read came back short, and the short buffer went straight to
   * ffmpeg — which cannot tell a dropped connection from the end of a file. So
   * it reported corruption in a file that is not corrupt, and on a header read
   * it refused the film outright.
   *
   * The `read(offset, size)` contract is "these bytes"; a partial answer is
   * the transport's problem to finish, not the demuxer's to interpret. Each
   * continuation is a fresh range for what is still missing, and it takes its
   * own turn on the line like any other read.
   */
  private async read(offset: number, size: number): Promise<ArrayBuffer> {
    const end = this.length > 0 ? Math.min(offset + size, this.length) : offset + size;
    /* At most one request's worth: a short read is legal, and ffmpeg asks for
       the rest. See READ_SECONDS. */
    const want = Math.min(Math.max(0, end - offset), this.requestBytes());
    if (want === 0) return new ArrayBuffer(0);
    const parts: Uint8Array[] = [];
    let got = 0;
    for (let attempt = 0; attempt < SHORT_READ_TRIES && got < want; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const piece = await this.readOnce(offset + got, want - got);
      if (piece.byteLength === 0) break;
      parts.push(new Uint8Array(piece));
      got += piece.byteLength;
    }
    if (parts.length === 1 && got === want) return parts[0]!.buffer as ArrayBuffer;
    if (got < want) {
      /* Said once, plainly: a film that is genuinely short here will show as a
         short film rather than as a corrupt one, and the log says which. */
      this.opts.note(`the line sent ${got} of ${want} bytes at ${offset}`, 'warn');
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.byteLength; }
    return out.buffer;
  }

  /** One request for one range, as far as it gets. */
  private readOnce(offset: number, size: number): Promise<ArrayBuffer> {
    /* `onTheLine` and not a bare fetch: the seek bar's frames are read by a
       second worker that cannot see this one, and on a subscription allowing
       one stream a second reader is refused rather than slowed. See
       `filmLine.ts` — it is the only place the two can be made to take turns. */
    return onTheLine(() => readRange(this.opts.url, offset, size, {
      onBytes: this.opts.onBytes,
      onRate: (bytes, ms) => {
        /* Only reads big enough to say something about the line, not about
           its latency. */
        if (bytes < MIN_READ || ms <= 0) return;
        const rate = bytes / (ms / 1000);
        this.rate = this.rate === 0 ? rate : this.rate * 0.7 + rate * 0.3;
      },
    }));
  }

  /** How much one network read asks for now — see READ_SECONDS. */
  private requestBytes(): number {
    if (this.seeksWaiting > 0) return HURRY_BYTES;
    if (this.rate === 0) return 1024 * 1024;
    return Math.max(MIN_READ, Math.min(READ_BYTES, Math.round(this.rate * READ_SECONDS)));
  }

  /**
   * How long the film is, which the remuxer needs before it reads anything.
   *
   * ── the trap that cost this feature a day ──
   *
   * The obvious way is a two-byte ranged GET and a read of `Content-Range`,
   * which names the whole file after the slash. It works in curl and returns
   * NOTHING in a browser: on a cross-origin response only the CORS-safelisted
   * headers are exposed to script — `Content-Length`, `Content-Type`,
   * `Cache-Control`, `Content-Language`, `Expires`, `Last-Modified`, `Pragma`
   * — and `Content-Range` is not among them. A panel can publish more with
   * `Access-Control-Expose-Headers`; this one does not, measured.
   *
   * So the length read as zero, every film was refused as "the line would not
   * say how long it is", and the player fell back to handing the file to the
   * element — which is the path that 509s. The measurement said the device
   * path was chosen and it WAS; it just could not get past its first question.
   *
   * An open-ended `Range: bytes=0-` is the answer: its `Content-Length` is the
   * whole file, which IS readable, and one ranged GET is what every player on
   * the line already sends.
   *
   * ── and why HEAD is not, although it was ──
   *
   * This asked HEAD first, because HEAD is a CORS-safelisted method and a
   * plain one triggers no preflight. It worked against the rig, which answers
   * the film directly. The owner's real line does not: it answers the film
   * with a 302 to a content edge on another host, and measured against it on
   * 2026-09-23 a HEAD did not merely fail —
   *
   *     HEAD  -> Failed to fetch      (net::ERR_CONNECTION_RESET at the edge)
   *     GET Range: bytes=0-1023 -> 206, access-control-allow-origin: *
   *     GET Range: bytes=0-     -> 206, content-length 2385301832
   *
   * — it RESET the connection, and on a subscription that allows one stream a
   * reset connection is the one the film needed. It cost a request, a
   * connection and several seconds of the door watchdog's patience, to learn
   * nothing that the ranged GET does not say.
   *
   * The body opened here is thrown away immediately, which is the one real
   * cost left: a cancelled body lingers upstream. Measured on the same line,
   * the reads that follow it succeed at once.
   */
  private async measure(): Promise<number> {
    const read = (res: Response): number => {
      const n = Number(res.headers.get('content-length') ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    try {
      const open = await fetch(this.opts.url, {
        headers: { Range: 'bytes=0-' }, credentials: 'omit', mode: 'cors',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      /* A status is an ANSWER, and a refusing door is worth leaving at once
         rather than waiting out the watchdog. See `onRefused`. */
      if (!open.ok && open.status !== 206 && open.status !== 200) {
        this.refused = open.status;
        await open.body?.cancel().catch(() => undefined);
        this.opts.onRefused(open.status);
        return 0;
      }
      const n = read(open);
      /* The door answered, which is the question the watchdog is asking. It
         buys the first read its time on a slow line — headers arrive in
         milliseconds, the 2.5 MB behind them does not. */
      if (n > 0) this.opts.onBytes();
      /* Let go at once: the body is the whole film and nothing wants it. */
      await open.body?.cancel().catch(() => undefined);
      return n;
    } catch {
      return 0;
    }
  }

  /** Run one remuxer call once nothing else is running. */
  private async turn<T>(job: () => Promise<T>): Promise<T> {
    while (this.inflight !== null) {
      // eslint-disable-next-line no-await-in-loop
      await this.inflight.then(() => undefined, () => undefined);
    }
    const p = job();
    this.inflight = p;
    try {
      return await p;
    } finally {
      if (this.inflight === p) this.inflight = null;
    }
  }

  /**
   * Open `url` into `video`, starting at `at` seconds.
   *
   * `keepSubtitles` is for a soundtrack change: the same film at the same
   * second, so the subtitle lines already collected stay where they are.
   */
  async open(video: HTMLVideoElement, at: number, keepSubtitles = false): Promise<boolean> {
    this.close(keepSubtitles);
    this.closed = false;
    this.video = video;
    const mine = ++this.epoch;

    let makeRemuxer: typeof import('./libavRemux.ts').makeRemuxer;
    let libav: LibAV;
    try {
      ({ makeRemuxer } = await import('./libavRemux.ts'));
      libav = await createLibav(window.location.origin);
    } catch (e) {
      this.opts.onImpossible(`the player could not be loaded — ${String((e as Error)?.message ?? e)}`);
      return false;
    }
    if (this.epoch !== mine || this.closed) { void Promise.resolve(libav.terminate?.()).catch(() => undefined); return false; }

    /* A reopen for another soundtrack already knows how long the film is; asking
       again would be a second connection to learn nothing. */
    const length = this.length > 0 ? this.length : await this.measure();
    this.length = length;
    const letGo = (): void => { void Promise.resolve(libav.terminate?.()).catch(() => undefined); };
    if (length <= 0) {
      /* A door that REFUSED has already said so and the player is moving; this
         is only for a door that answered and still told us nothing. */
      if (this.refused === 0) this.opts.onImpossible('the line would not say how long the film is');
      letGo();
      return false;
    }
    if (this.epoch !== mine || this.closed) { letGo(); return false; }

    try {
      this.remuxer = await makeRemuxer({
        libav,
        length,
        bufferSize: READ_BYTES,
        read: (offset: number, size: number) => this.read(offset, size),
        ...(this.audioIndex === undefined ? {} : { audioStreamIndex: this.audioIndex }),
      });
    } catch (e) {
      this.opts.onImpossible(`this film could not be opened — ${String((e as Error)?.message ?? e)}`);
      letGo();
      return false;
    }
    if (this.epoch !== mine || this.closed) { void this.remuxer?.destroy(); return false; }

    let init: Awaited<ReturnType<Remuxer['init']>>;
    try {
      const remuxer = this.remuxer;
      init = await this.turn(() => remuxer.init());
    } catch (e) {
      /* `init` is where a picture no browser decodes is refused, by name. It
         is the honest end of the road rather than a failure to try. */
      this.opts.onImpossible(String((e as Error)?.message ?? e));
      void Promise.resolve(this.remuxer?.destroy()).catch(() => undefined);
      return false;
    }
    if (this.epoch !== mine || this.closed) return false;

    const codecs = [init.info.output.videoMimeType, init.info.output.audioMimeType]
      .filter((c): c is string => typeof c === 'string' && c !== '')
      .join(',');
    const mime = `video/mp4; codecs="${codecs}"`;
    if (!MediaSource.isTypeSupported(mime)) {
      this.opts.onImpossible(`this browser will not play ${codecs}`);
      return false;
    }
    this.opts.note(`taking the film apart here: ${codecs}`);

    /*
     * Whichever of the two is a length, not whichever is defined.
     *
     * `??` was wrong here and cost an evening: the remuxer reports
     * `output.duration` as **0** — the mp4 muxer does not know how long a
     * fragmented stream will be until it ends — while `input.duration` carries
     * the container's real 1800. Zero is not null, so `??` took it, the
     * snapshot got no length, the seek bar has nothing to draw without one,
     * and a film played with no way to move inside it at all.
     */
    const duration = Math.max(init.info.output.duration ?? 0, init.info.input?.duration ?? 0);
    if (duration > 0) this.opts.onDuration(duration);
    else this.opts.note('the file does not say how long it is', 'warn');
    this.audio = (init.audioStreams ?? []).map((a) => ({
      index: a.streamIndex, language: a.language ?? '', title: a.title ?? '',
    }));
    if (!keepSubtitles) {
      this.addSubtitleTracks(video, (init.subtitles ?? []).map((s, i) => ({
        index: s.streamIndex ?? i, language: s.language ?? '', title: s.title ?? '',
      })));
    }
    this.announceTracks();

    this.scales = trackTimescales(init.data);
    this.shift = 0;

    const ms = new MediaSource();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    video.src = this.objectUrl;
    await new Promise<void>((done) => {
      ms.addEventListener('sourceopen', () => done(), { once: true });
    });
    if (this.epoch !== mine || this.closed) return false;
    if (this.objectUrl !== '') { URL.revokeObjectURL(this.objectUrl); this.objectUrl = ''; }
    if (duration > 0) {
      try { ms.duration = duration; } catch { /* set again on the first append */ }
    }

    try {
      this.sb = ms.addSourceBuffer(mime);
    } catch (e) {
      this.opts.onImpossible(`the buffer refused ${codecs} — ${String((e as Error)?.message ?? e)}`);
      return false;
    }
    await this.append(init.data, mine);
    if (at > 0) await this.seek(at);
    void this.pump(mine);
    return true;
  }

  /** Put the playhead at `t` and carry on reading from there. */
  async seek(t: number): Promise<void> {
    const v = this.video;
    if (v === null || this.remuxer === null || this.closed) return;
    /* Already here: a property assignment and nothing else, which is the whole
       point of holding the bytes. A move that does its work twice plays a
       quarter-second of film again. */
    if (holds(this.ranges, t)) { v.currentTime = t; return; }
    const mine = ++this.epoch;
    v.currentTime = t;
    let first: Chunk | null | typeof STALE;
    let waiting = true;
    this.seeksWaiting += 1;
    try {
      first = await this.turn(async () => {
        waiting = false;
        this.seeksWaiting -= 1;
        /* Overtaken while it waited: a newer seek is behind it, and that one
           is where the viewer is. */
        if (this.epoch !== mine || this.closed || this.remuxer === null) return STALE;
        return this.remuxer.seek(t);
      });
    } catch (e) {
      /*
       * A drag makes one of these per step and each cancels the one before it,
       * so "Cancelled" is the feature working. Fourteen of them in one drag,
       * measured. It is not something to put in front of a viewer.
       */
      const why = String((e as Error)?.message ?? e);
      if (/cancel/i.test(why)) return;
      this.opts.note(`could not move to ${Math.round(t)}s — ${why}`, 'warn');
      return;
    } finally {
      if (waiting) this.seeksWaiting -= 1;
    }
    if (first === STALE || this.epoch !== mine || this.closed) return;
    /*
     * `seek` RETURNS the first piece of the new pass. Throwing it away threw
     * away the one piece that says where the new pass begins, and with it the
     * keyframe the viewer just asked for.
     */
    if (first !== null) this.takeSubtitles(first.subtitles);
    if (first !== null && first.finished !== true) {
      await this.realign(first, t);
      if (this.epoch !== mine || this.closed) return;
      await this.append(first.data, mine);
    }
    void this.pump(mine);
  }

  /**
   * Put the muxer's clock back onto the film's, for everything appended next.
   *
   * See `mp4Time.ts` for the measurement: the remuxer's output time runs
   * CONTIGUOUSLY across a seek while the film's does not, so film-second 1140
   * arrived as output-second 40 and was written over the film's opening. One
   * subtraction per seek fixes it, and it is zero whenever the two clocks
   * already agree.
   */
  private async realign(chunk: Chunk, asked: number): Promise<void> {
    const sb = this.sb;
    if (sb === null) return;
    await this.idle();
    const found = fragmentStart(chunk.data, this.scales);
    if (found === null) {
      this.opts.note('a piece of the film did not say where it belongs', 'warn');
      return;
    }
    this.scales = found.scales;
    const film = Number.isFinite(chunk.pts) ? chunk.pts : asked;
    const shift = film - found.seconds;
    if (Math.abs(shift - this.shift) < 0.001) return;
    try {
      sb.timestampOffset = shift;
      this.shift = shift;
    } catch (e) {
      this.opts.note(`could not move to ${Math.round(asked)}s — ${String((e as Error)?.message ?? e)}`, 'warn');
    }
  }

  /**
   * Wait for the buffer to finish whatever it is doing.
   *
   * Two things can want it at once — the loop that was reading before a seek,
   * and the seek's own first piece — and `appendBuffer` on a busy buffer
   * throws. It also matters that a piece from the old pass lands BEFORE the
   * clock is shifted, or it lands in the new pass's place.
   */
  private async idle(): Promise<void> {
    const sb = this.sb;
    if (sb === null) return;
    for (let i = 0; i < 100 && sb.updating; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((done) => {
        sb.addEventListener('updateend', () => done(), { once: true });
      });
    }
  }

  /** Read fragments for as long as the playhead needs them. */
  private async pump(mine: number): Promise<void> {
    /*
     * One reader at a time — and the one that arrives while another is running
     * must not simply give up.
     *
     * That was the bug a seek died of. `seek` bumps the epoch and calls this;
     * the loop already running is mid-`read`, so this returned at once; and
     * when the old loop finally noticed its epoch had moved it returned too.
     * Nobody was left reading. Measured: dropped at 1116s with `readyState 1`
     * and the buffer still holding only what it had before the drag.
     *
     * So a caller that finds the door shut leaves its epoch on the handle, and
     * the loop on its way out reads it.
     */
    if (this.reading) { this.wanted = mine; return; }
    this.reading = true;
    try {
      for (;;) {
        if (this.epoch !== mine || this.closed || this.ms === null) return;
        const v = this.video;
        if (v === null) return;
        /* Never faster than it is watched: without this, opening a film pulls
           the whole film at line speed for one viewer. */
        if (aheadOf(this.ranges, v.currentTime) > FORWARD_S) {
          await sleep(500);
          continue;
        }
        let chunk: Chunk | null | typeof STALE;
        try {
          chunk = await this.turn(async () => {
            /* A seek got in first; its pass, not this one, is what to read. */
            if (this.epoch !== mine || this.closed || this.remuxer === null) return STALE;
            return this.remuxer.read();
          });
        } catch (e) {
          const why = String((e as Error)?.message ?? e);
          if (!/cancel/i.test(why)) this.opts.note(`the read stopped — ${why}`, 'warn');
          return;
        }
        if (chunk === STALE || this.epoch !== mine || this.closed) return;
        if (chunk !== null) this.takeSubtitles(chunk.subtitles);
        /* The first fragment of a pass says where in the film its clock starts.
           A seek lines it up itself; this is the pass that opened the film. */
        if (chunk !== null && chunk.restart === true && chunk.finished !== true) {
          await this.realign(chunk, v.currentTime);
          if (this.epoch !== mine || this.closed) return;
        }
        if (chunk === null || chunk.finished === true) {
          if (this.ms.readyState === 'open' && this.sb !== null && !this.sb.updating) {
            try { this.ms.endOfStream(); } catch { /* raced with a seek */ }
          }
          return;
        }
        await this.append(chunk.data, mine);
      }
    } finally {
      this.reading = false;
      /* Somebody asked while this was busy, and what they asked for is still
         current. Theirs is the loop that should be running. */
      const next = this.wanted;
      this.wanted = 0;
      if (next !== 0 && next === this.epoch && !this.closed) void this.pump(next);
    }
  }

  /** Hand one piece to the buffer, making room for it if the browser asks. */
  private async append(data: ArrayBuffer | Uint8Array, mine: number): Promise<void> {
    const sb = this.sb;
    if (sb === null || this.ms === null || this.ms.readyState !== 'open') return;
    if (this.epoch !== mine || this.closed) return;
    await this.idle();
    if (this.epoch !== mine || this.closed) return;
    if (this.ms === null || this.ms.readyState !== 'open') return;
    /*
     * `Uint8Array<ArrayBufferLike>` rather than `Uint8Array<ArrayBuffer>`: the
     * library's chunks are typed loosely enough to include a shared buffer,
     * which `appendBuffer` will not take. A view onto a plain ArrayBuffer is
     * what it wants, and the one case where a copy is actually needed — a
     * shared buffer — is the one this makes. Nothing is copied otherwise.
     */
    const bytes: BufferSource = data instanceof Uint8Array
      ? (data.buffer instanceof ArrayBuffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data))
      : new Uint8Array(data);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await new Promise<void>((done, fail) => {
          sb.addEventListener('updateend', () => done(), { once: true });
          sb.addEventListener('error', () => fail(new Error('the buffer refused it')), { once: true });
          sb.appendBuffer(bytes);
        });
        this.publish();
        return;
      } catch (e) {
        const quota = (e as Error)?.name === 'QuotaExceededError'
          || String((e as Error)?.message ?? '').includes('quota');
        if (!quota || attempt === 1) {
          this.opts.note(`the buffer refused a piece — ${String((e as Error)?.message ?? e)}`, 'warn');
          return;
        }
        this.evict();
        await sleep(60);
      }
    }
  }

  /** Drop what is far from the playhead so more can be held near it. */
  private evict(): void {
    const sb = this.sb;
    const v = this.video;
    if (sb === null || v === null || sb.updating) return;
    for (const span of this.ranges) {
      const far = span.end < v.currentTime - BACK_S || span.start > v.currentTime + FORWARD_S * 4;
      if (!far) continue;
      try { sb.remove(span.start, span.end); } catch { /* raced with an append */ }
      return;
    }
  }

  private publish(): void {
    const sb = this.sb;
    if (sb === null) return;
    const spans: Span[] = [];
    try {
      for (let i = 0; i < sb.buffered.length; i += 1) {
        spans.push({ start: sb.buffered.start(i), end: sb.buffered.end(i) });
      }
    } catch { return; }
    this.ranges = spans;
    this.opts.onRanges(spans);
  }

  /** The film's soundtracks and text subtitles, for the AUDIO and SUBTITLES menus. */
  get tracks(): DeviceTracks {
    return {
      audio: this.audio,
      audioIndex: this.audioIndex ?? this.audio[0]?.index ?? null,
      subtitles: [...this.subs.values()].map((s) => s.info),
      subtitleIndex: this.subtitleIndex,
    };
  }

  /**
   * Play another of the film's soundtracks, from where the viewer is.
   *
   * A new remuxer at the same second (see `audioIndex`), with the element
   * keeping whether it was playing. The subtitles collected so far stay.
   */
  async setAudio(index: number): Promise<void> {
    const v = this.video;
    if (v === null || this.closed) return;
    if (!this.audio.some((a) => a.index === index)) return;
    if (index === (this.audioIndex ?? this.audio[0]?.index)) return;
    const at = v.currentTime;
    const playing = !v.paused;
    this.audioIndex = index;
    this.opts.note(`soundtrack ${index}: reopening at ${Math.round(at)}s`);
    const ok = await this.open(v, at, true);
    if (!ok || this.video !== v) return;
    /* A new source is a new resource for the element, and the subtitle shown
       before it is put back rather than trusted to have survived. */
    this.showSubtitle(this.subtitleIndex);
    if (playing) void v.play().catch(() => undefined);
  }

  /** Show one of the film's subtitle tracks, or none. */
  showSubtitle(index: number | null): void {
    this.subtitleIndex = index !== null && this.subs.has(index) ? index : null;
    for (const [i, s] of this.subs) {
      s.el.track.mode = i === this.subtitleIndex ? 'showing' : 'hidden';
    }
    this.announceTracks();
  }

  private announceTracks(): void {
    this.opts.onTracks(this.tracks);
  }

  private addSubtitleTracks(video: HTMLVideoElement, list: DeviceTrack[]): void {
    this.dropSubtitleTracks();
    for (const info of list) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = info.title !== '' ? info.title : info.language;
      const lang = trackLang(info.language);
      if (lang !== '') el.srclang = lang;
      el.dataset['deviceSub'] = String(info.index);
      const url = URL.createObjectURL(new Blob(['WEBVTT\n\n'], { type: 'text/vtt' }));
      el.src = url;
      const entry = { info, el, url, ready: false, pending: [] as FilmDialogue[], seen: new Set<string>() };
      const settle = (): void => {
        if (entry.ready) return;
        entry.ready = true;
        const waiting = entry.pending;
        entry.pending = [];
        for (const d of waiting) this.addCue(entry, d);
      };
      el.addEventListener('load', settle, { once: true });
      el.addEventListener('error', settle, { once: true });
      video.appendChild(el);
      el.track.mode = 'hidden';
      this.subs.set(info.index, entry);
    }
    if (list.length > 0) this.opts.note(`${list.length} subtitle track(s) in the file`);
  }

  private takeSubtitles(lines: FilmDialogue[] | undefined): void {
    if (lines === undefined || lines.length === 0) return;
    for (const d of lines) {
      const entry = this.subs.get(d.streamIndex);
      if (entry === undefined) continue;
      if (entry.ready) this.addCue(entry, d);
      else entry.pending.push(d);
    }
  }

  private addCue(
    entry: { el: HTMLTrackElement; seen: Set<string> },
    d: FilmDialogue,
  ): void {
    const key = dialogueKey(d);
    if (entry.seen.has(key)) return;
    entry.seen.add(key);
    const text = cueText(d.content, d.fields);
    if (text === '' || !(d.end > d.start)) return;
    try {
      entry.el.track.addCue(new VTTCue(d.start / 1000, d.end / 1000, text));
    } catch { /* a cue the browser will not take is a line not shown, nothing worse */ }
  }

  private dropSubtitleTracks(): void {
    for (const s of this.subs.values()) {
      s.el.remove();
      URL.revokeObjectURL(s.url);
    }
    this.subs.clear();
    this.subtitleIndex = null;
  }

  /** Give the bytes back and let go of the element. */
  close(keepSubtitles = false): void {
    if (!keepSubtitles) this.dropSubtitleTracks();
    this.closed = true;
    this.epoch += 1;
    this.inflight = null;
    this.seeksWaiting = 0;
    const r = this.remuxer;
    this.remuxer = null;
    if (r !== null) { void Promise.resolve(r.destroy()).catch(() => undefined); }
    if (this.objectUrl !== '') { URL.revokeObjectURL(this.objectUrl); this.objectUrl = ''; }
    const ms = this.ms;
    this.ms = null;
    this.sb = null;
    this.video = null;
    this.ranges = [];
    if (ms !== null && ms.readyState === 'open') {
      try { ms.endOfStream(); } catch { /* already gone */ }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** What a remuxer call returns when it was overtaken before it ran. */
const STALE = Symbol('stale');
