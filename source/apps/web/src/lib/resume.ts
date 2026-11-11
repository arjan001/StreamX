/**
 * Carry on where they left off.
 *
 * Every television remembers its channel and every streaming app remembers the
 * film you were ten minutes into. This one remembered neither: it opened on the
 * home page with nothing playing, every single time, which is the difference
 * between a product and a demonstration of one.
 *
 * ── why this is small ──
 *
 * Because the routes already do the work. Every playing surface in the app is
 * addressable and already resumes itself from its own URL:
 *
 *   /live?ch=<ref>                   restores the channel and opens it
 *   /movie/<ref>?play=1              plays, and `watch.ts` supplies the playhead
 *   /series/<ref>?ep=<episodeId>     plays that episode, from its own playhead
 *   /catchup?ch=<id>&start=…&stop=…  plays that recording
 *
 * So the memory is a route and a label, and resuming is one redirect. No second
 * playback path, and anything that becomes link-addressable later resumes for
 * free. The playhead is NOT stored here for films and episodes — `watch.ts` owns
 * that, and duplicating it would guarantee two numbers that disagree. The copy
 * kept on the mark is for drawing a progress bar on a card, never for seeking.
 *
 * ── what "automatic" has to include ──
 *
 * An app that reopens a stream unasked has to be interruptible, or it is a trap:
 * someone who left a three-hour film on is not necessarily coming back to it. So
 * the redirect happens once per launch, it says what it did, and it can be
 * dismissed with the same BACK press that leaves anything else.
 */
import { useEffect, useState } from 'react';
import {
  getLastPlayed, getPrefs, notePlay, safeRoute, setLastPlayed, usePrefs, type LastPlayed,
} from './prefs.ts';

export type { LastPlayed };

/** How often the playhead on the mark is rewritten while something plays. */
const THROTTLE_MS = 5000;
/**
 * And how often a LIVE channel's mark is — which carries no playhead, only
 * `at`, and `at` only has to be younger than `MAX_AGE_MS` (a month).
 *
 * It was the same five seconds, and every write is the whole preference store
 * serialised to storage and handed to every `usePrefs` reader on screen: each
 * tile, the header, the rails. While a channel played, the television redrew
 * the page every five seconds to record that it was still the same channel.
 * Opening the channel writes the mark (`noteLastPlayed`); this only keeps its
 * age honest for somebody who leaves one channel on for a month.
 */
const LIVE_THROTTLE_MS = 10 * 60_000;

/**
 * What the mark says, minus everything that is measured rather than declared.
 *
 * A caller knows what it opened and where; it does not know how far in the viewer
 * will get, and should not have to tell us twice.
 */
export type Mark = Pick<LastPlayed, 'route' | 'label' | 'logo' | 'kind' | 'key'>;

let current: Mark | null = null;
let lastWrite = 0;
let watching = false;

function write(mark: Mark, positionS: number, durationS: number): void {
  setLastPlayed({
    ...mark,
    positionS: Math.max(0, Math.floor(positionS)),
    durationS: Math.max(0, Math.floor(durationS)),
    at: Date.now(),
  });
}

/**
 * One subscription for the whole app, attached on first use.
 *
 * `playerCore` is a singleton and the playing surface changes underneath it, so
 * subscribing per route would mean four subscriptions racing to describe the same
 * playhead. This one only ever writes the mark that was last declared.
 */
function watch(): void {
  if (watching) return;
  watching = true;
  /* Dynamic: resume.ts is on the cold path (main → resumeRoute / Chrome banner).
     Subscribing only after noteLastPlayed keeps playerCore out of first paint. */
  void import('./playerCore.ts').then(({ player }) => {
    player.subscribe((s) => {
      const mark = current;
      if (mark === null) return;
      if (s.phase !== 'playing' && s.phase !== 'paused') return;
      /*
       * Live has no playhead worth keeping. `currentTime` on a live feed is an
       * offset into whatever the engine happens to be buffering, so storing it
       * would produce a number that means nothing and a progress bar that lies.
       */
      if (s.live) {
        const now = Date.now();
        if (now - lastWrite < LIVE_THROTTLE_MS) return;
        lastWrite = now;
        write(mark, 0, 0);
        return;
      }
      if (!Number.isFinite(s.currentTime)) return;
      const now = Date.now();
      if (s.phase === 'playing' && now - lastWrite < THROTTLE_MS) return;
      lastWrite = now;
      write(mark, s.currentTime, Number.isFinite(s.duration) ? s.duration : 0);
    });
  });
}

