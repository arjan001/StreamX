/**
 * The log a television can show you.
 *
 * A set-top box has no devtools, an emulator's logcat is three screens away from
 * the picture, and the player's own error box has room for two sentences. So
 * when a channel would not open the only report that ever came back was "none of
 * them work", which is true and contains no evidence.
 *
 * This is the evidence. A ring buffer of what the app decided — which engine it
 * chose, which URL it asked for, what hls.js or libVLC said back, why it
 * escalated, when it gave up — plus anything the page itself threw. `DebugPanel`
 * draws it behind a floating button; `sendDebugReport` posts it to `/api/log`
 * so a device nobody can type on can still hand the log over.
 *
 * ── what it is not ──
 *
 * Not analytics, not a session record. Nothing here is written to disk; the
 * buffer is the current page's memory and dies with it. Provider URLs carry a
 * subscription's credentials in the path, so every line is redacted on the way
 * in with the same rule the server applies again on arrival.
 *
 * ── when it shows ──
 *
 * Off by default, everywhere — a viewer should never meet a console by accident.
 * It is unlocked under More → About the way Android's developer options are: tap
 * the build line a few times to reveal a PIN field, then enter the PIN. The
 * choice lives in `kv` so it survives a restart — turning it on to reproduce
 * something and having it gone by the time the channel is chosen is no use.
 */
import { useSyncExternalStore } from 'react';
import { kv } from './kv.ts';
import { apiUrl } from './api.ts';
import { hasNativeEngine, nativeEngineAsked, nativeDecoderNames } from './nativePlayer.ts';
import { knownHardware } from './deviceInfo.ts';

export type DebugLevel = 'info' | 'warn' | 'error';

/**
 * The name a report goes out under: invented at launch, held in memory, never
 * stored.
 *
 * It used to be the presence device id — the same name the live roster knew this
 * television by, kept in `kv` for ever — so every error report could be joined to
 * a household and to what it had been watching. Presence is gone, and the log
 * sink only needs something to rate-limit by (log.ts on the box refuses a report
 * with no name). A name that dies with the process groups one launch's reports
 * together and cannot follow anyone across two.
 */
let launch: string | null = null;
export function launchId(): string {
  if (launch !== null) return launch;
  let made = '';
  try {
    made = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
  } catch {
    made = Math.random().toString(36).slice(2).padEnd(12, '0');
  }
  launch = made;
  return made;
}

export interface DebugEntry {
  id: number;
  /** Wall clock, ms. */
  t: number;
  level: DebugLevel;
  /** Who said it: `player`, `native`, `fetch`, `page`, `boot`. */
  tag: string;
  text: string;
}

/** Enough for a whole evening of channel hopping; small enough to never matter. */
const MAX = 400;
/** One line of the on-screen log. Longer is a wall, not a message. */
const LINE_MAX = 600;

let seq = 0;
let entries: DebugEntry[] = [];
let errors = 0;
const subs = new Set<() => void>();

/**
 * Strip anything that identifies a subscription.
 *
 * Mirrors `redact` in `apps/server/src/log.ts`. Both exist on purpose: the two
 * will disagree one day, and the safe direction to be wrong in is twice.
 */
/*
 * One separator, two spellings.
 *
 * A provider path puts the credentials between slashes — `/movie/<user>/<pass>/…`.
 * But the same URL also travels as a QUERY PARAMETER inside another address
 * (a `?u=` or `?url=` wrapper), and a query parameter is percent-encoded:
 *
 *     ?u=http%3A%2F%2Fhost%2Fmovie%2F<user>%2F<pass>%2F123.mp4
 *
 * There is not a single `/` between `movie` and the id there, and the debug
 * panel is the screen a viewer is invited to send to support. So the separator
 * is either spelling, and a segment is anything that is not one.
 */
const SEP = '(?:\\/|%2[Ff])';
const SEG = `(?:(?!${SEP})[^\\s])+`;
const CREDS = new RegExp(`${SEP}(live|movie|series|timeshift)${SEP}${SEG}${SEP}${SEG}${SEP}`, 'gi');

/**
 * The names a Stalker portal's requests and the device identity travel under.
 * The server's own redactor strips the same set; keep the two in step.
 */
const SECRET_KEYS = 'username|password|token|mac|sn|serial|device_id2?|signature';

