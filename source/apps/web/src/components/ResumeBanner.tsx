import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Clapperboard, History, House, Tv2, X } from 'lucide-react';
import { clearAnnouncement, useResumeAnnouncement } from '../lib/resume';
import { getSkin } from '../lib/skin';
import { Poster } from './Poster';

/**
 * "Picking up where you left off."
 *
 * An app that reopens a stream by itself owes the viewer two things: to say that
 * it did, and to make leaving one action. Without the first, the launch looks like
 * a bug — someone who left a film on last night opens the app and it is playing
 * something with no explanation. Without the second, it is a trap.
 *
 * So this is not a toast for its own sake. It is the undo. It names what was
 * restored, offers the way out, and then gets out of the way after eight seconds,
 * which is long enough to read across a room and short enough not to sit over the
 * picture.
 */
const ICONS = {
  live: Radio,
  movie: Clapperboard,
  episode: Tv2,
  archive: History,
} as const;

function startRoute(): string {
  const home = getSkin().home;
  return '/home';
}

function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function ResumeBanner() {
  const mark = useResumeAnnouncement();
  const nav = useNavigate();

  useEffect(() => {
    if (mark === null) return;
    const t = window.setTimeout(clearAnnouncement, 8000);
    return () => window.clearTimeout(t);
  }, [mark]);

  if (mark === null) return null;
  const Icon = ICONS[mark.kind];
  const fraction =
    mark.durationS > 0 && mark.positionS > 0 ? Math.min(1, mark.positionS / mark.durationS) : 0;

  return (
    /*
      `data-nav-scope`, not `data-nav-contain`: this sits over a page someone may
      well want to keep using, so a D-pad must be able to leave it. The soft scope
      keeps an arrow press inside the card while there is somewhere to go, which is
      what makes reaching "Home instead" one press rather than a hunt.
    */
    <div
      data-nav-scope
      role="status"
      className="anim-fade fixed bottom-[calc(var(--edge-b)+0.75rem)] left-[calc(var(--edge-l)+0.75rem)]
                 z-40 flex max-w-[min(24rem,80vw)] items-center gap-3 border border-rule
                 bg-panel p-2.5 shadow-lg"
    >
      {mark.logo !== null && (
        <Poster src={mark.logo} alt={mark.label} ratio="logo" fit="contain" className="shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-mono text-[length:var(--t-2xs)] tracking-widest text-ink-3">
          <Icon className="h-3 w-3" />
          {mark.kind === 'live' ? 'BACK ON' : 'CONTINUING'}
          {fraction > 0 && ` · ${mmss(mark.positionS)}`}
        </span>
        <span className="mt-0.5 block truncate text-[length:var(--t-md)] text-ink">{mark.label}</span>
        {fraction > 0 && (
          <span className="meter mt-1 block h-0.5 w-full bg-rule">
            <span className="block h-full bg-tally" style={{ width: `${fraction * 100}%` }} />
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          /* Stop the stream as well as leaving the page. Navigating away from a
             route whose player is a singleton does not stop it, which would leave
             audio playing over the home screen — and on a single-connection
             account it would also hold the one session. Loaded on demand so the
             banner (always mounted in Chrome) does not pull playerCore into the
             first paint graph. */
          void import('../lib/playerCore').then(({ player }) => player.teardown());
          clearAnnouncement();
          nav(startRoute(), { replace: true });
        }}
        aria-label="Home instead"
        className="dest tap shrink-0 border border-rule p-1.5 text-ink-3
                   hover:border-tally hover:text-tally"
      >
        <House className="h-3.5 w-3.5" />
        <span className="dest-label">HOME</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={clearAnnouncement}
        className="tap shrink-0 text-ink-3 hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
