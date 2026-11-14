/**
 * Every error, from every television, without anybody pressing anything.
 *
 * Asked for as: "i want you to send all errors to the server, and in admin add a
 * config toggle or something that marks it enabled then all error logs will go
 * to the server, with a debounce of a few mins so we get a few at a time".
 *
 * ── why it was needed ──
 *
 * The app has had somewhere to report to for a while, and almost nothing ever
 * arrives: eight reports in eight days, all from two people who were asked to
 * send them. Everything else requires a viewer to find the diagnostics screen
 * behind five taps on the build line and a PIN, which nobody outside this room
 * has ever done. So the failures that matter — a decoder that refuses, a door
 * that will not answer, a film that stops after ninety seconds — happen on a box
 * in somebody's living room and are never seen here at all.
 *
 * ── the three rules it keeps ──
 *
 * **Off unless an operator turns it on.** `errorReports` in app-config, false by
 * default, re-read when the app comes back to the front so switching it on
 * reaches a running television without waiting for a restart. This is telemetry: it
 * costs a viewer bandwidth and it should be a decision, not a default.
 *
 * **A few at a time, not one request per failure.** Errors do not arrive singly —
 * a stream that will not open produces six lines in two seconds — and a device
 * that is failing is the worst possible one to ask for six round trips. So they
 * queue, repeats are folded into a count, and the queue is posted every
 * `FLUSH_MS`.
 *
 * **Never a loop.** The fetch wrapper in `debugLog` records failed requests as
 * errors, so a flush that fails would record its own failure, queue it, and try
 * again for ever. Anything about our own reporting endpoint is dropped before it
 * is queued, and a flush in flight never starts another.
 *
 * Nothing here is new evidence: it sends the lines the debug panel already shows,
 * redacted by the same rule, and the server redacts again on arrival.
 */
import { apiUrl } from './api.ts';
import { subscribeAppConfig } from './appConfig.ts';
import { applyOperatorConfig, watchOperatorFlags } from './operatorFlags.ts';
import { deviceSummary, launchId, subscribeErrors, type DebugEntry } from './debugLog.ts';
import { getSession } from './session.ts';

/**
 * How long a queue waits before it is sent — "a debounce of one minute".
 *
 * Measured from the FIRST error in the queue, not the last. That distinction is
 * the whole design: a true debounce restarts its timer on every new event, so a
 * television in a crash loop — which is precisely the one worth hearing from —
 * would produce errors faster than the timer could expire and would never report
 * at all. A fixed window from the first error means the report always arrives,
 * one minute after something started going wrong, with everything that
 * happened in between in it.
 */
export const FLUSH_MS = 60_000;

/**
 * How often a heartbeat is sent — every 5 minutes.
 *
 * A heartbeat is a synthetic "info" entry that carries the device identity,
 * app version, build number and platform type. It lets the logs panel show
 * every installed device even when nothing has gone wrong, and it keeps the
 * "last seen" timestamp fresh for the device list.
 */
const HEARTBEAT_MS = 5 * 60_000;

/**
 * The most distinct errors one flush carries. The server caps at the same
 * number; this is the client half of one rule.
 *
 * Distinct, because repeats are folded: a loop that raises the same line four
 * hundred times is one entry with `count: 400`, which says more than four hundred
 * copies would and costs a four-hundredth of the request.
 */
export const MAX_QUEUE = 30;

/** One error, with however many times it has happened since the last flush. */
export interface QueuedError {
  tag: string;
  text: string;
  level: string;
  count: number;
  /** Wall clock of the FIRST occurrence, ms — turned into an age when sent. */
  firstAt: number;
}

/**
 * Is this line safe to report, or is it about the reporting itself?
 *
 * Exported because it is the guard that stops an infinite loop, and a guard that
 * is only exercised by accident is a guard nobody knows is broken. `/api/log`
 * covers the batch route too, which lives under it.
 */
