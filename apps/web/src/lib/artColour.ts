/**
 * The dominant colour of a piece of artwork.
 *
 * Why this exists: many titles on these panels have a poster and no backdrop.
 * A hero needs a full frame of picture, and a 2:3 poster cannot become a 16:9
 * one - cropping it throws away two thirds of the image, and blurring it
 * produces a large out-of-focus area where the picture should be. Both were
 * tried and both were rejected, correctly.
 *
 * What works is what Plex and Emby do: show the poster whole, at its own aspect,
 * and fill the rest of the frame with a field built from the poster's own
 * colours. The result reads as one designed image rather than a small picture
 * stranded on black.
 *
 * The sampling is deliberately cheap - a 16x16 downscale, so 256 pixels - and
 * the answer is cached per URL for the life of the page. Artwork comes through
 * our own origin, so the canvas is not tainted and `getImageData` is allowed.
 *
 * Hosts that `deadArt` has already given up on are not sampled. Colour was
 * opening its own `<img>` against wsrv.nl for the same dead picon host the
 * poster grid had already timed out on — a 404 in the console for every hero
 * that stood a poster in for a missing backdrop.
 */

import { artIsDead, noteArtFailure, noteArtSuccess } from './deadArt.ts';

export type ArtColour = { r: number; g: number; b: number };

const cache = new Map<string, ArtColour | null>();
const waiting = new Map<string, Promise<ArtColour | null>>();
/** Bound — heroes sample one URL each; uncapped this grew with every title opened. */
const CACHE_MAX = 64;

function rememberColour(url: string, c: ArtColour | null): void {
  cache.delete(url);
  cache.set(url, c);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cachedColour(url: string): ArtColour | null | undefined {
  return cache.get(url);
}

export function colourOf(url: string): Promise<ArtColour | null> {
  if (artIsDead(url)) {
    rememberColour(url, null);
    return Promise.resolve(null);
  }
  const done = cache.get(url);
  if (done !== undefined) return Promise.resolve(done);
  const already = waiting.get(url);
  if (already !== undefined) return already;

  const job = sample(url).then((c) => {
    rememberColour(url, c);
    waiting.delete(url);
    return c;
  });
  waiting.set(url, job);
  return job;
}

function sample(url: string): Promise<ArtColour | null> {
  return new Promise((resolve) => {
    if (artIsDead(url)) { resolve(null); return; }
    const img = new Image();
    // Same-origin artwork still needs this for the canvas to stay untainted when
    // the relay answers with a redirect to another host.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onerror = () => {
      noteArtFailure(url);
      resolve(null);
    };
    img.onload = () => {
      try {
        const n = 16;
        const c = document.createElement('canvas');
        c.width = n;
        c.height = n;
        const ctx = c.getContext('2d', { willReadFrequently: false });
        if (ctx === null) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, n, n);
        const { data } = ctx.getImageData(0, 0, n, n);

        /*
          A plain mean of every pixel returns mud, because posters are mostly
          dark or mostly pale and the average of a colourful image is grey. So
          weight each pixel by its saturation: the colour a person would name
          when describing the poster is its most saturated one, not its most
          common.
        */
        let r = 0;
        let g = 0;
        let b = 0;
        let weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const pr = data[i]!;
          const pg = data[i + 1]!;
          const pb = data[i + 2]!;
          const alpha = data[i + 3]!;
          if (alpha < 128) continue;
          const max = Math.max(pr, pg, pb);
          const min = Math.min(pr, pg, pb);
          // Ignore near-black and near-white: neither says anything about hue.
          if (max < 24 || min > 232) continue;
          const sat = max === 0 ? 0 : (max - min) / max;
          const w = 0.15 + sat;
          r += pr * w;
          g += pg * w;
          b += pb * w;
          weight += w;
        }
        if (weight === 0) { resolve(null); return; }
        noteArtSuccess(url);
        resolve({
          r: Math.round(r / weight),
          g: Math.round(g / weight),
          b: Math.round(b / weight),
        });
      } catch {
        // A tainted canvas throws on getImageData. Not fatal - the caller falls
        // back to the accent wash.
        resolve(null);
      }
    };
    img.src = url;
  });
}

/** `r g b` for a CSS `rgb()` with a slash-alpha. */
export function css(c: ArtColour): string {
  return `${c.r} ${c.g} ${c.b}`;
}
