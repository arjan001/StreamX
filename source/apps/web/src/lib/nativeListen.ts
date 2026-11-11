/**
 * The app listening to its own sound, for live captions.
 *
 * ── what this is for ──
 *
 * Captions transcribe what the `<video>` element is playing. On this APK the
 * interesting channels are played by libVLC onto a surface BEHIND the page —
 * that is the whole reason the APK exists — so the element is empty and there is
 * nothing to transcribe. Every live channel on this catalogue is a raw MPEG-TS,
 * which is exactly what libVLC is for, so "no captions" was all of live
 * television.
 *
 * The audio cannot be fetched a second time (`max_connections` is 1, and some
 * panels evict the viewer's own picture to make room), and it must not be lifted
 * out of the stream by our own server (that bills the operator for every
 * viewer-hour of captions). So it is captured on the device, after libVLC has
 * already decoded it: `AudioPlaybackCapture`, scoped by uid to this app.
 *
 * See `StreamixListenPlugin.java` for the permission dance and why each of the
 * three prompts is correct rather than merely required.
 *
 * ── everything here fails soft ──
 *
 * Same rule as `nativeBridge.ts`. No plugin, an older Android, a viewer who says
 * no — every one of those returns "not available" and the page falls back to
 * offering the browser engine instead. Nothing about this may be able to stop
 * captions working where they already worked.
 */
import { dlog } from './debugLog.ts';
import { unthenable } from './unthenable.ts';
import { nativePluginsPossible } from './platform.ts';

export interface ListenStart {
  started: boolean;
  /** Empty when it started; otherwise something a viewer can act on. */
  why: string;
  rate?: number;
  channels?: number;
}

