import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { activeAccountProblem, checkAccount, subscribeAccountProblem } from '../lib/accountCheck';
import { subscription } from '../lib/providers';
import { openAddAccount } from '../lib/addAccount';
import { player } from '../lib/playerCore';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import { pushBackHandler } from '../lib/nativeBack';

/**
 * The source on this device has stopped working — said once, over everything,
 * until something is done about it.
 *
 * The two things somebody can actually do: check again (they have just
 * renewed), or add another source. There is no close:
 * behind this every channel fails, and a dialog that can be dismissed into a
 * screen of errors is the thing being replaced. The account itself is kept (see
 * `setProblem` in lib/accountCheck.ts), so a renewal is one press.
 *
 * Television rules, as Welcome's: a contained panel, focus inside on mount, BACK
 * swallowed so it cannot walk the page behind it.
 */
export function ExpiredDialog() {
  const problem = useSyncExternalStore(subscribeAccountProblem, activeAccountProblem, () => null);
  const modern = useSkin().shell === 'modern';
  const panel = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (problem !== null && panel.current !== null) focusFirst(panel.current);
  }, [problem]);
  useEffect(() => (problem === null ? undefined : pushBackHandler(() => true)), [problem]);
  /* The app resumes the last channel on launch; behind this dialog that is a
     stream the panel will refuse — or, on a lenient one, sound under a question. */
  useEffect(() => { if (problem !== null) player.teardown(); }, [problem]);

  if (problem === null) return null;

  const until = subscription()?.expiresAt ?? null;
  const title = problem.reason === 'expired'
    ? "This source's account has expired"
    : problem.reason === 'disabled'
      ? 'This source has been switched off'
      : 'This source no longer accepts the login';
  const why = problem.reason === 'expired' && until !== null
    ? `It ran out on ${new Date(until).toLocaleDateString()}. `
    : '';

  const checkAgain = async () => {
    setBusy('Checking…');
    setNote(null);
    const v = await checkAccount(true);
    setBusy(null);
    if (v.kind === 'valid') return;
    setNote(v.kind === 'unknown'
      ? 'The source did not answer. Try again in a moment.'
      : 'Still not active. Check with your provider.');
  };

  const card = modern
    ? 'welcome-card glass-float tally-glow is-on w-full max-w-[26rem] p-5 tv:p-6'
    : 'card w-full max-w-[26rem] border border-rule bg-panel p-5 shadow-lg tv:p-6';
  const button = 'card card-hover tap mt-3 flex w-full items-center gap-3 border border-rule px-4 py-3 text-left';

  return (
    <div
      data-nav-contain
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      className="anim-fade fixed inset-0 z-[72] flex items-center justify-center bg-black/60 px-4 py-6"
    >
      <div className="absolute inset-0" aria-hidden />
      <div ref={panel} className={`relative z-10 ${card}`}>
        <h1 className="text-[length:var(--t-xl)] leading-tight text-ink">{title}</h1>
        <p className="mt-1.5 text-[length:var(--t-sm)] leading-relaxed text-ink-2">
          {why}Check with your provider. Nothing on it will play until it is renewed.
        </p>

        <button type="button" disabled={busy !== null} onClick={() => void checkAgain()} className={button}>
          <RefreshCw className={`h-5 w-5 shrink-0 text-tally ${busy === 'Checking…' ? 'animate-spin' : ''}`} />
          <span className="min-w-0">
            <span className="block text-ink">Check again</span>
            <span className="block text-[length:var(--t-xs)] text-ink-3">If you have just renewed it</span>
          </span>
        </button>
        <button type="button" disabled={busy !== null} onClick={() => openAddAccount()} className={button}>
          <Plus className="h-5 w-5 shrink-0 text-ink-2" />
          <span className="min-w-0">
            <span className="block text-ink">Add a source</span>
            <span className="block text-[length:var(--t-xs)] text-ink-3">Another server, playlist or stream link</span>
          </span>
        </button>

        {(busy !== null || note !== null) && (
          <p className="mt-3 text-[length:var(--t-sm)] text-ink-2" role="status">{busy ?? note}</p>
        )}
      </div>
    </div>
  );
}