export function redactSecrets(text: string): string {
  return text
    .replace(new RegExp(`([?&;\\s](?:${SECRET_KEYS})=)[^&;\\s]*`, 'gi'), '$1<redacted>')
    /* The same pairs, percent-encoded, which is how they arrive inside `?u=`. */
    .replace(new RegExp(`((?:${SECRET_KEYS})%3D)(?:(?!%26)[^&\\s])*`, 'gi'), '$1<redacted>')
    /* A JSON body or a logged object. */
    .replace(new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*")[^"]*(")`, 'gi'), '$1<redacted>$2')
    /* Header lines: the portal's `Cookie: mac=...` and its bearer token. */
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '$1: <redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    /* A MAC address wherever it turns up, in either spelling. */
    .replace(/\b[0-9A-F]{2}(?:(?::|%3A)[0-9A-F]{2}){5}\b/gi, '<mac>')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//<redacted>@')
    .replace(CREDS, '/$1/<redacted>/<redacted>/');
}

function notify(): void {
  for (const fn of subs) fn();
}

function push(level: DebugLevel, tag: string, text: string): void {
  const entry: DebugEntry = {
    id: ++seq, t: Date.now(), level, tag, text: redactSecrets(String(text)).slice(0, LINE_MAX),
  };
  /* A new array each time: `useSyncExternalStore` compares by reference. */
  entries = entries.length >= MAX ? [...entries.slice(entries.length - MAX + 1), entry] : [...entries, entry];
  if (level === 'error') errors += 1;
  /* Every error AND warning in the app passes through here, which is why the
     automatic reporter hangs off this line rather than off each failure site.
     Warnings too, because the player's most telling moments are warnings — a
     frozen picture, a retry in software, a seek that broke the stream — and
     none of them ever reached the server while only errors were offered. The
     reporter decides what is worth sending. A watcher that throws must not
     take the failure it is reporting with it. */
  if (level === 'error' || level === 'warn') {
    for (const fn of errorWatchers) { try { fn(entry); } catch { /* never */ } }
  }
  notify();
}

/**
 * Called once for every error the app records, with the redacted entry.
 *
 * A one-way door on purpose: `errorReports.ts` subscribes to this, and this file
 * knows nothing about it. The dependency has to point that way — the reporter
 * needs the log, the log must keep working with no reporter at all — and a
 * circular import between the two would be the kind of thing that only shows up
 * as an undefined function in a production bundle.
 */
const errorWatchers = new Set<(e: DebugEntry) => void>();

export function subscribeErrors(fn: (e: DebugEntry) => void): () => void {
  errorWatchers.add(fn);
  return () => { errorWatchers.delete(fn); };
}

export const dlog = {
  info: (tag: string, text: string): void => push('info', tag, text),
  warn: (tag: string, text: string): void => push('warn', tag, text),
  error: (tag: string, text: string): void => push('error', tag, text),
};

/* ── a field's own keydown, for the report a viewer cannot type ──────────────
 * "When the keyboard opens and you press OK... instead of pressing enter it
 * presses a number or a character." Nothing here can see the platform's own
 * on-screen keyboard, or which of ITS keys was highlighted when OK landed —
 * that is outside the page entirely. What the page DOES see is the keydown
 * the IME leaves behind, and that is the evidence a report from the television
 * needs: whether it carried `key: 'Enter'`, whether `isComposing` or
 * `keyCode 229` say the IME was still mid-composition, whether it repeated.
 * `lib/keys.ts` calls this for every keydown that reaches a focused field.
 */

/**
 * Would printing this key, exactly as it was pressed, spell out what a
 * password field holds? A single character IS the content; Enter, Backspace
 * and the arrows name an action and carry nothing secret, composing or not.
 */
function isFieldContent(key: string): boolean {
  return key.length === 1;
}

/**
 * A key name that is safe to reason about, whatever arrived.
 *
 * An event is not always the shape its type says. `keyCode` is deprecated and
 * absent on some IMEs; a television's on-screen keyboard is exactly the place
 * a half-formed keydown turns up — and this function's whole reason for
 * existing is that keyboard. Missing is NOT the empty string here: an unknown
 * key in a password field is redacted rather than printed, because the one
 * thing that must not happen is a character reaching the log.
 */
function saidKey(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The line itself, built from plain values so the redaction rule can be
 * pinned without a DOM.
 *
 * `logFieldKeydown` below is the part that has to touch one, and it was called
 * "a thin enough wrapper to not need its own test" here, in this comment, for
 * as long as it was broken — the tests all handed THIS function a hand-made
 * object, which is precisely the shape a DOM event is not. A wrapper thin
 * enough to skip testing is thin enough to read wrong, and the way it read
 * wrong was invisible from here. The browser-side probes assert it now.
 *
 * `redactSecrets` hides a FINISHED string; that does nothing here,
 * because a password never arrives whole — it comes one keydown at a time —
 * so this redacts by field type instead, before the string is ever built.
 */
export function fieldKeydownLine(e: {
  key?: string | undefined;
  code?: string | undefined;
  keyCode?: number | undefined;
  isComposing?: boolean | undefined;
  repeat?: boolean | undefined;
  field: string;
  /** From a `type="password"` element — see `logFieldKeydown`. */
  sensitive: boolean;
}): string {
  const said = saidKey(e.key);
  /* Fail CLOSED on a key nobody named: unknown plus a password field is
     redacted, not printed. A line that says `<char>` when it did not have to
     costs a diagnostic nothing; the other mistake puts a password in a log. */
  const hide = e.sensitive && (said === null || isFieldContent(said));
  const key = hide ? '<char>' : said === null ? '<none>' : said === ' ' ? 'Space' : said;
  const code = hide ? '<char>' : saidKey(e.code) ?? '<none>';
  const keyCode = hide ? '<redacted>'
    : typeof e.keyCode === 'number' ? String(e.keyCode) : '<none>';
  return `key=${key} code=${code} keyCode=${keyCode} `
    + `composing=${e.isComposing === true} repeat=${e.repeat === true} field=${e.field}`;
}

/**
 * A name for a focused field that is safe to put in the log — never its
 * value, which can be a password or a PIN. Every field this was written for
 * already carries an `aria-label`, for the same reason a screen reader needs
 * one; the rest are fallbacks for anything that does not.
 */
export function fieldDebugName(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return 'unknown';
  const named = target.getAttribute('aria-label')
    ?? target.getAttribute('name')
    ?? (target.id !== '' ? target.id : null)
    ?? target.getAttribute('placeholder');
  if (named !== null && named.trim() !== '') return named;
  const type = target instanceof HTMLInputElement ? target.type : null;
  return type === null ? target.tagName.toLowerCase() : `${target.tagName.toLowerCase()}[${type}]`;
}

/**
 * One line of evidence: everything about a keydown except the one thing that
 * could be a password.
 */
export function logFieldKeydown(e: {
  key?: string | undefined;
  code?: string | undefined;
  keyCode?: number | undefined;
  isComposing?: boolean | undefined;
  repeat?: boolean | undefined;
  target: EventTarget | null;
}): void {
  const el = e.target instanceof HTMLElement ? e.target : null;
  const sensitive = el instanceof HTMLInputElement && el.type === 'password';
  /*
   * Named one at a time, because `{ ...e }` COPIES NOTHING from a DOM event.
   *
   * `key`, `code`, `keyCode`, `isComposing` and `repeat` are getters on
   * `KeyboardEvent.prototype`, and object spread takes only OWN enumerable
   * properties — so the spread produced `{}`, `e.key` was `undefined` inside
   * the line builder, and `undefined.length` threw. Every keydown in every
   * text field, since the day this was written:
   *
   *   TypeError: Cannot read properties of undefined (reading 'length')
   *
   * Two things came of that and the second is much worse than the first. This
   * diagnostic — built for the television report "when the keyboard opens and
   * you press OK it presses a number instead of Enter" — never wrote a single
   * line. And because it throws from inside the global keydown listener, it
   * took everything AFTER it down with it: the Tab trap, `intentFor`, and the
   * rule that BACK is never swallowed by a text field. Which is to say a
   * viewer on a television who focused the username box could not get out of
   * it with the remote, and the fix for that was sitting right there, four
   * lines below a line that always threw.
   */
  dlog.info('field', fieldKeydownLine({
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    isComposing: e.isComposing,
    repeat: e.repeat,
    field: fieldDebugName(el),
    sensitive,
  }));
}

export function debugEntries(): readonly DebugEntry[] {
  return entries;
}

export function debugErrorCount(): number {
  return errors;
}

export function subscribeDebug(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function clearDebug(): void {
  entries = [];
  errors = 0;
  notify();
}

/* ── on or off ─────────────────────────────────────────────────────────────── */

const KEY = 'iptv.debug';
const NATIVE = (import.meta.env?.VITE_PLATFORM as string | undefined) === 'capacitor';

/**
 * "Open the log", asked from somewhere that is not the floating button.
 *
 * The button lives in the bottom-right corner over everything, and a corner is
 * the one place D-pad geometry cannot honestly serve: nothing shares its row and
 * nothing shares its column, so no arrow from the middle of a page is
 * unambiguously "towards" it. Reported as "i cannot select debug mode bcs of
 * it" — and `pickNext` gained a last-resort tier for lone controls in the same
 * change, but a corner button should not depend on a tie-break.
 *
 * Diagnostics are turned ON in Settings, so Settings is where opening the log
 * belongs too: one reachable place for both halves. The panel
 * owns its own open state and this is how something outside asks for it.
 */
const openRequests = new Set<() => void>();

export function requestDebugPanel(): void {
  for (const fn of openRequests) fn();
}

export function subscribeDebugPanel(fn: () => void): () => void {
  openRequests.add(fn);
  return () => { openRequests.delete(fn); };
}

export function debugEnabled(): boolean {
  /* Off unless explicitly turned on: a viewer is not shown a console all the
     time. The floating button and the log appear only after someone unlocks
     diagnostics with the PIN. */
  return kv.get(KEY) === 'on';
}

export function setDebugEnabled(on: boolean): void {
  kv.set(KEY, on ? 'on' : 'off');
  notify();
}

/**
 * The code that turns diagnostics on, and the taps that reveal the box to type it.
 *
 * Diagnostics are a support tool, not something a viewer should ever meet by
 * accident — so enabling them is gated twice, the way Android's own developer
 * options are. First a hidden gesture (tap the build line a few times) reveals
 * the PIN field; then the PIN itself enables it. `4788` spells IPTV on a phone
 * keypad. Change it here if it ever needs to be secret from the people who have
 * read this file. It is not a security boundary — a determined person reads it in
 * the bundle — it is a guard against an ordinary viewer stumbling into a console.
 */
export const DEV_PIN = '4788';
/** How many taps on the build line reveal the PIN field. Android uses seven. */
export const DEV_TAPS = 5;

export function checkDevPin(pin: string): boolean {
  return pin.trim() === DEV_PIN;
}

export function useDebugEnabled(): boolean {
  return useSyncExternalStore(subscribeDebug, debugEnabled, () => false);
}

/* ── what the device is ────────────────────────────────────────────────────── */

const VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? 'dev';
const BUILD = (import.meta.env?.VITE_APP_BUILD as string | undefined) ?? '';

/** The header of every report: the questions support asks before any other. */
export function deviceSummary(): [string, string][] {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const chrome = nav === null ? null : (/Chrome\/(\d+)/.exec(nav.userAgent) ?? [])[1] ?? null;
  const rows: [string, string][] = [
    ['Build', BUILD === '' ? VERSION : `${VERSION}+${BUILD}`],
    ['Running as', NATIVE ? 'installed app' : 'browser'],
    /* Three answers, not two — see `nativeEngineAsked`. A header written before
       the probe has run used to report a device that HAS libVLC as WebView-only,
       which is the first thing anyone reading the report believes. */
    ['Native engine', hasNativeEngine() ? 'libVLC present'
      : nativeEngineAsked() ? 'none — WebView only' : 'still asking…'],
    ['Web engine', chrome === null ? 'unknown' : `Chromium ${chrome}`],
  ];
  /* WHICH television. A report saying "installed app, Chromium 114" describes
     ten thousand different boxes, and a decoder that refuses a profile it
     advertises is a fault of ONE maker's firmware. Absent in a browser and on
     an install running an older APK — a row that is not there is better than a
     row that says "unknown". */
  const box = knownHardware();
  if (box !== null) rows.push(['Device', box]);
  /* And what its decoders are called. `OMX.MS.AVC.Decoder` failing where
     `c2.android.avc.decoder` works is the difference between "this brand cannot
     play our films" and "this brand's hardware path cannot, and the software
     one can" — which is a setting, not a rewrite. */
  const decoders = nativeDecoderNames();
  if (decoders.length > 0) rows.push(['Decoders', decoders.join(', ')]);
  if (typeof window !== 'undefined') {
    rows.push(['Viewport', `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`]);
    rows.push(['Origin', location.origin]);
  }
  if (nav !== null) rows.push(['Online', nav.onLine ? 'yes' : 'no']);
  return rows;
}

/* ── capture what the page did not mean to say ─────────────────────────────── */

let installed = false;

/**
 * Hook the channels a failure leaks through when nobody is logging it.
 *
 * `console.error`/`warn` because that is where every library reports; the two
 * window events because an uncaught throw otherwise vanishes into a WebView with
 * no console attached; and `fetch`, failures only, because "the catalogue never
 * arrived" and "the stream never arrived" both start as a request that did not
 * come back. Successful requests are not recorded — that would be a session log.
 */
export function installDebugCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  dlog.info('boot', deviceSummary().map(([k, v]) => `${k}: ${v}`).join(' · '));
  if (typeof navigator !== 'undefined') dlog.info('boot', `UA ${navigator.userAgent}`);

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => { push('error', 'console', args.map(fmt).join(' ')); origError(...args); };
  console.warn = (...args: unknown[]) => { push('warn', 'console', args.map(fmt).join(' ')); origWarn(...args); };

  window.addEventListener('error', (e) => {
    push('error', 'page', `${e.message} (${e.filename?.split('/').pop() ?? '?'}:${e.lineno})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    push('error', 'page', `unhandled rejection: ${fmt(e.reason)}`);
  });
  window.addEventListener('offline', () => push('warn', 'net', 'offline'));
  window.addEventListener('online', () => push('info', 'net', 'online'));

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const started = performance.now();
    try {
      const res = await origFetch(input, init);
      if (!res.ok) push('warn', 'fetch', `${res.status} ${shortUrl(url)} (${Math.round(performance.now() - started)}ms)`);
      return res;
    } catch (err) {
      /* An aborted request is the caller changing its mind, not a failure. */
      if (init?.signal?.aborted !== true) {
        push('error', 'fetch', `${fmt(err)} ${shortUrl(url)} (${Math.round(performance.now() - started)}ms)`);
      }
      throw err;
    }
  };
}

function fmt(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Host and the tail of the path: enough to know which request, never the credentials. */
export function shortUrl(url: string, max = 96): string {
  /*
   * Parse the REAL url, then redact the string it produced.
   *
   * Redacting first put the literal `<redacted>` inside a URL, and reading
   * `pathname` back percent-encoded it — so the log read
   * `/movie/%3Credacted%3E/%3Credacted%3E/2131378.mkv`, which looks like the app
   * is playing a mangled address rather than hiding a password. Same protection,
   * legible output.
   */
  try {
    const u = new URL(url, typeof location === 'undefined' ? 'http://x' : location.href);
    const s = redactSecrets(`${u.host}${u.pathname}${u.search}`);
    return s.length > max ? `${s.slice(0, 40)}…${s.slice(-(max - 41))}` : s;
  } catch {
    return redactSecrets(url).slice(0, max);
  }
}

/* ── hand it over ──────────────────────────────────────────────────────────── */

export type ReportOutcome = 'sent' | 'dropped' | 'failed';

/**
 * Post the last of the log to the server.
 *
 * `/api/log` keeps `context` to 4000 characters, so the lines are packed newest
 * first until that budget is spent — the most recent failure is the one being
 * asked about. Sent as `info`: this is a report somebody chose to send, not an
 * error the app raised.
 */

export async function sendDebugReport(): Promise<ReportOutcome> {
  const lines: string[] = [];
  let budget = 3_400;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    const line = `${stamp(e.t)} ${e.level[0]!.toUpperCase()} ${e.tag}: ${e.text}`;
    if (line.length > budget) break;
    budget -= line.length + 3;
    lines.unshift(line);
  }
  const lastError = [...entries].reverse().find((e) => e.level === 'error');
  try {
    const res = await fetch(apiUrl('/api/log'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: launchId(),
        level: 'info',
        message: `debug report: ${lastError === undefined ? 'no error recorded' : lastError.text.slice(0, 300)}`,
        context: { device: Object.fromEntries(deviceSummary()), lines },
        version: BUILD === '' ? VERSION : `${VERSION}+${BUILD}`,
        platform: NATIVE ? 'android-app' : 'web',
      }),
    });
    if (!res.ok) return 'failed';
    const body = (await res.json().catch(() => ({}))) as { dropped?: boolean };
    return body.dropped === true ? 'dropped' : 'sent';
  } catch {
    return 'failed';
  }
}

export function stamp(t: number): string {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