export function reportable(e: { tag: string; text: string; level?: string }): boolean {
  if (e.text.trim() === '') return false;
  if (e.text.includes('/api/log')) return false;
  /*
   * "Only the important logs, not the logs that try other servers."
   *
   * The fetch wrapper records every failed request, and almost none of them is
   * news: a sign-in walks four doors on two schemes and expects most to fail,
   * artwork is rate-limited by design, and this provider serves no guide at
   * all. Whatever a failed request actually BROKE is reported by the part of
   * the app that cared — the player, sign-in, the catalogue — in words that
   * say what the viewer saw. So raw requests are never sent.
   */
  if (e.tag === 'fetch') return false;
  const said = `${e.tag}: ${e.text}`;
  if (NOISE.some((re) => re.test(said))) return false;
  /* A warning is sent only from the parts of the app whose warnings mean the
     viewer noticed something. `exit`, say, warns about a dialog; nobody fixes
     anything with that. */
  if (e.level === 'warn') return WARN_TAGS.has(e.tag);
  return true;
}

/** Tags whose warnings describe something a viewer saw go wrong. */
const WARN_TAGS = new Set(['player', 'native', 'signin', 'catalogue', 'captions', 'update', 'perf']);

/**
 * Steps on the way to an answer, not answers.
 *
 * The player tries doors, retries over plain http and asks what a URL serves
 * as a matter of course; the verdict it reaches is what is worth reading, and
 * it arrives as its own line.
 */
const NOISE: readonly RegExp[] = [
  /^player: try door\b/i,
  /^player: door refused:/i,
  /^player: retry over plain http/i,
  /^player: server says /i,
  /player_api\.php/i,
  /get_short_epg|get_simple_data_table|xmltv\.php/i,
];

/**
 * What makes two lines the same problem.
 *
 * "If there are multiple errors then send it once." The same failure rarely
 * reads identically twice: it carries a duration, a stream id, a byte count,
 * a query string. Folded on the exact text, a stall on six channels was six
 * lines; folded on this it is one line with a count of six.
 */
