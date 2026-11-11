/**
 * Live captions for whatever is playing.
 *
 * A great deal of IPTV content carries no subtitle track at all, and live channels
 * essentially never do. So the audio is transcribed as it plays — and optionally
 * translated — by streaming it to Soniox's realtime endpoint.
 *
 * Two taps, because they have opposite speaker requirements.
 *
 * `captureStream()` COPIES audio and leaves the element playing. Prefer that.
 * `createMediaElementSource()` steals the soundtrack and can starve live
 * playback, so it is only used when capture is unavailable.
 *
 * The temporary key is minted by our API (which proxies translive-api on this
 * box); the PCM goes browser-to-Soniox directly, because a relay hop cannot help
 * something that has to keep pace with real time.
 */

import { shouldCommitCaption } from './captionLayout';
import { audioRoute } from './captionAudio';
import { dlog } from './debugLog';
import { canListenNatively, listenNatively, type Listening } from './nativeListen';
import { player } from './playerCore';
import { apiUrl } from './api';
import { getPrefs, setPrefs } from './prefs';
import { kv } from './kv.ts';

/**
 * The PCM worklet, resolved against the app's base rather than the domain root.
 *
 * It lives in `public/`, so Vite copies it verbatim to the base URL — which means
 * `new URL(..., import.meta.url)` is the wrong tool (that is for bundled assets).
 * A root-absolute `'/pcm16-capture.worklet.js'` is correct only when the app is
 * served from a domain root: under `VITE_BASE=./` it must be relative, and under
 * `file://` a leading slash resolves to the filesystem root.
 *
 * `import.meta.env` is undefined under plain Node, hence the optional chain — the
 * same reason `apiUrl()` reads it that way.
 */
const WORKLET_URL = `${(import.meta.env?.BASE_URL as string | undefined) ?? '/'}pcm16-capture.worklet.js`;

export interface CaptionLine {
  id: number;
  /** Transcript in the spoken language. */
  orig: string;
  /** Translation, when a target language is set. */
  trans: string;
  final: boolean;
  speaker: string | null;
  lang: string | null;
}

export type CaptionPhase = 'off' | 'starting' | 'live' | 'error';

export interface CaptionState {
  phase: CaptionPhase;
  lines: CaptionLine[];
  /** Target language for translation (`off` = transcript only). */
  target: string;
  source: string;
  error: string | null;
  model: string | null;
  /** Which capture route was used; `element` is the one that can cost buffer. */
  tap: TapKind | null;
  /**
   * The page cannot hear this stream, but it could if it were playing it.
   *
   * Set only when switching THIS channel to the browser engine is a thing that
   * would actually help — so the panel can put a button under the message
   * instead of naming a Settings screen and hoping.
   */
  offer: boolean;
  /** Show the spoken-language line under the translation. Off by default. */
  showOriginal: boolean;
  /** The spoken-language stream, for the transcript sheet and `showOriginal`. */
  spokenLines: CaptionLine[];
}

export const CAPTION_LANGS: { id: string; label: string }[] = [
  { id: 'off', label: 'Transcribe only' },
  { id: 'en', label: 'English' },
  { id: 'ar', label: 'Arabic' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'nl', label: 'Dutch' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'it', label: 'Italian' },
  { id: 'tr', label: 'Turkish' },
  { id: 'ru', label: 'Russian' },
  { id: 'hi', label: 'Hindi' },
  { id: 'ur', label: 'Urdu' },
  { id: 'zh', label: 'Chinese' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
];

export const CAPTION_SOURCES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto-detect' },
  ...CAPTION_LANGS.filter((l) => l.id !== 'off'),
];

const MAX_LINES = 60;
/** Connection attempts in a row before captions give up and say so. */
const MAX_CONNECT_TRIES = 5;

/** One segmented line stream: committed lines, the line in progress, its tail. */
interface Stream {
  committed: CaptionLine[];
  active: CaptionLine | null;
  partial: string;
}

function emptyStream(): Stream {
  return { committed: [], active: null, partial: '' };
}