/**
 * Declare what is now playing.
 *
 * Called by the surface that opened it, at the moment it opened it — not after
 * the first frame. A stream that fails to open is still where the viewer was, and
 * coming back to a channel that needs a retry is more useful than coming back to
 * the home page.
 */
export function noteLastPlayed(mark: Mark): void {
  current = mark;
  lastWrite = Date.now();
  /*
   * Every open in the app already comes through here, which makes this the one
   * place a play counter can live without four call sites having to remember. It
   * is the only signal there is about live viewing: a channel has no end, so
   * "watched" can only mean "opened, often". See `prefs.notePlay`.
   */
  notePlay(mark.key);
  const prev = getLastPlayed();
  write(mark, prev?.key === mark.key ? prev.positionS : 0, prev?.key === mark.key ? prev.durationS : 0);
  watch();
}

/** Forget the mark, if it is the one named. Used when a title finishes. */
export function retireLastPlayed(key: string): void {
  if (getLastPlayed()?.key !== key) return;
  if (current?.key === key) current = null;
  setLastPlayed(null);
}

export function forgetLastPlayed(): void {
  current = null;
  setLastPlayed(null);
}

/* ── the launch decision ───────────────────────────────────────────────────── */

/**
 * Nothing older than this reopens by itself.
 *
 * A month is generous on purpose — a set-top box that comes back to last night's
 * channel is behaving correctly, and so is one that comes back to the channel from
 * a fortnight ago. What it must not do is reopen a stream from a holiday six months
 * back as if no time had passed.
 */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * Should this launch reopen the mark?
 *
 * Pure, and separate from `resumeRoute`, because the interesting parts are the
 * boundaries — the setting being off, an empty mark, a mark from six months ago —
 * and none of them are worth a browser to test.
 */
export function shouldResume(
  mark: LastPlayed | null,
  opts: { enabled: boolean; now: number },
): string | null {
  if (!opts.enabled) return null;
  if (mark === null) return null;
  const route = safeRoute(mark.route);
  if (route === null || route === '') return null;
  if (mark.at > 0 && opts.now - mark.at > MAX_AGE_MS) return null;
  return route;
}

let announced: LastPlayed | null = null;
let decided = false;

/**
 * Where this launch should open, or null for the usual start page.
 *
 * Decided once. A second call during the same run returns null, because the
 * redirect is a launch behaviour: re-running it on a later navigation to `/`
 * would drag someone back into a stream they had just left.
 */
export function resumeRoute(): string | null {
  if (decided) return null;
  decided = true;
  const prefs = getPrefs();
  const route = shouldResume(prefs.lastPlayed, {
    enabled: prefs.resumeOnOpen,
    now: Date.now(),
  });
  if (route === null) return null;
  announced = prefs.lastPlayed;
  return route;
}

/** The mark this launch resumed, until it is acknowledged. */
export function resumedMark(): LastPlayed | null {
  return announced;
}

export function clearAnnouncement(): void {
  announced = null;
  for (const fn of listeners) fn();
}

const listeners = new Set<() => void>();

/**
 * The banner's view of the launch.
 *
 * A plain module value with a listener set rather than context: exactly one
 * component reads it, once, and it has to be readable from outside React by the
 * key handler that dismisses it.
 */
export function useResumeAnnouncement(): LastPlayed | null {
  const [mark, setMark] = useState(resumedMark);
  useEffect(() => {
    const fn = () => setMark(resumedMark());
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return mark;
}

/** The mark, live, for a Home card. */
export function useLastPlayed(): LastPlayed | null {
  const [prefs] = usePrefs();
  return prefs.lastPlayed;
}
