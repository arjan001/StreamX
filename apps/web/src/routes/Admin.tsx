import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, LogOut, RefreshCw, Shield } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';
import { Button } from '../components/ui';
import { apiUrl } from '../lib/api';
import { pushBackHandler } from '../lib/nativeBack';
import {
  adminGet, setToken, token, Unauthorised, type Overview as Data,
} from './admin/api';
import { count, Empty } from './admin/parts';
import { Overview } from './admin/Overview';

/**
 * The operator's console.
 *
 * Deliberately a route in the same app rather than a separate build: it is one
 * box, one deploy, and a second front-end for a handful of panels would be more
 * infrastructure than the thing it administers. It is not in the navigation and
 * nothing links to it — an operator types `/admin`.
 *
 * ── what it answers ──
 *
 * The box keeps nothing about viewers — not who is watching, not who is signed
 * in — so there is no panel for it. What remains is the box's own business.
 *
 *   Overview     error counts, the config revision, and
 *                whether the box itself is well.
 *   Errors       what televisions reported going wrong, grouped and raw.
 *   Settings     what can change without a deploy, including the one control that
 *                can stop every older client from working.
 *
 * ── why it is in pieces ──
 *
 * The previous version was one 550-line file that fetched everything in one call
 * and drew four tables. It crashed on a field the server had stopped sending, and
 * because every panel lived in the same component the failure took the entire
 * page with it — the admin area was a blank screen for weeks and reported nothing
 * about why. Each panel is now its own component with its own query and its own
 * failure: a broken endpoint costs one table, not the console.
 *
 * ── the session ──
 *
 * A token from `POST /api/admin/login`, held in `sessionStorage` rather than
 * `localStorage`: an admin session should end when the window does. It expires
 * server-side after eight hours regardless, and a server restart ends it early.
 */

/* Split out, so the tabs an operator does not open are not in the first chunk. */
const Errors = lazy(async () => ({ default: (await import('./admin/Errors')).Errors }));
const Settings = lazy(async () => ({ default: (await import('./admin/Settings')).Settings }));

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'errors', label: 'Errors' },
  { id: 'settings', label: 'Settings' },
] as const;

export function Admin() {
  const [signedIn, setSignedIn] = useState(() => token() !== null);
  /* Hardware BACK signs out rather than leaving the app: an admin screen left open
     on a television is the one screen that should not stay open by accident. */
  useEffect(() => pushBackHandler(() => {
    if (!signedIn) return false;
    setToken(null);
    setSignedIn(false);
    return true;
  }), [signedIn]);
  return signedIn
    ? <Console onOut={() => { setToken(null); setSignedIn(false); }} />
    : <AdminLogin onIn={() => setSignedIn(true)} />;
}

function AdminLogin({ onIn }: { onIn: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/admin/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) { setError(String(body['message'] ?? 'Sign-in failed.')); return; }
      setToken(String(body['token']));
      setPassword('');
      onIn();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full border border-rule bg-panel px-3 py-2.5 text-ink outline-none focus:border-focus';

  return (
    <div className="grid min-h-full place-items-center bg-ground p-6">
      <form
        data-nav-scope
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="w-full max-w-sm"
      >
        <div className="mb-6 flex items-center gap-2 text-ink-3">
          <Shield className="h-4 w-4" aria-hidden />
          <span className="font-mono text-[length:var(--t-xs)] uppercase tracking-widest">Admin</span>
        </div>
        <input
          ref={first}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          aria-label="Username"
          className={`mb-2 ${field}`}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
          placeholder="password"
          aria-label="Password"
          className={field}
        />
        {error !== null && (
          <p role="alert" className="mt-3 border border-alert/60 bg-alert/10 p-2 text-[length:var(--t-sm)] text-alert">
            {error}
          </p>
        )}
        <Button variant="primary" as="button" type="submit" disabled={busy || password === ''}
          className="mt-4 !flex w-full disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
          Sign in
        </Button>
      </form>
    </div>
  );
}

