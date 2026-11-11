/**
 * The operator's client.
 *
 * One place that knows the admin token, the header it goes in, and what every
 * endpoint answers. The screen used to hold all of that inline — a `fetch` per
 * panel, each re-deriving the header and each with its own idea of what a failure
 * looked like — and the panels drifted apart exactly as you would expect.
 *
 * ── the shape of the failure ──
 *
 * `adminGet` throws `Unauthorised` and nothing else special. The shell catches
 * that one type and signs out; every other failure is a message a panel shows in
 * place of its table, because a whole console going blank over one endpoint is
 * how this screen spent a fortnight showing nothing at all.
 */
import { apiUrl } from '../../lib/api';

/* Re-exported so a panel that must build its own request — the backup download
   needs a header a plain link cannot carry — has one import for the admin plane
   rather than reaching around it into the app's API module. */
export { apiUrl };

export const TOKEN_KEY = 'iptv.admin.token';

export function token(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null): void {
  try {
    if (t === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, t);
  } catch { /* private mode: the session simply does not survive a reload */ }
}

/** Thrown for a 401 alone, so the shell can tell "signed out" from "broken". */
export class Unauthorised extends Error {
  constructor() { super('Sign in again.'); this.name = 'Unauthorised'; }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = token();
  if (t === null) throw new Unauthorised();
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }), 'x-admin-token': t },
  });
  if (res.status === 401) { throw new Unauthorised(); }
  if (!res.ok) throw new Error(`the server said ${res.status}`);
  return await res.json() as T;
}

export const adminGet = <T,>(path: string): Promise<T> => call<T>(path);
export const adminPost = <T,>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const adminPut = <T,>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: 'PUT', body: JSON.stringify(body) });

/** Build a query string, dropping the keys that are empty rather than sending `&brand=`. */
export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' ) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s === '' ? '' : `?${s}`;
}

/* ── what the endpoints answer ─────────────────────────────────────────────── */

/*
 * Every field here is optional or defaulted at the point of use.
 *
 * The last version of this file declared `catalogue` as required, the server
 * stopped sending it, and `data.catalogue.live` type-checked perfectly against a
 * field that had not existed for weeks — then threw at runtime and unmounted the
 * whole page. A response is not typed by declaring a type for it; it is typed by
 * reading it defensively. `?? 0` and `?? []` below are not noise, they are the
 * only thing standing between a schema change and a blank screen.
 */

export interface LogRow {
  id: number; at: string; device_id: string | null; level: string;
  message: string; context: unknown; app_version: string | null; platform: string | null;
}
export interface LogGroup {
  message: string; n: number; devices: number; level: string; newest: string; builds: string[];
}

/** Error reports held, by window and by level. No viewer is counted anywhere. */
export interface LogStats {
  held: number; errors: number; day: number; week: number;
  errors_day: number; errors_week: number; newest: string | null;
  levels: { level: string; n: number }[];
}

export interface Health {
  db: { db_bytes: number; logs: number; connections: number; db_now: string; roundTripMs: number };
  process: { uptimeSec: number; node: string; pid: number; rssBytes: number; heapBytes: number };
}

export interface Overview {
  brand: { name: string; applicationId: string | null; site: string | null };
  now: string;
  health: Health;
  logs: LogStats;
  config: { revision: number; updatedAt: string; config: Record<string, unknown> };
}
