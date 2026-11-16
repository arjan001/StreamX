import { X, Download } from 'lucide-react';
import { useState } from 'react';
import { getUpdateRelease } from '../lib/updateState';

/**
 * Top update banner — shows "NEW VERSION {version}" with an Update button.
 *
 * The Update button is visually present but does not trigger any download or
 * redirect. This avoids exposing the GitHub repository on TV devices while
 * keeping the UI element in place for future re-enablement.
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const release = getUpdateRelease();

  if (dismissed) return null;

  const version = release?.version ?? '';

  return (
    <div className="bg-ink-1/80 border-b border-rule/40 px-4 py-2 text-center">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 shrink-0 text-ink-3" />
          <span className="font-mono text-[length:var(--t-xs)] text-ink-2">
            NEW VERSION {version}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            tabIndex={-1}
            className="card-hover tap flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[length:var(--t-xs)] font-medium text-white"
          >
            <Download className="h-3.5 w-3.5" />
            Update
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="card-hover tap flex h-7 w-7 items-center justify-center rounded-md text-ink-3"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
