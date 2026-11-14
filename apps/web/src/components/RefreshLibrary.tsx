/**
 * Rebuild the library, from the header, with the progress on the button itself.
 *
 * Asked for in these words: "we have a refresh library — add it to the top, on
 * the right side of the search icon, so it refreshes the library, and show an
 * animation or something by the percentage inside it… this reload button will be
 * used more than search". That last part is the whole argument: a subscription's
 * channel list changes under you, the fix is always "rebuild the catalogue", and
 * until now that lived four screens deep under More → Accounts → REFRESH IT NOW.
 * It is the most-used maintenance action in the app and it was the hardest to
 * reach.
 *
 * ── why the percentage is ON the button ──
 *
 * A rebuild is not instant — it walks the panel's categories and pages — and the
 * one question during it is "is this doing anything". A spinner answers "yes",
 * which is not the question. The ring fills with `step/steps` from the ingest
 * status, so the button IS the progress bar and nothing has to open to show it.
 * There is already a `LocalCatalogueBar` that narrates the same rebuild in
 * sentences; this is the same status, small enough to live in a header.
 *
 * The ring is drawn as one SVG circle with `stroke-dasharray` rather than an
 * animated width, because the button is 40px and a 40px bar is a smudge. While a
 * phase reports no step count the circle spins instead of filling — an honest
 * "working, length unknown" rather than a fake 30%.
 */
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  localEnabled, localStatus, refreshLocal, subscribeLocal, type IngestStatus,
} from '../lib/localCatalogue';

const R = 9;
const C = 2 * Math.PI * R;

export function RefreshLibrary({ className }: { className?: string }) {
  const [s, setS] = useState<IngestStatus>(localStatus);
  useEffect(() => subscribeLocal(setS), []);

  /* Nothing to rebuild without an on-device catalogue — no button rather than a
     button that explains it cannot work. */
  if (!localEnabled()) return null;

  const busy = s.state === 'loading';
  /* `steps` counts the phases this rebuild will walk; `step` is where it is. A
     rebuild that has not said how long it is reports null and the ring spins. */
  const pct = busy && s.steps > 0
    ? Math.max(0, Math.min(100, Math.round((s.step / s.steps) * 100)))
    : null;

  const phaseLabel = busy && s.phase
    ? s.phase === 'live' || s.phase === 'liveCategories' ? 'Downloading channels'
      : s.phase === 'vod' || s.phase === 'vodCategories' ? 'Downloading movies'
      : s.phase === 'series' || s.phase === 'seriesCategories' ? 'Downloading series'
      : s.phase === 'saving' ? 'Saving to device'
      : s.phase === 'store' ? 'Restoring from cache'
      : s.phase === 'packages' ? 'Fetching packages'
      : `Fetching ${s.phase}`
    : null;

  const title = busy
    ? `${phaseLabel ?? 'Rebuilding the library'}${pct !== null ? ` — ${pct}%` : '…'}`
    : s.state === 'error'
      ? `Last rebuild failed: ${s.error ?? 'unknown'}. Press to try again.`
      : 'Rebuild this device’s library';

  return (
    <button
      type="button"
      onClick={() => { if (!busy) void refreshLocal().catch(() => {}); }}
      disabled={busy}
      aria-label={title}
      title={title}
      aria-busy={busy || undefined}
      className={`tap relative grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-sm)]
        transition-colors focus-visible:outline-none
        ${s.state === 'error' ? 'text-alert' : busy ? 'text-tally' : 'text-ink-2'}
        ${busy ? '' : 'hover:bg-panel-2 hover:text-ink focus-visible:bg-panel-2 focus-visible:text-ink'}
        ${className ?? ''}`}
    >
      {/* The ring. Absolute so the glyph inside keeps the icon row's rhythm. */}
      {busy && (
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className={`absolute inset-0 h-full w-full -rotate-90 ${pct === null ? 'animate-spin' : ''}`}
        >
          <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
          <circle
            cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={C}
            /* A quarter turn while the length is unknown; the real arc once it is. */
            strokeDashoffset={pct === null ? C * 0.75 : C * (1 - pct / 100)}
            style={{ transition: 'stroke-dashoffset .3s linear' }}
          />
        </svg>
      )}

      {busy && pct !== null ? (
        /* The number replaces the glyph while there is one to show — two things
           spinning in a 40px square is noise, and the number is the message. */
        <span className="font-mono text-[length:var(--t-2xs)] tabular-nums leading-none">{pct}</span>
      ) : busy && phaseLabel ? (
        /* Show a small icon while the phase label describes what's happening */
        <RefreshCw className="h-5 w-5 animate-spin" />
      ) : (
        <RefreshCw className={`h-5 w-5 ${busy ? 'animate-spin' : ''}`} />
      )}
    </button>
  );
}
