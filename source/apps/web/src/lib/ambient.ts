/**
 * The colour of what is playing, for the light around it.
 *
 * Asked for as "aren't the player always i'm sure there are packages you can
 * like show shades you know what's playing right now like a television" — which
 * is Ambilight, and on the web it is YouTube's ambient mode. The technique is
 * settled and worth copying exactly: draw the video onto a very small canvas,
 * read the edges, blur the result heavily in CSS. A 32x18 draw is 576 pixels, so
 * the cost is in the sampling RATE rather than the sampling.
 *
 * ── where it can and cannot work, which is not a detail here ──
 *
 * A canvas can only read pixels the WebView owns. On this app that means the
 * `<video>` element — and NOT the libVLC path, where the film is drawn on an
 * Android surface behind a transparent WebView and there is nothing in the DOM
 * to sample.
 *
 * That used to be the end of it, and it should not have been: the pixels exist,
 * they are just on the other side of the bridge, and this app is native. So
 * there are two samplers now — `startAmbient` for a `<video>` element, and
 * `startNativeAmbient`, which asks the plugin to read the surface back with
 * `PixelCopy` and hand over the edge average. Same rate, same tempering, same
 * smoothing; only the source of the numbers differs. `playerCore`'s `surface`
 * flag decides which one the caller starts — see `VideoPlayer`.
 *
 * A tainted canvas is the other refusal. The `<video>` carries
 * `crossOrigin="anonymous"` and every door this account uses answers
 * `Access-Control-Allow-Origin: *` (measured across 26 episodes), so
 * `getImageData` works — but a build pointed at a panel that does not send the
 * header would throw on the first read, and one throw per frame is a broken app.
 * So the first failure stops the sampler for good.
 *
 * ── and why the rate is 600ms and not every frame ──
 *
 * YouTube samples per frame because it runs on a laptop. This runs on a box that
 * already has `index.css` disabling every decorative animation to keep frames
 * for the video. The colour of a scene changes over a second, not over 16ms, and
 * with smoothing between samples nobody can tell the difference — measured
 * against a cut-heavy news feed, 600ms reads as continuous. That is ~1.7 draws a
 * second of 576 pixels, which is nothing, against 60.
 */

/** A sampled colour, 0-255 per channel. */
export interface Shade { r: number; g: number; b: number }

/**
 * The average of the frame's EDGES, not the whole frame.
 *
 * The glow sits around the picture, so what belongs next to an edge is the
 * colour of that edge — averaging the middle in would tint the sides with
 * whatever is happening in the centre of the shot. Two strips, left and right,
 * because that is where the light lands on a letterboxed picture.
 *
 * `data` is RGBA, row-major, as `getImageData` returns it. Exported for its own
 * test: the arithmetic is trivial and the indexing is not.
 */
export function edgeShade(data: Uint8ClampedArray, w: number, h: number): Shade | null {
  if (w < 2 || h < 1 || data.length < w * h * 4) return null;
  /* An eighth of the width each side, at least one column. At 32 wide that is
     four columns a side — enough to survive a dark vignette without reaching
     into the middle of the shot. */
  const band = Math.max(1, Math.round(w / 8));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < band; x++) {
      for (const px of [x, w - 1 - x]) {
        const i = (y * w + px) * 4;
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
        n += 1;
      }
    }
  }
  if (n === 0) return null;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/**
 * Move part of the way from one colour to the next.
 *
 * Exponential smoothing, because a cut between two shots is a step change and a
 * glow that steps with it flickers — which on a television, in a dark room, is
 * worse than no glow at all. `f` is how much of the new colour to take.
 */
export function blend(from: Shade, to: Shade, f: number): Shade {
  const k = Math.max(0, Math.min(1, f));
  return {
    r: Math.round(from.r + (to.r - from.r) * k),
    g: Math.round(from.g + (to.g - from.g) * k),
    b: Math.round(from.b + (to.b - from.b) * k),
  };
}

/**
 * Keep a shade usable as light: never black, never white, never garish.
 *
 * Three things learned from how televisions actually look, and one from the
 * design guidance for the platform — saturated colour bands on a TV panel and
 * oversaturated reds read as harsh at three metres.
 *
 *   - a black frame would switch the glow off mid-film, so there is a floor
 *   - a white frame would flood the room, so there is a ceiling
 *   - a fully saturated frame would ring the picture in neon, so saturation is
 *     pulled back toward the middle
 */
export function temper(s: Shade): Shade {
  const lo = 18;
  const hi = 190;
  const clamp = (v: number) => Math.max(lo, Math.min(hi, v));
  const r = clamp(s.r);
  const g = clamp(s.g);
  const b = clamp(s.b);
  /* Toward the mean by a third: keeps the hue, drops the shout. */
  const mean = (r + g + b) / 3;
  const pull = (v: number) => Math.round(v + (mean - v) * 0.34);
  return { r: pull(r), g: pull(g), b: pull(b) };
}

export function cssOf(s: Shade): string {
  return `rgb(${s.r} ${s.g} ${s.b})`;
}

/** How often a frame is read. See the note above on why this is not per-frame. */
export const SAMPLE_MS = 600;