/** Committed sentences, then the line in progress with its unstable tail attached. */
function visible(s: Stream): CaptionLine[] {
  const out = [...s.committed];
  const orig = (s.active?.orig ?? '') + s.partial;
  if (orig.trim() !== '') {
    out.push({
      id: s.active?.id ?? -1,
      orig,
      trans: '',
      final: false,
      speaker: s.active?.speaker ?? null,
      lang: s.active?.lang ?? null,
    });
  }
  return out;
}

type Listener = (s: CaptionState) => void;

/** How the audio was obtained, for the diagnostics line. */
export type TapKind = 'capture' | 'element' | 'native';


/**
 * `createMediaElementSource` may only be called once per element — a second call
 * throws — so that node is remembered. Capture taps are rebuilt: a MediaSource
 * reset (channel change, stall jumper, reconnect) ends the old audio tracks.
 */
interface Tap {
  ctx: AudioContext;
  node: AudioNode;
  kind: TapKind;
  stream?: MediaStream;
}
const taps = new WeakMap<HTMLMediaElement, Tap>();

interface Capturable extends HTMLMediaElement {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
}

function liveAudio(stream: MediaStream): MediaStreamTrack[] {
  return stream.getAudioTracks().filter((t) => t.readyState === 'live');
}

/** Wait until the element actually has audio to hand over. */
async function ready(video: HTMLMediaElement): Promise<void> {
  if (video.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener('loadeddata', done);
      resolve();
    };
    video.addEventListener('loadeddata', done);
    window.setTimeout(done, 4000);
  });
}

async function waitLiveAudio(
  el: HTMLMediaElement,
  stream: MediaStream,
  alive: () => boolean,
): Promise<MediaStreamTrack[]> {
  const have = liveAudio(stream);
  if (have.length > 0) return have;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const fail = (e: Error) => {
      cleanup();
      reject(e);
    };
    const check = () => {
      if (!alive()) {
        fail(new Error('cancelled'));
        return;
      }
      const tracks = liveAudio(stream);
      if (tracks.length > 0) {
        cleanup();
        resolve(tracks);
        return;
      }
      if (Date.now() - started > 20_000) {
        fail(new Error('This stream has no audio to transcribe.'));
      }
    };
    const onAdd = (e: MediaStreamTrackEvent) => {
      if (e.track.kind === 'audio') check();
    };
    stream.addEventListener('addtrack', onAdd);
    el.addEventListener('playing', check);
    el.addEventListener('loadeddata', check);
    const poll = window.setInterval(check, 300);
    const cleanup = () => {
      stream.removeEventListener('addtrack', onAdd);
      el.removeEventListener('playing', check);
      el.removeEventListener('loadeddata', check);
      window.clearInterval(poll);
    };
    check();
  });
}

async function tap(el: HTMLMediaElement, alive: () => boolean): Promise<Tap> {
  const existing = taps.get(el);
  if (existing?.kind === 'element') {
    if (existing.ctx.state === 'suspended') await existing.ctx.resume().catch(() => {});
    return existing;
  }
  await ready(el);
  const ctx = existing?.ctx ?? new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  const media = el as Capturable;
  const capture = media.captureStream ?? media.mozCaptureStream;
  if (capture) {
    const stream = capture.call(media);
    const tracks = await waitLiveAudio(el, stream, alive);
    if (existing?.kind === 'capture') {
      try { existing.node.disconnect(); } catch { /* replaced */ }
    }
    const t: Tap = {
      ctx,
      node: ctx.createMediaStreamSource(new MediaStream(tracks)),
      kind: 'capture',
      stream,
    };
    taps.set(el, t);
    return t;
  }

  const src = ctx.createMediaElementSource(el);
  src.connect(ctx.destination);
  const t: Tap = { ctx, node: src, kind: 'element' };
  taps.set(el, t);
  return t;
}

/**
 * Can this browser COPY the element's audio, or only steal it?
 *
 * `captureStream()` is not part of the stable WebView surface, and the fallback
 * (`createMediaElementSource`) reroutes the soundtrack through the audio graph,
 * whose buffering starves a stream sitting near the live edge. Callers use this to
 * warn up front instead of letting someone discover it as stuttering.
 */