function Console({ onOut }: { onOut: () => void }) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const tab = params.get('tab') ?? 'overview';
  const go = useCallback((next: string) => {
    setParams((p) => { const u = new URLSearchParams(p); u.set('tab', next); return u; }, { replace: true });
    window.scrollTo({ top: 0 });
  }, [setParams]);

  /**
   * Plain fetches, no socket.
   *
   * The overview is read on mount, on the Refresh button, and on a gentle poll
   * while this tab is visible. React Query pauses the interval in a background
   * tab, so a console left open behind other windows costs the box nothing.
   */
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => adminGet<Data>('/api/admin/overview'),
    staleTime: 30_000,
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
  });

  /* One place that knows a 401 means "signed out" rather than "broken". Every
     panel throws the same type, so this catches all of them. */
  const dead = overview.error instanceof Unauthorised;
  useEffect(() => { if (dead) onOut(); }, [dead, onOut]);

  const data = overview.data;

  return (
    <div className="h-full overflow-y-auto bg-ground p-4 sm:p-6">
      <header data-nav-scope className="mb-4 flex flex-wrap items-center gap-3">
        <Wordmark size="md" full />
        <span className="font-mono text-[length:var(--t-xs)] uppercase tracking-widest text-ink-3">Admin</span>
        {data === undefined ? null : (
          <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">
            {data.brand?.name ?? '—'}
            {data.brand?.applicationId === null || data.brand?.applicationId === undefined
              ? '' : ` · ${data.brand.applicationId}`}
          </span>
        )}
        <span className="ml-auto flex flex-wrap gap-2">
          <Button
            onClick={() => void qc.invalidateQueries({ queryKey: ['admin'] })}
            disabled={overview.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5${overview.isFetching ? ' animate-spin' : ''}`} aria-hidden />
            Refresh
          </Button>
          <Button
            className="hover:!border-alert hover:!text-alert"
            onClick={() => {
              const t = token();
              if (t !== null) {
                void fetch(apiUrl('/api/admin/logout'), { method: 'POST', headers: { 'x-admin-token': t } });
              }
              onOut();
            }}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
          </Button>
        </span>
      </header>

      {/* Its own section, and the only one above the panels: on a television, Down
          out of the tabs must land in the panel rather than in the next tab. */}
      <nav data-nav-scope aria-label="Admin sections" className="mb-2 flex flex-wrap gap-1.5 border-b border-rule pb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? 'page' : undefined}
            className={`chip${tab === t.id ? ' is-on' : ''}`}
            onClick={() => go(t.id)}
          >
            {t.label}
            {t.id === 'errors' && (data?.logs?.errors_day ?? 0) > 0
              ? <span className="text-alert"> {count(data?.logs?.errors_day)}</span> : null}
          </button>
        ))}
      </nav>

      {/*
        A failure shows here and the console stays.

        The old screen returned a bare spinner until `data !== null` and rendered
        nothing else — so one bad response was an empty page with no message, no
        sign-out and no way to reach any other panel.
      */}
      {overview.isError && !dead ? (
        <p role="alert" className="mt-4 border border-alert/60 bg-alert/10 p-3 text-[length:var(--t-sm)] text-alert">
          {(overview.error as Error).message}. The panels below may be stale.
        </p>
      ) : null}

      {data === undefined ? (
        <div className="grid min-h-64 place-items-center">
          {overview.isError
            ? <Empty tone="alert">Could not read the box.</Empty>
            : <Loader2 className="h-6 w-6 animate-spin text-tally" aria-label="loading" />}
        </div>
      ) : (
        <Suspense fallback={<div className="grid min-h-64 place-items-center">
          <Loader2 className="h-6 w-6 animate-spin text-tally" aria-label="loading" />
        </div>}>
          {tab === 'overview' && <Overview data={data} onGo={go} />}
          {tab === 'errors' && <Errors />}
          {tab === 'settings' && (
            <Settings
              /* Keyed on the revision so a save elsewhere reloads the editor's own
                 state rather than leaving a stale `revision` that 409s for ever. */
              key={data.config?.revision ?? 0}
              data={data}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['admin', 'overview'] })}
            />
          )}
        </Suspense>
      )}
    </div>
  );
}