/**
 * Watch a video element and report the colour beside it.
 *
 * Returns a stop function. Safe to call in an effect: it starts nothing until
 * the video has a frame, stops itself on the first refusal, and pauses entirely
 * while the page is hidden — a background tab painting a glow nobody can see is
 * the definition of wasted work on a device this size.
 */
export function startAmbient(
  video: HTMLVideoElement,
  onShade: (s: Shade) => void,
): () => void {
  const W = 32;
  const H = 18;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let at: Shade | null = null;
  let timer = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== 0) { window.clearInterval(timer); timer = 0; }
    canvas = null;
    ctx = null;
  };

  const tick = () => {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    /* Nothing decoded yet, or the element has gone: skip this turn rather than
       stop, because both states are temporary. */
    if (video.readyState < 2 || video.videoWidth === 0) return;
    if (canvas === null) {
      canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (ctx === null) { stop(); return; }
    try {
      ctx.drawImage(video, 0, 0, W, H);
      const got = edgeShade(ctx.getImageData(0, 0, W, H).data, W, H);
      if (got === null) return;
      const want = temper(got);
      /* A third of the way each sample: about a second and a half to settle,
         which is slower than a cut and faster than a scene. */
      at = at === null ? want : blend(at, want, 0.34);
      onShade(at);
    } catch {
      /*
       * A tainted canvas, or a decoder that will not hand over a frame. Either
       * way it will not start working later in this stream, and one throw per
       * sample is a browser console full of the same line for as long as the
       * film runs.
       */
      stop();
    }
  };

  timer = window.setInterval(tick, SAMPLE_MS);
  /* One immediate read so the glow does not wait 600ms to exist. */
  tick();
  return stop;
}

/* ── the native source ─────────────────────────────────────────────────────── */

/** What the plugin answers. Mirrors `ambient` in StreamixPlayerPlugin. */
export interface NativeShade {
  lit: boolean;
  why?: string;
  r?: number;
  g?: number;
  b?: number;
}

/**
 * Is this refusal worth asking about again?
 *
 * The difference matters because the alternative to knowing is a choice between
 * two bad sampler behaviours: give up on the first `lit: false` and the glow
 * never starts, because the first sample almost always lands before the first
 * frame is decoded; or never give up, and poll a protected stream for the whole
 * film to be told "no" 6,000 times.
 *
 *   idle / hidden / nosurface   the stream is opening, or the surface is not up
 *                               yet, or the picture is behind a page that has
 *                               taken the screen. All temporary; ask again.
 *   api                         the WebView predates `PixelCopy` (API 24). It
 *                               will predate it for ever.
 *   refused / copyN / read      the buffer will not be read back — a protected
 *                               or secure surface, which is a property of the
 *                               stream and not of the moment.
 *
 * An unrecognised reason is treated as temporary: a future plugin that names a
 * new transient state should not switch the feature off in an old page.
 */
export function keepAsking(why: string | undefined): boolean {
  if (why === undefined) return true;
  return !['api', 'refused', 'read', 'empty'].includes(why)
    && !why.startsWith('copy');
}

/**
 * Watch the native surface and report the colour beside it.
 *
 * Same contract as `startAmbient`: returns a stop function, safe in an effect,
 * pauses while the page is hidden, and gives up for good on a refusal it knows
 * cannot change. The tempering and the smoothing are the shared ones, so a film
 * that switches engine mid-catalogue does not change the character of the light.
 *
 * `ask` is injected rather than imported so this is testable without a bridge —
 * the sampling loop has the opinions in it, and the plugin call does not.
 */
export function startNativeAmbient(
  ask: () => Promise<NativeShade>,
  onShade: (s: Shade) => void,
): () => void {
  let at: Shade | null = null;
  /* A bare `setInterval`, not `window.setInterval`: this loop has opinions in it
     — when to give up, what to clamp — and those are the parts worth testing, so
     it must run outside a browser. `startAmbient` above cannot, because a canvas
     cannot either. */
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  /* One in flight at a time. A box that answers slower than the interval would
     otherwise queue reads it can never catch up with. */
  let busy = false;

  const stop = () => {
    stopped = true;
    if (timer !== null) { clearInterval(timer); timer = null; }
  };

  const tick = () => {
    if (stopped || busy) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    busy = true;
    void ask().then((got) => {
      busy = false;
      if (stopped) return;
      if (!got.lit) {
        if (!keepAsking(got.why)) stop();
        return;
      }
      const raw = {
        r: Math.max(0, Math.min(255, got.r ?? 0)),
        g: Math.max(0, Math.min(255, got.g ?? 0)),
        b: Math.max(0, Math.min(255, got.b ?? 0)),
      };
      const want = temper(raw);
      at = at === null ? want : blend(at, want, 0.34);
      onShade(at);
    }).catch(() => {
      /* The bridge itself failed. Not fatal on its own — a call can be lost
         while the activity is being recreated — so this keeps asking. */
      busy = false;
    });
  };

  timer = setInterval(tick, SAMPLE_MS);
  tick();
  return stop;
}
