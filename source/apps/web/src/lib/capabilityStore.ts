/**
 * The capability report, probed once and shared.
 *
 * Probing costs a handful of async platform calls, and the answers cannot change
 * while the page is open — but the error box needs them at the exact moment
 * something has already gone wrong, which is the worst time to start asking. So
 * the probe runs early, in the background, and whatever it found is available
 * synchronously afterwards.
 *
 * Persisted per device as well, because on a TV box the first failure often
 * happens before an idle probe has finished, and a report from the last session
 * is still true — the decoders do not change between launches. The stored copy is
 * only ever a head start: a fresh probe overwrites it every session.
 */
import { useEffect, useState } from 'react';
import { kv } from './kv.ts';
import { probeCapabilities, type CapabilityReport, type NativeAnswer } from './codecs.ts';
import { MIMES, nativeEngine } from './nativePlayer.ts';
import { askHardware, reportLastCrash } from './deviceInfo.ts';
import { dlog } from './debugLog.ts';

/* v2: reports now include the native engine, so a v1 copy would understate a
   device that has one. */
const KEY = 'iptv.codecs.v2';

function read(): CapabilityReport | null {
  try {
    const raw = kv.get(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as CapabilityReport;
    return Array.isArray(r.codecs) ? r : null;
  } catch {
    return null;
  }
}

let report: CapabilityReport | null = null;
const subs = new Set<(r: CapabilityReport | null) => void>();

export function getCapabilities(): CapabilityReport | null {
  if (report === null) report = read();
  return report;
}

/**
 * Ask the device about its own decoder before asking the browser about the browser.
 *
 * Failure here is not an error: the web build has no plugin at all, and that is
 * the ordinary case. It just means the report describes a browser, which on the
 * web is the whole truth anyway.
 */
async function askNative(): Promise<NativeAnswer | null> {
  try {
    const engine = await nativeEngine();
    if (engine === null) return null;
    const caps = await engine.capabilities();
    const hardware = new Set<string>();
    for (const [id, mimes] of Object.entries(MIMES)) {
      if (caps.codecs.some((c) => mimes.includes(c.mime))) hardware.add(id);
    }
    return { available: true, hardware };
  } catch {
    return null;
  }
}

export async function refreshCapabilities(): Promise<CapabilityReport> {
  const next = await probeCapabilities(undefined, await askNative());
  report = next;
  try {
    kv.set(KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  for (const fn of subs) fn(next);
  return next;
}

export function useCapabilities(): CapabilityReport | null {
  const [r, setR] = useState(getCapabilities);
  useEffect(() => {
    subs.add(setR);
    setR(getCapabilities());
    return () => {
      subs.delete(setR);
    };
  }, []);
  return r;
}

/** Kick the probe off without blocking anything. Called once from `main.tsx`. */
export function primeCapabilities(): void {
  if (typeof window === 'undefined') return;
  const run = () => {
    void refreshCapabilities().catch(() => {});
    /*
      Warm the native plugin here too.

      `hasNativeEngine()` is synchronous, and it can only answer once the plugin
      has been proved to exist by calling it. Escalating a decode failure asks that
      question inside an error handler, where there is no time to go and find out.
      It happened to work — `tryNative` probes at the top of every load, so by the
      time an error fires the answer is cached — but relying on the order of two
      unrelated code paths is not a thing to leave standing.
    */
    void nativeEngine()
      .then((e) => dlog.info('native', e === null ? 'no plugin — the WebView is the only engine' : 'plugin answered — libVLC available'))
      .catch(() => null);
    /* And why the app went away last time, if it did — see `reportLastCrash`.
       The run that crashed could not report itself; this is where its report
       arrives. */
    void reportLastCrash();
    /* And WHICH box this is, so a report from a brand that misbehaves names the
       brand. Asked once, here, because `deviceSummary()` is synchronous — see
       `askHardware`. */
    void askHardware();
  };
  /* After the first paint: this is diagnostics, and it must not compete with the
     first screen of content for the main thread. Read through a local alias
     because `'requestIdleCallback' in window` narrows `window` itself to `never`
     in the else branch — the DOM lib does not declare the method, so the check
     "proves" the object cannot be a Window. */
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout: 4000 });
  else w.setTimeout(run, 1500);
}
