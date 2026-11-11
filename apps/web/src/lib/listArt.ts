/**
 * Poster URL for a catalogue row, when the row's own logo is on a dead host.
 *
 * Measured: "Water For Elephants" EN points at a host that hangs forever;
 * the same title as GR carries a live TMDB poster. Detail already swaps a dead
 * cover for the TMDB backdrop (`DetailHero`); the grid only had `item.logo`, so
 * it drew "WF". Prefer a sibling row's live art, then anything remembered from
 * opening the title (backdrop), then the logo itself.
 */
import { artIsDead } from './deadArt.ts';
import { bulkTitle, cleanTitle } from './displayName.ts';
import { localCatalogue } from './localCatalogue.ts';
import { readText, type Catalogue } from '@iptv/core-store';
import type { Item } from './api.ts';
import { safeImage } from './localRead.ts';


/** Covers remembered after a detail fetch — keyed by catalogue row id. */
const remembered = new Map<number, string>();

export function rememberListArt(itemId: number, url: string | null): void {
  if (url === null || url === '') return;
  remembered.set(itemId, url);
}

export function artKey(name: string, year: string | null, bulk = false): string {
  /* `bulk` for the catalogue-wide walk below: the name grammar is memoised for
     the screen, and putting fifty thousand names through that memo evicts the
     forty the screen is drawing. See `bulkTitle`. */
  const base = (bulk ? bulkTitle(name) : cleanTitle(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const y = year !== null && year !== '' ? year.slice(0, 4) : '';
  return y.length === 4 ? `${base} ${y}` : base;
}

/** True when this URL's host has been seen failing — see `deadArt.ts`. */
export function logoHostDead(url: string | null): boolean {
  if (url === null || url === '') return true;
  return artIsDead(url);
}

function logoUsable(url: string | null): url is string {
  return url !== null && url !== '' && !logoHostDead(url);
}

/**
 * The sibling index: folded "title year" → raw logos from the catalogue.
 *
 * It has to cover the WHOLE library — any film may be the one whose poster is
 * dead — and the library is tens of thousands of rows. Built in one synchronous
 * pass, as it was, that came to **4.3 seconds of blocked main thread in the
 * middle of a React render**: a CPU profile of the built site on 2026-09-15
 * showed opening Movies spending 703 ms in `rewriteArtwork`, 600 ms in the
 * `cleanTitle` grammar and 327 ms deciding which hosts were dead, all before the
 * first tile could paint. That is the "it hangs for a bit" this screen was
 * reported for.
 *
 * Two changes, and the second is the one that matters.
 *
 * Only the KEY is computed while walking. Judging a logo costs two `new URL`s
 * and a dead-host tally that MOVES during a session, so candidates are kept as
 * the raw catalogue text and judged at lookup instead — cheaper here, and
 * fresher there. Up to `KEEP` are held per title so a dead first sibling cannot
 * shadow a live second one; rebuild order is catalogue order, which is also
 * preference order.
 *
 * And the walk is sliced. It runs in idle time in short bursts, and `listArt`
 * answers from however much is indexed so far. A borrowed poster arriving a
 * second late is invisible; a page that will not scroll for four seconds is not.
 */
const KEEP = 3;
/** Budget per burst. Short enough to leave a 60 Hz frame its own time. */
const SLICE_MS = 6;
/**
 * How long after a key press the walk stays out of the way.
 *
 * Six milliseconds a slice is small, and it is still the wrong six milliseconds
 * when somebody is holding a direction on a remote: measured on a
 * four-times-throttled CPU, walking the poster grid cost 78 ms a press with this
 * running, and the profile was most of a second of name-grammar underneath it.
 *
 * The index is a nicety — it recovers a poster for a film whose own is on a dead
 * host — so it yields to the person using the screen, unconditionally, and picks
 * up again a quarter of a second after they stop.
 */
const QUIET_MS = 250;
let lastPress = 0;

if (typeof window !== 'undefined') {
  const touch = () => { lastPress = Date.now(); };
  window.addEventListener('keydown', touch, { capture: true, passive: true });
  window.addEventListener('pointerdown', touch, { capture: true, passive: true });
  window.addEventListener('wheel', touch, { capture: true, passive: true });
}
/** The dead box, recognised on the raw text so the cheap pass can skip it. */
const DEAD_TEXT = /51\.158\.145\.100/;

let indexGen = -1;
let siblingLogos = new Map<string, string[]>();
let cursor = 0;
let scheduled = false;
/** Bumped when a walk finishes, so a grid can repaint with what it found. */
let indexReady = 0;
const watchers = new Set<() => void>();

/** Subscribe to "the sibling index finished" — see `getListArtReady`. */
export function subscribeListArt(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/** Snapshot for `useSyncExternalStore`: changes once per completed walk. */
export function getListArtReady(): number {
  return indexReady;
}

function schedule(cat: Catalogue): void {
  if (scheduled) return;
  scheduled = true;
  const run = (): void => {
    scheduled = false;
    walk(cat);
  };
  const idle = (globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  /* A timeout, so a television that never goes idle still finishes the walk. */
  if (idle) idle(run, { timeout: 400 });
  else setTimeout(run, 0);
}

function walk(cat: Catalogue): void {
  if (indexGen !== cat.generation) return; /* a re-ingest superseded this walk */
  /* Somebody is driving. Come back when they stop — see `QUIET_MS`. */
  if (Date.now() - lastPress < QUIET_MS) {
    schedule(cat);
    return;
  }
  const cols = cat.items;
  const until = Date.now() + SLICE_MS;
  let row = cursor;
  while (row < cols.count) {
    if ((cols.kind[row] ?? 0) === 2) {
      /* films only — series covers are usually fine */
      const raw = readText(cols.logos, row);
      if (raw !== '' && !DEAD_TEXT.test(raw)) {
        const year = cols.year[row] ?? 0;
        const key = artKey(readText(cols.names, row), year === 0 ? null : String(year), true);
        if (key !== '') {
          const held = siblingLogos.get(key);
          if (held === undefined) siblingLogos.set(key, [raw]);
          else if (held.length < KEEP) held.push(raw);
        }
      }
    }
    row++;
    /* Checking the clock every row would cost more than the row does. */
    if ((row & 0xff) === 0 && Date.now() >= until) break;
  }
  cursor = row;
  if (row < cols.count) {
    schedule(cat);
    return;
  }
  indexReady++;
  for (const w of watchers) w();
}

function ensureIndex(cat: Catalogue): void {
  if (indexGen === cat.generation) return;
  indexGen = cat.generation;
  siblingLogos = new Map();
  cursor = 0;
  schedule(cat);
}

/** The first sibling logo that still answers, judged now rather than at build. */
function siblingArt(key: string): string | null {
  const raws = siblingLogos.get(key);
  if (raws === undefined) return null;
  for (const raw of raws) {
    const url = safeImage(raw);
    if (logoUsable(url)) return url;
  }
  return null;
}

/**
 * Best picture for a grid / search row.
 *
 * Own logo when it lives; else a same-title sibling with live art; else a cover
 * remembered from opening the title; else the original logo (Poster monograms it).
 */
export function listArt(item: Item): string | null {
  if (logoUsable(item.logo)) return item.logo;

  const held = remembered.get(item.id);
  if (logoUsable(held ?? null)) return held!;

  const cat = localCatalogue();
  if (cat !== null) {
    ensureIndex(cat);
    const sib = siblingArt(artKey(item.name, item.year));
    if (sib !== null) return sib;
  }

  /* There used to be a last rung here — TMDB, through our own box. The box no
     longer answers anything but logs, updates, config and captions
     (2026-10-01), so a tile with nothing left shows its own logo, or its
     letters. */
  return item.logo;
}