interface ListenPlugin {
  available(): Promise<{ available: boolean; why: string; listening: boolean }>;
  start(): Promise<ListenStart>;
  stop(): Promise<{ started: boolean }>;
  addListener(
    event: 'listenAudio' | 'listenLost',
    fn: (data: { pcm?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

let proxy: ListenPlugin | null = null;
let asked = false;
let present = false;

/**
 * A plugin proxy, carried inside something that is NOT thenable.
 *
 * ── the bug this exists for ──
 *
 * Reported as "the live caption keeps loading and doesn't work", and found in
 * a log sent from a television:
 *
 *     page: unhandled rejection:
 *     Error: "StreamixListen.then()" is not implemented on android
 *
 * `plugin()` used to be an `async` function that RETURNED the proxy. Resolving
 * an async function awaits its return value, and awaiting anything asks it for
 * `.then` — and a Capacitor proxy answers every property access by treating it
 * as a native method. So the runtime's own bookkeeping called a method called
 * `then`, Android had no such method, and the promise rejected. Every time,
 * on every device, since 1.34.0: native listening has never once worked.
 *
 * The rejection was not even visible as a caption failure. `start()` awaited
 * `canListenNatively()` BEFORE its try block, so the throw escaped the engine
 * entirely, nothing set the phase to `error`, and the spinner stayed up for
 * ever — which is exactly what "keeps loading" is.
 *
 * A one-field box fixes it: a plain object is not thenable, so resolving this
 * touches nothing on the proxy. The proxy is only ever reached through `.api`,
 * by a caller that is no longer inside an await.
 */
/** Every method that has to survive `unthenable` — see its test. */
const METHODS = ['available', 'start', 'stop', 'addListener'] as const;

/** Registered once and kept — see `nativePlayer.ts` for why repeating it is not free. */
async function plugin(): Promise<ListenPlugin | null> {
  if (proxy !== null) return proxy;
  if (asked) return null;
  asked = true;
  /* iOS has no StreamixListen (AudioPlaybackCapture is Android 10+ only). */
  if (!nativePluginsPossible()) return null;
  try {
    const core = await import('@capacitor/core');
    if (!core.Capacitor.isNativePlatform()) return null;
    /* Wrapped BEFORE it can be returned from this async function, which is the
       whole of the trap — see `lib/unthenable.ts`. `proxy` holds the plain
       object, so every later `return proxy` is safe too. */
    proxy = unthenable(core.registerPlugin<ListenPlugin>('StreamixListen'), METHODS);
    return proxy;
  } catch {
    return null;
  }
}

/**
 * Can this device listen to itself?
 *
 * Answered by the plugin rather than assumed from the platform: it is Android 10
 * and newer only, and an APK built before this existed has no such plugin at all
 * while still being a perfectly good native build.
 */
export async function canListenNatively(): Promise<boolean> {
  const p = await plugin();
  if (p === null) return false;
  try {
    const r = await p.available();
    present = r.available === true;
    if (!present && r.why !== '') dlog.info('captions', `native listening unavailable — ${r.why}`);
    return present;
  } catch {
    /* An older APK whose plugin has no `available` method. */
    return false;
  }
}

/** What `hasNativeEngine()` is to the player: the last answer, without a call. */
export function nativeListenKnown(): boolean {
  return present;
}

export interface Listening {
  stop(): Promise<void>;
}

/** How long a feed may be pure silence before it is treated as no feed at all. */
const SILENT_GIVE_UP_MS = 8000;

/**
 * Is there anything in this frame but zeroes?
 *
 * A stride rather than every sample: this runs ten times a second on a
 * television, and the question is "is this silence", which one loud sample
 * answers. 16-bit signed, little-endian, so the high byte alone is enough to
 * separate silence from speech without assembling the value.
 */
export function loudEnough(pcm: ArrayBuffer, floor = 200): boolean {
  const view = new DataView(pcm);
  for (let i = 0; i + 1 < view.byteLength; i += 16) {
    const v = view.getInt16(i, true);
    if (v > floor || v < -floor) return true;
  }
  return false;
}

/**
 * Ask for the permissions, start capturing, and hand each frame to `onPcm`.
 *
 * The frames are 16 kHz mono signed 16-bit — the same shape the element tap
 * produces — so the caller forwards them to the transcriber without caring which
 * of the two it is holding.
 */
export async function listenNatively(
  onPcm: (pcm: ArrayBuffer) => void,
  onLost: () => void,
  onSilent: () => void,
): Promise<{ ok: true; handle: Listening } | { ok: false; why: string }> {
  const p = await plugin();
  if (p === null) return { ok: false, why: 'this build cannot listen to itself' };

  /* Subscribed BEFORE starting: the recorder begins the moment the viewer
     answers the last prompt, and a listener attached afterwards loses whatever
     arrived in between. */
  let audioSub: { remove: () => Promise<void> } | null = null;
  let lostSub: { remove: () => Promise<void> } | null = null;
  try {
    let frames = 0;
    let firstAt = 0;
    let heardSomething = false;
    let gaveUp = false;
    audioSub = await p.addListener('listenAudio', (data) => {
      const b64 = data.pcm;
      if (typeof b64 !== 'string' || b64 === '') return;
      const pcm = decode(b64);
      /* Once, on the first frame. "It started" and "sound is actually arriving"
         are different claims and a report that cannot tell them apart sends you
         looking at the transcriber when the problem is the recorder. */
      if (frames === 0) {
        firstAt = Date.now();
        dlog.info('captions', `first sound from the device — ${pcm.byteLength} bytes`);
      }
      frames += 1;
      if (!heardSomething && loudEnough(pcm)) {
        heardSomething = true;
        dlog.info('captions', `the sound is real after ${frames} frame(s)`);
      }
      /*
       * ── the watchdog, and why it is not optional ──
       *
       * Frames arriving is NOT the same as audio arriving. A recorder that
       * captures nothing still delivers perfectly punctual silence at 32,000
       * bytes a second, and captions fed on silence sit behind a spinner for
       * ever with nothing to say — which is a worse answer than the honest one
       * this feature replaced.
       *
       * Measured on a Google TV image while building this: libVLC's AudioTrack
       * reported `stop(706): called with 0 frames delivered` under ARM
       * translation, and the capture faithfully returned ten seconds of zeroes.
       * That was the emulator being too slow, but the shape of it is exactly
       * what a device whose audio cannot be captured would look like — so
       * rather than trusting that it cannot happen, silence for this long hands
       * the viewer back to the engine offer, which needs no permission and
       * cannot fail this way.
       */
      if (!heardSomething && !gaveUp && firstAt !== 0 && Date.now() - firstAt > SILENT_GIVE_UP_MS) {
        gaveUp = true;
        dlog.warn('captions', `${SILENT_GIVE_UP_MS / 1000}s of captured silence — giving up on listening`);
        onSilent();
        return;
      }
      if (gaveUp) return;
      onPcm(pcm);
    });
    lostSub = await p.addListener('listenLost', () => onLost());
  } catch {
    /* fall through to start, which will fail honestly */
  }

  let started: ListenStart;
  try {
    started = await p.start();
  } catch (e) {
    await drop(audioSub, lostSub);
    return { ok: false, why: String(e) };
  }
  if (!started.started) {
    await drop(audioSub, lostSub);
    return { ok: false, why: started.why };
  }
  dlog.info('captions', `listening to this app's own sound — ${started.rate ?? 16000}Hz mono`);
  return {
    ok: true,
    handle: {
      stop: async () => {
        await drop(audioSub, lostSub);
        try { await p.stop(); } catch { /* already gone */ }
      },
    },
  };
}

async function drop(...subs: ({ remove: () => Promise<void> } | null)[]): Promise<void> {
  for (const s of subs) {
    if (s === null) continue;
    try { await s.remove(); } catch { /* already gone */ }
  }
}

/**
 * Base64 to bytes, without `fetch`.
 *
 * `atob` is the only decoder guaranteed present in every WebView this ships to,
 * and the frames are 3,200 bytes ten times a second — small enough that the
 * per-character loop is cheaper than anything asynchronous.
 */
export function decode(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
