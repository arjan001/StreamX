import { useEffect, useState } from 'react';
import { cachedColour, colourOf, css, type ArtColour } from './artColour';

/**
 * The artwork's dominant colour, as a CSS `r g b` triple.
 *
 * Returns null until it is known, and null for ever if the image cannot be
 * sampled — callers fall back to the brand wash rather than waiting.
 */
export function useArtColour(url: string | null): string | null {
  const [colour, setColour] = useState<ArtColour | null>(
    () => (url === null ? null : cachedColour(url) ?? null),
  );

  useEffect(() => {
    if (url === null) { setColour(null); return; }
    const known = cachedColour(url);
    if (known !== undefined) { setColour(known); return; }
    let live = true;
    void colourOf(url).then((c) => { if (live) setColour(c); });
    return () => { live = false; };
  }, [url]);

  return colour === null ? null : css(colour);
}
