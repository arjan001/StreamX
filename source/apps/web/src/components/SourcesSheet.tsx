import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2, Users, X } from 'lucide-react';
import {
  localStatus, PHASE_LABELS, subscribeLocal,
  type IngestStatus,
} from '../lib/localCatalogue';
import {
  activeProvider, allProviders, displayLabel, subscribeProviders, subscriptionOf, type Provider,
} from '../lib/providers';
import { removeSource, useSource } from '../lib/sources.ts';
import { focusFirst } from '../lib/spatialNav';
import { openAddAccount } from '../lib/addAccount.ts';

/**
 * Sources.
 *
 * A person can keep several: a second server, a playlist, a stream link. One is
 * in use at a time; adding one is the dialog in `AddAccountDialog`.
 */
/**
 * One source, as this device knows it.
 *
 * There is one catalogue and one download at a time, and `localStatus()` already
 * publishes exactly what it is doing, so the progress sits once under the list
 * rather than in every row. What is left per row is what a viewer can decide:
 * which source is in use, and whether to keep it.
 */
function Row({
  p, active, onChanged, onBusy,
}: {
  p: Provider;
  active: boolean;
  onChanged: () => void;
  onBusy: (msg: string | null) => void;
}) {
  const sub = subscriptionOf(p.id);
  const expires = sub?.expiresAt ?? null;

  async function act(fn: () => void | Promise<unknown>, label: string) {
    onBusy(label);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onBusy(e instanceof Error ? e.message : String(e));
      return;
    }
    onBusy(null);
  }

  return (
    <div className={`rounded-[var(--r-md)] border p-2.5 ${active ? 'border-tally bg-tally/5' : 'border-rule'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[length:var(--t-md)] text-ink">{displayLabel(p)}</p>
          {/* The username identifies a source to the person who owns it.
              The address never appears: somebody's own M3U routinely carries
              their password in its query string, and a television is a shared
              screen. */}
          <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">
            {p.kind === 'xtream' ? (p.username ?? '—') : p.kind === 'm3u' ? 'Playlist link' : p.kind === 'stalker' ? 'Stalker portal' : 'Stream link'}
          </p>
          {p.kind === 'xtream' && (
            <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">
              {expires === null
                ? (sub === null ? 'not checked yet' : (sub.status ?? 'active'))
                : `${sub?.status ?? 'active'} · until ${new Date(expires).toLocaleDateString()}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {active ? (
            <span className="flex items-center gap-1 rounded-[var(--r-sm)] border border-tally px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-tally">
              <Check className="h-3 w-3" /> ACTIVE
            </span>
          ) : (
            <button
              onClick={() => void act(() => useSource(p.id), 'switching…')}
              aria-label={`Use ${displayLabel(p)}`}
              title="Use this source"
              className="border border-rule px-1.5 py-0.5 font-mono text-[length:var(--t-2xs)] text-ink-2
                         hover:border-tally hover:text-tally"
            >
              USE
            </button>
          )}
          <button
            /* Its password or link, its channel list and its guide leave the
               device with it — see `removeSource`. The last one removed puts the
               first-run door back. */
            onClick={() => void act(() => removeSource(p.id), 'removing…')}
            /* Named, not just titled. A `title` is a mouse tooltip; a D-pad can
               land here and a remote shows nothing — which left a bin icon that
               deletes a source as the one unnamed control on the screen. */
            aria-label={`Remove ${displayLabel(p)}`}
            title="Remove this source"
            className="border border-rule p-1 text-ink-3 hover:border-alert hover:text-alert"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What the one download is doing, if it is doing anything.
 *
 * A step bar rather than a percentage of bytes: the panel sends no
 * `content-length` on the big payloads, so a byte percentage would be a guess,
 * while "Films · step 2 of 3 · 24.1 MB" is both true and more informative than a
 * bar that lies.
 */
function DownloadProgress() {
  const [st, setSt] = useState<IngestStatus>(localStatus);
  useEffect(() => subscribeLocal(setSt), []);
  if (st.state !== 'loading' && st.state !== 'error') return null;
  const pct = st.steps > 0 ? Math.min(100, (st.step / st.steps) * 100) : 0;
  return (
    <div className="space-y-1 border border-rule/60 p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[length:var(--t-2xs)] text-ink-2">
          {st.state === 'error' ? 'download failed' : (st.phase ? PHASE_LABELS[st.phase] : 'starting')}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--t-2xs)] tabular-nums text-ink-3">
          {st.steps > 0 ? `${st.step}/${st.steps}` : ''}
          {st.bytes ? ` · ${(st.bytes / 1e6).toFixed(1)} MB` : ''}
        </span>
      </div>
      {st.state === 'loading' && (
        <div className="meter h-1 w-full bg-rule">
          <div className="h-full bg-tally transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {st.state === 'error' && (
        <p className="font-mono text-[length:var(--t-2xs)] text-ink-3">{st.error}</p>
      )}
    </div>
  );
}

