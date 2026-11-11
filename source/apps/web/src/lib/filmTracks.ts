/**
 * The languages inside a film, as menu rows.
 *
 * A browser opens exactly one soundtrack out of a `.mkv` — the one the file marks
 * default — and cannot see its subtitle tracks at all: `audioTracks` is
 * `undefined` on Chromium and `textTracks` reads 0. So a film this page takes
 * apart itself (`deviceFilm.ts`) reports its tracks here, and this turns them
 * into the rows of the AUDIO and SUBTITLES menus. The app on a TV box never uses
 * any of this — libVLC reads the tracks directly.
 *
 * Everything here is a pure function over data so it can be pinned without a
 * browser: the wiring lives in `playerCore`.
 */
import { trackName } from './trackLabels.ts';

export interface FilmTrack {
  index: number;
  kind: 'audio' | 'subtitle';
  lang: string | null;
  title: string | null;
  codec: string;
  isDefault: boolean;
  /** False for picture subtitles (DVD/Blu-ray), which cannot become text here. */
  textual: boolean;
}

/** What the player shows in the AUDIO and SUBTITLES menus. */
export interface TrackChoice {
  /** The container's stream index. */
  id: number;
  label: string;
  active: boolean;
}

/**
 * The rows for the AUDIO menu.
 *
 * Named by language where the file states one, and numbered only where two rows
 * would otherwise read the same — see `trackLabels`. A track the file leaves
 * unnamed keeps a position rather than being guessed at: "Track 2" is true,
 * "English" would not be.
 */
export function audioChoices(tracks: readonly FilmTrack[], activeIndex: number | null): TrackChoice[] {
  const audio = tracks.filter((t) => t.kind === 'audio');
  const rows = audio.map((t, i) => ({
    id: t.index,
    label: nameOf(t, i),
    active: t.index === activeIndex,
  }));
  return numberCollisions(rows);
}

/**
 * The rows for the SUBTITLES menu, with "Off" first.
 *
 * `-1` is off, which is the same id the native engine and hls.js use for it, so
 * the menu component needs no special case for this path.
 */
export function subtitleChoices(
  tracks: readonly FilmTrack[], activeIndex: number | null,
): TrackChoice[] {
  const subs = tracks.filter((t) => t.kind === 'subtitle' && t.textual);
  if (subs.length === 0) return [];
  const rows = subs.map((t, i) => ({
    id: t.index,
    label: nameOf(t, i),
    active: t.index === activeIndex,
  }));
  return [{ id: -1, label: 'Off', active: activeIndex === null }, ...numberCollisions(rows)];
}

function nameOf(t: FilmTrack, i: number): string {
  /* The file's own title first when it has one that says something — "Director's
     commentary" is worth more than "English" — but not when it is the encoder's
     watermark, which this catalogue is full of. */
  const title = (t.title ?? '').trim();
  if (title !== '' && !/encoder|joya|rip|www\.|\.tv\b|@/i.test(title)) return title;
  if (t.lang !== null) return trackName('', t.lang);
  return `Track ${i + 1}`;
}

function numberCollisions(rows: TrackChoice[]): TrackChoice[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((r) => {
    if ((counts.get(r.label) ?? 0) < 2) return r;
    const n = (seen.get(r.label) ?? 0) + 1;
    seen.set(r.label, n);
    return { ...r, label: `${r.label} ${n}` };
  });
}

/**
 * What to tell someone whose film cannot play here.
 *
 * Named rather than a codec verdict, because the verdict would be true and
 * useless — "this browser cannot decode E-AC-3" tells a viewer nothing they
 * can act on. The thing they can act on is the app on their television, which
 * plays it.
 */
export const NEEDS_DEVICE_HINT =
  'This file is in a wrapper no browser can open — Matroska, or sound in AC-3 or DTS. '
  + 'The app on a television plays it: it unwraps the film on the device itself.';
