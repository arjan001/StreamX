import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { clearCaches } from '../lib/warm';
import { forgetPagedLists } from '../lib/usePagedItems';
import {
  catalogueIsCurrent, localEnabled, localStatus, refreshLocal, subscribeLocal,
  type IngestStatus,
} from '../lib/localCatalogue';

/**
 * Refresh the library, by hand.
 *
 * Asked for as: "clear all the caches — the issue is that it's using the old
 * library — and add a button where they can reload the library manually, so there
 * is no auto cache removal, they should manually do it. Also you can update it
 * weekly for them automatically and try to sync it instead of downloading
 * everything."
 *
 * That is three separate behaviours and this is the manual one. The other two live
 * in `lib/localCatalogue.ts`: `weeklyCheck()` runs once at launch and compares the
 * server's catalogue generation against the one this device holds — one small
 * request in the ordinary week, and a download only when the catalogue really
 * changed. Nothing anywhere removes a cache on a timer.
 *
 * ── what pressing it does, in order ──
 *
 *   1. **Empties every cache this device holds.** Service-worker caches, stored
 *      API answers, artwork, and the query snapshot the app paints its first frame
 *      from. Nothing here is the viewer's — it is all reconstructible — and the
 *      things that ARE theirs (preferences, favourites, history, the session) are
 *      untouched.
 *   2. **Forgets the in-memory list pages**, which otherwise survive a navigation
 *      by design and would put the old channel list straight back on screen.
 *   3. **Asks react-query to refetch everything.**
 *   4. **Re-downloads the on-device catalogue**, if this screen keeps one.
 *
 * It reports what happened rather than flashing and going quiet: a spinner while
 * it works, then a tick, then back to the icon. A button that looks identical
 * before and after is a button people press five times.
 */
export function LibraryButton() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<IngestStatus>(localStatus);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => subscribeLocal(setStatus), []);
  useEffect(() => {
    if (!done) return undefined;
    const t = window.setTimeout(() => setDone(false), 2500);
    return () => window.clearTimeout(t);
  }, [done]);

  const downloading = status.state === 'loading';
  const working = busy || downloading || status.checking;

  const run = async () => {
    if (working) return;
    setBusy(true);
    try {
      await clearCaches();
      forgetPagedLists();
      /*
       * `refetchType: 'all'` on purpose.
       *
       * The default only refetches queries something is currently watching, which
       * on a phone is one screen's worth — so the moment you navigated anywhere
       * else you were back on the old data, and the button appeared not to have
       * worked. Whoever presses this wants everything re-asked.
       */
      await qc.invalidateQueries({ refetchType: 'all' });
      if (localEnabled()) await refreshLocal();
      else await catalogueIsCurrent();
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  const label = downloading
    ? `Downloading the library… ${(status.bytes / 1e6).toFixed(0)}MB`
    : status.checking
      ? 'Checking for a newer library…'
      : done
        ? 'Library refreshed'
        : status.builtAt !== null
          ? `Refresh the library (updated ${ago(status.builtAt)})`
          : 'Refresh the library';

  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={() => void run()}
        disabled={working}
        aria-label={label}
        /*
         * The one accent-blue control in the shell.
         *
         * Everything else uses the brand's amber tally, so a second colour has to
         * earn its place: this is the only button that throws work away and starts
         * again, it is destructive-adjacent, and it should not look like the
         * settings gear it sits next to.
         */
        className={`tap grid h-8 w-8 shrink-0 place-items-center border transition-colors
          disabled:opacity-70 ${done
            ? 'border-live text-live'
            : 'border-[#3b82f6]/70 text-[#60a5fa] hover:border-[#60a5fa] hover:bg-[#3b82f6]/15'}`}
        style={{ borderRadius: 'var(--r-full)' }}
      >
        {working
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : done
            ? <Check className="h-4 w-4" />
            : <RefreshCw className="h-4 w-4" />}
      </button>
    </Tooltip>
  );
}

/** "3 days ago", in the fewest words that are still true. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