/**
 * Sources, and only sources: the saved list, which one is in use, and a button
 * that opens the add dialog.
 *
 * Rendered inline by the settings page and inside a drawer by `SourcesSheet`, so
 * both routes into sources are the same component rather than two that drift.
 */
export function AccountsPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [list, setList] = useState<Provider[]>(allProviders);
  useEffect(() => subscribeProviders(setList), []);
  const active = activeProvider();

  /** Switching sources changes every list, so the whole cache goes. */
  const changed = () => {
    setList(allProviders());
    void qc.invalidateQueries();
  };

  return (
    <div className="space-y-2">
      {busy && <p className="font-mono text-[length:var(--t-2xs)] text-tally">{busy}</p>}
      {list.map((p) => (
        <Row key={p.id} p={p} active={p.id === active?.id} onChanged={changed} onBusy={setBusy} />
      ))}
      <DownloadProgress />

      {/*
        A button, and the form somewhere else entirely.

        This panel is rendered in two places — the shell's drawer and
        `/more?s=accounts` — so a form here would be two copies of it. The panel
        asks for the dialog and the dialog owns the form: see `lib/addAccount.ts`.
        The shell closes this drawer on the way, so two are never on one screen.
      */}
      <button
        type="button"
        onClick={openAddAccount}
        /* Where the remote lands when this panel opens: the one thing a viewer
           comes here to do that is not already on the list. */
        data-nav-first
        className="card card-hover tap flex w-full items-center justify-center gap-2 border border-rule
                   px-3 py-2.5 text-[length:var(--t-md)] text-ink transition-colors"
      >
        <Plus className="h-4 w-4 shrink-0 text-tally" aria-hidden />
        Add a source
      </button>
    </div>
  );
}

export function SourcesSheet({ onClose }: { onClose: () => void }) {
  /* Arrive INSIDE the drawer. Without this the remote stayed on the page behind
     it and the first DOWN was spent getting in — measured on the television. */
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => { if (box.current) focusFirst(box.current); }, 60);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div ref={box} data-nav-contain className="fixed inset-0 z-[60] flex justify-end bg-black/60 anim-fade">
      {/* The scrim is a POINTER affordance: click beside the drawer to close it.
          It was also a focus stop, so a remote arriving in the drawer landed on
          an invisible full-height button and DOWN never reached the account rows
          or "Add a source" — measured on the television build. `tabIndex`
          -1 keeps the click and takes it out of the D-pad's way. */}
      <button tabIndex={-1} className="flex-1 cursor-default" aria-label="Close" onClick={onClose} />
      {/* Full width on a phone, a drawer everywhere else — and clear of the notch
          and the home indicator, because a fixed overlay sits outside the shell
          that spends those insets for the rest of the app. */}
      <aside
        className="glass-float flex w-[26rem] max-w-full flex-col border-l border-rule bg-panel anim-slide
                   pb-[var(--edge-b)] pt-[var(--edge-t)] pr-[var(--edge-r)]"
      >
        <div className="flex items-center justify-between border-b border-rule px-3 py-2">
          <span className="flex items-center gap-1.5 font-mono text-[length:var(--t-xs)] tracking-widest text-ink-3">
            <Users className="h-3.5 w-3.5" /> SOURCES
          </span>
          <button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <AccountsPanel />
        </div>
      </aside>
    </div>
  );
}
