/**
 * The room the app sits in — one generated image, not a photograph.
 *
 * Asked for as a background image "like the one I gave you", found by searching
 * online. This is deliberately NOT that, and the reason is worth stating rather
 * than burying: a photograph found on the web comes with a licence, and the
 * licence follows the product onto every television it ships to. A still that
 * looks free and is not is the kind of thing that surfaces years later, in a
 * letter, about an app somebody is selling. A picture we drew has no such tail.
 *
 * What it is instead: an abstract cinematic ground, composed from the brand's own
 * accent so it moves when the theme does. Three layers, and each one is doing a
 * job rather than decorating —
 *
 *   the ground     a near-black base, so text keeps its contrast wherever it
 *                  lands on it
 *   the glow       one large, very soft accent bloom low and off-centre. Off-
 *                  centre because a symmetrical glow reads as a lens flare
 *                  rather than as a lit room, and low because that is where a
 *                  television's own light comes from once it is under a screen
 *   the streaks    two faint diagonals, wide and low-contrast. They are the only
 *                  thing giving the frame a direction; without them a radial
 *                  glow on black is a vignette and looks like a rendering fault
 *
 * ── the grain is not texture, it is the point ──
 *
 * A 1600px-wide smooth ramp across a dark ground is precisely the image that
 * BANDS on an 8-bit television panel — the concern written down all through
 * `index.css`, and the reason every gradient in the app is short-distance. A
 * full-screen one cannot be short. So a fine dither is laid over the whole
 * frame: it costs nothing at three metres, it compresses to a few tens of
 * kilobytes, and it breaks the flat steps that would otherwise be visible as
 * contour lines on exactly the screens this product runs on.
 *
 * Rendered through headless Chromium for the same reason the brand assets are:
 * the alternative is hand-plotting pixels, and this is mostly gradients, which
 * a browser is very good at and a hand-rolled encoder is not.
 *
 * Usage: node apps/web/scripts/backdrop.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand } from '../../../scripts/brand-kit.mjs';

const BRAND = loadBrand();
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

/*
 * 1600x900, not 1920x1080.
 *
 * The image is soft everywhere — there is no edge in it to go blurry — and the
 * box this is for reports a 960x540 CSS viewport, so 1600 wide is already
 * beyond what it can show at any sensible pixel ratio. The saving is real: the
 * same frame at 1920 is about a third larger for nothing anybody can see, on a
 * download that happens before the first channel does.
 */
const W = 1600;
const H = 900;

const ACCENT = BRAND.accent;
const GROUND = BRAND.ground ?? '#0b1013';

/**
 * The frame, as a page.
 *
 * `mix-blend-mode: screen` on the streaks so they add light rather than paint
 * over it — a translucent white diagonal on a dark ground goes grey and looks
 * like a smear; screened, it reads as a beam.
 *
 * The grain is an SVG feTurbulence rather than a tiled PNG: it is generated at
 * render time, it is genuinely random rather than a repeating tile (a tile shows
 * its seams on a large flat area, which is the one place this is needed), and it
 * costs one filter pass in a browser that is about to be thrown away.
 */
function page() {
  return `<!doctype html>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${GROUND} }
  .frame { position: relative; width: ${W}px; height: ${H}px; background: ${GROUND} }
  .layer { position: absolute; inset: 0 }

  /* The bloom. Two stops of the accent and a long tail to nothing, placed low
     and left of centre. 26% at the core is well under half: the text that goes
     over this has to stay readable, and a backdrop that competes with a heading
     is a backdrop that has to be turned off. */
  .glow {
    background:
      radial-gradient(78% 86% at 34% 92%,
        color-mix(in srgb, ${ACCENT} 26%, transparent) 0%,
        color-mix(in srgb, ${ACCENT} 9%, transparent) 34%,
        transparent 72%),
      radial-gradient(52% 60% at 84% 12%,
        color-mix(in srgb, ${ACCENT} 7%, transparent) 0%,
        transparent 66%);
  }

  /* Two beams, wide and shallow, crossing the lower half. */
  .streaks { mix-blend-mode: screen; opacity: .5 }
  .streaks::before, .streaks::after {
    content: ''; position: absolute; left: -30%; width: 160%; height: 42%;
    background: linear-gradient(100deg,
      transparent 0%,
      rgba(255,255,255,.055) 42%,
      rgba(255,255,255,.09) 52%,
      rgba(255,255,255,.03) 62%,
      transparent 100%);
    filter: blur(56px);
  }
  .streaks::before { top: 34%; transform: rotate(-9deg) }
  .streaks::after  { top: 62%; transform: rotate(-14deg); opacity: .6 }

  /* A vignette, so the corners fall away and nothing on top of them has to
     fight the brightest part of the frame. */
  .vignette {
    background: radial-gradient(120% 120% at 50% 45%,
      transparent 0%, transparent 46%, rgba(0,0,0,.55) 100%);
  }

  /* And the dither. See the note above: this is the layer that keeps a
     full-screen ramp from contouring on an 8-bit panel. */
  .grain { opacity: .055; mix-blend-mode: overlay }
</style>
<div class="frame">
  <div class="layer glow"></div>
  <div class="layer streaks"></div>
  <div class="layer vignette"></div>
  <svg class="layer grain" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <filter id="g">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="100%" height="100%" filter="url(#g)"/>
  </svg>
</div>`;
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.log('playwright-core is not installed — the backdrop needs a browser to rasterise.');
  process.exit(0);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await p.setContent(page());
/*
 * JPEG, and this is the one asset in the product where that is right.
 *
 * PNG is lossless and therefore keeps every grain pixel exactly, which is the
 * worst case for it — the same frame came out about eight times larger. Nothing
 * in this image has a hard edge or a flat colour that a JPEG would ruin, and it
 * is a background: quality 82 is indistinguishable at three metres and the whole
 * thing lands in tens of kilobytes, on a download that happens before the first
 * channel does.
 */
const buf = await p.screenshot({ type: 'jpeg', quality: 82 });
writeFileSync(join(PUBLIC, 'backdrop.jpg'), buf);
await browser.close();
console.log(`backdrop.jpg  ${W}x${H}  ${(buf.length / 1024).toFixed(0)}KB  accent ${ACCENT}`);
