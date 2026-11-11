/**
 * The operator's config document, fetched — never pushed.
 *
 * It is the cheapest thing that still reaches a television that is never
 * restarted:
 *
 *   - once at boot;
 *   - again when the app comes back to the front, at most every six hours.
 *
 * One fetch serves every reader (UpdateGate, error reports, the operator's
 * switches).
 *
 * **It fails quiet.** No network, no box, a 500, a timeout: nobody is told, and
 * every reader keeps its default. The request carries this build's version and
 * nothing else.
 */
import { apiUrl } from './api.ts';

const VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '';

/** How long a hung request may hold a reader's default hostage. */
const TIMEOUT_MS = 8_000;
/** How stale the document may get on a television that is never restarted. */
const REFRESH_MS = 6 * 3600_000;

type Reader = (raw: unknown) => void;
const readers = new Set<Reader>();
let latest: unknown = null;
let fetchedAt = 0;
let inFlight: Promise<unknown> | null = null;
let started = false;

/**
 * Hear every answer, and the last one straight away if there already is one —
 * a reader that mounts after boot must not wait six hours for its first value.
 */
export function subscribeAppConfig(fn: Reader): () => void {
  readers.add(fn);
  if (latest !== null) fn(latest);
  return () => { readers.delete(fn); };
}

/** Fetch now. Concurrent callers share one request. Resolves to the body, or null. */
export function refreshAppConfig(): Promise<unknown> {
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(
        apiUrl(`/api/app-config?version=${encodeURIComponent(VERSION)}`),
        { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (body === null || typeof body !== 'object') return null;
      latest = body;
      fetchedAt = Date.now();
      for (const fn of readers) fn(body);
      return body;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Boot, and every return to the front once the document is six hours old. Idempotent. */
export function startAppConfig(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void refreshAppConfig();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - fetchedAt > REFRESH_MS) {
      void refreshAppConfig();
    }
  });
}
