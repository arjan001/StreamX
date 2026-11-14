import { useEffect, useRef } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import type { ReleaseInfo } from '../lib/updateCheck';

/**
 * "What's New" update modal — shown when a newer stable release is available.
 *
 * Uses the same centered overlay design as Welcome, ExpiredDialog and ExitDialog:
 * glass-float card, data-nav-contain, focusFirst on mount, anim-fade overlay.
 * z-[71] sits between Welcome (z-[70]) and ExpiredDialog (z-[72]).
 *
 * The changelog body comes from the GitHub release notes, rendered as plain text
 * in a scrollable area. Two buttons: Download opens the release page, Dismiss
 * closes and remembers the version.
 */
export function UpdateModal({
  release,
  onDismiss,
}: {
  release: ReleaseInfo | null;
  onDismiss: () => void;
}) {
  const modern = useSkin().shell === 'modern';
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (release !== null && panel.current !== null) focusFirst(panel.current);
  }, [release]);

  if (release === null) return null;

  const card = modern
    ? 'welcome-card glass-float tally-glow is-on w-full max-w-[26rem] tv:max-w-[36rem] p-5 tv:p-6'
    : 'card w-full max-w-[26rem] tv:max-w-[36rem] border border-rule bg-panel p-5 shadow-lg tv:p-6';
  const button = 'card card-hover tap mt-3 flex w-full items-center justify-center gap-3'
    + ' border border-rule px-4 py-3 text-center tv:py-3.5';

  return (
    <div
      data-nav-contain
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      className="anim-fade fixed inset-0 z-[71] flex items-center justify-center bg-black/35 px-4 py-6 tv:px-8"
    >
      <div className="absolute inset-0" aria-hidden />
      <div ref={panel} className={`relative z-10 ${card}`}>
        <div className="flex items-start justify-between gap-3">
          <h1
            id="update-title"
            className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]"
          >
            What's new in v{release.version}
          </h1>
          <button
            type="button"
            onClick={onDismiss}
            className="card-hover tap ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink"
            aria-label="Dismiss"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {release.body && (
          <div
            className="mt-3 max-h-[20rem] overflow-y-auto text-[length:var(--t-sm)] leading-relaxed text-ink-2"
            style={{ scrollbarWidth: 'thin' }}
          >
            {release.body.split('\n').map((line, i) => (
              <p key={i} className={line.trim() === '' ? 'h-2' : ''}>
                {line}
              </p>
            ))}
          </div>
        )}

        <div className="mt-5">
          <button
            data-nav-first
            type="button"
            onClick={() => window.open(release.html_url, '_blank', 'noopener')}
            className={`${button} bg-tally/8 border-tally/30`}
          >
            <ExternalLink className="h-5 w-5 shrink-0 text-ground" aria-hidden />
            <span className="text-[length:var(--t-md)] font-semibold text-ground tv:text-[length:var(--t-lg)]">
              Download
            </span>
          </button>
          <button type="button" onClick={onDismiss} className={button}>
            <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
              Dismiss
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
