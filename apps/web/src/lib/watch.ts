/**
 * Continue-watching, stored with the active profile.
 *
 * Row ids change every ingest, so records key on the provider stream/series id
 * the same way favourites do. Live has no useful playhead; this is VOD only.
 *
 * The last known playhead is kept in a ref: player.teardown() zeros currentTime
 * and pagehide tears the engine down, so flushing player.state on unmount would
 * save 0 and delete the record.
 */
import { useEffect, useRef } from 'react';
import { getPrefs, setWatchHistory, usePrefs, type WatchRecord } from './prefs.ts';
import { retireLastPlayed } from './resume.ts';
import { Kind } from '@iptv/core-xtream';

const NEAR_END = 15;
const MIN_SAVE = 5;
const THROTTLE_MS = 4000;

export interface WatchKey {
  section: 'movies' | 'series';
  streamId: number;
  episodeId?: number | null;
  season?: number | null;
  episode?: number | null;
}

/**
 * The identity of a watch record — and why the episode is part of it.
 *
 * ── the bug ──
 *
 * "It doesn't save the progress of how much watched… if I go next, it's lost."
 * Measured: playing a film for 12s writes `{ pos: 12, dur: 7229 }` and the
 * Continue strip appears, so saving worked. What did not was KEEPING it. The
 * record was identified by section plus `streamId`, and for a series `streamId`
 * is the SERIES — `episodeId` was stored on the record but took no part in
 * deciding which record it replaced. So starting episode 2 deleted episode 1's
 * position, every time, and a series could only ever remember one place.
 *
 * That is the wrong shape for the thing being modelled. A series is not a
 * position; each episode is. YouTube keeps a mark per video, and a season is
 * twenty videos.
 *
 * Films are unaffected: their `episodeId` is null on both sides, so the identity
 * collapses back to section + stream and behaves exactly as before.
 */
function sameItem(r: WatchRecord, section: WatchKey['section'], streamId: number, episodeId: number | null): boolean {
  return r.section === section
    && r.streamId === streamId
    && (r.episodeId ?? null) === episodeId;
}

export function getWatch(
  section: WatchKey['section'],
  streamId: number | null,
  episodeId: number | null = null,
): WatchRecord | null {
  if (streamId === null) return null;
  const all = getPrefs().history;
  const exact = all.find((r) => sameItem(r, section, streamId, episodeId));
  if (exact) return exact;
  /*
   * Asking about a SERIES rather than an episode: answer with the newest episode
   * of it. That is what "resume this series" means, and it is what the Continue
   * strip and the poster overlays want — one row per series, at the place the
   * viewer actually stopped, rather than one row per episode.
   */
  if (episodeId !== null) return null;
  let best: WatchRecord | null = null;
  for (const r of all) {
    if (r.section !== section || r.streamId !== streamId) continue;
    if (best === null || r.updatedAt > best.updatedAt) best = r;
  }
  return best;
}

function finiteDuration(durationS: number): number {
  return Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
}

export function saveWatch(key: WatchKey, positionS: number, durationS: number): void {
  if (key.streamId <= 0) return;
  if (!Number.isFinite(positionS)) return;
  const prefs = getPrefs();
  /* Replace THIS episode's mark, not every mark this series has — see `sameItem`. */
  const rest = prefs.history.filter(
    (r) => !sameItem(r, key.section, key.streamId, key.episodeId ?? null),
  );
  const dur = finiteDuration(durationS);
  const done = dur > 0 && positionS >= dur - NEAR_END;
  const tooEarly = positionS < MIN_SAVE;
  if (done || tooEarly) {
    if (rest.length !== prefs.history.length) setWatchHistory(rest);
    /*
     * A film that has been watched to the end is not where anyone wants to be
     * taken on the next launch. The mark and the history record retire together,
     * because they are two views of the same fact.
     */
    if (done) {
      retireLastPlayed(
        key.section === 'movies' ? `${Kind.Movie}.${key.streamId}` : `${Kind.Episode}.${key.episodeId}`,
      );
    }
    return;
  }
  setWatchHistory([
    {
      section: key.section,
      streamId: key.streamId,
      positionS: Math.floor(positionS),
      durationS: Math.floor(dur),
      episodeId: key.episodeId ?? null,
      season: key.season ?? null,
      episode: key.episode ?? null,
      updatedAt: Date.now(),
    },
    ...rest,
  ].slice(0, 80));
}

export function resumeAt(rec: WatchRecord | null): number | undefined {
  if (!rec || rec.positionS < MIN_SAVE) return undefined;
  if (rec.durationS > 0 && rec.positionS >= rec.durationS - NEAR_END) return undefined;
  return rec.positionS;
}

export function watchFraction(rec: WatchRecord | null): number | null {
  if (resumeAt(rec) === undefined || !rec || rec.durationS <= 0) return null;
  return Math.min(1, rec.positionS / rec.durationS);
}

/** Writes the playhead for the current VOD title while it plays. */
export function useWatchProgress(key: WatchKey | null): void {
  const [prefs] = usePrefs();
  const keyRef = useRef(key);
  keyRef.current = key;
  const last = useRef(0);
  const pos = useRef({ t: 0, d: 0, live: true });

  useEffect(() => {
    if (!key) return;
    pos.current = { t: 0, d: 0, live: false };
    let alive = true;
    let unsub: (() => void) | null = null;
    const flush = () => {
      const k = keyRef.current;
      const p = pos.current;
      if (!k || p.live) return;
      saveWatch(k, p.t, p.d);
    };
    /*
     * playerCore stays out of the Home/search graph: PosterCard and Spotlight
     * only need getWatch/watchFraction. The engine module loads with the first
     * playing surface that mounts this hook.
     */
    void import('./playerCore.ts').then(({ player }) => {
      if (!alive) return;
      unsub = player.subscribe((s) => {
        if (s.live) {
          pos.current = { t: 0, d: 0, live: true };
          return;
        }
        if (s.phase !== 'playing' && s.phase !== 'paused') return;
        if (!Number.isFinite(s.currentTime)) return;
        /*
         * A shutdown is not the viewer going back to the start.
         *
         * Measured on the TV emulator: film at 12s, one press of BACK, and the
         * saved place was gone. `teardown` drops the native engine and zeroes its
         * clock with the phase still reading `playing`, so for one snapshot the
         * film is "playing at 0:00" — this took that as the position, the flush on
         * the way out saved it, and anything under MIN_SAVE deletes the record.
         * Every film on the TV app plays natively, so every film lost its place on
         * the way out: "pause a show and then restart, it goes back to the
         * beginning".
         *
         * So a drop to the very start, from somewhere past it, is ignored. A viewer
         * who really does go back to the beginning plays on from there, and the
         * next snapshot past MIN_SAVE records it as usual.
         */
        if (s.currentTime < MIN_SAVE && pos.current.t >= MIN_SAVE) return;
        pos.current = { t: s.currentTime, d: finiteDuration(s.duration), live: false };
        if (s.phase === 'paused') {
          last.current = Date.now();
          flush();
          return;
        }
        const now = Date.now();
        if (now - last.current < THROTTLE_MS) return;
        last.current = now;
        flush();
      });
    });
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = () => flush();
    document.addEventListener('visibilitychange', onHide);
    // Capture: playerCore tears down on bubble pagehide and zeros currentTime.
    window.addEventListener('pagehide', onPageHide, true);
    return () => {
      alive = false;
      unsub?.();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide, true);
      flush();
    };
  }, [key?.section, key?.streamId, key?.episodeId, prefs.activeId]);
}
