import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, Play } from 'lucide-react';
import { BRAND } from '../brand';
import { useSkin } from '../lib/skin';
import { markOnboarded } from '../lib/session';
import type { SourceTypeId } from '../lib/sources';
import { AddSource, useHiddenOnLegal } from './AddSource';
import { Wordmark } from './Wordmark';
import { focusFirst } from '../lib/spatialNav';
import { WELCOME_KEY } from '../lib/firstRun';

export { WELCOME_KEY };

/**
 * First visit: the app shell (header + home) stays visible underneath; this is
 * only a blocking overlay with sign-in or continue-free.
 *
 * Classic and Modern share the same shape — dim scrim + centred dialog. Modern
 * uses glass; Classic uses a solid panel. Nothing behind the overlay is
 * clickable or reachable by the remote (`data-nav-contain` + full-screen catcher).
 */

function Choice({
  Icon, title, blurb, first = false, onPick,
}: {
  Icon: typeof Play;
  title: string;
  blurb: string;
  first?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      {...(first ? { 'data-nav-first': true } : {})}
      type="button"
      onClick={onPick}
      className="card card-hover grad-pick tap flex min-h-[8rem] flex-col items-start
                 p-4 text-left transition-transform tv:min-h-[10rem] tv:p-5"
    >
      <span
        className="mb-3 flex h-10 w-10 shrink-0 items-center justify-center
                   border border-tally/30 bg-tally/10 text-tally"
        style={{ borderRadius: 'var(--r-sm)' }}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="block text-[length:var(--t-lg)] leading-tight text-ink">
        {title}
      </span>
      <span className="mt-1.5 block max-w-[34ch] text-[length:var(--t-sm)] leading-relaxed text-ink-2">
        {blurb}
      </span>
    </button>
  );
}

export function Welcome({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const modern = useSkin().shell === 'modern';
  const [step, setStep] = useState<'door' | 'ready'>('door');
  const [note, setNote] = useState<string | null>(null);
  const [kind, setKind] = useState<SourceTypeId>('xtream');
  /* The Terms and Privacy pages are routes: while one is open this sheet steps
     aside (it stays mounted, so a half-ticked box is still there on return). */
  const aside = useHiddenOnLegal();
  const panel = useRef<HTMLDivElement | null>(null);

  /* Home behind the overlay — Classic showcase or Modern launcher, both under Chrome. */
  useEffect(() => {
    nav('/home', { replace: true });
  }, [nav]);

  useEffect(() => {
    const el = panel.current;
    if (el !== null && !aside) focusFirst(el);
  }, [step, aside]);

  const answer = () => markOnboarded(WELCOME_KEY);

  const finish = (to: string | null) => {
    answer();
    onDone();
    if (to !== null) nav(to);
  };

  /* Narrower than it was (32rem on a television is over half the width of a
     960px viewport), so the cards and the clock stay readable behind it —
     which is the whole reason the shell is rendered underneath at all. */
  const panelClass = modern
    ? 'signin-panel welcome-card glass-float tally-glow is-on w-full max-w-[25rem] p-5 tv:max-w-[26rem] tv:p-6'
    : 'signin-panel card w-full max-w-[25rem] border border-rule bg-panel p-5 shadow-lg tv:max-w-[26rem] tv:p-6';

  return (
    <div
      data-nav-contain
      role="dialog"
      aria-modal="true"
      aria-label={`Welcome to ${BRAND.name}`}
      /*
        A lighter scrim and NO blur.
        
        Asked for as "show the homepage always and show this dialog over it": the
        launcher is the point of this screen, so 55% black with a 2px blur over it
        was hiding the thing it is meant to sit on. The blur also had to go on its
        own account — a full-screen `backdrop-filter` is the single most expensive
        thing this app can paint, and it is the reason the launcher was dropping a
        third of its frames before 1.15.1 took it off everything else.
      */
      className={`signin-overlay anim-fade fixed inset-0 z-[70] flex items-center justify-center
                 bg-black/35 px-4 py-6 tv:px-8 ${aside ? 'hidden' : ''}`}
    >
      {/* Full-screen catcher — shell underneath stays visible, never interactive. */}
      <div className="absolute inset-0" aria-hidden />

      <div ref={panel} className={`relative z-10 ${panelClass}`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <Wordmark size={modern ? 'lg' : 'md'} full to={null} />
        </div>

        {step === 'door' && (
          <>
            <h1 className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]">
              Welcome to {BRAND.name}
            </h1>
            <p className="mt-1.5 text-[length:var(--t-sm)] leading-relaxed text-ink-2">
              Add a source to get started.
            </p>

            <div className="mt-5">
              <AddSource
                onAdded={(m, k) => { setNote(m); setKind(k); answer(); setStep('ready'); }}
              />
            </div>

            <button
              type="button"
              onClick={() => finish(null)}
              className="card card-hover tap mt-3 flex w-full items-center justify-center gap-3
                         border border-rule px-4 py-3 text-center tv:mt-3 tv:py-3.5"
            >
              <span className="text-[length:var(--t-md)] text-ink tv:text-[length:var(--t-lg)]">
                Not now
              </span>
            </button>
          </>
        )}

        {step === 'ready' && (
          <>
            <h1 className="text-[length:var(--t-xl)] leading-tight text-ink tv:text-[length:var(--t-2xl)]">
              Source added
            </h1>
            <p className="mt-1.5 text-[length:var(--t-sm)] leading-relaxed text-ink-2">
              {note}
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Choice
                first
                Icon={Play}
                title="Start watching"
                blurb="Straight to the channels. The download carries on behind you."
                onPick={() => finish('/live')}
              />
              {kind === 'xtream' && (
                <Choice
                  Icon={ListChecks}
                  title="Personalise the list first"
                  blurb="Countries, packages, and order — changes every screen."
                  onPick={() => finish('/organise')}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