export function captureSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('video') as HTMLVideoElement & {
    captureStream?: unknown;
    mozCaptureStream?: unknown;
  };
  return typeof (probe.captureStream ?? probe.mozCaptureStream) === 'function';
}

/**
 * The PCM pump: the player's audio, converted to what Soniox wants.
 *
 * An `AudioWorklet` is the right tool — it converts on the audio thread and never
 * competes with rendering — but `ctx.audioWorklet` exists only in a SECURE
 * context, and this app is routinely opened on a television by its plain address,
 * `http://<ip>:7500`. Measured there on 2026-09-15: everything else survives (an
 * AudioContext opens, `captureStream()` is a function, the key endpoint answers
 * 200) and `audioWorklet` alone is `undefined`, so captions died on the first
 * line of `openAudio` with nothing to show the viewer.
 *
 * So the same resampler is kept twice. `ScriptProcessorNode` is deprecated and
 * runs on the main thread, which for 16 kHz mono is of no consequence, and it is
 * available on any origin. Secure pages — the APK (`https://localhost`) and the
 * public site — keep the worklet.
 */
interface PcmSource {
  /** Connect the tap into this. */
  node: AudioNode;
  /** Stop delivering and leave the graph. */
  close: () => void;
}

/** 100 ms at 16 kHz — the chunk the socket is fed. */
const PCM_CHUNK = 1600;

