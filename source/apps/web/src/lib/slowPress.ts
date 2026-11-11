/**
 * A press that took seconds, reported by the television that felt it.
 *
 * "Takes 10 seconds to move left right … 14 seconds from the left menu to the
 * middle … like old Windows." Every number measured here comes from an Android
 * TV emulator on a server CPU, slowed by a factor that is a guess at what a
 * MediaTek box does, against a fake panel that is not the viewer's line. It
 * found real costs and fixed them (1.51), and it still cannot say what a
 * particular box in a particular living room is waiting for.
 *
 * So the box says it. A D-pad press whose result has not reached the screen
 * `SLOW_MS` after the remote sent it becomes one line in the debug log, which
 * `errorReports` already carries to the server a few at a time:
 *
 *   a press took 3.2 s on /sports — page busy 7.1 s of the last 10 s (longest
 *   2.8 s); guide loading; library ready; pictures 3 + 12 waiting; picture on
 *   the TV player; heap 180 MB; box 2 GB, 4 cores
 *
 * Everything after the dash is what the page was doing at that moment, because
 * a slow press on its own says only that something is wrong, and each of those
 * has been the answer at least once: the whole-guide download, a library
 * rebuild, pictures holding the WebView's request threads, libVLC decoding on
 * the CPU, a heap near the box's limit.
 *
 * At most one line a minute, so a box that is slow at everything reports that
 * it is, rather than filling the queue with the same fact.
 */
import { dlog } from './debugLog.ts';
import { bulkGuideStatus } from './bulkGuide.ts';
import { localStatus } from './localCatalogue.ts';
import { turnsInUse } from './imageTurns.ts';

/** A press slower than this is reported. A remote feels 300 ms; 1.5 s is broken. */
export const SLOW_MS = 1_500;
/** And no more than one report in this long. */
export const QUIET_MS = 60_000;
/** How far back "how busy was the page" looks. */
const WINDOW_MS = 10_000;

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter']);

export interface PressContext {
  ms: number;
  route: string;
  /** Long-task time in the last ten seconds, and the longest one. */
  busyMs: number;
  worstMs: number;
  guide: string;
  library: string;
  pictures: { active: number; waiting: number };
  /** libVLC's surface has the picture (the page's `data-native-video`). */
  nativeVideo: boolean;
  heapMB: number | null;
  /** `navigator.deviceMemory` (GB, rounded by the browser) and cores, when told. */
  deviceGB: number | null;
  cores: number | null;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The line itself, pure, so the wording is pinned by a test. */
export function slowPressLine(c: PressContext): string {
  const parts = [
    `page busy ${secs(c.busyMs)} of the last 10 s${c.worstMs > 0 ? ` (longest ${secs(c.worstMs)})` : ''}`,
    `guide ${c.guide}`,
    `library ${c.library}`,
    `pictures ${c.pictures.active} + ${c.pictures.waiting} waiting`,
    c.nativeVideo ? 'picture on the TV player' : 'picture in the page',
  ];
  if (c.heapMB !== null) parts.push(`heap ${c.heapMB} MB`);
  if (c.deviceGB !== null || c.cores !== null) {
    parts.push(`box ${[c.deviceGB === null ? null : `${c.deviceGB} GB`, c.cores === null ? null : `${c.cores} cores`]
      .filter((x) => x !== null).join(', ')}`);
  }
  return `a press took ${secs(c.ms)} on ${c.route} — ${parts.join('; ')}`;
}

let installed = false;

/** Start listening. Once; main.tsx calls it beside the other debug hooks. */
export function installSlowPress(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  /* [end, duration] of each long task, newest last. A WebView without the
     entry type still reports the press, with the page's business unknown. */
  const long: [number, number][] = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) long.push([e.startTime + e.duration, e.duration]);
      if (long.length > 300) long.splice(0, long.length - 300);
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* not supported here */ }
  let lastReport = -QUIET_MS;
  addEventListener('keydown', (e) => {
    if (!NAV_KEYS.has(e.key) || e.repeat) return;
    /* `timeStamp` is when the remote's key reached the page, so the wait in the
       queue behind whatever was running counts — that is the part a viewer
       feels. The frame after the handlers is when the answer can be seen. */
    const at = e.timeStamp;
    requestAnimationFrame(() => window.setTimeout(() => {
      const now = performance.now();
      const ms = now - at;
      if (ms < SLOW_MS || now - lastReport < QUIET_MS) return;
      lastReport = now;
      const recent = long.filter(([end]) => end >= now - WINDOW_MS);
      const guide = bulkGuideStatus();
      const lib = localStatus();
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      dlog.warn('perf', slowPressLine({
        ms,
        route: location.hash.replace(/^#/, '').split('?')[0] || location.pathname,
        busyMs: recent.reduce((a, [, d]) => a + d, 0),
        worstMs: recent.reduce((a, [, d]) => Math.max(a, d), 0),
        guide: guide.state,
        library: lib.state === 'loading' && lib.phase !== null ? `loading ${lib.phase}` : lib.state,
        pictures: turnsInUse(),
        nativeVideo: document.documentElement.dataset.nativeVideo === 'on',
        heapMB: mem === undefined ? null : Math.round(mem.usedJSHeapSize / 1e6),
        deviceGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
        cores: navigator.hardwareConcurrency || null,
      }));
    }, 0));
  }, true);
}
