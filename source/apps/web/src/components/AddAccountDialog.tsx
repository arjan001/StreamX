import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { AddSource, useHiddenOnLegal } from './AddSource';
import { useSkin } from '../lib/skin';
import { focusFirst } from '../lib/spatialNav';
import type { SourceTypeId } from '../lib/sources';
import { pushBackHandler } from '../lib/nativeBack';

/**
 * Adding a subscription, asked for in one place and one shape.
 *
 * This is the form that used to be inlined at the bottom of the accounts panel —
 * inside the settings drawer, inside `/more?s=accounts`, and inside whatever else
 * rendered that panel next. The television showed what that costs: the welcome
 * dialog centred on the screen with the drawer's own ADD A SUBSCRIPTION form
 * still sitting behind it, two forms asking the same question at the same time.
 * "just add a buttton to show the dialog to add, instead of there".
 *
 * So the panels keep a button and this keeps the form. It is mounted once, beside
 * the welcome sheet in `main.tsx` and above the shell, which is the only place a
 * drawer cannot end up in front of it — and the mount refuses to show it while
 * the welcome door is open, because the one thing that must never happen again is
 * two of these on one screen.
 *
 * ── the television rules, which are Welcome's ──
 *
 * Same scrim, same card, same `data-nav-contain` boundary so the arrows cannot
 * walk out of the panel onto the shell behind it, and the same `focusFirst` on
 * mount: an overlay that opens with focus still behind it turns the first press
 * of OK into a click on whatever the scrim is covering. `SignInFields autoFocus`
 * is what declares where that focus lands — the server address field, rather than
 * whatever happens to be topmost in reading order.
 *
 * Escape and BACK both close it. BACK goes through `pushBackHandler`, the stack
 * the sheets and the player share, so the remote's back button means here what it
 * means everywhere else; the shell's own handler sits below this one and never
 * sees the press.
 */
export function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const modern = useSkin().shell === 'modern';
  const [note, setNote] = useState<string | null>(null);
  const [kind, setKind] = useState<SourceTypeId>('xtream');
  /* Terms and Privacy are routes: this sheet steps aside while one is open. */
  const aside = useHiddenOnLegal();
  const panel = useRef<HTMLDivElement | null>(null);
  const done = note !== null;

  useEffect(() => {
    const el = panel.current;
    if (el !== null && !aside) focusFirst(el);
  }, [done, aside]);

  useEffect(() => {
    if (aside) return undefined;
    return pushBackHandler(() => { onClose(); return true; });
  }, [onClose, aside]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* Welcome's panel, unchanged: the same form over the same launcher, so the
     card that was measured for it — including the near-solid fill the modern
     shell gives `.welcome-card`, because a tile coming through the middle of a
     username field is a rendering fault — is the right card for this one too. */
  const panelClass = modern
    ? 'welcome-card glass-float tally-glow is-on w-full max-w-[25rem] p-5 tv:max-w-[26rem] tv:p-6'
    : 'card w-full max-w-[25rem] border border-rule bg-panel p-5 shadow-lg tv:max-w-[26rem] tv:p-6';
  const secondary = 'card card-hover tap mt-3 flex w-full items-center justify-center gap-3'
    + ' border border-rule px-4 py-3 text-center tv:py-3.5';

  return (
    <div
      data-nav-contain
      role="dialog"
      aria-modal="true"
      aria-label="Add a source"
      className={`anim-fade fixed inset-0 z-[70] flex items-center justify-center
                 bg-black/35 px-4 py-6 tv:px-8 ${aside ? 'hidden' : ''}`}
    >
      {/* Full-screen catcher — the shell underneath stays visible, never
          interactive. Deliberately not a dismiss button: on a remote a
          full-screen catcher that closes the dialog is one stray press away
          from losing a half-typed password. */}
      <div className="absolute inset-0" aria-hidden />

      <div ref={panel} className={`relative z-10 ${panelClass}`}>
        <h1 className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]">
          {done ? 'Source added' : 'Add a source'}
        </h1>

        {!done && (
          <>
            <div className="mt-4">
              <AddSource
                onAdded={(message, k) => {
                  setNote(message);
                  setKind(k);
                  /*
                   * Every cached list was answered for the library this device
                   * had a moment ago, so they all go. The build finishing
                   * invalidates again (the `subscribeLocal` watcher in
                   * `main.tsx`), which is the later of the two moments, not a
                   * substitute for this one.
                   */
                  void qc.invalidateQueries();
                }}
              />
            </div>

            <button
              type="button"
              onClick={onClose}
              className={secondary}
            >
              <X className="h-5 w-5 shrink-0 text-ink-3" aria-hidden />
              <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
                Cancel
              </span>
            </button>
          </>
        )}

        {done && (
          <>
            <p className="mt-1.5 text-[length:var(--t-sm)] leading-relaxed text-ink-2">{note}</p>

            <button
              data-nav-first
              type="button"
              onClick={onClose}
              className="tap mt-5 w-full justify-center rounded-[var(--r-full)] bg-tally px-4 py-2.5
                         text-center font-semibold text-ground transition-colors hover:brightness-110"
            >
              Done
            </button>

            {/*
              Choosing packages, where it belongs.

              A server can arrive with hundreds of packages, and this is the first
              moment choosing between them is worth anybody's time. The dialog
              closes on the way out, because it is mounted above the shell and
              would otherwise still be sitting on top of the page it just sent
              somebody to.
            */}
            {kind === 'xtream' && (
            <button
              type="button"
              onClick={() => { onClose(); nav('/packages'); }}
              className={secondary}
            >
              <ListChecks className="h-5 w-5 shrink-0 text-tally" aria-hidden />
              <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
                Choose which packages to show
              </span>
            </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