async function pcmSource(ctx: AudioContext, send: (pcm: ArrayBuffer) => void): Promise<PcmSource> {
  // Typed as always-present by lib.dom, absent in fact on an insecure origin.
  const worklet = (ctx as { audioWorklet?: AudioWorklet }).audioWorklet;
  if (!worklet) return scriptPcmSource(ctx, send);
  await worklet.addModule(WORKLET_URL);
  const node = new AudioWorkletNode(ctx, 'pcm16-capture');
  node.port.onmessage = (e: MessageEvent) => send(e.data as ArrayBuffer);
  return {
    node,
    close: () => {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

/** The worklet's resampler, in the main thread, for origins without a worklet. */
function scriptPcmSource(ctx: AudioContext, send: (pcm: ArrayBuffer) => void): PcmSource {
  const node = ctx.createScriptProcessor(4096, 1, 1);
  // A ScriptProcessorNode only runs while it reaches the destination. The sound is
  // already being heard (the element plays it, or the element tap is wired to the
  // destination itself), so this branch drains into silence rather than doubling it.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);

  const out = new Int16Array(PCM_CHUNK);
  let outLen = 0;
  let inBuf = new Float32Array(0);
  let pos = 0;
  const step = ctx.sampleRate / 16000;

  node.onaudioprocess = (e: AudioProcessingEvent) => {
    const ch = e.inputBuffer.getChannelData(0);
    const merged = new Float32Array(inBuf.length + ch.length);
    merged.set(inBuf);
    merged.set(ch, inBuf.length);
    inBuf = merged;

    while (pos + 1 < inBuf.length) {
      const i = Math.floor(pos);
      const f = pos - i;
      let sample = (inBuf[i] ?? 0) * (1 - f) + (inBuf[i + 1] ?? 0) * f;
      sample = Math.max(-1, Math.min(1, sample));
      out[outLen++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      pos += step;
      if (outLen === PCM_CHUNK) {
        send(out.slice(0).buffer);
        outLen = 0;
      }
    }
    const keep = Math.floor(pos);
    if (keep > 0) {
      inBuf = inBuf.slice(keep);
      pos -= keep;
    }
  };

  return {
    node,
    close: () => {
      node.onaudioprocess = null;
      try {
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

export class LiveCaptions {
  private ws: WebSocket | null = null;
  private pcm: PcmSource | null = null;
  private listeners = new Set<Listener>();
  private nextId = 1;
  /**
   * Transcript and translation are kept as two INDEPENDENT streams.
   *
   * The first version tried to align them — hold a queue of committed transcript
   * lines and feed each arriving translation token to the oldest one still owed
   * text. It cannot work: Soniox segments the translation on its own boundaries,
   * with its own lag, so the two never line up. What it produced was exactly what
   * was reported — a line appearing in the spoken language and then being replaced
   * by a translation ("first shows separate then combines"), several sentences'
   * translations merged into one line, and the original leaking through even with
   * "show the spoken line" switched off, because a line with no translation yet
   * fell back to its own text.
   *
   * Two streams, each segmented by its own tokens, need no alignment and cannot
   * merge or swap. The display simply reads whichever one the target language asks
   * for.
   */
  private spoken: Stream = emptyStream();
  private translated: Stream = emptyStream();
  private reconnects = 0;
  private stopped = true;
  /** Invalidates an in-flight start() when a newer start/stop wins. */
  private gen = 0;
  private video: HTMLVideoElement | null = null;
  private unhook: (() => void) | null = null;
  private reconnectTimer = 0;
  private opening = false;
  private stalled = false;
  /** Captions were on when the player tore down; restart on the next load. */
  private resumeAfterLoad = false;
  /*
   * Which stream the automatic engine switch has already been spent on.
   *
   * Turning captions on IS the consent to move the sound somewhere the page can
   * hear it — "just do it auto, if they dont want it just prompt them" — so the
   * offer is taken rather than shown. But exactly once per channel: if the
   * browser engine cannot play it either, the second attempt would switch,
   * fail, switch again, and the picture would never settle.
   */
  private switchedFor: string | null = null;
  /**
   * The device recording its own sound, while it is doing so.
   *
   * Released by `halt()` like the element tap, because it is the same thing in a
   * different place — and leaving it running would leave the notification up and
   * the microphone permission in use with nothing listening.
   */
  private native: Listening | null = null;


  private state: CaptionState = (() => {
    const c = getPrefs().captions;
    return {
      phase: 'off', lines: [], target: c.target, source: c.source, error: null, model: null,
      tap: null, showOriginal: c.showOriginal, spokenLines: [], offer: false,
    };
  })();

  /**
   * Keep captions on across channel changes.
   *
   * The player stays mounted on Live, so unmount never runs. Starting as soon as
   * `loadId` flipped used to attach to a video that was still tearing down — the
   * tap failed, phase went to error/off, and the next channel had no captions.
   * Stop on the switch; start again only once the new stream is actually playing.
   */
  watchStreamChanges(): void {
    let lastLoad = player.state.loadId;
    let lastPhase = player.state.phase;
    player.subscribe((p) => {
      if (p.loadId !== lastLoad) {
        lastLoad = p.loadId;
        lastPhase = p.phase;
        const keep =
          this.resumeAfterLoad
          || this.state.phase === 'live'
          || this.state.phase === 'starting';
        this.wipe();
        if (!keep) return;
        this.resumeAfterLoad = true;
        void this.halt();
        return;
      }
      if (p.phase === lastPhase) return;
      lastPhase = p.phase;
      if (!this.resumeAfterLoad) return;
      if (p.phase !== 'playing' && p.phase !== 'paused') return;
      this.resumeAfterLoad = false;
      const el = player.element;
      if (el) void this.start(el, this.state.target, this.state.source);
    });
  }

  private wipe(): void {
    this.spoken = emptyStream();
    this.translated = emptyStream();
    if (this.state.phase !== 'off') this.emit({ lines: [], spokenLines: [] });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  get snapshot(): CaptionState {
    return this.state;
  }

  private emit(p: Partial<CaptionState>): void {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Remember a language choice while stopped, so starting uses it. */
  configure(patch: { target?: string; source?: string }): void {
    this.emit(patch);
    const cur = getPrefs().captions;
    setPrefs({
      captions: {
        ...cur,
        ...(patch.target !== undefined ? { target: patch.target } : {}),
        ...(patch.source !== undefined ? { source: patch.source } : {}),
      },
    });
  }

  setShowOriginal(on: boolean): void {
    setPrefs({ captions: { ...getPrefs().captions, showOriginal: on } });
    this.emit({ showOriginal: on });
  }

  async start(video: HTMLVideoElement, target: string, source: string): Promise<void> {
    await this.halt();
    const mine = ++this.gen;
    this.stopped = false;
    this.reconnects = 0;
    this.video = video;
    this.spoken = emptyStream();
    this.translated = emptyStream();
    this.emit({ phase: 'starting', target, source, error: null, lines: [], spokenLines: [] });

    /*
     * ── when there is no sound in the ELEMENT ──
     *
     * Live captions work by tapping the `<video>`'s audio. When libVLC or a
     * television's own player owns the picture, the sound comes out of a native
     * surface behind the page and the element is empty — so tapping it would
     * open a socket, send silence, and transcribe nothing for ever behind a
     * spinner. This used to say so and stop:
     *
     *     This channel is playing on the television's own video engine, which
     *     the captions cannot listen to.
     *
     * Honest, and useless — `chooseEngine` routes every raw MPEG-TS to the
     * native engine on purpose, and every live channel on this line is a raw
     * MPEG-TS, so that message WAS live television.
     *
     * What it could not do is fetch the sound instead: `max_connections` is 1,
     * so a second connection is refused and on some panels takes the viewer's
     * own picture down to make room. What it must not do is have our server lift
     * the sound out of the stream — that was built, and taken out again, because
     * it charges the operator for every viewer-hour of captions.
     *
     * So the page has to be the one playing it, and the answer is an OFFER. See
     * `lib/captionAudio.ts`.
     */
    /*
     * Asked, not assumed: it is Android 10 and newer only, an APK built before
     * the plugin existed is still a perfectly good native build, and the website
     * has no plugin at all. Only asked when the element IS silent, so the
     * ordinary path costs nothing.
     */
    const silent = silentElement(video);
    /*
     * Asking must never be able to hang the spinner.
     *
     * This await used to sit outside the try below, so when `canListenNatively`
     * rejected — which it did on EVERY android device, see `nativeListen.ts` —
     * the throw left `start()` altogether. Nothing set the phase to `error`,
     * nothing fell back to the offer, and `starting` was simply where the
     * engine stopped: "the live caption keeps loading and doesn't work".
     *
     * A device that cannot answer the question is a device that cannot listen
     * to itself, which is what `false` means here, and the offer below is
     * exactly the path built for it.
     */
    let nativeAudio = false;
    if (silent) {
      try {
        nativeAudio = await canListenNatively();
      } catch (e) {
        dlog.info('captions', `native listening could not be asked about — ${describe(e)}`);
      }
    }
    if (this.gen !== mine || this.stopped) return;
    let route = audioRoute({ silent, pinned: player.onBrowserEngine, nativeAudio });

    if (route === 'native') {
      const got = await listenNatively(
        (pcm) => {
          const ws = this.ws;
          if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(pcm);
        },
        () => {
          /* The recorder stopped on its own — the viewer revoked the permission,
             or Android took the projection back. Say so rather than sitting
             behind a spinner that will never fill. */
          if (this.stopped) return;
          this.emit({
            phase: 'error',
            error: 'The television stopped letting the app listen to itself.',
            offer: true,
            lines: [], spokenLines: [],
          });
        },
        () => {
          /* Frames arrived and every one of them was silence. Hand back to the
             offer, which needs no permission and cannot fail this way. */
          if (this.stopped) return;
          void this.halt();
          this.emit({
            phase: 'error',
            error: 'The app could listen to itself, but heard only silence \u2014 this '
                 + 'television does not let its video engine be recorded. Playing '
                 + 'this channel in the browser engine instead puts the sound where '
                 + 'the captions can hear it.',
            offer: true,
            lines: [], spokenLines: [],
          });
        },
      );
      if (this.gen !== mine || this.stopped) {
        if (got.ok) void got.handle.stop();
        return;
      }
      if (got.ok) {
        this.native = got.handle;
        this.emit({ tap: 'native' });
      } else {
        /* Declined, or a device that would not. Fall back to the thing that
           needs no permission at all. `why` is kept: "declined" is a decision
           and deserves different words from "this device would not". */
        dlog.info('captions', `native listening not used — ${got.why}`);
        route = audioRoute({ silent, pinned: player.onBrowserEngine, nativeAudio: false });
      }
    }

    /*
     * Nothing in this branch reloads anything. The picture is the viewer's, and
     * the only thing that can move it to the other engine is the viewer asking —
     * `useBrowserEngine()` below, wired to the button the panel shows when
     * `offer` is set.
     */
    if (route === 'offer' || route === 'refuse') {
      /*
       * Taken, not offered — the first time, for this channel.
       *
       * The button was the honest thing to build when it was unclear whether
       * moving the picture was wanted. It is not what a viewer wants: they
       * pressed ON for captions, and were answered with a paragraph and a
       * second button to find with a remote. "just do it auto, if they dont
       * want it just prompt them."
       *
       * So the switch happens by itself, and the paragraph is what they get
       * only when it has already been tried and did not help — `switchedFor`
       * below, and the `refuse` route, which is what a channel that is ALREADY
       * on the browser engine and still silent resolves to.
       *
       * Once per channel, and never a loop: `useBrowserEngine` reloads the
       * picture, `watchStreamChanges` starts the engine again when it returns,
       * and without the latch that second start would find the same silence and
       * switch again.
       */
      /* `loadId` is the player's own counter for "this is a different thing
         playing now" — see `playerCore`. Exactly the grain the latch wants: a
         channel change earns a fresh attempt, a restart of the same one does
         not. */
      const here = String(player.state.loadId);
      if (route === 'offer' && this.switchedFor !== here) {
        this.switchedFor = here;
        this.emit({
          phase: 'starting',
          error: 'Moving this channel to the browser engine so the captions can hear it\u2026',
          offer: false,
          lines: [], spokenLines: [],
        });
        if (this.useBrowserEngine()) return;
        /* The player would not move it. Fall through and say so. */
      }
      this.emit({
        phase: 'error',
        error: route === 'offer'
          ? 'This channel is playing on the television\u2019s own video engine, which '
            + 'the page cannot listen to. Playing it in the browser engine instead '
            + 'puts the sound where the captions can hear it.'
          : 'This channel is already playing in the browser engine and its sound '
            + 'still never reaches the page \u2014 which means this television cannot '
            + 'play it any other way. Captions are not possible on it here.',
        offer: route === 'offer',
        lines: [], spokenLines: [],
      });
      return;
    }

    try {
      if (this.native === null) await this.openAudio(video);
      if (this.gen !== mine || this.stopped) return;
      this.hook(video);
      try {
        await this.connect();
      } catch {
        if (this.gen !== mine || this.stopped) return;
        this.scheduleReconnect();
      }
    } catch (e) {
      if (this.gen !== mine || this.stopped) return;
      this.emit({ phase: 'error', error: describe(e) });
      await this.halt();
    }
  }

  /**
   * Captions off.
   *
   * Split from `halt()` because they answer different questions: `halt()` is
   * "let go of the audio" and runs on every channel change, while this is "the
   * viewer does not want captions" and cancels the resume with it. The engine a
   * channel was pinned to is NOT undone here — it was the viewer's choice, it
   * survives until they make another, and undoing it would reload the picture
   * for someone who only pressed Off.
   */
  async stop(): Promise<void> {
    this.resumeAfterLoad = false;
    await this.halt();
  }

  /**
   * The viewer accepted the offer: play this one channel in the browser engine.
   *
   * The reload flips `loadId`, `watchStreamChanges` restarts the caption engine
   * once the picture is back, and by then the sound is in the element and the
   * ordinary tap works. Nothing here is automatic and nothing is remembered
   * beyond this one channel.
   */
  useBrowserEngine(): boolean {
    if (!player.playInBrowserEngine()) return false;
    this.resumeAfterLoad = true;
    this.emit({ phase: 'starting', error: null, offer: false });
    return true;
  }

  private async halt(): Promise<void> {
    this.stopped = true;
    this.gen++;
    this.unhook?.();
    this.unhook = null;
    this.video = null;
    this.stalled = false;
    this.opening = false;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
    player.setLagSlack(0);
    /* Released here rather than in `stop()`, because this runs on every channel
       change too — and a recorder left running keeps the notification up and the
       permission in use with nothing listening to it. */
    const listening = this.native;
    this.native = null;
    if (listening !== null) void listening.stop();
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      w.onmessage = null;
      // An empty text frame is Soniox's end-of-stream marker: it flushes the
      // tokens still in flight instead of losing the last sentence.
      try {
        w.send('');
      } catch {
        /* already closing */
      }
      window.setTimeout(() => {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }, 2500);
    }
    this.pcm?.close();
    this.pcm = null;
    this.spoken = emptyStream();
    this.translated = emptyStream();
    /* A halt that is part of a reload is not the captions going off — the panel
       would blink from "starting captions…" to nothing and back for every
       channel change, and for the reload that turning captions on causes. */
    if (this.state.phase !== 'off') {
      this.emit(this.resumeAfterLoad
        ? { lines: [], spokenLines: [] }
        : { phase: 'off', lines: [], spokenLines: [] });
    }
  }

  private hook(video: HTMLVideoElement): void {
    this.unhook?.();
    const onWaiting = () => {
      this.stalled = true;
    };
    const onPlaying = () => {
      void this.onPlaying(video);
    };
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    this.unhook = () => {
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
    };
  }

  private async onPlaying(video: HTMLVideoElement): Promise<void> {
    if (this.stopped) return;
    const retap = this.stalled;
    this.stalled = false;
    const t = taps.get(video);
    if (t?.ctx.state === 'suspended') await t.ctx.resume().catch(() => {});
    if (retap && this.pcm) {
      const next = await tap(video, () => !this.stopped && this.video === video);
      if (this.stopped || !this.pcm) return;
      next.node.connect(this.pcm.node);
    }
    this.reconnects = 0;
    if (!this.ws && !this.opening) void this.connect().catch(() => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.opening || this.ws) return;
    /* A service that never answers is not "starting": after a handful of tries
       (about twenty seconds) say so, instead of a spinner that never ends. */
    if (this.reconnects >= MAX_CONNECT_TRIES) {
      void this.halt();
      this.emit({
        phase: 'error',
        error: 'Live captions are not available right now. Try again in a moment.',
        lines: [], spokenLines: [],
      });
      return;
    }
    const delay = Math.min(8000, 600 * 2 ** Math.min(this.reconnects, 4));
    this.reconnects++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (!this.stopped && !this.ws) void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async openAudio(video: HTMLVideoElement): Promise<void> {
    const t = await tap(video, () => !this.stopped && this.video === video);
    player.setLagSlack(t.kind === 'element' ? 2.5 : 0);
    const pcm = await pcmSource(t.ctx, (buf) => {
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
    });
    if (this.stopped) {
      pcm.close();
      return;
    }
    t.node.connect(pcm.node);
    this.pcm = pcm;
    this.emit({ tap: t.kind });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.opening || this.ws?.readyState === WebSocket.OPEN) return;
    this.opening = true;
    try {
      const res = await fetch(apiUrl('/api/captions/session'), { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(String(body['message'] ?? `caption session failed (${res.status})`));
      const url = String(body['websocketUrl'] ?? '');
      const key = String(body['apiKey'] ?? '');
      const model = String(body['model'] ?? 'stt-rt-v5');
      if (!url || !key) throw new Error('caption service returned no key');
      if (this.stopped) return;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        let opened = false;
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          opened = true;
          this.opening = false;
          if (this.stopped) {
            try { ws.close(); } catch { /* stop() already ran */ }
            resolve();
            return;
          }
          const cfg: Record<string, unknown> = {
            api_key: key,
            model,
            audio_format: 'pcm_s16le',
            sample_rate: 16000,
            num_channels: 1,
            enable_language_identification: true,
            enable_speaker_diarization: true,
            enable_endpoint_detection: true,
            max_endpoint_delay_ms: 1500,
            endpoint_sensitivity: 0.3,
            endpoint_latency_adjustment_level: 2,
          };
          if (this.state.target !== 'off' && this.state.target !== this.state.source) {
            cfg['translation'] = { type: 'one_way', target_language: this.state.target };
          }
          if (this.state.source !== 'auto') {
            cfg['language_hints'] = [this.state.source];
            // Broadcast audio is noisy and music-heavy; without this the language
            // identifier flaps and the transcript turns to nonsense mid-sentence.
            cfg['language_hints_strict'] = true;
          }
          this.ws = ws;
          ws.send(JSON.stringify(cfg));
          this.emit({ phase: 'live', model, error: null });
          resolve();
        };
        ws.onmessage = (e) => {
          if (this.ws !== ws) return;
          try {
            this.handle(JSON.parse(String(e.data)) as SonioxFrame);
          } catch {
            /* non-JSON keepalive */
          }
        };
        ws.onerror = () => {
          if (!opened) reject(new Error('caption websocket refused the connection'));
        };
        ws.onclose = () => {
          this.opening = false;
          if (this.ws === ws) this.ws = null;
          else if (this.ws) return;
          if (this.stopped) return;
          this.scheduleReconnect();
        };
      });
    } finally {
      this.opening = false;
    }
  }

  private handle(frame: SonioxFrame): void {
    if (this.stopped) return;
    if (frame.error_code) {
      try { this.ws?.close(); } catch { /* onclose reconnects */ }
      return;
    }
    const toks = frame.tokens ?? [];
    if (toks.length === 0) return;
    this.reconnects = 0;

    // Non-final tokens are REPLACED each frame, never accumulated: Soniox resends
    // the whole unstable tail, so appending would duplicate it.
    this.spoken.partial = '';
    this.translated.partial = '';

    for (const t of toks) {
      if (t.text === '<end>') continue;
      const stream = t.translation_status === 'translation' ? this.translated : this.spoken;
      if (!t.is_final) {
        stream.partial += t.text;
        continue;
      }
      // A speaker change ends a line in either stream.
      if (stream.active && t.speaker && stream.active.speaker && t.speaker !== stream.active.speaker) {
        this.commit(stream);
      }
      if (!stream.active) {
        stream.active = {
          id: this.nextId++, orig: '', trans: '', final: false,
          speaker: t.speaker ?? null, lang: t.language ?? null,
        };
      }
      stream.active.orig += t.text;
      if (t.language) stream.active.lang = t.language;
      if (t.speaker) stream.active.speaker = t.speaker;
      // Keep the current talk on one card until a real sentence end.
      if (shouldCommitCaption(stream.active.orig)) this.commit(stream);
    }
    this.render();
  }

  private render(): void {
    const spokenVis = visible(this.spoken);
    const transVis = visible(this.translated);
    const haveTrans = transVis.some((l) => l.orig.trim() !== '');
    const display = this.state.target !== 'off' && haveTrans ? transVis : spokenVis;
    this.emit({
      lines: display.slice(-MAX_LINES),
      spokenLines: spokenVis.slice(-MAX_LINES),
    });
  }

  private commit(stream: Stream): void {
    const line = stream.active;
    stream.active = null;
    if (!line || line.orig.trim() === '') return;
    line.final = true;
    stream.committed = [...stream.committed, line].slice(-MAX_LINES);
  }

}

interface SonioxToken {
  text: string;
  is_final?: boolean;
  translation_status?: string;
  speaker?: string;
  language?: string;
}
interface SonioxFrame {
  tokens?: SonioxToken[];
  error_code?: string | number;
  error_message?: string;
}

/**
 * Is there anything in this element to listen to?
 *
 * `readyState 0` with no source and no `srcObject` is what a `<video>` looks
 * like while a native engine paints over it: the page mounted the element,
 * nothing was ever loaded into it, and the sound is coming out of a surface
 * behind the page.
 */
function silentElement(video: HTMLVideoElement): boolean {
  return video.readyState === 0 && video.currentSrc === '' && !video.srcObject;
}

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NotAllowedError|user gesture/i.test(msg)) {
    return 'The browser blocked audio capture until you interact with the page. Press play, then start captions again.';
  }
  return msg;
}

/**
 * The first-time notice: captions send the sound to a speech-recognition
 * provider, so the viewer is told once, in words, before the first start. The
 * answer is kept on the device (`Turn on` remembers; `Not now` asks again next
 * time, because nothing was agreed).
 */
const NOTICE_KEY = 'iptv.captions.notice';
export const captionsNoticeAccepted = (): boolean => kv.get(NOTICE_KEY) !== null;
export const acceptCaptionsNotice = (): void => kv.set(NOTICE_KEY, new Date().toISOString());

export const captions = new LiveCaptions();
// Bound once, for the life of the page: the singleton follows the one player.
captions.watchStreamChanges();