export function signature(tag: string, text: string): string {
  const shape = text
    .replace(/\?[^\s'")]*/g, '')             // query strings
    .replace(/\(\s*\d+(\.\d+)?\s*m?s\s*\)/g, '') // "(370ms)"
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return `${tag}|${shape}`;
}

/**
 * How long a device stays quiet about a problem it has already reported.
 *
 * Folding handles a burst inside one report; this handles the television that
 * fails the same way all evening. Once in half an hour says it is still
 * happening, which is all a second copy would.
 */
export const RESEND_MS = 30 * 60_000;
const lastSent = new Map<string, number>();

/**
 * Add one error to a queue, folding it into an identical line if there is one.
 *
 * Pure, so the folding and the cap can be pinned without a timer or a network.
 * Identity is tag plus text: two failures that read the same ARE the same as far
 * as anyone reading the admin screen is concerned, and that screen already groups
 * on the message.
 */
export function fold(
  queue: readonly QueuedError[], e: { tag: string; text: string; level: string; t: number },
): QueuedError[] {
  const sig = signature(e.tag, e.text);
  const at = queue.findIndex((q) => signature(q.tag, q.text) === sig);
  if (at >= 0) {
    const copy = [...queue];
    copy[at] = { ...copy[at]!, count: copy[at]!.count + 1 };
    return copy;
  }
  /* Full: keep what is already there. The first errors of an episode say why it
     started; the four hundredth says it is still going, which the counts on the
     lines above already say. */
  if (queue.length >= MAX_QUEUE) return [...queue];
  return [...queue, { tag: e.tag, text: e.text, level: e.level, count: 1, firstAt: e.t }];
}

/** The body posted to `/api/log/batch`. Pure, and the shape the test pins. */
export function flushBody(
  queue: readonly QueuedError[], now: number,
): {
  deviceId: string; accountId: string | null; entries: unknown[]; device: Record<string, string>;
  version: string; platform: string;
} {
  // Include account ID for per-user identification in logs
  const session = getSession();
  return {
    deviceId: launchId(),
    accountId: session?.account ?? null,
    entries: queue.map((q) => ({
      tag: q.tag,
      text: q.text,
      level: q.level,
      count: q.count,
      ago: Math.max(0, Math.round((now - q.firstAt) / 1000)),
    })),
    device: Object.fromEntries(deviceSummary()),
    version: BUILD === '' ? VERSION : `${VERSION}+${BUILD}`,
    platform: NATIVE ? 'android-app' : 'web',
  };
}

const VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? 'dev';
const BUILD = (import.meta.env?.VITE_APP_BUILD as string | undefined) ?? '';
const NATIVE = (import.meta.env?.VITE_PLATFORM as string | undefined) === 'capacitor';
const API_ORIGIN = (import.meta.env?.VITE_API_ORIGIN as string | undefined) ?? '';

// Debug: log the beta mode and API origin at startup — critical for diagnosing why logs don't arrive
if (typeof window !== 'undefined') {
  const isBeta = NATIVE && BUILD !== '';
  console.log('[errorReports] Startup diagnostics:');
  console.log('[errorReports]   NATIVE (capacitor):', NATIVE);
  console.log('[errorReports]   BUILD number:', BUILD);
  console.log('[errorReports]   IS_BETA (auto-enable logs):', isBeta);
  console.log('[errorReports]   API_ORIGIN (log endpoint base):', API_ORIGIN || '(EMPTY — logs will NOT reach the server!)');
  console.log('[errorReports]   VERSION:', VERSION);
  if (NATIVE && API_ORIGIN === '') {
    console.error('[errorReports] CRITICAL: APK built without VITE_API_ORIGIN! Logs cannot reach the server. Rebuild with STREAMIX_API_ORIGIN=https://dev.lovix.com');
  }
}

/* ── the live half ─────────────────────────────────────────────────────────── */

let enabled = false;
let queue: QueuedError[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sending = false;
let installed = false;

/** For the test, and for the admin toggle taking effect without a reload. */
export function setErrorReportsEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (on) return;
  lastSent.clear();
  /* Turned off: nothing already queued is sent. An operator who switches this
     off has withdrawn consent for the lot, not for the next one. */
  queue = [];
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

export function errorReportsEnabled(): boolean {
  return enabled;
}

/** What is waiting to be sent. Exported for the test only. */
export function queued(): readonly QueuedError[] {
  return queue;
}

/**
 * One error offered to the queue.
 *
 * Exported because it is where the two rules that matter meet — the flag is
 * checked here, and the flush window starts here — and neither can be pinned
 * through `installErrorReports`, which needs a `window` to install into.
 */
export function noteError(e: DebugEntry): void {
  if (!enabled || !reportable(e)) return;
  const sig = signature(e.tag, e.text);
  const sentAt = lastSent.get(sig);
  if (sentAt !== undefined && e.t - sentAt < RESEND_MS) return;
  queue = fold(queue, e);
  console.log('[errorReports] Queued error:', e.tag, e.text, 'Queue size:', queue.length);
  /* The window starts with the first error and is not extended — see FLUSH_MS. */
  if (timer === null) timer = setTimeout(() => { void flush(); }, FLUSH_MS);
}

/**
 * Send a heartbeat so the device appears in the logs panel even when idle.
 *
 * Runs every HEARTBEAT_MS. The heartbeat is a synthetic "info" entry with
 * tag "heartbeat" that carries the version, build, and platform. It is
 * deduplicated by the same RESEND_MS rule, so only one heartbeat per 30
 * minutes actually reaches the server.
 */
function sendHeartbeat(): void {
  if (!enabled) return;
  const version = BUILD === '' ? VERSION : `${VERSION}+${BUILD}`;
  const platform = NATIVE ? 'android-app' : 'web';
  const device = Object.fromEntries(deviceSummary());
  const model = device.model ?? 'unknown';
  const text = `heartbeat v=${version} build=${BUILD || '0'} platform=${platform} model=${model}`;
  const sig = signature('heartbeat', text);
  const sentAt = lastSent.get(sig);
  if (sentAt !== undefined && Date.now() - sentAt < RESEND_MS) return;
  queue = fold(queue, { tag: 'heartbeat', text, level: 'info', t: Date.now() });
  lastSent.set(sig, Date.now());
  /* Flush immediately so the device shows up right away */
  void flush();
}

export async function flush(): Promise<boolean> {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (sending || queue.length === 0) return false;
  const batch = queue;
  queue = [];
  sending = true;
  const now = Date.now();
  for (const q of batch) lastSent.set(signature(q.tag, q.text), now);
  try {
    const url = apiUrl('/api/log/batch');
    console.log('[errorReports] Flushing', batch.length, 'entries to', url);
    console.log('[errorReports]   API_ORIGIN used:', API_ORIGIN || '(EMPTY — relative URL!)');
    const body = flushBody(batch, Date.now());
    console.log('[errorReports]   deviceId:', body.deviceId, 'platform:', body.platform, 'version:', body.version);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('[errorReports] Flush response:', res.status, res.ok ? 'OK' : 'FAILED');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log('[errorReports] Server response body:', text.slice(0, 200));
    }
    return res.ok;
  } catch (e) {
    console.error('[errorReports] Flush network error:', e);
    console.error('[errorReports]   This usually means the API_ORIGIN is not set correctly in the APK build.');
    /*
     * Dropped, deliberately, rather than put back.
     *
     * Re-queuing looks kinder and is not: the device is offline or this box is
     * down, the next flush will fail the same way, and the queue grows until
     * something that was meant to be diagnostic is the biggest thing in memory.
     * The errors are still in the debug buffer, and whatever is still wrong will
     * raise them again.
     */
    return false;
  } finally {
    sending = false;
  }
}

/**
 * Start listening, and follow the operator's switch.
 *
 * Called once from `main.tsx`, beside `installDebugCapture`. It subscribes
 * before it knows whether reporting is on, because `note` checks the flag itself
 * — and because the errors worth having are often the ones raised during boot,
 * before any config has arrived.
 *
 * Beta mode: error reports are always enabled in beta builds so the client can
 * see all user logs automatically without server config.
 */
const IS_BETA = NATIVE && BUILD !== '';

export function installErrorReports(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  console.log('[errorReports] installErrorReports called');
  console.log('[errorReports]   IS_BETA:', IS_BETA, '(NATIVE:', NATIVE, 'BUILD:', BUILD + ')');
  console.log('[errorReports]   API_ORIGIN for flush:', API_ORIGIN || '(EMPTY — flush will fail!)');

  // Beta mode: always enable error reporting for client monitoring
  if (IS_BETA) {
    console.log('[errorReports] Beta mode: enabling error reports automatically');
    setErrorReportsEnabled(true);
  }

  subscribeErrors(noteError);

  const read = (raw: unknown): void => {
    /* The operator's other switches ride the same body rather than paying for
       a second fetch of the same document — see `operatorFlags.ts`. */
    applyOperatorConfig(raw);
    if (raw !== null && typeof raw === 'object') {
      // Beta mode overrides server config
      if (!IS_BETA) {
        setErrorReportsEnabled((raw as { errorReports?: unknown }).errorReports === true);
      }
    }
  };
  watchOperatorFlags();

  /* The shared config document — fetched at boot and when the app comes back
     to the front after six hours (lib/appConfig.ts). Until it answers, and for
     ever when there is no box, reporting stays off, which is the default. */
  subscribeAppConfig(read);

  /*
   * Heartbeat: send device presence every 5 minutes so the logs panel shows
   * every installed device even when nothing goes wrong. The heartbeat carries
   * version, build, platform and model. It is deduplicated by RESEND_MS (30 min)
   * so only one heartbeat per 30 minutes actually reaches the server.
   */
  if (IS_BETA) {
    // Send initial heartbeat immediately so the device shows up right away
    setTimeout(() => { sendHeartbeat(); }, 10_000);
    heartbeatTimer = setInterval(() => { sendHeartbeat(); }, HEARTBEAT_MS);
  }

  /*
   * A television being switched off is the end of the window, not a reason to
   * lose it. `sendBeacon` hands the body to the platform, which delivers it after
   * the page is gone; a `fetch` here is cancelled on unload and arrives nowhere.
   */
  window.addEventListener('pagehide', () => {
    if (!enabled || queue.length === 0) return;
    try {
      const body = JSON.stringify(flushBody(queue, Date.now()));
      queue = [];
      navigator.sendBeacon?.(apiUrl('/api/log/batch'), new Blob([body], { type: 'application/json' }));
    } catch { /* nothing useful to do while the page is being torn down */ }
  });
}
