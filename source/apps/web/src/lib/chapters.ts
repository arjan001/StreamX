/**
 * Getting somewhere in a two-and-a-half-hour film.
 *
 * ── what the sources actually give us ──
 *
 * Nothing, today. The panel publishes no chapter data of any kind for films or
 * episodes: `get_vod_info` carries plot, cast, duration, bitrate and codec details
 * and not one timestamp inside the film. MKV can hold real chapters in its
 * container and 53,168 of this catalogue's 100,698 films are MKV — Chromium
 * demuxes Matroska perfectly well (measured: a 5012x2160 .mkv played a full
 * minute with zero stalls and zero dropped frames, `scripts/stream-probe.mjs`) —
 * but it exposes no chapter list to the page. There is no web API for it at all.
 * libVLC can read them, which is what `real` below is for.
 *
 * ── so this module shows nothing unless something real arrived ──
 *
 * An earlier version divided the runtime into ten-minute blocks and offered them
 * as a jump table. That was a fabrication dressed as a feature: "1 · 0:00,
 * 2 · 10:00, 3 · 20:00" tells a viewer this title has parts and that the sixth one
 * starts at 50:00, when the truth is that nobody knows where anything starts. A
 * grid of arbitrary timestamps is not navigation, it is a seek bar with the
 * precision removed — and the ±30s skip, the seek bar and the digit keys already
 * do that job honestly.
 *
 * When an engine reports the container's own chapters they are used, the panel
 * lists them by name, and the remote's chapter buttons step between them. Until
 * then, `chapters()` returns nothing and every surface that draws them
 * disappears. Missing is the correct rendering of missing.
 */

export interface Chapter {
  /** Seconds from the start. */
  startS: number;
  /** The chapter's name, or its timestamp when the container named it nothing. */
  label: string;
}

export function clock(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * The chapters of this title — the container's, or none.
 *
 * @param real what the playback engine reported. Absent or empty means this title
 *   has no chapters, which is the case for every title on this panel today.
 */
export function chapters(real?: readonly { startS: number; label?: string }[]): Chapter[] {
  if (real === undefined || real.length === 0) return [];
  return real
    .filter((c) => Number.isFinite(c.startS) && c.startS >= 0)
    .sort((a, b) => a.startS - b.startS)
    .map((c, i) => ({
      startS: Math.floor(c.startS),
      label: c.label !== undefined && c.label.trim() !== ''
        ? c.label.trim()
        : `Chapter ${i + 1} · ${clock(c.startS)}`,
    }));
}

/**
 * The chapter to land on for a chapter-skip press.
 *
 * Backwards has a threshold, which is the whole difference between a chapter
 * button that works and one that feels broken: eight seconds into a chapter,
 * PREVIOUS means the chapter before this one, not a jump back to a point you have
 * just passed. Every disc player ever made behaves this way.
 *
 * Returns null when there is nowhere to go — including when there are no chapters
 * at all, which is how the caller knows to fall back to a plain skip.
 */
export function skipTo(
  list: readonly Chapter[],
  currentS: number,
  dir: 1 | -1,
  opts: { backThresholdS?: number } = {},
): number | null {
  if (list.length === 0) return null;
  const back = opts.backThresholdS ?? 5;
  if (dir === 1) {
    const next = list.find((c) => c.startS > currentS + 0.5);
    return next?.startS ?? null;
  }
  const here = currentS - back;
  let prev: Chapter | null = null;
  for (const c of list) {
    if (c.startS <= here) prev = c;
    else break;
  }
  // Before the first chapter, backwards means the start of the title.
  return prev?.startS ?? (currentS > 1 ? 0 : null);
}

/** Which chapter the playhead is inside, for highlighting one row. */
export function chapterAt(list: readonly Chapter[], currentS: number): number {
  let idx = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]!.startS <= currentS + 0.001) idx = i;
    else break;
  }
  return idx;
}

/**
 * Where a digit key lands: 1 → 10%, 9 → 90%, 0 → the start.
 *
 * The oldest keyboard convention in video playback, and the one thing a remote's
 * number pad is good for on a film. This one is not a fabrication — it says
 * nothing about the title's structure, only about its runtime, which is known.
 * Live already owns the digits for channel numbers, so it applies only to a title
 * with a duration.
 */
export function digitSeek(digit: number, durationS: number): number | null {
  if (!Number.isFinite(durationS) || durationS <= 0) return null;
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return null;
  return Math.min(durationS - 1, (durationS * digit) / 10);
}
