/**
 * Whether a screen's filter chips are showing.
 *
 * Asked for across Movies and Series: "the tab filters make it
 * toggleable and in a top so you open and close it". The chips were always on.
 * On Movies that is one row beside the count, about 110px of a 540px television
 * spent above a grid, on every visit, for something used now and then.
 *
 * Remembered per section, because somebody who keeps the genres open on Movies
 * has told the app something about Movies, not about everything. Closed by
 * default: the grid is what a viewer came for, and the toggle says how many
 * filters are set whenever the strip is shut, so nothing ever filters silently.
 */
import { useCallback, useState } from 'react';
import { kv } from './kv.ts';

export function stripKey(section: string): string {
  return `iptv.filters.open.${section}`;
}

/** Stored answer, or the default. Pure over the stored string, for the tests. */
export function readStrip(raw: string | null): boolean {
  return raw === '1';
}

export function useFilterStrip(section: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try { return readStrip(kv.get(stripKey(section))); } catch { return false; }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try { kv.set(stripKey(section), next ? '1' : '0'); } catch { /* the choice still applies this visit */ }
  }, [section]);
  return [open, set];
}
