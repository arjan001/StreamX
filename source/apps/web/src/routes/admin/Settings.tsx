/**
 * What an operator can change without a deploy — and what it will do.
 *
 * `minVersion` is fenced off from the rest, because it is the only field on this
 * screen that reaches out and stops other people's televisions from working.
 * Typing a version into it puts a pop-up on every older client that cannot be
 * dismissed and cannot be used behind.
 *
 * The box keeps no record of who runs which build, so it cannot say how many
 * clients a value would reach. The field checks that what is typed is a version
 * the server will parse, and says so when it is not.
 */
import { useRef, useState } from 'react';
import {
  AlertTriangle, Check, Download, Loader2, RotateCcw, Save, Trash2, Upload,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui';
import { adminPost, adminPut, apiUrl, token, type Overview } from './api';
import { count, Panel } from './parts';

/** What the server will accept as a version — anything else forces nothing. */
const VERSION = /^\d+(\.\d+)*$/;

const input = 'w-full border border-rule bg-ground px-2.5 py-2 text-[length:var(--t-sm)] text-ink '
  + 'outline-none focus:border-focus';

export function Settings({ data, onSaved }: { data: Overview; onSaved: () => void }) {
  const [cfg, setCfg] = useState<Record<string, unknown>>(data.config?.config ?? {});
  const [revision, setRevision] = useState(data.config?.revision ?? 0);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'stale' | 'error'>('idle');

  const field = (k: string): string => String(cfg[k] ?? '');
  const set = (k: string, v: unknown) => { setCfg((c) => ({ ...c, [k]: v })); setState('idle'); };

  const min = field('minVersion').trim();

  const save = async () => {
    setState('saving');
    try {
      const body = await adminPut<Record<string, unknown>>('/api/admin/config', { revision, config: cfg })
        .catch(async (e: Error) => {
          /* A 409 is not a failure, it is somebody else's save. `adminPut` throws
             on it like anything else, so it is unpacked here rather than being
             shown as "could not save" over an edit that is simply out of date. */
          if (!/409/.test(e.message)) throw e;
          return null;
        });
      if (body === null) { setState('stale'); onSaved(); return; }
      setRevision(Number(body['revision'] ?? revision + 1));
      setState('saved');
      onSaved();
    } catch {
      setState('error');
    }
  };

  return (
    <>
      <Panel title="App config" note={`revision ${count(revision)} · applies to every client on next check`}>
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <label className="block lg:col-span-2">
            <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Notice</span>
            <input className={`mt-1 ${input}`} value={field('notice')}
              placeholder="Shown to everyone. Leave empty for none."
              onChange={(e) => set('notice', e.target.value)} />
          </label>

          <div className="border border-alert/50 bg-alert/5 p-3 lg:col-span-2">
            <p className="flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-alert">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Forced update
            </p>
            <p className="mt-1 max-w-prose text-[length:var(--t-xs)] leading-relaxed text-ink-2">
              Every client older than this version gets a screen it cannot dismiss, pointing to the
              store, and cannot use the app behind it. A client that does not report a version is never locked out.
              Leave empty to force nothing.
            </p>
            <label className="mt-3 block max-w-xs">
              <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Minimum version</span>
              <input className={`mt-1 ${input}`} value={field('minVersion')} placeholder="empty = force nothing"
                onChange={(e) => set('minVersion', e.target.value)} />
            </label>
            {/* Only says whether the value is in force. A field that looks accepted
                for a value the server cannot parse reads as though the rule is on. */}
            <p className="mt-2 font-mono text-[length:var(--t-2xs)] text-ink-3">
              {min === '' ? 'Nothing is forced.'
                : !VERSION.test(min) ? `“${min}” is not a version number, so nothing is forced.`
                : `Clients older than ${min} will be locked out until they update.`}
            </p>
            <label className="mt-3 block">
              <span className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Message</span>
              <input className={`mt-1 ${input}`} value={field('updateMessage')}
                placeholder="What the pop-up says"
                onChange={(e) => set('updateMessage', e.target.value)} />
            </label>
          </div>

          <Toggle
            label="Turn off the TV connection relay"
            hint="Android TVs route films through a relay on the TV itself so seeking and resuming work on one-connection lines. Switch this on only if films stop opening on TVs; it takes effect within seconds."
            on={cfg['deviceRelayOff'] === true}
            onChange={(v) => set('deviceRelayOff', v)}
          />
          {/*
            "Keep the library on the device by default" was here, and it was a
            switch with nothing on the other end of it: `localCatalogueDefault`
            was written to the config document and read by no line of the app.
            It could not have been otherwise since 2026-09-03, when the server
            catalogue was removed — the library is on the device for everyone,
            always, and there is no second behaviour for a switch to choose
            between. Removed rather than wired, because wiring it would mean
            building back the thing it used to turn off.
          */}
          {/* Telemetry, so it says what it collects rather than only what it is
              for. An operator turning this on is deciding for other people's
              televisions, and the hint is the only place that is stated. */}
          <Toggle
            label="Collect errors from apps"
            hint={'Apps send their errors here by themselves, a few at a time, instead of waiting '
              + 'for somebody to send a report. Error lines only — never a password or what anyone '
              + 'watched — kept for seven days and shown under Errors.'}
            on={cfg['errorReports'] === true}
            onChange={(v) => set('errorReports', v)}
          />

          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            <Button variant="primary" onClick={() => void save()} disabled={state === 'saving'}>
              {state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
            {state === 'saved' && (
              <span className="flex items-center gap-1.5 font-mono text-[length:var(--t-xs)] text-live">
                <Check className="h-3.5 w-3.5" aria-hidden /> saved as revision {count(revision)}
              </span>
            )}
            {state === 'stale' && (
              <span className="font-mono text-[length:var(--t-xs)] text-alert">
                someone else saved first — reload to see their version, then save again
              </span>
            )}
            {state === 'error' && <span className="font-mono text-[length:var(--t-xs)] text-alert">could not save</span>}
          </div>
        </div>
      </Panel>

      <BackupAndReset />
    </>
  );
}


/**
 * Keep a copy, put one back, or empty something out.
 *
 * Asked for as "a button where I can reset stuff or back them up".
 *
 * ── what is actually worth backing up ──
 *
 * The config document, and only that. It is the one thing on this box that
 * cannot be re-derived: the error log sweeps itself weekly. So the log is
 * included in the file when asked for, but RESTORE deliberately puts back the
 * config alone.
 *
 * ── every destructive button says its number first ──
 *
 * Nothing here deletes on the first press. The screen asks the box to COUNT, the
 * box answers, and only then does a button appear with that number written on it.
 * A control whose consequences are invisible from the thing you click is a trap
 * however carefully it is labelled.
 */
function BackupAndReset() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [armed, setArmed] = useState<{ what: string; n: number; detail?: string } | null>(null);
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);

  /*
   * Fetched and turned into a blob rather than linked to directly.
   *
   * The endpoint needs `x-admin-token`, and an `<a href>` cannot carry a header —
   * a plain link would download a 401 as a JSON file called "backup".
   */
  const download = async (everything: boolean) => {
    setBusy(everything ? 'all' : 'config');
    setNote(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/backup${everything ? '?logs=1' : ''}`),
        { headers: { 'x-admin-token': token() ?? '' } });
      if (!res.ok) throw new Error(`the server said ${res.status}`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
        ?? 'admin-backup.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      /* Revoked on the next tick rather than immediately: revoking synchronously
         can beat the browser to the click it was created for. */
      setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
      setNote({ tone: 'ok', text: `saved ${name} (${Math.max(1, Math.round(blob.size / 1024))} KB)` });
    } catch (e) {
      setNote({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const restore = async (f: File) => {
    setBusy('restore');
    setNote(null);
    try {
      const doc = JSON.parse(await f.text()) as Record<string, unknown>;
      const body = await adminPost<{ revision: number }>('/api/admin/restore', doc);
      setNote({ tone: 'ok', text: `restored — saved as revision ${count(body.revision)}` });
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      setNote({ tone: 'bad', text: `${(e as Error).message}. Nothing was changed.` });
    } finally {
      setBusy(null);
      if (file.current !== null) file.current.value = '';
    }
  };

  const count_ = async (what: string) => {
    setNote(null);
    const r = await adminPost<{ matched: number; detail?: string }>('/api/admin/reset', { what });
    setArmed({ what, n: r.matched, detail: r.detail });
  };
  const run = async () => {
    if (armed === null) return;
    setBusy('reset');
    try {
      const r = await adminPost<{ deleted?: number; cleared?: number }>(
        '/api/admin/reset', { what: armed.what, dryRun: false },
      );
      setNote({ tone: 'ok', text: `${armed.what}: removed ${count(r.deleted ?? r.cleared ?? 0)}` });
      setArmed(null);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) {
      setNote({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const TARGETS = [
    { what: 'config', label: 'App config', hint: 'back to an empty document — every reader has its own default' },
    { what: 'logs', label: 'Client reports', hint: 'everything televisions have reported; they sweep weekly anyway' },
  ];

  return (
    <Panel title="Backup and reset" note="the config is the only thing here that cannot rebuild itself">
      <div className="grid gap-5 p-4">
        <div>
          <p className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Back up</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => void download(false)} disabled={busy !== null}>
              {busy === 'config' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Settings only
            </Button>
            <Button onClick={() => void download(true)} disabled={busy !== null}>
              {busy === 'all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Settings and reports
            </Button>
          </div>
        </div>

        <div>
          <p className="font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-ink-3">Restore</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={() => file.current?.click()} disabled={busy !== null}>
              {busy === 'restore' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Choose a backup file
            </Button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void restore(f); }}
            />
            <span className="max-w-prose font-mono text-[length:var(--t-2xs)] leading-relaxed text-ink-3">
              Puts the settings back. The reports in a backup are an archive to read,
              not something to write over what is live.
            </span>
          </div>
        </div>

        <div className="border border-alert/50 bg-alert/5 p-3">
          <p className="flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider text-alert">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset
          </p>
          <p className="mt-1 max-w-prose text-[length:var(--t-xs)] leading-relaxed text-ink-2">
            Nothing here deletes on the first press. Each one asks the box how much it would
            remove, and the button that removes it appears with that number on it.
          </p>
          <div className="mt-3 grid gap-2">
            {TARGETS.map((t) => (
              <div key={t.what} className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void count_(t.what)} disabled={busy !== null} className="min-w-44">
                  Count {t.label.toLowerCase()}
                </Button>
                {armed?.what === t.what ? (
                  armed.n === 0 ? (
                    <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">already empty</span>
                  ) : (
                    <Button className="!border-alert !text-alert" onClick={() => void run()} disabled={busy !== null}>
                      {busy === 'reset' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Yes — clear {count(armed.n)}{armed.what === 'config' ? ' settings' : ' rows'}
                    </Button>
                  )
                ) : (
                  <span className="font-mono text-[length:var(--t-2xs)] text-ink-3">{t.hint}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {note === null ? null : (
          <p role="status" className={`font-mono text-[length:var(--t-xs)] ${note.tone === 'ok' ? 'text-live' : 'text-alert'}`}>
            {note.text}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Toggle({
  label, hint, on, onChange,
}: {
  label: string; hint: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className={`flex items-start justify-between gap-3 border px-3 py-3 text-left transition-colors
        ${on ? 'border-tally text-ink' : 'border-rule text-ink-2 hover:border-ink-3'}`}
    >
      <span>
        <span className="block text-[length:var(--t-sm)]">{label}</span>
        <span className="block font-mono text-[length:var(--t-2xs)] text-ink-3">{hint}</span>
      </span>
      <span className={`mt-1 h-3 w-3 shrink-0 ${on ? 'bg-tally' : 'bg-rule'}`} />
    </button>
  );
}
