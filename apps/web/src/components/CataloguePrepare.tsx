import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import {
  PHASE_LABELS, localStatus, subscribeLocal, type IngestStatus,
} from '../lib/localCatalogue';
import { isPreparing, stopPreparing, subscribePreparing } from '../lib/firstCatalogue';

/**
 * The screen a new subscription gets while its catalogue is being built.
 *
 *     when they sign in you have to show a proper loading screen till
 *     everything is loaded Right now it's so bad
 *
 * It covers the entire screen so the user cannot browse an empty catalogue.
 * It shows the phase, progress, and size so the user knows what's happening.
 *
 * The only way out is if the build fails — a "Carry on without it" button
 * appears on error. There is no "Browse while it finishes" option; the user
 * waits for the catalogue to complete to avoid black screens on tabs like Movies.
 *
 * It shows only for a FIRST build of a newly added subscription — see
 * `lib/firstCatalogue.ts` for why that is an explicit signal and not something
 * inferred from the ingest status.
 */
export function CataloguePrepare() {
  const [on, setOn] = useState(isPreparing);
  const [s, setS] = useState<IngestStatus>(localStatus);

  useEffect(() => subscribePreparing(setOn), []);
  useEffect(() => subscribeLocal(setS), []);

  /* Built: no longer the only thing on screen. */
  useEffect(() => {
    if (on && s.state === 'ready') stopPreparing();
  }, [on, s.state]);

  if (!on) return null;

  const failed = s.state === 'error';
  const label = s.phase ? PHASE_LABELS[s.phase] : 'Starting';
  const mb = s.bytes > 0 ? `${(s.bytes / 1_048_576).toFixed(1)} MB` : null;
  const pct = s.steps > 0 ? Math.min(100, Math.round((s.step / s.steps) * 100)) : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Preparing your catalogue"
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-6
                 bg-ground px-8 text-center anim-fade"
    >
      <div className="flex flex-col items-center gap-3">
        {failed ? (
          <AlertTriangle className="h-8 w-8 text-alert tv:h-12 tv:w-12" aria-hidden />
        ) : (
          <Loader2 className="h-8 w-8 animate-spin text-tally tv:h-12 tv:w-12" aria-hidden />
        )}
        <h1 className="text-[length:var(--t-lg)] leading-tight text-ink tv:text-[length:var(--t-2xl)]">
          {failed ? 'The catalogue did not finish' : 'Getting your channels ready'}
        </h1>
        <p className="max-w-[46ch] text-[length:var(--t-sm)] leading-relaxed text-ink-2 tv:text-[length:var(--t-lg)]">
          {failed
            ? s.error ?? 'Something went wrong while building the catalogue.'
            : 'This happens once. Everything is stored on this device, so after '
              + 'today it opens straight away.'}
        </p>
      </div>

      {!failed && (
        <div className="w-full max-w-[32rem]">
          <div className="h-1 w-full overflow-hidden rounded-full bg-rule">
            <div
              className="h-full rounded-full bg-tally transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-3 font-mono text-[length:var(--t-2xs)] uppercase tracking-wider
                        text-ink-3 tv:text-[length:var(--t-sm)]">
            {label}
            {s.steps > 0 ? ` · ${s.step}/${s.steps}` : ''}
            {mb ? ` · ${mb}` : ''}
            {s.rows > 0 ? ` · ${s.rows.toLocaleString()} titles` : ''}
          </p>
        </div>
      )}

      {failed && (
        <button
          type="button"
          onClick={() => stopPreparing()}
          className="tap border border-rule px-4 py-2 text-[length:var(--t-sm)] text-ink
                     hover:border-ink-3 focus:border-focus tv:px-6 tv:py-3 tv:text-[length:var(--t-lg)]"
          style={{ borderRadius: 'var(--r-sm)' }}
        >
          Carry on without it
        </button>
      )}
    </div>
  );
}
